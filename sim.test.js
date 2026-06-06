'use strict';

// Keep the scheduler's own logging quiet during tests (logger reads env at require time).
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mock } = require('node:test');
const { DateTime } = require('luxon');

const { nextOpenMs, describeNext, scheduleMarketOpen, scheduleAfter } = require('./src/scheduler');

// Helper: build an epoch-ms instant for a wall-clock time IN a given timezone.
function at(iso, tz) {
  const dt = DateTime.fromISO(iso, { zone: tz });
  assert.ok(dt.isValid, `bad test instant ${iso} ${tz}`);
  return dt.toMillis();
}

// Flush pending microtasks (onOpen runs inside Promise.resolve().then(...)).
function flush() {
  return new Promise((r) => setImmediate(r));
}

const cfg = { tz: 'Europe/Warsaw', weekday: 1, hour: 0, minute: 0, leadMs: 5000, repeat: false };

// ── 1. Pure time computation (no waiting, no timers) ─────────────────────────
test('nextOpenMs: picks the next Monday 00:00 in the configured tz', () => {
  // 2025-01-01 is a Wednesday in Europe/Warsaw -> next Monday is 2025-01-06.
  const from = at('2025-01-01T12:00:00', 'Europe/Warsaw');
  const got = describeNext(cfg, from);
  assert.equal(got.iso.slice(0, 19), '2025-01-06T00:00:00');
});

test('nextOpenMs: when the target moment already passed, jumps a full week', () => {
  // It is already Monday 01:00 -> the 00:00 open has passed -> next week.
  const from = at('2025-01-06T01:00:00', 'Europe/Warsaw');
  const got = describeNext(cfg, from);
  assert.equal(got.iso.slice(0, 19), '2025-01-13T00:00:00');
});

test('nextOpenMs: uses the configured tz, not the reference clock', () => {
  const from = at('2025-01-01T12:00:00', 'Europe/Warsaw');
  const tokyo = describeNext({ ...cfg, tz: 'Asia/Tokyo' }, from);
  // Same wall-clock target (Mon 00:00) but anchored to Tokyo -> different instant.
  assert.equal(tokyo.iso.slice(0, 19), '2025-01-06T00:00:00');
  assert.notEqual(tokyo.ms, describeNext(cfg, from).ms);
});

// ── 2. scheduleMarketOpen actually FIRES at fireAt (mocked clock + timers) ────
test('scheduleMarketOpen: fires onOpen leadMs before the open instant', async () => {
  const start = at('2025-01-01T12:00:00', 'Europe/Warsaw'); // Wednesday
  const openMs = nextOpenMs(cfg, start); // Mon 2025-01-06 00:00
  const fireAt = openMs - cfg.leadMs;

  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: start });
  try {
    const calls = [];
    const stop = scheduleMarketOpen(cfg, (next) => calls.push(next));

    // 1ms before fireAt: must NOT have fired yet.
    mock.timers.tick(fireAt - start - 1);
    await flush();
    assert.equal(calls.length, 0, 'fired too early');

    // cross fireAt: must fire exactly once with the correct open instant.
    mock.timers.tick(1);
    await flush();
    assert.equal(calls.length, 1, 'did not fire at fireAt');
    assert.equal(calls[0].ms, openMs);

    stop();
  } finally {
    mock.timers.reset();
  }
});

test('scheduleAfter: fires once after the delay (the TEST_OPEN_AFTER path)', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  try {
    let fired = 0;
    const stop = scheduleAfter(60_000, () => { fired += 1; });

    mock.timers.tick(59_000);
    await flush();
    assert.equal(fired, 0, 'fired before the delay elapsed');

    mock.timers.tick(1_000);
    await flush();
    assert.equal(fired, 1, 'did not fire after the delay');

    stop();
  } finally {
    mock.timers.reset();
  }
});
