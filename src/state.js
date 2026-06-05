'use strict';

const fs = require('fs');
const path = require('path');
const logger = require('./logger');

/**
 * Tiny JSON state store with atomic-ish writes and a Windows EPERM fallback.
 * Holds active hedge runs so the bot can resume after a restart.
 */
class StateStore {
  constructor(filePath) {
    this.filePath = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
    this.data = { runs: {} };
    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
        if (raw && typeof raw === 'object') this.data = { runs: {}, ...raw };
      }
    } catch (e) {
      logger.warn(`[state] failed to load ${this.filePath}: ${e.message}`);
    }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      try {
        fs.renameSync(tmp, this.filePath);
      } catch (e) {
        // Windows can throw EPERM on rename if the target is briefly locked
        fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
        try {
          fs.unlinkSync(tmp);
        } catch {
          /* ignore */
        }
      }
    } catch (e) {
      logger.warn(`[state] failed to save ${this.filePath}: ${e.message}`);
    }
  }

  upsertRun(run) {
    this.data.runs[run.id] = run;
    this.save();
  }

  removeRun(id) {
    delete this.data.runs[id];
    this.save();
  }

  listRuns() {
    return Object.values(this.data.runs);
  }
}

module.exports = { StateStore };
