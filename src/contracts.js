'use strict';

const { roundToUnit, decimalsFromUnit, safeNum } = require('./util');
const logger = require('./logger');

/**
 * Caches MEXC contract specs per symbol and provides sizing/rounding helpers.
 * A single REST client (any account) is enough since /contract/detail is public.
 */
class ContractCache {
  constructor(rest) {
    this.rest = rest;
    this.cache = new Map(); // symbol -> normalized spec
  }

  async get(symbol) {
    if (this.cache.has(symbol)) return this.cache.get(symbol);
    const d = await this.rest.getContractDetail(symbol);
    if (!d || !d.symbol) {
      throw new Error(`contract detail unavailable for ${symbol}`);
    }
    const priceUnit = safeNum(d.priceUnit, 0);
    const volUnit = safeNum(d.volUnit, 1) || 1;
    const spec = {
      symbol: d.symbol,
      contractSize: safeNum(d.contractSize, 1) || 1,
      priceUnit,
      priceScale: d.priceScale != null ? safeNum(d.priceScale, decimalsFromUnit(priceUnit)) : decimalsFromUnit(priceUnit),
      volUnit,
      volScale: safeNum(d.volScale, 0),
      minVol: safeNum(d.minVol, 1) || 1,
      // maxVol is the cap for a SINGLE ORDER, not for the position. The
      // position cap comes from the risk-limit tiers (see maxPositionVol).
      maxVol: safeNum(d.maxVol, 0) || Infinity,
      minLeverage: safeNum(d.minLeverage, 1),
      maxLeverage: safeNum(d.maxLeverage, 0) || Infinity,
      // risk-limit tiers: a position of vol <= tier.maxVol may use leverage up
      // to tier.maxLeverage (e.g. SILVER_USDT: 3.6M contracts at <=500x).
      riskTiers: Array.isArray(d.riskLimitCustom)
        ? d.riskLimitCustom
            .map((t) => ({
              level: safeNum(t.level, 0),
              maxVol: safeNum(t.maxVol, 0),
              maxLeverage: safeNum(t.maxLeverage, 0),
            }))
            .filter((t) => t.maxVol > 0 && t.maxLeverage > 0)
        : [],
      riskBaseVol: safeNum(d.riskBaseVol, 0),
      raw: d,
    };
    this.cache.set(symbol, spec);
    logger.info(
      `[contract] ${spec.symbol}: size=${spec.contractSize} priceUnit=${spec.priceUnit} priceScale=${spec.priceScale} volUnit=${spec.volUnit} minVol=${spec.minVol} maxLev=${spec.maxLeverage}`
    );
    return spec;
  }

  /**
   * Max POSITION size (contracts) allowed at the given leverage, derived from
   * the symbol's risk-limit tiers (higher tiers allow more volume but cap the
   * leverage lower). Falls back to riskBaseVol, then Infinity.
   * NOTE: spec.maxVol is the per-ORDER cap and does NOT limit the position.
   */
  maxPositionVol(spec, leverage) {
    const lev = leverage > 0 ? leverage : 1;
    let cap = 0;
    for (const t of spec.riskTiers || []) {
      if (t.maxLeverage >= lev && t.maxVol > cap) cap = t.maxVol;
    }
    if (cap > 0) return cap;
    return spec.riskBaseVol > 0 ? spec.riskBaseVol : Infinity;
  }

  /**
   * Round an absolute price to the contract's tick / scale (nearest tick).
   */
  roundPrice(spec, price, mode = 'nearest') {
    if (spec.priceUnit > 0) return roundToUnit(price, spec.priceUnit, spec.priceScale, mode);
    return roundToUnit(price, 0, spec.priceScale, mode);
  }

  /**
   * Size an integer number of contracts for a TARGET NOTIONAL (the final
   * position value in USDT), independent of leverage.
   *   contracts = notional / (price * contractSize)
   * Leverage only affects how much collateral the exchange locks
   * (collateral = notional / leverage). Floored to volUnit, clamped to the
   * POSITION risk-limit for the leverage (NOT to per-order maxVol — chunking
   * splits large positions into <= maxVol orders). Returns
   * { vol, notional, marginUsed, requestedVol, clamped, positionCapVol }
   * or throws when below minVol.
   */
  contractsFromNotional(spec, { notionalUsdt, leverage, price }) {
    if (!(price > 0)) throw new Error('price required to size order');
    if (!(notionalUsdt > 0)) throw new Error('notionalUsdt required to size order');
    const perContract = price * spec.contractSize;
    let vol = Math.floor(notionalUsdt / perContract / spec.volUnit) * spec.volUnit;
    if (vol < spec.minVol) {
      throw new Error(
        `computed vol ${vol} < minVol ${spec.minVol} for ${spec.symbol} (increase margin/notional). ` +
          `notional=${notionalUsdt.toFixed(2)} perContract=${perContract.toFixed(6)}`
      );
    }
    const requestedVol = vol;
    const posCap = this.maxPositionVol(spec, leverage);
    let clamped = false;
    if (vol > posCap) {
      vol = Math.floor(posCap / spec.volUnit) * spec.volUnit;
      clamped = true;
    }
    const notional = vol * perContract;
    const marginUsed = leverage > 0 ? notional / leverage : null;
    return {
      vol,
      notional,
      marginUsed,
      requestedVol,
      clamped,
      positionCapVol: Number.isFinite(posCap) ? posCap : null,
    };
  }

  /**
   * Convert a USDT margin (collateral) + leverage into an integer number of
   * contracts.
   *   notional   = margin * leverage   (USDT)
   *   contracts  = notional / (price * contractSize)
   * Floored to volUnit and clamped to the POSITION risk-limit for the leverage
   * (per-order maxVol is handled by chunking, see contractsFromNotional).
   * Returns { vol, notional, marginUsed, requestedVol, clamped, positionCapVol }
   * or throws if below minVol.
   */
  contractsFromMargin(spec, { marginUsdt, leverage, price }) {
    if (!(price > 0)) throw new Error('price required to size order');
    const notional = marginUsdt * leverage;
    const perContract = price * spec.contractSize;
    let vol = Math.floor(notional / perContract / spec.volUnit) * spec.volUnit;
    if (vol < spec.minVol) {
      throw new Error(
        `computed vol ${vol} < minVol ${spec.minVol} for ${spec.symbol} (increase marginUsdt or leverage). ` +
          `notional=${notional.toFixed(2)} perContract=${perContract.toFixed(6)}`
      );
    }
    const requestedVol = vol;
    const posCap = this.maxPositionVol(spec, leverage);
    let clamped = false;
    if (vol > posCap) {
      vol = Math.floor(posCap / spec.volUnit) * spec.volUnit;
      clamped = true;
    }
    const marginUsed = (vol * perContract) / leverage;
    return {
      vol,
      notional: vol * perContract,
      marginUsed,
      requestedVol,
      clamped,
      positionCapVol: Number.isFinite(posCap) ? posCap : null,
    };
  }
}

module.exports = { ContractCache };
