'use strict';

const { SIDE } = require('./mexc/rest');
const { sleep, safeNum } = require('./util');
const { PHASE } = require('./monitor');
const logger = require('./logger');

/**
 * Resolve the freshly-opened position for a leg (poll a few times until the
 * fill is reflected in open_positions).
 */
async function resolveLegPosition(rest, symbol, side /* 'long'|'short' */, { attempts = 8, delayMs = 700 } = {}) {
  for (let i = 0; i < attempts; i++) {
    const pos = await rest.getPositionBySymbolSide(symbol, side);
    if (pos && Number(pos.holdVol) > 0) return pos;
    await sleep(delayMs);
  }
  return null;
}

// MEXC web API rate-limit: code 510 "Requests are too frequent". Treat these
// (and any "too frequent" message) as transient and retryable.
function isRateLimit(e) {
  if (!e) return false;
  if (e.code === 510 || e.code === '510') return true;
  return /too frequent|frequent.*request|requests are too/i.test(e.message || '');
}

/**
 * Run a submit, retrying on transient MEXC rate-limit errors (code 510) with
 * linear backoff. Non-rate-limit errors propagate immediately.
 */
async function submitWithRetry(fn, { retries = 5, baseDelayMs = 400, label = 'submit', groupName = '' } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt > retries || !isRateLimit(e)) throw e;
      const delay = baseDelayMs * attempt;
      logger.warn(`[hedge ${groupName}] ${label} rate-limited (code ${e.code || '?'}); retry ${attempt}/${retries} in ${delay}ms`);
      await sleep(delay);
    }
  }
}

/**
 * Open a hedge: long on group.longAccount, short on group.shortAccount.
 * Returns a `run` object ready for HedgeMonitor, or throws on failure (after
 * attempting to unwind any single leg that did open).
 */
async function openHedge(group, { getRest, contracts, feed, targetMs = null }) {
  const { symbol } = group;
  const tOpen0 = Date.now(); // overall open-latency clock
  const spec = await contracts.get(symbol);
  const longRest = getRest(group.longAccount);
  const shortRest = getRest(group.shortAccount);
  const positionMode = group.positionMode || 1;
  const isLimit = group.orderType === 'limit';
  // BOTH legs of a chunk are always fired together (in parallel) so the hedge
  // builds symmetrically. One long+short pair per chunk tick stays inside
  // MEXC's ~2 order-creates/sec per-account budget even on a single account.
  const singleAccount = longRest === shortRest;

  // ── accumulation timing (secondstoopen) ───────────────────────────────────
  // Begin opening `secondsToOpen` before the target instant; accumulate the
  // position over the FIRST HALF of that window (the second half is buffer so
  // the full size is in place before the target). With no target (immediate /
  // test opens) start now.
  const secondsToOpen = group.secondsToOpen > 0 ? group.secondsToOpen : 0;
  const startAtMs =
    targetMs != null && secondsToOpen > 0 ? targetMs - secondsToOpen * 1000 : Date.now();
  const accumulateMs = Math.max(0, Math.round((secondsToOpen / 2) * 1000));
  const waitMs = startAtMs - Date.now();
  if (waitMs > 0) {
    logger.info(`[hedge ${group.name}] waiting ${waitMs}ms to begin opening (${secondsToOpen}s before target)`);
    await sleep(waitMs);
  }

  // reference price for sizing (fresh, right before accumulation)
  let price = feed.getPrice(symbol);
  if (!price) {
    try {
      const t = await longRest.getTicker(symbol);
      price = safeNum(t.lastPrice, 0);
    } catch (e) {
      logger.warn(`[hedge ${group.name}] ticker fallback failed: ${e.message}`);
    }
  }
  if (!price) throw new Error(`no price available for ${symbol} to size order`);

  // total target volume (same on both legs)
  let totalVol;
  if (group.volContracts != null) {
    totalVol = Math.max(spec.minVol, Math.floor(group.volContracts / spec.volUnit) * spec.volUnit);
  } else if (group.notionalUsdt != null) {
    // notionalUsdt = the FINAL position value (e.g. from the DB `margin` field):
    // open exactly this position size; collateral used = notional / leverage.
    const sized = contracts.contractsFromNotional(spec, {
      notionalUsdt: group.notionalUsdt,
      leverage: group.leverage,
      price,
    });
    totalVol = sized.vol;
    if (sized.clamped) {
      logger.warn(
        `[hedge ${group.name}] target ${sized.requestedVol} contracts exceeds the MAX POSITION for x${group.leverage} ` +
          `(risk-limit cap ${sized.positionCapVol}); opening ${totalVol} contracts (lower the leverage to allow a bigger position)`
      );
    }
    logger.info(
      `[hedge ${group.name}] sizing: target position ${group.notionalUsdt} USDT (final) x${group.leverage} @${price} -> ${totalVol} contracts ` +
        `(notional ~${sized.notional.toFixed(2)} USDT, est collateral ~${sized.marginUsed != null ? sized.marginUsed.toFixed(2) : '?'} USDT)`
    );
  } else {
    const sized = contracts.contractsFromMargin(spec, {
      marginUsdt: group.marginUsdt,
      leverage: group.leverage,
      price,
    });
    totalVol = sized.vol;
    if (sized.clamped) {
      logger.warn(
        `[hedge ${group.name}] target ${sized.requestedVol} contracts exceeds the MAX POSITION for x${group.leverage} ` +
          `(risk-limit cap ${sized.positionCapVol}); opening ${totalVol} contracts (lower the leverage to allow a bigger position)`
      );
    }
    logger.info(
      `[hedge ${group.name}] sizing: margin ${group.marginUsdt} USDT x${group.leverage} @${price} -> ${totalVol} contracts (notional ~${sized.notional.toFixed(2)} USDT)`
    );
  }

  // ── split the target size into chunks (don't dump the whole size at once) ──
  // Fixed cadence: one long+short pair is submitted SIMULTANEOUSLY every
  // `interval` ms (default 1500). Cap the chunk count so the last submit still
  // lands inside the accumulation half-window (fills/top-ups use the rest).
  const interval = group.chunkIntervalMs > 0 ? Math.round(group.chunkIntervalMs) : 1500;
  const wantChunks = Number.isInteger(group.openChunks) && group.openChunks > 0 ? group.openChunks : 1;
  // never make a chunk smaller than minVol
  const maxChunksBySize = Math.max(1, Math.floor(totalVol / spec.minVol));
  const maxChunksByTime = accumulateMs > 0 ? Math.floor(accumulateMs / interval) + 1 : wantChunks;
  let nChunks = Math.max(1, Math.min(wantChunks, maxChunksBySize, maxChunksByTime));
  if (nChunks < wantChunks) {
    logger.warn(
      `[hedge ${group.name}] capping chunks ${wantChunks} -> ${nChunks} ` +
        `(minVol ${spec.minVol}, window ${accumulateMs}ms @ ${interval}ms/chunk)`
    );
  }
  // spec.maxVol caps a SINGLE ORDER, not the position: a position bigger than
  // maxVol MUST be built from more chunks. This overrides the time cap —
  // finishing a little late beats silently opening a smaller position.
  const orderCapChunks = Number.isFinite(spec.maxVol) ? Math.ceil(totalVol / spec.maxVol) : 1;
  if (orderCapChunks > nChunks) {
    logger.warn(
      `[hedge ${group.name}] raising chunks ${nChunks} -> ${orderCapChunks} so every order fits the per-order cap (maxVol ${spec.maxVol})`
    );
    nChunks = orderCapChunks;
  }
  let chunkVols = splitVol(totalVol, nChunks, spec.volUnit);
  // splitVol puts the remainder into the LAST chunk — re-split if that spills
  // over the per-order cap (only happens when totalVol is close to n*maxVol)
  while (Number.isFinite(spec.maxVol) && chunkVols[chunkVols.length - 1] > spec.maxVol) {
    nChunks += 1;
    chunkVols = splitVol(totalVol, nChunks, spec.volUnit);
  }

  const layout =
    group.mode === 'single'
      ? `LONG+SHORT both on ${group.longAccount} (single-account hedge)`
      : `LONG on ${group.longAccount} + SHORT on ${group.shortAccount}`;
  logger.info(
    `[hedge ${group.name}] accumulating ${totalVol} contracts in ${nChunks} chunk(s) over ${accumulateMs}ms ` +
      `(interval ${interval}ms, chunks [${chunkVols.join(', ')}]): ${layout} ` +
      `(${symbol}, lev ${group.leverage}, openType ${group.openType}, posMode ${positionMode}, ${isLimit ? 'LIMIT' : 'MARKET'})`
  );

  // A leg that keeps failing with a NON-rate-limit error (e.g. code 6026 "risk
  // control verification", auth/balance errors) will never open — stop early
  // and unwind instead of building one-sided exposure on the healthy leg.
  const FATAL_LEG_FAILS = 2;
  const hardFails = { long: 0, short: 0 };
  const trackLeg = (leg, ok, reason) => {
    if (ok) hardFails[leg] = 0;
    else if (!isRateLimit(reason)) hardFails[leg] += 1;
  };
  const assertLegsAlive = async () => {
    const dead =
      hardFails.long >= FATAL_LEG_FAILS ? 'LONG' : hardFails.short >= FATAL_LEG_FAILS ? 'SHORT' : null;
    if (!dead) return;
    logger.error(
      `[hedge ${group.name}] ${dead} leg failed ${FATAL_LEG_FAILS}x with non-retryable errors — ` +
        `aborting hedge & unwinding to avoid one-sided exposure`
    );
    await abortHedge({ longRest, shortRest, symbol, groupName: group.name, isLimit });
    throw new Error(`hedge ${group.name}: ${dead} leg cannot open (fatal submit errors)`);
  };

  // Submit one chunk of both legs. Marketable limit prices are recomputed fresh
  // per chunk so we stay marketable as the book moves. Each submit retries on
  // rate-limit (code 510).
  const submitChunk = async (cv, idx) => {
    let longPrice = null;
    let shortPrice = null;
    if (isLimit) {
      const prices = await computeLimitPrices(longRest, symbol, spec, contracts, group.limitLevel, group.name);
      longPrice = prices.longPrice;
      shortPrice = prices.shortPrice;
    }
    const openLeg = (rest, side, limitPrice, name) =>
      submitWithRetry(
        () =>
          isLimit
            ? rest.submitLimitOpen({ symbol, side, vol: cv, leverage: group.leverage, openType: group.openType, positionMode, price: limitPrice })
            : rest.submitMarketOpen({ symbol, side, vol: cv, leverage: group.leverage, openType: group.openType, positionMode }),
        { label: `chunk ${idx + 1}/${nChunks} ${name}`, groupName: group.name }
      );
    const t = Date.now();
    // both legs of the pair fire at the same instant, even on one account
    const [lr, sr] = await Promise.allSettled([
      openLeg(longRest, SIDE.OPEN_LONG, longPrice, 'LONG'),
      openLeg(shortRest, SIDE.OPEN_SHORT, shortPrice, 'SHORT'),
    ]);
    const longOk = lr.status === 'fulfilled';
    const shortOk = sr.status === 'fulfilled';
    trackLeg('long', longOk, lr.reason);
    trackLeg('short', shortOk, sr.reason);
    if (!longOk) logger.warn(`[hedge ${group.name}] chunk ${idx + 1}/${nChunks} LONG failed: ${lr.reason.message}`);
    if (!shortOk) logger.warn(`[hedge ${group.name}] chunk ${idx + 1}/${nChunks} SHORT failed: ${sr.reason.message}`);
    logger.info(
      `[hedge ${group.name}] chunk ${idx + 1}/${nChunks} ${cv} contracts in ${Date.now() - t}ms ` +
        `(long ok=${longOk}, short ok=${shortOk}${isLimit ? `, @${longPrice}/${shortPrice}` : ''})`
    );
    return { longVol: longOk ? cv : 0, shortVol: shortOk ? cv : 0 };
  };

  const tSubmit = Date.now();
  const accStart = Date.now();
  let longSubmitted = 0;
  let shortSubmitted = 0;
  for (let i = 0; i < nChunks; i++) {
    if (i > 0 && interval > 0) {
      // schedule against an absolute clock so per-chunk drift doesn't accumulate
      const dt = accStart + i * interval - Date.now();
      if (dt > 0) await sleep(dt);
    }
    try {
      const r = await submitChunk(chunkVols[i], i);
      longSubmitted += r.longVol;
      shortSubmitted += r.shortVol;
    } catch (e) {
      logger.warn(`[hedge ${group.name}] chunk ${i + 1}/${nChunks} errored: ${e.message}`);
    }
    await assertLegsAlive();
  }
  const submitMs = Date.now() - tSubmit;
  if (longSubmitted !== shortSubmitted) {
    logger.warn(
      `[hedge ${group.name}] uneven chunk acks (long ${longSubmitted} vs short ${shortSubmitted}); reconciling to ${totalVol}`
    );
  }

  // let the last submits' fills land before we measure the shortfall
  await sleep(800);

  // ── reconcile to target: top up any shortfall (e.g. chunks lost to code 510) ──
  // Re-resolve actual filled holdVol per leg; if a leg is short by >= one lot,
  // submit the missing remainder (retried, fresh marketable price) and re-check.
  // A single order may not exceed the per-order cap (spec.maxVol); whatever is
  // still missing is picked up by the next reconcile round.
  const topUp = async (side, name, rest, vol) => {
    if (Number.isFinite(spec.maxVol) && vol > spec.maxVol) {
      vol = Math.floor(spec.maxVol / spec.volUnit) * spec.volUnit;
    }
    let price = null;
    if (isLimit) {
      const prices = await computeLimitPrices(longRest, symbol, spec, contracts, group.limitLevel, group.name);
      price = side === SIDE.OPEN_LONG ? prices.longPrice : prices.shortPrice;
    }
    try {
      await submitWithRetry(
        () =>
          isLimit
            ? rest.submitLimitOpen({ symbol, side, vol, leverage: group.leverage, openType: group.openType, positionMode, price })
            : rest.submitMarketOpen({ symbol, side, vol, leverage: group.leverage, openType: group.openType, positionMode }),
        { label: `${name} top-up ${vol}`, groupName: group.name }
      );
      trackLeg(side === SIDE.OPEN_LONG ? 'long' : 'short', true);
      logger.info(`[hedge ${group.name}] ${name} top-up submitted: +${vol} contracts${isLimit ? ` @${price}` : ''}`);
    } catch (e) {
      trackLeg(side === SIDE.OPEN_LONG ? 'long' : 'short', false, e);
      logger.warn(`[hedge ${group.name}] ${name} top-up failed: ${e.message}`);
    }
  };

  let longPos = null;
  let shortPos = null;
  const tFill = Date.now();
  const RECONCILE_ROUNDS = 4;
  const measure = () => {
    const haveLong = longPos ? safeNum(longPos.holdVol, 0) : 0;
    const haveShort = shortPos ? safeNum(shortPos.holdVol, 0) : 0;
    const missLong = Math.floor((totalVol - haveLong) / spec.volUnit) * spec.volUnit;
    const missShort = Math.floor((totalVol - haveShort) / spec.volUnit) * spec.volUnit;
    return {
      haveLong,
      haveShort,
      missLong,
      missShort,
      needLong: missLong >= spec.minVol,
      needShort: missShort >= spec.minVol,
    };
  };
  for (let round = 0; round <= RECONCILE_ROUNDS; round++) {
    const opts =
      round === 0
        ? isLimit
          ? { attempts: 14, delayMs: 700 }
          : { attempts: 8, delayMs: 700 }
        : { attempts: 6, delayMs: 600 };
    [longPos, shortPos] = await Promise.all([
      resolveLegPosition(longRest, symbol, 'long', opts),
      resolveLegPosition(shortRest, symbol, 'short', opts),
    ]);
    let m = measure();
    if (!m.needLong && !m.needShort) break;
    if (round === RECONCILE_ROUNDS) {
      logger.warn(
        `[hedge ${group.name}] still short after ${RECONCILE_ROUNDS} top-up round(s): long ${m.haveLong}/${totalVol}, short ${m.haveShort}/${totalVol}`
      );
      break;
    }
    // CRITICAL: cancel resting limit orders BEFORE topping up. A resting chunk
    // that fills AFTER the shortfall was measured would stack on top of the
    // top-up and overshoot the target (over-accumulation). Cancel, re-measure,
    // then submit only the true remainder.
    if (isLimit) {
      await safeCancelAll(longRest, symbol, group.name);
      if (!singleAccount) await safeCancelAll(shortRest, symbol, group.name);
      await sleep(600); // let cancel acks / racing fills settle
      const [lp, sp] = await Promise.all([
        resolveLegPosition(longRest, symbol, 'long', { attempts: 1, delayMs: 0 }),
        resolveLegPosition(shortRest, symbol, 'short', { attempts: 1, delayMs: 0 }),
      ]);
      if (lp) longPos = lp;
      if (sp) shortPos = sp;
      m = measure();
      if (!m.needLong && !m.needShort) break;
    }
    logger.info(
      `[hedge ${group.name}] top-up round ${round + 1}/${RECONCILE_ROUNDS}: ` +
        `long ${m.haveLong}/${totalVol}${m.needLong ? ` (+${m.missLong})` : ''}, short ${m.haveShort}/${totalVol}${m.needShort ? ` (+${m.missShort})` : ''}`
    );
    // top up BOTH legs in parallel (same simultaneous-pair rule as the chunks)
    await Promise.all([
      m.needLong ? topUp(SIDE.OPEN_LONG, 'LONG', longRest, m.missLong) : Promise.resolve(),
      m.needShort ? topUp(SIDE.OPEN_SHORT, 'SHORT', shortRest, m.missShort) : Promise.resolve(),
    ]);
    await assertLegsAlive();
    await sleep(700); // let the top-up fills settle before re-checking
  }
  const fillMs = Date.now() - tFill;

  if (!longPos || !shortPos) {
    logger.error(`[hedge ${group.name}] positions not filled (long=${!!longPos}, short=${!!shortPos}); aborting & cleaning up`);
    await abortHedge({ longRest, shortRest, symbol, groupName: group.name, isLimit });
    throw new Error(`hedge ${group.name}: positions not filled after open`);
  }

  // legs must be EQUAL: if one ended bigger (late fills of resting orders, or a
  // blocked/underfunded counterparty), close the excess so the hedge is neutral.
  ({ longPos, shortPos } = await rebalanceLegs({
    longRest,
    shortRest,
    symbol,
    longPos,
    shortPos,
    spec,
    groupName: group.name,
  }));

  const openedAt = Date.now();
  const run = {
    id: `${group.name}-${openedAt}`,
    groupName: group.name,
    symbol,
    openedAt,
    strategy: group.strategy,
    leverage: group.leverage,
    pctBasis: group.pctBasis,
    // when true the monitor places NO stop-losses — it just holds + logs PnL
    withoutSl: !!group.withoutSl,
    vol: totalVol,
    long: {
      account: group.longAccount,
      positionId: longPos.positionId,
      entry: safeNum(longPos.openAvgPrice || longPos.holdAvgPrice, price),
      vol: safeNum(longPos.holdVol, longSubmitted),
    },
    short: {
      account: group.shortAccount,
      positionId: shortPos.positionId,
      entry: safeNum(shortPos.openAvgPrice || shortPos.holdAvgPrice, price),
      vol: safeNum(shortPos.holdVol, shortSubmitted),
    },
    phase: PHASE.WATCHING,
    winner: null,
    loser: null,
    slPlaced: false,
    tp2SlPlaced: false,
  };

  logger.info(
    `[hedge ${group.name}] OPENED run ${run.id} in ${Date.now() - tOpen0}ms (submit ${submitMs}ms, fill ${fillMs}ms` +
      `${group.withoutSl ? ', SL DISABLED (without_sl)' : ''}): ` +
      `long entry ${run.long.entry} (pos ${run.long.positionId}, ${run.long.vol}), ` +
      `short entry ${run.short.entry} (pos ${run.short.positionId}, ${run.short.vol})`
  );
  return run;
}

/**
 * Split a total contract volume into `n` chunks aligned to `unit`. Each chunk
 * gets an equal floored share; the LAST chunk absorbs the remainder so the
 * pieces sum EXACTLY to `total`.
 */
function splitVol(total, n, unit) {
  const u = unit > 0 ? unit : 1;
  const per = Math.floor(total / n / u) * u;
  const vols = [];
  let assigned = 0;
  for (let i = 0; i < n; i++) {
    const v = i === n - 1 ? total - assigned : per;
    vols.push(v);
    assigned += v;
  }
  return vols;
}

/**
 * Equalise the two legs after reconcile: if one leg ended larger than the
 * other by at least one lot, close the excess on the LARGER leg at market so
 * the hedge is delta-neutral before monitoring starts. Best-effort: on failure
 * the imbalance is logged for manual action.
 */
async function rebalanceLegs({ longRest, shortRest, symbol, longPos, shortPos, spec, groupName }) {
  try {
    const haveLong = safeNum(longPos.holdVol, 0);
    const haveShort = safeNum(shortPos.holdVol, 0);
    const unit = spec.volUnit > 0 ? spec.volUnit : 1;
    const excess = Math.floor(Math.abs(haveLong - haveShort) / unit) * unit;
    if (excess < Math.max(spec.minVol, unit)) return { longPos, shortPos };
    const bigIsLong = haveLong > haveShort;
    const rest = bigIsLong ? longRest : shortRest;
    const pos = bigIsLong ? longPos : shortPos;
    logger.warn(
      `[hedge ${groupName}] legs unequal (long ${haveLong} vs short ${haveShort}); ` +
        `closing ${excess} excess on ${bigIsLong ? 'LONG' : 'SHORT'} to rebalance`
    );
    // the close order is capped per-order too — slice the excess if needed
    let remaining = excess;
    while (remaining > 0) {
      const slice = Number.isFinite(spec.maxVol)
        ? Math.min(remaining, Math.floor(spec.maxVol / unit) * unit)
        : remaining;
      await submitWithRetry(() => rest.closePositionMarket(pos, slice), {
        label: `rebalance close ${slice}`,
        groupName,
      });
      remaining -= slice;
    }
    await sleep(800); // let the partial close settle before re-reading the leg
    const fresh = await resolveLegPosition(rest, symbol, bigIsLong ? 'long' : 'short', {
      attempts: 4,
      delayMs: 500,
    });
    if (fresh) {
      if (bigIsLong) longPos = fresh;
      else shortPos = fresh;
    }
  } catch (e) {
    logger.error(`[hedge ${groupName}] rebalance failed: ${e.message} (legs left unequal — check manually)`);
  }
  return { longPos, shortPos };
}

/**
 * Pick marketable limit prices from the order book.
 *   LONG (buy)  -> Nth ASK (crosses up; fills through ask1..askN)
 *   SHORT (sell)-> Nth BID (crosses down; fills through bid1..bidN)
 */
async function computeLimitPrices(rest, symbol, spec, contracts, level, groupName) {
  const depth = await rest.getDepth(symbol, Math.max(20, level));
  const asks = Array.isArray(depth.asks) ? depth.asks : [];
  const bids = Array.isArray(depth.bids) ? depth.bids : [];
  if (!asks.length || !bids.length) throw new Error(`empty order book for ${symbol}`);
  if (asks.length < level || bids.length < level) {
    logger.warn(`[hedge ${groupName}] order book has < ${level} levels (asks ${asks.length}, bids ${bids.length}); using deepest available`);
  }
  const askPrice = safeNum(asks[Math.min(level, asks.length) - 1][0], 0);
  const bidPrice = safeNum(bids[Math.min(level, bids.length) - 1][0], 0);
  if (!askPrice || !bidPrice) throw new Error(`invalid order book prices for ${symbol}`);
  return {
    longPrice: contracts.roundPrice(spec, askPrice, 'ceil'),
    shortPrice: contracts.roundPrice(spec, bidPrice, 'floor'),
  };
}

/**
 * Best-effort cleanup of a failed open: cancel any resting (limit) orders, then
 * close any position that did open, on both legs.
 */
async function abortHedge({ longRest, shortRest, symbol, groupName, isLimit }) {
  if (isLimit) {
    await safeCancelAll(longRest, symbol, groupName);
    await safeCancelAll(shortRest, symbol, groupName);
  }
  await unwindIfOpen(longRest, symbol, 'long', groupName);
  await unwindIfOpen(shortRest, symbol, 'short', groupName);
}

async function safeCancelAll(rest, symbol, groupName) {
  try {
    await rest.cancelAllOpenOrders(symbol);
    logger.warn(`[hedge ${groupName}] cancelled resting orders on ${rest.name} (${symbol})`);
  } catch (e) {
    logger.warn(`[hedge ${groupName}] cancel-all failed on ${rest.name}: ${e.message}`);
  }
}

async function unwindIfOpen(rest, symbol, side, groupName) {
  // Close the leg if it actually opened (covers the case where the order
  // succeeded server-side even though our request errored).
  try {
    const pos = await resolveLegPosition(rest, symbol, side, { attempts: 3, delayMs: 600 });
    if (pos) {
      logger.warn(`[hedge ${groupName}] unwinding stray ${side} leg on ${rest.name}`);
      await safeClose(rest, pos, groupName);
    }
  } catch (e) {
    logger.warn(`[hedge ${groupName}] unwind check failed on ${rest.name}: ${e.message}`);
  }
}

async function safeClose(rest, position, groupName) {
  try {
    await rest.closePositionMarket(position);
    logger.warn(`[hedge ${groupName}] closed ${rest.name} position ${position.positionId}`);
  } catch (e) {
    logger.error(`[hedge ${groupName}] FAILED to close ${rest.name} position ${position.positionId}: ${e.message} (CLOSE MANUALLY)`);
  }
}

module.exports = { openHedge, resolveLegPosition, splitVol, rebalanceLegs };
