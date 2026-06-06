'use strict';

const fs = require('fs');
const { MexcRest } = require('./mexc/rest');
const { PriceFeed } = require('./mexc/ws');
const { ContractCache } = require('./contracts');
const { StateStore } = require('./state');
const { HedgeMonitor, PHASE } = require('./monitor');
const { openHedge } = require('./hedge');
const { scheduleMarketOpen, describeNext, scheduleAfter, humanizeDuration } = require('./scheduler');
const { Mongo } = require('./db/mongo');
const { ListingsWatcher } = require('./listings');
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
    // contract specs are public (/contract/detail needs no auth); reuse any
    // static account's client, or fall back to a token-less public client when
    // accounts come entirely from MongoDB (so config.json can be empty).
    const anyRest =
      this.rest.values().next().value ||
      new MexcRest(
        { name: 'public', webToken: '' },
        {
          privateBase: config.endpoints.privateBase,
          contractBase: config.endpoints.contractBase,
          timeoutMs: config.runtime.httpTimeoutMs,
        }
      );
    this.contracts = new ContractCache(anyRest);
    this.feed = new PriceFeed({
      wsUrl: config.endpoints.wsUrl,
      priceSource: config.priceSource,
    });
    this.state = new StateStore(config.runtime.stateFile);
    this.monitors = new Map(); // runId -> HedgeMonitor
    this.cancelSchedule = null;
    this.mongo = new Mongo({ url: config.mongo.url, dbName: config.mongo.dbName });
    this.listings = new ListingsWatcher({
      mongo: this.mongo,
      pollMs: config.mongo.pollMs,
      serverNumber: config.mongo.serverNumber,
      eventSingle: config.mongo.eventSingle,
      eventMulti: config.mongo.eventMulti,
      userId: config.mongo.userId,
      exchange: config.mongo.exchange,
      collections: config.mongo.collections,
      onListings: (result) => this.onListings(result),
    });
    this.latestListings = { items: [], plans: [] };
    // auth registry so runtime (Listings) accounts can build/rebuild rest clients
    // on demand, e.g. when resuming a persisted run after a restart.
    this.accountAuth = new Map(); // key -> { name, webToken }
    this.getRest = (name) => {
      let r = this.rest.get(name);
      if (r) return r;
      const auth = this.accountAuth.get(name);
      if (auth) {
        r = new MexcRest(auth, {
          privateBase: config.endpoints.privateBase,
          contractBase: config.endpoints.contractBase,
          timeoutMs: config.runtime.httpTimeoutMs,
        });
        this.rest.set(name, r);
        return r;
      }
      throw new Error(`no rest client for account "${name}"`);
    };
  }

  /**
   * Start price feed, preload contract specs and resume persisted runs.
   * Shared by start() and the open-now script.
   */
  async warm() {
    const { config } = this;
    for (const name of Object.keys(config.accounts)) {
      logger.info(`  account ${name} ready`);
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
      const accts =
        g.mode === 'single'
          ? `account=${g.longAccount} (single-account hedge)`
          : `long=${g.longAccount} short=${g.shortAccount}`;
      logger.info(
        `  group ${g.name}: ${g.symbol} mode=${g.mode} ${accts} margin=${g.marginUsdt} lev=${g.leverage} entry=${entry} basis=${g.pctBasis} ` +
          `trigger=+${g.strategy.profitTriggerPct}% lock=+${g.strategy.stopLockPct}% tp2=+${g.strategy.tp2TriggerPct}%/+${g.strategy.tp2Pct}% (${g.pctBasis})`
      );
    }

    if (this.mongo.enabled) {
      logger.info(
        `  hedge groups sourced from MongoDB Listings ` +
          `(server=${config.mongo.serverNumber != null ? config.mongo.serverNumber : 'any'}, ` +
          `events ${config.mongo.eventSingle}/${config.mongo.eventMulti})`
      );
    }

    await this.warm();
    await this.startListings();

    // open immediately, after a test delay, or on the weekly market-open schedule
    if (config.schedule.openImmediately) {
      logger.warn('[manager] OPEN_IMMEDIATELY=true -> opening now');
      await this.openScheduled();
    } else if (config.schedule.testOpenAfterMs != null) {
      const ms = config.schedule.testOpenAfterMs;
      logger.warn(
        `[manager] TEST_OPEN_AFTER="${config.schedule.testOpenAfter}" -> opening once in ` +
          `${humanizeDuration(ms)} (weekly schedule ignored)`
      );
      this.cancelSchedule = scheduleAfter(ms, () => this.openScheduled());
    } else {
      const next = describeNext(config.schedule);
      logger.info(`[manager] scheduled. Next market open: ${next.human}`);
      this.cancelSchedule = scheduleMarketOpen(config.schedule, () => this.openScheduled());
    }
  }

  resumeRuns() {
    const runs = this.state.listRuns().filter((r) => r.phase && r.phase !== PHASE.DONE);
    if (runs.length === 0) return;
    logger.info(`[manager] resuming ${runs.length} active run(s) from state`);
    for (const run of runs) {
      // re-register auth for runtime (Listings) accounts not in the static config
      for (const legKey of ['long', 'short']) {
        const leg = run[legKey];
        if (leg && leg.auth && !this.rest.has(leg.account) && !this.accountAuth.has(leg.account)) {
          this.accountAuth.set(leg.account, leg.auth);
        }
      }
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
      // persist auth for runtime accounts so the run can be resumed after restart
      for (const legKey of ['long', 'short']) {
        const auth = run[legKey] && this.accountAuth.get(run[legKey].account);
        if (auth) run[legKey].auth = auth;
      }
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

  // Build (or reuse) a rest client for a runtime (Listings) account, keyed by its
  // Mongo id. Records auth so it can be rebuilt on demand / after restart.
  _ensureRest(acc) {
    const key = acc.id;
    this.accountAuth.set(key, {
      name: acc.label || key,
      webToken: acc.webToken,
    });
    this.getRest(key); // build + cache now
    return key;
  }

  // Convert a READY Listings plan into a hedge group consumable by openHedge.
  // margin/leverage/openType come from the listing; the rest from env defaults.
  _planToGroup(plan) {
    const d = this.config.groupDefaults;
    const longKey = this._ensureRest(plan.longAccount);
    const shortKey = plan.mode === 'single' ? longKey : this._ensureRest(plan.shortAccount);
    const name =
      plan.mode === 'single'
        ? `listing-s${plan.serverNumber}-single-${plan.longAccount.id}`
        : `listing-s${plan.serverNumber}-dual`;
    // single-account hedge must use hedge position mode (both directions on one acct)
    const positionMode = plan.mode === 'single' ? 1 : d.positionMode;
    return {
      name,
      symbol: plan.symbol,
      mode: plan.mode,
      longAccount: longKey,
      shortAccount: shortKey,
      // DB `margin` is the FINAL position value (notional), not collateral:
      // open a position of exactly this size; collateral = notional / leverage.
      notionalUsdt: plan.margin,
      marginUsdt: null,
      leverage: plan.leverage,
      openType: plan.openType != null ? plan.openType : d.openType,
      positionMode,
      volContracts: null,
      orderType: d.orderType,
      limitLevel: d.limitLevel,
      pctBasis: d.pctBasis,
      strategy: { ...this.config.strategyDefaults },
      source: 'listing',
    };
  }

  // ── live config.json snapshot (visibility into what Mongo data we pulled) ─────
  _maskToken(t) {
    if (!t) return null;
    const s = String(t);
    return s.length <= 12 ? '***' : `${s.slice(0, 6)}…${s.slice(-4)}`;
  }

  _accountView(acc) {
    if (!acc) return null;
    return {
      id: acc.id,
      label: acc.label || null,
      exchange: acc.exchange || null,
      webToken: this._maskToken(acc.webToken),
      usable: !!(acc.webToken && !acc.disabled && !acc.cookieExpired),
    };
  }

  // Build a plain, display-only view of a plan: WHAT we pulled from Mongo and
  // exactly HOW it will be used (resolved hedge group params). No side effects.
  _planView(plan) {
    const d = this.config.groupDefaults;
    const view = {
      mode: plan.mode,
      serverNumber: plan.serverNumber != null ? plan.serverNumber : null,
      symbol: plan.symbol,
      margin: plan.margin,
      leverage: plan.leverage,
      openType: plan.openType != null ? plan.openType : d.openType,
      ready: !!plan.ready,
      issues: plan.issues || [],
    };
    if (plan.mode === 'single') {
      view.groupName = `listing-s${plan.serverNumber}-single-${plan.longAccount ? plan.longAccount.id : '?'}`;
      view.account = this._accountView(plan.account);
    } else {
      view.groupName = `listing-s${plan.serverNumber}-dual`;
      view.side = plan.side || null;
      view.longAccount = this._accountView(plan.longAccount);
      view.shortAccount = this._accountView(plan.shortAccount);
    }
    // exactly how this plan is turned into an order (mirrors _planToGroup)
    const lev = plan.leverage;
    view.willUse = {
      // DB `margin` = final position value (notional); collateral = notional/leverage
      sizing: 'margin = final position (notional)',
      notionalUsdt: plan.margin,
      estCollateralUsdt: plan.margin != null && lev > 0 ? Number((plan.margin / lev).toFixed(4)) : null,
      orderType: d.orderType,
      limitLevel: d.limitLevel,
      pctBasis: d.pctBasis,
      positionMode: plan.mode === 'single' ? 1 : d.positionMode,
      strategy: { ...this.config.strategyDefaults },
    };
    return view;
  }

  /**
   * Mirror the current Mongo-sourced listings/plans into config.json under a
   * read-only `_live` key so the user can see what was pulled and how it maps
   * to hedge groups. The loader ignores `_live`, so this never affects startup.
   */
  writeLiveConfig() {
    if (!this.mongo.enabled) return;
    const plans = (this.latestListings && this.latestListings.plans) || [];
    const views = plans.map((p) => this._planView(p));
    const ready = views.filter((v) => v.ready);
    const snapshot = {
      updatedAt: new Date().toISOString(),
      source: 'mongodb',
      serverNumber: this.config.mongo.serverNumber != null ? this.config.mongo.serverNumber : 'any',
      events: { single: this.config.mongo.eventSingle, dual: this.config.mongo.eventMulti },
      counts: {
        listings: (this.latestListings && this.latestListings.items ? this.latestListings.items.length : 0),
        plans: views.length,
        ready: ready.length,
        readySingle: ready.filter((v) => v.mode === 'single').length,
        readyDual: ready.filter((v) => v.mode === 'dual').length,
      },
      lastOpen: this.lastOpen || null,
      plans: views,
    };
    try {
      const raw = JSON.parse(fs.readFileSync(this.config.configPath, 'utf8'));
      raw._live = snapshot;
      fs.writeFileSync(this.config.configPath, `${JSON.stringify(raw, null, 2)}\n`);
      logger.info(
        `[manager] config.json _live updated: ${views.length} plan(s), ${ready.length} ready @ ${snapshot.updatedAt}`
      );
    } catch (e) {
      logger.warn(`[manager] could not write _live snapshot to config.json: ${e.message}`);
    }
  }

  /**
   * Open hedges from the current Listings plans. Re-pulls fresh plans at open
   * time, opens every READY plan, and logs the ones skipped (not ready).
   */
  async openFromListings() {
    if (!this.mongo.enabled) return [];
    let plans = [];
    try {
      const result = await this.listings.fetch();
      this.latestListings = result;
      plans = result.plans || [];
    } catch (e) {
      logger.warn(`[manager] open: fresh listings fetch failed (${e.message}); using cached plans`);
      plans = (this.latestListings && this.latestListings.plans) || [];
    }
    const ready = plans.filter((p) => p.ready);
    for (const p of plans.filter((x) => !x.ready)) {
      logger.warn(`[manager] skip ${p.mode} plan srv=${p.serverNumber} ${p.symbol}: ${p.issues.join('; ')}`);
    }
    if (!ready.length) {
      logger.info('[manager] no ready listing plans to open');
      return [];
    }
    logger.info(`[manager] === LISTINGS OPEN: opening ${ready.length} plan(s) ===`);
    // warm symbols + contracts before sizing/opening
    for (const symbol of new Set(ready.map((p) => p.symbol))) {
      this.feed.subscribe(symbol);
      try {
        await this.contracts.get(symbol);
      } catch (e) {
        logger.warn(`[manager] preload contract ${symbol}: ${e.message}`);
      }
    }
    const groups = ready.map((p) => this._planToGroup(p));
    this.lastOpen = { at: new Date().toISOString(), groups: groups.map((g) => g.name) };
    this.writeLiveConfig();
    return Promise.allSettled(groups.map((g) => this.openGroup(g)));
  }

  /**
   * Market-open entrypoint. When MongoDB is configured, opens from Listings
   * plans; otherwise opens the static config.json groups.
   */
  async openScheduled() {
    if (this.mongo.enabled) {
      if (this.config.groups.length) {
        logger.info(`[manager] mongo-driven: ${this.config.groups.length} static config group(s) are ignored`);
      }
      await this.openFromListings();
    } else {
      await this.openAllGroups();
    }
  }

  /**
   * Connect to MongoDB and begin polling Listings (every config.mongo.pollMs).
   * No-op when DATABASE_URL is not configured.
   */
  async startListings() {
    if (!this.mongo.enabled) {
      logger.info('[manager] listings watcher disabled (no DATABASE_URL)');
      return;
    }
    try {
      await this.listings.start();
    } catch (e) {
      logger.error(`[manager] listings watcher failed to start: ${e.message}`);
    }
  }

  /**
   * Called every poll with the resolved listings + ready-to-open hedge plans.
   * Caches them and warms symbols; the actual open happens at market time
   * (openScheduled -> openFromListings re-pulls fresh plans then).
   */
  onListings(result) {
    this.latestListings = result;
    const plans = result.plans || [];
    const ready = plans.filter((p) => p.ready);
    logger.info(
      `[manager] listings update: ${plans.length} plan(s), ${ready.length} ready ` +
        `(single=${ready.filter((p) => p.mode === 'single').length}, dual=${ready.filter((p) => p.mode === 'dual').length})`
    );
    // keep the price feed + contract cache warm for plan symbols ahead of open
    for (const symbol of new Set(ready.map((p) => p.symbol).filter(Boolean))) {
      this.feed.subscribe(symbol);
      this.contracts.get(symbol).catch((e) => logger.warn(`[manager] preload contract ${symbol}: ${e.message}`));
    }
    // mirror what we pulled (and how it maps to groups) into config.json _live
    this.writeLiveConfig();
  }

  stop() {
    if (this.cancelSchedule) this.cancelSchedule();
    for (const m of this.monitors.values()) m.stop();
    this.listings.stop();
    this.mongo.close().catch(() => {});
    this.feed.stop();
  }
}

module.exports = { Manager };
