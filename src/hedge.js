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
    logger.info(
      `[hedge ${group.name}] sizing: margin ${group.marginUsdt} USDT x${group.leverage} @${price} -> ${totalVol} contracts (notional ~${sized.notional.toFixed(2)} USDT)`
    );
  }

  // ── split the target size into chunks (don't dump the whole size at once) ──
  const wantChunks = Number.isInteger(group.openChunks) && group.openChunks > 0 ? group.openChunks : 1;
  // never make a chunk smaller than minVol
  const maxChunksBySize = Math.max(1, Math.floor(totalVol / spec.minVol));
  const nChunks = Math.min(wantChunks, maxChunksBySize);
  const chunkVols = splitVol(totalVol, nChunks, spec.volUnit);
  const interval = nChunks > 1 ? Math.floor(accumulateMs / nChunks) : 0;

  const layout =
    group.mode === 'single'
      ? `LONG+SHORT both on ${group.longAccount} (single-account hedge)`
      : `LONG on ${group.longAccount} + SHORT on ${group.shortAccount}`;
  logger.info(
    `[hedge ${group.name}] accumulating ${totalVol} contracts in ${nChunks} chunk(s) over ${accumulateMs}ms ` +
      `(interval ${interval}ms, chunks [${chunkVols.join(', ')}]): ${layout} ` +
      `(${symbol}, lev ${group.leverage}, openType ${group.openType}, posMode ${positionMode}, ${isLimit ? 'LIMIT' : 'MARKET'})`
  );

  // Submit one chunk of both legs in parallel. Marketable limit prices are
  // recomputed fresh per chunk so we stay marketable as the book moves.
  const submitChunk = async (cv, idx) => {
    let longPrice = null;
    let shortPrice = null;
    if (isLimit) {
      const prices = await computeLimitPrices(longRest, symbol, spec, contracts, group.limitLevel, group.name);
      longPrice = prices.longPrice;
      shortPrice = prices.shortPrice;
    }
    const openLeg = (rest, side, limitPrice) =>
      isLimit
        ? rest.submitLimitOpen({ symbol, side, vol: cv, leverage: group.leverage, openType: group.openType, positionMode, price: limitPrice })
        : rest.submitMarketOpen({ symbol, side, vol: cv, leverage: group.leverage, openType: group.openType, positionMode });
    const t = Date.now();
    const [lr, sr] = await Promise.allSettled([
      openLeg(longRest, SIDE.OPEN_LONG, longPrice),
      openLeg(shortRest, SIDE.OPEN_SHORT, shortPrice),
    ]);
    const longOk = lr.status === 'fulfilled';
    const shortOk = sr.status === 'fulfilled';
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
  }
  const submitMs = Date.now() - tSubmit;

  if (longSubmitted === 0 || shortSubmitted === 0) {
    logger.error(`[hedge ${group.name}] accumulation produced no orders on a leg (long=${longSubmitted}, short=${shortSubmitted}); aborting & cleaning up`);
    await abortHedge({ longRest, shortRest, symbol, groupName: group.name, isLimit });
    throw new Error(`hedge ${group.name}: accumulation failed (long=${longSubmitted}, short=${shortSubmitted})`);
  }
  if (longSubmitted !== shortSubmitted) {
    logger.warn(
      `[hedge ${group.name}] LEG IMBALANCE after accumulation: long submitted ${longSubmitted} vs short ${shortSubmitted} contracts (manage the difference manually)`
    );
  }

  // resolve real positions (entry price + positionId). Marketable limits fill
  // almost instantly, but allow a little extra time before giving up.
  const resolveOpts = isLimit ? { attempts: 14, delayMs: 700 } : { attempts: 8, delayMs: 700 };
  // time how long each leg takes to show up as a filled position
  const timedResolve = async (rest, side, acct) => {
    const t = Date.now();
    const pos = await resolveLegPosition(rest, symbol, side, resolveOpts);
    logger.info(
      `[hedge ${group.name}] ${side.toUpperCase()} ${pos ? 'filled' : 'NOT filled'} on ${acct} in ${Date.now() - t}ms`
    );
    return pos;
  };
  const tFill = Date.now();
  const [longPos, shortPos] = await Promise.all([
    timedResolve(longRest, 'long', group.longAccount),
    timedResolve(shortRest, 'short', group.shortAccount),
  ]);
  const fillMs = Date.now() - tFill;

  if (!longPos || !shortPos) {
    logger.error(`[hedge ${group.name}] positions not filled (long=${!!longPos}, short=${!!shortPos}); aborting & cleaning up`);
    await abortHedge({ longRest, shortRest, symbol, groupName: group.name, isLimit });
    throw new Error(`hedge ${group.name}: positions not filled after open`);
  }

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

module.exports = { openHedge, resolveLegPosition, splitVol };
