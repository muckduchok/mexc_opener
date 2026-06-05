'use strict';

const { MexcRest } = require('./mexc/rest');
const { PriceFeed } = require('./mexc/ws');
const { ContractCache } = require('./contracts');
const { StateStore } = require('./state');
const { HedgeMonitor, PHASE } = require('./monitor');
const { openHedge } = require('./hedge');
const { scheduleMarketOpen, describeNext } = require('./scheduler');
const { describeProxy } = require('./proxy');
const logger = require('./logger');

class Manager {
  constructor(config) {
    this.config = config;
    this.rest = new Map(); // accountName -> MexcRest
    for (const name of Object.keys(config.accounts)) {
      this.rest.set(name, new MexcRest(config.accounts[name], {
        privateBase: config.endpoints.privateBase,
        contractBase: config.endpoints.contractBase,
        timeoutMs: config.runtime.httpTimeoutMs,
      }));
    }
    // contract specs are public; use any account's client
    const anyRest = this.rest.values().next().value;
    this.contracts = new ContractCache(anyRest);
    this.feed = new PriceFeed({
      wsUrl: config.endpoints.wsUrl,
      proxy: config.endpoints.wsProxy,
      priceSource: config.priceSource,
    });
    this.state = new StateStore(config.runtime.stateFile);
    this.monitors = new Map(); // runId -> HedgeMonitor
    this.cancelSchedule = null;
    this.getRest = (name) => {
      const r = this.rest.get(name);
      if (!r) throw new Error(`no rest client for account "${name}"`);
      return r;
    };
  }

  /**
   * Start price feed, preload contract specs and resume persisted runs.
   * Shared by start() and the open-now script.
   */
  async warm() {
    const { config } = this;
    for (const name of Object.keys(config.accounts)) {
      logger.info(`  account ${name} -> proxy ${describeProxy(config.accounts[name].proxy)}`);
    }
    const symbols = [...new Set(config.groups.map((g) => g.symbol))];
    this.feed.start();
    for (const s of symbols) {
      this.feed.subscribe(s);
      try {
        await this.contracts.get(s);
      } catch (e) {
        logger.warn(`[manager] could not preload contract ${s}: ${e.message}`);
      }
    }
    this.resumeRuns();
  }

  async start() {
    const { config } = this;
    logger.info('═══ mexc_opener starting ═══');
    logger.info(`  schedule: opening ${config.schedule.leadMs}ms before target time`);
    for (const g of config.groups) {
      const entry = g.orderType === 'limit' ? `limit@L${g.limitLevel}` : 'market';
      logger.info(
        `  group ${g.name}: ${g.symbol} long=${g.longAccount} short=${g.shortAccount} margin=${g.marginUsdt} lev=${g.leverage} entry=${entry} basis=${g.pctBasis} ` +
          `trigger=+${g.strategy.profitTriggerPct}% lock=+${g.strategy.stopLockPct}% tp2=+${g.strategy.tp2Pct}% (${g.pctBasis})`
      );
    }

    await this.warm();

    // schedule market-open, or open immediately for testing
    if (config.schedule.openImmediately) {
      logger.warn('[manager] OPEN_IMMEDIATELY=true -> opening all groups now');
      await this.openAllGroups();
    } else {
      const next = describeNext(config.schedule);
      logger.info(`[manager] scheduled. Next market open: ${next.human}`);
      this.cancelSchedule = scheduleMarketOpen(config.schedule, () => this.openAllGroups());
    }
  }

  resumeRuns() {
    const runs = this.state.listRuns().filter((r) => r.phase && r.phase !== PHASE.DONE);
    if (runs.length === 0) return;
    logger.info(`[manager] resuming ${runs.length} active run(s) from state`);
    for (const run of runs) {
      this.feed.subscribe(run.symbol);
      this._spawnMonitor(run);
    }
  }

  async openAllGroups() {
    logger.info(`[manager] === MARKET OPEN: opening ${this.config.groups.length} group(s) ===`);
    // open all groups concurrently; each group opens its two legs in parallel
    await Promise.allSettled(this.config.groups.map((g) => this.openGroup(g)));
  }

  async openGroup(group) {
    try {
      const run = await openHedge(group, {
        getRest: this.getRest,
        contracts: this.contracts,
        feed: this.feed,
      });
      this.state.upsertRun(run);
      this._spawnMonitor(run);
      return run;
    } catch (e) {
      logger.error(`[manager] openGroup ${group.name} failed: ${e.message}`);
      return null;
    }
  }

  _spawnMonitor(run) {
    if (this.monitors.has(run.id)) return this.monitors.get(run.id);
    const monitor = new HedgeMonitor({
      run,
      getRest: this.getRest,
      contracts: this.contracts,
      feed: this.feed,
      state: this.state,
      pollMs: this.config.runtime.positionPollMs,
      onDone: (r) => {
        this.monitors.delete(r.id);
        this.state.removeRun(r.id);
      },
    });
    this.monitors.set(run.id, monitor);
    monitor.start();
    return monitor;
  }

  stop() {
    if (this.cancelSchedule) this.cancelSchedule();
    for (const m of this.monitors.values()) m.stop();
    this.feed.stop();
  }
}

module.exports = { Manager };
