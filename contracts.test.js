'use strict';

process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { ContractCache } = require('./src/contracts');

const cache = new ContractCache(null);

// SILVER_USDT-like spec (real values from /contract/detail, Jun 2026)
const spec = {
  symbol: 'SILVER_USDT',
  contractSize: 0.01,
  volUnit: 1,
  minVol: 1,
  maxVol: 1000000, // per-ORDER cap
  riskTiers: [
    { level: 1, maxVol: 120000, maxLeverage: 1000 },
    { level: 2, maxVol: 3600000, maxLeverage: 500 },
    { level: 3, maxVol: 7200000, maxLeverage: 200 },
    { level: 4, maxVol: 24000000, maxLeverage: 50 },
    { level: 5, maxVol: 48000000, maxLeverage: 20 },
  ],
  riskBaseVol: 48000000,
};

// ── position cap from risk-limit tiers ───────────────────────────────────────
test('maxPositionVol: picks the largest tier whose maxLeverage allows the leverage', () => {
  assert.equal(cache.maxPositionVol(spec, 500), 3600000);
  assert.equal(cache.maxPositionVol(spec, 1000), 120000);
  assert.equal(cache.maxPositionVol(spec, 501), 120000);
  assert.equal(cache.maxPositionVol(spec, 200), 7200000);
  assert.equal(cache.maxPositionVol(spec, 20), 48000000);
  assert.equal(cache.maxPositionVol(spec, 1), 48000000);
});

test('maxPositionVol: falls back to riskBaseVol, then Infinity', () => {
  assert.equal(cache.maxPositionVol({ ...spec, riskTiers: [] }, 500), 48000000);
  assert.equal(cache.maxPositionVol({ ...spec, riskTiers: [], riskBaseVol: 0 }, 500), Infinity);
});

// ── sizing: per-order maxVol must NOT shrink the position ────────────────────
test('contractsFromNotional: 2.3M USDT at 500x fits tier 2 and exceeds per-order maxVol', () => {
  const sized = cache.contractsFromNotional(spec, {
    notionalUsdt: 2302000,
    leverage: 500,
    price: 67.63,
  });
  assert.equal(sized.clamped, false);
  assert.equal(sized.vol, sized.requestedVol);
  assert.ok(sized.vol > spec.maxVol, `position ${sized.vol} should exceed the per-order cap`);
  assert.ok(sized.vol <= 3600000, `position ${sized.vol} must stay inside the 500x tier`);
});

test('contractsFromNotional: clamps to the risk-limit tier for the leverage', () => {
  const sized = cache.contractsFromNotional(spec, {
    notionalUsdt: 2302000,
    leverage: 1000,
    price: 67.63,
  });
  assert.equal(sized.clamped, true);
  assert.equal(sized.vol, 120000);
  assert.equal(sized.positionCapVol, 120000);
  assert.ok(sized.requestedVol > sized.vol);
});

test('contractsFromMargin: unclamped sizing reports clamped=false', () => {
  const sized = cache.contractsFromMargin(spec, { marginUsdt: 100, leverage: 20, price: 50 });
  assert.equal(sized.vol, 4000); // 100*20 / (50*0.01)
  assert.equal(sized.clamped, false);
  assert.equal(sized.requestedVol, 4000);
});
