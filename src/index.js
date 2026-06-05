'use strict';

const config = require('./config');
const { Manager } = require('./manager');
const logger = require('./logger');

async function main() {
  let cfg;
  try {
    cfg = config.load();
  } catch (e) {
    logger.error(e.message);
    process.exit(1);
    return;
  }

  const manager = new Manager(cfg);

  const shutdown = (sig) => {
    logger.info(`[index] received ${sig}, shutting down (positions & exchange-side SL/TP remain on MEXC)`);
    try {
      manager.stop();
    } catch (e) {
      logger.warn(`[index] stop error: ${e.message}`);
    }
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (r) => logger.error(`[index] unhandledRejection: ${r && r.message ? r.message : r}`));
  process.on('uncaughtException', (e) => logger.error(`[index] uncaughtException: ${e.message}`));

  await manager.start();
}

main();
