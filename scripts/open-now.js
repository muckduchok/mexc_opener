'use strict';

/**
 * Manually open ONE hedge group right now (bypasses the market-open schedule),
 * then keep the monitor running so SL/TP logic is exercised live.
 *
 * Usage:
 *   node scripts/open-now.js               # opens the first enabled group
 *   node scripts/open-now.js silver_pair_1 # opens the named group
 *
 * WARNING: this places REAL market orders on both accounts. Use small size.
 */
const config = require('../src/config');
const { Manager } = require('../src/manager');
const logger = require('../src/logger');

async function main() {
  const cfg = config.load();
  const wanted = process.argv[2];
  const group = wanted ? cfg.groups.find((g) => g.name === wanted) : cfg.groups[0];
  if (!group) {
    logger.error(`group "${wanted || '(first)'}" not found. Available: ${cfg.groups.map((g) => g.name).join(', ')}`);
    process.exit(1);
  }

  const manager = new Manager(cfg);
  const shutdown = (sig) => {
    logger.info(`[open-now] ${sig} — stopping monitors (positions/SL/TP remain on MEXC)`);
    try {
      manager.stop();
    } catch {
      /* ignore */
    }
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await manager.warm();
  logger.warn(`[open-now] opening group "${group.name}" NOW`);
  const run = await manager.openGroup(group);
  if (!run) {
    logger.error('[open-now] open failed — see errors above');
    process.exit(1);
  }
  logger.info('[open-now] opened. Monitor running. Press Ctrl+C to stop the monitor (orders stay on MEXC).');
}

main().catch((e) => {
  logger.error(`open-now failed: ${e.message}`);
  process.exit(1);
});
