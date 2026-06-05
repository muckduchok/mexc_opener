'use strict';

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

const envLevel = (process.env.LOG_LEVEL || 'info').toLowerCase();
const threshold = LEVELS[envLevel] != null ? LEVELS[envLevel] : LEVELS.info;

function ts() {
  return new Date().toISOString();
}

function fmt(level, args) {
  return [`[${ts()}] ${level.toUpperCase()}`, ...args];
}

const logger = {
  error: (...a) => threshold >= LEVELS.error && console.error(...fmt('error', a)),
  warn: (...a) => threshold >= LEVELS.warn && console.warn(...fmt('warn', a)),
  info: (...a) => threshold >= LEVELS.info && console.log(...fmt('info', a)),
  debug: (...a) => threshold >= LEVELS.debug && console.log(...fmt('debug', a)),
};

module.exports = logger;
