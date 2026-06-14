'use strict';

process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { splitVol, rebalanceLegs } = require('./src/hedge');

// minimal rest stub for rebalanceLegs
function fakeRest({ closeError = null, refreshed = null } = {}) {
  const calls = { close: [] };
  return {
    calls,
    name: 'fake',
    async closePositionMarket(position, vol) {
      calls.close.push({ position, vol });
      if (closeError) throw closeError;
    },
    async getPositionBySymbolSide() {
      return refreshed;
    },
  };
}

// ── leg rebalancing (equalise after reconcile) ───────────────────────────────
test('rebalanceLegs: equal legs -> no close', async () => {
  const longRest = fakeRest();
  const shortRest = fakeRest();
  const longPos = { holdVol: 100, positionId: 1 };
  const shortPos = { holdVol: 100, positionId: 2 };
  const r = await rebalanceLegs({
    longRest,
    shortRest,
    symbol: 'SILVER_USDT',
    longPos,
    shortPos,
    spec: { volUnit: 1, minVol: 1 },
    groupName: 't',
  });
  assert.equal(longRest.calls.close.length, 0);
  assert.equal(shortRest.calls.close.length, 0);
  assert.equal(r.longPos, longPos);
  assert.equal(r.shortPos, shortPos);
});

test('rebalanceLegs: bigger LONG leg is trimmed by the excess', async () => {
  const refreshed = { holdVol: 100, positionId: 1 };
  const longRest = fakeRest({ refreshed });
  const shortRest = fakeRest();
  const r = await rebalanceLegs({
    longRest,
    shortRest,
    symbol: 'SILVER_USDT',
    longPos: { holdVol: 130, positionId: 1 },
    shortPos: { holdVol: 100, positionId: 2 },
    spec: { volUnit: 1, minVol: 1 },
    groupName: 't',
  });
  assert.equal(longRest.calls.close.length, 1);
  assert.equal(longRest.calls.close[0].vol, 30);
  assert.equal(shortRest.calls.close.length, 0);
  assert.equal(r.longPos, refreshed);
});

test('rebalanceLegs: excess below one lot -> no close', async () => {
  const longRest = fakeRest();
  const shortRest = fakeRest();
  await rebalanceLegs({
    longRest,
    shortRest,
    symbol: 'SILVER_USDT',
    longPos: { holdVol: 104, positionId: 1 },
    shortPos: { holdVol: 100, positionId: 2 },
    spec: { volUnit: 10, minVol: 10 },
    groupName: 't',
  });
  assert.equal(longRest.calls.close.length, 0);
  assert.equal(shortRest.calls.close.length, 0);
});

test('rebalanceLegs: close failure is tolerated (returns original legs)', async () => {
  const longPos = { holdVol: 100, positionId: 1 };
  const shortPos = { holdVol: 150, positionId: 2 };
  const longRest = fakeRest();
  const shortRest = fakeRest({ closeError: new Error('boom') });
  const r = await rebalanceLegs({
    longRest,
    shortRest,
    symbol: 'SILVER_USDT',
    longPos,
    shortPos,
    spec: { volUnit: 1, minVol: 1 },
    groupName: 't',
  });
  assert.equal(shortRest.calls.close.length, 1);
  assert.equal(shortRest.calls.close[0].vol, 50);
  assert.equal(r.longPos, longPos);
  assert.equal(r.shortPos, shortPos);
});

// ── chunk splitting (gradual accumulation) ───────────────────────────────────
test('splitVol: equal split sums exactly to total', () => {
  const v = splitVol(125, 5, 1);
  assert.deepEqual(v, [25, 25, 25, 25, 25]);
  assert.equal(v.reduce((a, b) => a + b, 0), 125);
});

test('splitVol: remainder lands in the LAST chunk', () => {
  const v = splitVol(127, 5, 1);
  assert.deepEqual(v, [25, 25, 25, 25, 27]);
  assert.equal(v.reduce((a, b) => a + b, 0), 127);
});

test('splitVol: every chunk is aligned to volUnit and sums to total', () => {
  const total = 100;
  const unit = 5;
  const v = splitVol(total, 3, unit);
  assert.equal(v.reduce((a, b) => a + b, 0), total);
  for (const x of v) assert.equal(x % unit, 0, `chunk ${x} not aligned to ${unit}`);
  // first chunks floored, last absorbs remainder
  assert.deepEqual(v, [30, 30, 40]);
});

test('splitVol: single chunk returns the whole total', () => {
  assert.deepEqual(splitVol(42, 1, 1), [42]);
});

test('splitVol: unit > 1, floored equal chunks with aligned remainder', () => {
  // total is a multiple of unit (as it always is after sizing): remainder stays aligned
  const v = splitVol(95, 4, 5); // per = floor(95/4/5)*5 = floor(4.75)*5 = 20
  assert.deepEqual(v, [20, 20, 20, 35]);
  assert.equal(v.reduce((a, b) => a + b, 0), 95);
  for (const x of v) assert.equal(x % 5, 0, `chunk ${x} not aligned to 5`);
});
