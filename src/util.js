'use strict';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Round a number to a given number of decimal places.
 */
function roundTo(value, decimals) {
  const f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

/**
 * Round a price DOWN/UP/NEAREST to the nearest multiple of `unit`, then trim to `decimals`.
 * mode: 'nearest' | 'floor' | 'ceil'
 */
function roundToUnit(value, unit, decimals, mode = 'nearest') {
  if (!unit || unit <= 0) return roundTo(value, decimals);
  const n = value / unit;
  const r = mode === 'floor' ? Math.floor(n) : mode === 'ceil' ? Math.ceil(n) : Math.round(n);
  return roundTo(r * unit, decimals);
}

/**
 * Number of decimals implied by a `scale` (e.g. 2 -> 2 decimals) or a `unit` (0.01 -> 2).
 */
function decimalsFromUnit(unit) {
  if (!unit) return 0;
  const s = String(unit);
  if (s.includes('e-')) return parseInt(s.split('e-')[1], 10);
  const dot = s.indexOf('.');
  return dot === -1 ? 0 : s.length - dot - 1;
}

/**
 * Price-movement PnL percentage for a leg, given entry and current price.
 * side: 'long' | 'short'. Returns a percentage (e.g. 0.4 means +0.4%).
 */
function legPnlPct(side, entryPrice, currentPrice) {
  if (!entryPrice || !currentPrice) return 0;
  const raw = (currentPrice - entryPrice) / entryPrice;
  const signed = side === 'short' ? -raw : raw;
  return signed * 100;
}

/**
 * Given an entry price, a side and a target PnL% (price movement), return the
 * absolute price at which the leg reaches that PnL%.
 *   long:  price = entry * (1 + pct/100)
 *   short: price = entry * (1 - pct/100)
 */
function priceForPnlPct(side, entryPrice, pct) {
  const f = pct / 100;
  return side === 'short' ? entryPrice * (1 - f) : entryPrice * (1 + f);
}

function nowIso() {
  return new Date().toISOString();
}

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

module.exports = {
  sleep,
  roundTo,
  roundToUnit,
  decimalsFromUnit,
  legPnlPct,
  priceForPnlPct,
  nowIso,
  safeNum,
};
