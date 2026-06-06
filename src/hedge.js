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
async function openHedge(group, { getRest, contracts, feed }) {
  const { symbol } = group;
  const tOpen0 = Date.now(); // overall open-latency clock
  const spec = await contracts.get(symbol);
  const longRest = getRest(group.longAccount);
  const shortRest = getRest(group.shortAccount);
  const positionMode = group.positionMode || 1;

  // reference price for sizing
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

  // volume (same on both legs)
  let vol;
  if (group.volContracts != null) {
    vol = Math.max(spec.minVol, Math.floor(group.volContracts / spec.volUnit) * spec.volUnit);
  } else if (group.notionalUsdt != null) {
    // notionalUsdt = the FINAL position value (e.g. from the DB `margin` field):
    // open exactly this position size; collateral used = notional / leverage.
    const sized = contracts.contractsFromNotional(spec, {
      notionalUsdt: group.notionalUsdt,
      leverage: group.leverage,
      price,
    });
    vol = sized.vol;
    logger.info(
      `[hedge ${group.name}] sizing: target position ${group.notionalUsdt} USDT (final) x${group.leverage} @${price} -> ${vol} contracts ` +
        `(notional ~${sized.notional.toFixed(2)} USDT, est collateral ~${sized.marginUsed != null ? sized.marginUsed.toFixed(2) : '?'} USDT)`
    );
  } else {
    const sized = contracts.contractsFromMargin(spec, {
      marginUsdt: group.marginUsdt,
      leverage: group.leverage,
      price,
    });
    vol = sized.vol;
    logger.info(
      `[hedge ${group.name}] sizing: margin ${group.marginUsdt} USDT x${group.leverage} @${price} -> ${vol} contracts (notional ~${sized.notional.toFixed(2)} USDT)`
    );
  }

  // marketable limit prices from the order book (buy crosses into asks, sell into bids)
  const isLimit = group.orderType === 'limit';
  let longPrice = null;
  let shortPrice = null;
  if (isLimit) {
    const prices = await computeLimitPrices(longRest, symbol, spec, contracts, group.limitLevel, group.name);
    longPrice = prices.longPrice;
    shortPrice = prices.shortPrice;
    logger.info(
      `[hedge ${group.name}] marketable limit (level ${group.limitLevel}): LONG buy @${longPrice} (ask${group.limitLevel}), SHORT sell @${shortPrice} (bid${group.limitLevel})`
    );
  }

  const layout =
    group.mode === 'single'
      ? `LONG+SHORT both on ${group.longAccount} (single-account hedge)`
      : `LONG on ${group.longAccount} + SHORT on ${group.shortAccount}`;
  logger.info(
    `[hedge ${group.name}] opening ${vol} contracts: ${layout} ` +
      `(${symbol}, lev ${group.leverage}, openType ${group.openType}, posMode ${positionMode}, ${isLimit ? 'LIMIT' : 'MARKET'})`
  );

  const openLeg = (rest, side, limitPrice) =>
    isLimit
      ? rest.submitLimitOpen({ symbol, side, vol, leverage: group.leverage, openType: group.openType, positionMode, price: limitPrice })
      : rest.submitMarketOpen({ symbol, side, vol, leverage: group.leverage, openType: group.openType, positionMode });

  // time each leg's submit round-trip individually so we can see per-account latency
  const timedOpen = async (rest, side, limitPrice, label, acct) => {
    const t = Date.now();
    try {
      const r = await openLeg(rest, side, limitPrice);
      logger.info(`[hedge ${group.name}] ${label} order acked on ${acct} in ${Date.now() - t}ms`);
      return r;
    } catch (e) {
      logger.warn(`[hedge ${group.name}] ${label} order on ${acct} errored after ${Date.now() - t}ms: ${e.message}`);
      throw e;
    }
  };

  // fire both legs in parallel
  const tSubmit = Date.now();
  const [longRes, shortRes] = await Promise.allSettled([
    timedOpen(longRest, SIDE.OPEN_LONG, longPrice, 'LONG', group.longAccount),
    timedOpen(shortRest, SIDE.OPEN_SHORT, shortPrice, 'SHORT', group.shortAccount),
  ]);
  const submitMs = Date.now() - tSubmit;

  const longOk = longRes.status === 'fulfilled';
  const shortOk = shortRes.status === 'fulfilled';

  if (!longOk || !shortOk) {
    if (!longOk) logger.error(`[hedge ${group.name}] LONG open failed: ${longRes.reason.message}`);
    if (!shortOk) logger.error(`[hedge ${group.name}] SHORT open failed: ${shortRes.reason.message}`);
    await abortHedge({ longRest, shortRest, symbol, groupName: group.name, isLimit });
    throw new Error(`hedge ${group.name}: failed to open both legs (long ok=${longOk}, short ok=${shortOk})`);
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
    vol,
    long: {
      account: group.longAccount,
      positionId: longPos.positionId,
      entry: safeNum(longPos.openAvgPrice || longPos.holdAvgPrice, price),
      vol: safeNum(longPos.holdVol, vol),
    },
    short: {
      account: group.shortAccount,
      positionId: shortPos.positionId,
      entry: safeNum(shortPos.openAvgPrice || shortPos.holdAvgPrice, price),
      vol: safeNum(shortPos.holdVol, vol),
    },
    phase: PHASE.WATCHING,
    winner: null,
    loser: null,
    slPlaced: false,
    tp2SlPlaced: false,
  };

  logger.info(
    `[hedge ${group.name}] OPENED run ${run.id} in ${Date.now() - tOpen0}ms (submit ${submitMs}ms, fill ${fillMs}ms): ` +
      `long entry ${run.long.entry} (pos ${run.long.positionId}), short entry ${run.short.entry} (pos ${run.short.positionId})`
  );
  return run;
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

module.exports = { openHedge, resolveLegPosition };
