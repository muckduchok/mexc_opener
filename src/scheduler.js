'use strict';

const { DateTime } = require('luxon');
const logger = require('./logger');

const MAX_TIMEOUT_MS = 2 ** 31 - 1; // setTimeout cap (~24.8 days)

/**
 * Compute the next market-open instant (epoch ms) STRICTLY in the configured
 * timezone, independent of the server's own clock/offset.
 *
 * @param {object} cfg { tz, weekday(1=Mon..7=Sun), hour, minute }
 * @param {number} fromMs reference time (default now)
 */
function nextOpenMs(cfg, fromMs = Date.now()) {
  const { tz, weekday, hour, minute } = cfg;
  const now = DateTime.fromMillis(fromMs, { zone: tz });
  if (!now.isValid) throw new Error(`invalid timezone "${tz}"`);

  // Candidate: today at hh:mm
  let cand = now.set({ hour, minute, second: 0, millisecond: 0 });
  // Move forward to the target weekday (luxon weekday: 1=Mon..7=Sun)
  let dayDiff = (weekday - cand.weekday + 7) % 7;
  cand = cand.plus({ days: dayDiff });
  // If it's already in the past (same weekday but time passed, or exactly now), jump a week
  if (cand.toMillis() <= fromMs) cand = cand.plus({ weeks: 1 });
  return cand.toMillis();
}

function describeNext(cfg, fromMs = Date.now()) {
  const ms = nextOpenMs(cfg, fromMs);
  const dt = DateTime.fromMillis(ms, { zone: cfg.tz });
  return {
    ms,
    iso: dt.toISO(),
    human: `${dt.toFormat('cccc yyyy-LL-dd HH:mm')} ${cfg.tz}`,
    inMs: ms - fromMs,
  };
}

/**
 * Schedule a recurring (or one-shot) callback at the configured market open.
 * Handles the setTimeout 32-bit cap by chaining. Returns a stop() function.
 */
function scheduleMarketOpen(cfg, onOpen) {
  let cancelled = false;
  let timer = null;

  const leadMs = Math.max(0, cfg.leadMs || 0);

  function arm(fromMs = Date.now()) {
    if (cancelled) return;
    const next = describeNext(cfg, fromMs);
    // fire `leadMs` BEFORE the logical open time (e.g. 5s early)
    const fireAt = next.ms - leadMs;
    logger.info(
      `[scheduler] next market open: ${next.human} (in ${(next.inMs / 1000 / 60).toFixed(1)} min); ` +
        `will open ${leadMs}ms early`
    );
    const wait = Math.max(0, fireAt - Date.now());
    const step = Math.min(wait, MAX_TIMEOUT_MS);
    timer = setTimeout(function tick() {
      if (cancelled) return;
      const remaining = fireAt - Date.now();
      if (remaining > 50) {
        // long-wait chaining
        timer = setTimeout(tick, Math.min(remaining, MAX_TIMEOUT_MS));
        return;
      }
      Promise.resolve()
        .then(() => onOpen(next))
        .catch((e) => logger.error(`[scheduler] onOpen error: ${e.message}`))
        .finally(() => {
          // advance past the just-fired open so we schedule the NEXT occurrence,
          // not the same one again (we fired leadMs before it actually elapsed)
          if (cfg.repeat && !cancelled) arm(next.ms + 1000);
          else logger.info('[scheduler] one-shot schedule complete (MARKET_OPEN_REPEAT=false)');
        });
    }, step);
  }

  arm();
  return () => {
    cancelled = true;
    if (timer) clearTimeout(timer);
  };
}

module.exports = { nextOpenMs, describeNext, scheduleMarketOpen };
