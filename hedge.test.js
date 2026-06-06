'use strict';

process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { splitVol } = require('./src/hedge');

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
