'use strict';

const { legPnlPct, priceForPnlPct } = require('./util');
const logger = require('./logger');

const PHASE = {
  WATCHING: 'watching', // both legs open, waiting for first leg to hit profit trigger
  ARMED_FIRST: 'armed_first', // SL placed on winner, waiting for it to fill
  SECOND_LEG: 'second_leg', // winner SL filled, TP armed on loser immediately
  ARMED_SECOND: 'armed_second', // TP placed on loser, waiting for it to fill
  DONE: 'done',
};

const OTHER = { long: 'short', short: 'long' };

/**
 * Drives one opened hedge run through the SL/TP state machine.
 * - Price ticks (WebSocket) trigger order placement.
 * - Position polling confirms SL/TP fills and advances phases.
 */
class HedgeMonitor {
  /**
   * @param {object} deps {
   *   run, getRest(accountName)->MexcRest, contracts: ContractCache,
   *   feed: PriceFeed, state: StateStore, pollMs, onDone(run)
   * }
   */
  constructor({ run, getRest, contracts, feed, state, pollMs = 3000, onDone }) {
    this.run = run;
    this.getRest = getRest;
    this.contracts = contracts;
    this.feed = feed;
    this.state = state;
    this.pollMs = pollMs;
    this.onDone = onDone || (() => {});
    this.busy = false;
    this.polling = false;
    this.done = false;
    this.pollTimer = null;
    this._priceHandler = (rec) => this._onPrice(rec);
  }

  start() {
    const run = this.run;
    logger.info(
      `[monitor ${run.id}] start phase=${run.phase} basis=${run.pctBasis} lev=${run.leverage} long=${run.long.account}@${run.long.entry} short=${run.short.account}@${run.short.entry}`
    );
    this.feed.subscribe(run.symbol);
    this.feed.on('price', this._priceHandler);
    this.pollTimer = setInterval(() => this._poll().catch((e) => logger.warn(`[monitor ${run.id}] poll: ${e.message}`)), this.pollMs);
    // evaluate immediately against the latest known price (covers resume)
    const last = this.feed.getPrice(run.symbol);
    if (last) this._onPrice({ symbol: run.symbol, price: last });
  }

  stop() {
    this.feed.removeListener('price', this._priceHandler);
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  _finish() {
    if (this.done) return;
    this.done = true;
    this.run.phase = PHASE.DONE;
    this.state.upsertRun(this.run);
    this.stop();
    logger.info(`[monitor ${this.run.id}] DONE`);
    this.onDone(this.run);
  }

  // Multiplier to convert raw price movement into the configured basis.
  //   'roe'   -> price% * leverage (matches MEXC's displayed PnL%)
  //   'price' -> price% (no leverage)
  _factor() {
    return this.run.pctBasis === 'roe' ? this.run.leverage || 1 : 1;
  }

  // Leg PnL expressed in the configured basis (roe or price).
  legPnl(which, price) {
    const leg = this.run[which];
    return legPnlPct(which, leg.entry, price) * this._factor();
  }

  // ── price-driven order placement ───────────────────────────────────────────
  async _onPrice(rec) {
    const run = this.run;
    if (rec.symbol !== run.symbol) return;
    if (this.busy) return;
    const price = rec.price;
    if (!price) return;

    if (run.phase === PHASE.WATCHING) {
      const pl = this.legPnl('long', price);
      const ps = this.legPnl('short', price);
      const best = pl >= ps ? 'long' : 'short';
      const bestPnl = Math.max(pl, ps);
      if (bestPnl >= run.strategy.profitTriggerPct) {
        await this._armFirst(best, price);
      }
    } else if (run.phase === PHASE.SECOND_LEG) {
      // fallback for resume / placement retry; normally armed the instant SL fills
      if (!run.tpPlaced) await this._armSecond(price);
    }
  }

  async _armFirst(winner, price) {
    const run = this.run;
    this.busy = true;
    try {
      const loser = OTHER[winner];
      const leg = run[winner];
      const spec = await this.contracts.get(run.symbol);
      // stopLockPct is in the configured basis; convert to a raw price-move %
      const slRaw = priceForPnlPct(winner, leg.entry, run.strategy.stopLockPct / this._factor());
      // round towards locking slightly less profit (conservative trigger placement)
      const mode = winner === 'long' ? 'floor' : 'ceil';
      const slPrice = this.contracts.roundPrice(spec, slRaw, mode);
      const rest = this.getRest(leg.account);
      logger.info(
        `[monitor ${run.id}] ${winner.toUpperCase()} hit +${run.strategy.profitTriggerPct}% ${run.pctBasis} (pnl@${price}). ` +
          `Placing SL lock @+${run.strategy.stopLockPct}% ${run.pctBasis} -> price ${slPrice} on ${leg.account} pos ${leg.positionId}`
      );
      await rest.placeTpSlByPosition({
        symbol: run.symbol,
        positionId: leg.positionId,
        vol: leg.vol,
        stopLossPrice: slPrice,
      });
      run.winner = winner;
      run.loser = loser;
      run.slPrice = slPrice;
      run.slPlaced = true;
      run.phase = PHASE.ARMED_FIRST;
      this.state.upsertRun(run);
      logger.info(`[monitor ${run.id}] SL placed. phase -> armed_first (waiting for ${winner} to fill)`);
    } catch (e) {
      logger.error(`[monitor ${run.id}] failed to place SL on winner: ${e.message}`);
    } finally {
      this.busy = false;
    }
  }

  async _armSecond(price) {
    const run = this.run;
    this.busy = true;
    try {
      const loser = run.loser;
      const leg = run[loser];
      const spec = await this.contracts.get(run.symbol);
      // tp2Pct is in the configured basis; convert to a raw price-move %
      const tpRaw = priceForPnlPct(loser, leg.entry, run.strategy.tp2Pct / this._factor());
      const mode = loser === 'long' ? 'ceil' : 'floor';
      const tpPrice = this.contracts.roundPrice(spec, tpRaw, mode);
      const rest = this.getRest(leg.account);
      logger.info(
        `[monitor ${run.id}] winner SL filled -> placing TP on ${loser.toUpperCase()} immediately ` +
          `@+${run.strategy.tp2Pct}% ${run.pctBasis} -> price ${tpPrice} on ${leg.account} pos ${leg.positionId}`
      );
      await rest.placeTpSlByPosition({
        symbol: run.symbol,
        positionId: leg.positionId,
        vol: leg.vol,
        takeProfitPrice: tpPrice,
      });
      run.tpPrice = tpPrice;
      run.tpPlaced = true;
      run.phase = PHASE.ARMED_SECOND;
      this.state.upsertRun(run);
      logger.info(`[monitor ${run.id}] TP placed. phase -> armed_second (waiting for ${loser} to fill)`);
    } catch (e) {
      logger.error(`[monitor ${run.id}] failed to place TP on loser: ${e.message}`);
    } finally {
      this.busy = false;
    }
  }

  // ── fill detection via position polling ──────────────────────────────────────
  async _isLegOpen(which) {
    const leg = this.run[which];
    const rest = this.getRest(leg.account);
    const pos = await rest.getPositionById(leg.positionId);
    return !!(pos && Number(pos.holdVol) > 0);
  }

  async _poll() {
    const run = this.run;
    if (this.busy || this.polling || this.done) return;
    this.polling = true;
    try {
      await this._pollInner(run);
    } finally {
      this.polling = false;
    }
  }

  async _pollInner(run) {
    if (run.phase === PHASE.WATCHING) {
      const [longOpen, shortOpen] = await Promise.all([this._isLegOpen('long'), this._isLegOpen('short')]);
      if (!longOpen && !shortOpen) {
        logger.warn(`[monitor ${run.id}] both legs closed externally while watching -> done`);
        this._finish();
      } else if (!longOpen || !shortOpen) {
        const gone = !longOpen ? 'long' : 'short';
        logger.warn(`[monitor ${run.id}] ${gone} leg closed externally before any trigger -> finishing (manage remaining leg manually if any)`);
        this._finish();
      }
    } else if (run.phase === PHASE.ARMED_FIRST) {
      const open = await this._isLegOpen(run.winner);
      if (!open) {
        logger.info(`[monitor ${run.id}] winner (${run.winner}) stop filled -> phase second_leg`);
        run.phase = PHASE.SECOND_LEG;
        this.state.upsertRun(run);
        // place TP on the loser right away (no tp2 trigger wait)
        const price = this.feed.getPrice(run.symbol);
        await this._armSecond(price);
      }
    } else if (run.phase === PHASE.SECOND_LEG) {
      const open = await this._isLegOpen(run.loser);
      if (!open) {
        logger.warn(`[monitor ${run.id}] loser (${run.loser}) closed before TP was armed -> done`);
        this._finish();
      }
    } else if (run.phase === PHASE.ARMED_SECOND) {
      const open = await this._isLegOpen(run.loser);
      if (!open) {
        logger.info(`[monitor ${run.id}] loser (${run.loser}) take-profit filled`);
        this._finish();
      }
    }
  }
}

module.exports = { HedgeMonitor, PHASE };
