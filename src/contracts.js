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
      maxVol: safeNum(d.maxVol, 0) || Infinity,
      minLeverage: safeNum(d.minLeverage, 1),
      maxLeverage: safeNum(d.maxLeverage, 0) || Infinity,
      raw: d,
    };
    this.cache.set(symbol, spec);
    logger.info(
      `[contract] ${spec.symbol}: size=${spec.contractSize} priceUnit=${spec.priceUnit} priceScale=${spec.priceScale} volUnit=${spec.volUnit} minVol=${spec.minVol} maxLev=${spec.maxLeverage}`
    );
    return spec;
  }

  /**
   * Round an absolute price to the contract's tick / scale (nearest tick).
   */
  roundPrice(spec, price, mode = 'nearest') {
    if (spec.priceUnit > 0) return roundToUnit(price, spec.priceUnit, spec.priceScale, mode);
    return roundToUnit(price, 0, spec.priceScale, mode);
  }

  /**
   * Convert a USDT margin + leverage into an integer number of contracts.
   *   notional   = margin * leverage   (USDT)
   *   contracts  = notional / (price * contractSize)
   * Floored to volUnit and clamped to [minVol, maxVol].
   * Returns { vol, notional, marginUsed } or throws if below minVol.
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
    if (vol > spec.maxVol) vol = Math.floor(spec.maxVol / spec.volUnit) * spec.volUnit;
    const marginUsed = (vol * perContract) / leverage;
    return { vol, notional: vol * perContract, marginUsed };
  }
}

module.exports = { ContractCache };
