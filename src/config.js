'use strict';

const fs = require('fs');
const path = require('path');
const logger = require('./logger');
require('dotenv').config();

function envStr(key, fallback) {
  const v = process.env[key];
  return v == null || v === '' ? fallback : v;
}

function envNum(key, fallback) {
  const v = process.env[key];
  if (v == null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function envBool(key, fallback) {
  const v = process.env[key];
  if (v == null || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

function fail(msg) {
  throw new Error(`[config] ${msg}`);
}

// Parse a human duration like "30m", "1h", "90s", "1h30m", "2d" into milliseconds.
// Supported units: ms, s, m, h, d. A bare number is treated as MINUTES.
// Returns null when empty/invalid.
function parseDuration(str) {
  if (str == null) return null;
  const s = String(str).trim().toLowerCase();
  if (!s) return null;
  const unitMs = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 };
  const re = /(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)/g;
  let total = 0;
  let matched = false;
  let m;
  while ((m = re.exec(s)) !== null) {
    matched = true;
    total += parseFloat(m[1]) * unitMs[m[2]];
  }
  if (matched) return Math.round(total);
  const n = Number(s);
  if (Number.isFinite(n) && n > 0) return Math.round(n * 60000); // bare number = minutes
  return null;
}

// 'roe'/'roi'/'leverage' -> 'roe' (leveraged), anything else normalised lower-case.
function normPctBasis(v) {
  const s = String(v == null ? 'roe' : v).toLowerCase();
  if (s === 'roi' || s === 'leverage' || s === 'leveraged') return 'roe';
  return s;
}

// Hedge layout: 'single' = both legs on ONE account (account must be in hedge
// position mode on MEXC); 'dual' = long/short on two separate accounts (default).
function normHedgeMode(v) {
  const s = String(v == null ? 'dual' : v).toLowerCase();
  if (['single', 'one', 'solo', 'same', 'mono', '1'].includes(s)) return 'single';
  if (['dual', 'two', 'cross', 'split', 'pair', 'multi', '2'].includes(s)) return 'dual';
  return s;
}

// Minimal config skeleton written automatically when no config file exists.
// Accounts and hedge groups are normally sourced from MongoDB (Listings) at
// runtime, so an empty file is enough to start in DB-driven mode. All tunables
// have defaults in .env / code.
const DEFAULT_CONFIG = { accounts: {}, groups: [] };

function loadConfigFile(configPath) {
  if (!fs.existsSync(configPath)) {
    // Auto-create a default config instead of failing: in DB-driven mode the
    // accounts/groups come from MongoDB, so the file only needs to exist.
    try {
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`);
      logger.info(
        `[config] ${path.basename(configPath)} not found — created a default one. ` +
          `Accounts/groups will be pulled from MongoDB (or add them here for static mode).`
      );
    } catch (e) {
      fail(`config file not found and could not be created at ${configPath}: ${e.message}`);
    }
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {
    fail(`failed to parse ${configPath}: ${e.message}`);
  }
  return raw;
}

function buildStrategyDefaults() {
  return {
    profitTriggerPct: envNum('PROFIT_TRIGGER_PCT', 0.4),
    stopLockPct: envNum('STOP_LOCK_PCT', 0.2),
    tp2TriggerPct: envNum('TP2_TRIGGER_PCT', 0.4),
    tp2Pct: envNum('TP2_PCT', 0.2),
  };
}

function validateStrategy(s, label) {
  if (!(s.profitTriggerPct > 0)) fail(`${label}: profitTriggerPct must be > 0`);
  if (!(s.stopLockPct > 0)) fail(`${label}: stopLockPct must be > 0`);
  if (s.stopLockPct >= s.profitTriggerPct)
    fail(`${label}: stopLockPct (${s.stopLockPct}) must be < profitTriggerPct (${s.profitTriggerPct})`);
  if (!(s.tp2TriggerPct > 0)) fail(`${label}: tp2TriggerPct must be > 0`);
  if (!(s.tp2Pct > 0)) fail(`${label}: tp2Pct must be > 0`);
  // 2nd-leg exit is now a profit-locking STOP: it arms at +tp2TriggerPct and
  // locks +tp2Pct, so the locked profit MUST be below the arming level.
  if (s.tp2Pct >= s.tp2TriggerPct)
    fail(`${label}: tp2Pct (${s.tp2Pct}) must be < tp2TriggerPct (${s.tp2TriggerPct}) — it is the profit LOCKED by the 2nd-leg stop`);
}

function load() {
  const configFile = envStr('CONFIG_FILE', 'config.json');
  const configPath = path.isAbsolute(configFile)
    ? configFile
    : path.resolve(process.cwd(), configFile);
  const raw = loadConfigFile(configPath);

  // When MongoDB is wired up, hedge groups come from Listings at runtime, so a
  // static config.json group is optional (the file still defines accounts/tunables).
  const mongoEnabled = !!envStr('DATABASE_URL', null);

  const strategyDefaults = buildStrategyDefaults();
  // Mongo-sourced (Listings) plans inherit these defaults verbatim, so validate
  // them here too — otherwise a bad .env (e.g. TP2_PCT >= TP2_TRIGGER_PCT) would
  // only surface as a rejected stop order at runtime.
  validateStrategy(strategyDefaults, 'env strategy defaults');

  // ── accounts ────────────────────────────────────────────────────────────────
  const accounts = {};
  const accObj = raw.accounts || {};
  const accNames = Object.keys(accObj);
  // In DB-driven mode accounts are resolved from MongoDB (Listings), so an empty
  // accounts block is fine. Only require static accounts when Mongo is disabled.
  if (accNames.length === 0 && !mongoEnabled) {
    fail('no accounts defined in config and DATABASE_URL is not set — add an account to config.json or enable the MongoDB (Listings) source');
  }
  for (const name of accNames) {
    const a = accObj[name] || {};
    if (!a.webToken || String(a.webToken).startsWith('WEB_PASTE')) {
      fail(`account "${name}": webToken is missing (paste the u_id cookie that starts with "WEB")`);
    }
    accounts[name] = {
      name,
      webToken: String(a.webToken),
    };
  }

  // ── defaults for groups ───────────────────────────────────────────────────────
  const defMargin = envNum('DEFAULT_MARGIN_USDT', 50);
  const defLeverage = envNum('DEFAULT_LEVERAGE', 20);
  const defOpenType = envNum('DEFAULT_OPEN_TYPE', 1);
  const defPositionMode = envNum('DEFAULT_POSITION_MODE', 1);
  const defOrderType = (envStr('DEFAULT_ORDER_TYPE', 'limit') || 'limit').toLowerCase();
  const defLimitLevel = envNum('DEFAULT_LIMIT_LEVEL', 3);
  const defPctBasis = normPctBasis(envStr('DEFAULT_PCT_BASIS', 'roe'));
  const defHedgeMode = normHedgeMode(envStr('DEFAULT_HEDGE_MODE', 'dual'));
  // Gradual accumulation: split each leg's target size into this many chunks,
  // submitted over the first half of the open window (1 = single shot).
  const defOpenChunks = envNum('OPEN_CHUNKS', 5);
  // How many seconds BEFORE the target time to begin opening; the position is
  // accumulated over the FIRST HALF of this window. Per-listing override:
  // customFields.secondstoopen.
  const defSecondsToOpen = envNum('DEFAULT_SECONDS_TO_OPEN', 20);
  // When true, place NO stop-losses on either leg. Per-listing override:
  // customFields.without_sl.
  const defWithoutSl = envBool('DEFAULT_WITHOUT_SL', false);

  // ── groups ────────────────────────────────────────────────────────────────────
  const groups = [];
  const rawGroups = Array.isArray(raw.groups) ? raw.groups : [];
  if (rawGroups.length === 0 && !mongoEnabled) fail('no hedge groups defined in config');
  const seenNames = new Set();
  for (let i = 0; i < rawGroups.length; i++) {
    const g = rawGroups[i] || {};
    const name = g.name || `group_${i + 1}`;
    if (seenNames.has(name)) fail(`duplicate group name "${name}"`);
    seenNames.add(name);
    if (g.enabled === false) continue;

    const symbol = g.symbol || 'SILVER_USDT';

    // hedge layout: 'single' = both legs on ONE account (account must be in
    // hedge position mode on MEXC); 'dual' = long/short on two accounts.
    const mode = normHedgeMode(g.mode != null ? g.mode : defHedgeMode);
    if (!['single', 'dual'].includes(mode))
      fail(`group "${name}": mode must be "single" or "dual"`);

    let longAccount;
    let shortAccount;
    if (mode === 'single') {
      const acct = g.account || g.longAccount || g.shortAccount;
      if (!acct) fail(`group "${name}": single-account mode requires "account"`);
      if (!accounts[acct]) fail(`group "${name}": account "${acct}" not found in accounts`);
      longAccount = acct;
      shortAccount = acct;
    } else {
      if (!accounts[g.longAccount]) fail(`group "${name}": longAccount "${g.longAccount}" not found in accounts`);
      if (!accounts[g.shortAccount]) fail(`group "${name}": shortAccount "${g.shortAccount}" not found in accounts`);
      if (g.longAccount === g.shortAccount)
        fail(`group "${name}": dual mode needs two DIFFERENT accounts (use mode "single" to hedge on one account)`);
      longAccount = g.longAccount;
      shortAccount = g.shortAccount;
    }

    const strategy = { ...strategyDefaults, ...(g.strategy || {}) };
    validateStrategy(strategy, `group "${name}"`);

    const marginUsdt = g.marginUsdt != null ? Number(g.marginUsdt) : defMargin;
    const leverage = g.leverage != null ? Number(g.leverage) : defLeverage;
    const openType = g.openType != null ? Number(g.openType) : defOpenType;
    // single-account hedge requires hedge position mode (1) so both directions
    // can be held at once; force it and warn if the config asked for one-way (2).
    let positionMode = g.positionMode != null ? Number(g.positionMode) : defPositionMode;
    if (mode === 'single' && positionMode !== 1) {
      logger.warn(
        `[config] group "${name}": single-account hedge requires hedge position mode; forcing positionMode=1 (was ${positionMode}). Ensure the account is set to Hedge mode on MEXC.`
      );
      positionMode = 1;
    }
    if (!(marginUsdt > 0)) fail(`group "${name}": marginUsdt must be > 0`);
    if (!(leverage >= 1)) fail(`group "${name}": leverage must be >= 1`);
    // optional explicit contract volume override (skips margin->contracts conversion)
    const volContracts = g.volContracts != null ? Number(g.volContracts) : null;

    const orderType = (g.orderType != null ? String(g.orderType) : defOrderType).toLowerCase();
    if (!['market', 'limit'].includes(orderType))
      fail(`group "${name}": orderType must be "market" or "limit"`);
    const limitLevel = g.limitLevel != null ? Number(g.limitLevel) : defLimitLevel;
    if (orderType === 'limit' && !(Number.isInteger(limitLevel) && limitLevel >= 1))
      fail(`group "${name}": limitLevel must be an integer >= 1`);

    // how the strategy percentages are measured: 'roe' (leveraged, matches MEXC's
    // displayed PnL%) or 'price' (raw price movement, no leverage).
    const pctBasis = g.pctBasis != null ? normPctBasis(g.pctBasis) : defPctBasis;
    if (!['roe', 'price'].includes(pctBasis))
      fail(`group "${name}": pctBasis must be "roe" or "price"`);

    const openChunks = g.openChunks != null ? Number(g.openChunks) : defOpenChunks;
    if (!(Number.isInteger(openChunks) && openChunks >= 1))
      fail(`group "${name}": openChunks must be an integer >= 1`);
    const secondsToOpen = g.secondsToOpen != null ? Number(g.secondsToOpen) : defSecondsToOpen;
    if (!(secondsToOpen >= 0)) fail(`group "${name}": secondsToOpen must be >= 0`);
    const withoutSl = g.withoutSl != null ? !!g.withoutSl : defWithoutSl;

    groups.push({
      name,
      symbol,
      mode,
      longAccount,
      shortAccount,
      marginUsdt,
      leverage,
      openType,
      positionMode,
      volContracts,
      orderType,
      limitLevel,
      pctBasis,
      openChunks,
      secondsToOpen,
      withoutSl,
      strategy,
    });
  }
  if (groups.length === 0 && !mongoEnabled) fail('all groups are disabled');

  // TEST helper: open once this long after startup (e.g. "30m", "1h").
  const testOpenAfterRaw = envStr('TEST_OPEN_AFTER', null);
  const testOpenAfterMs = parseDuration(testOpenAfterRaw);
  if (testOpenAfterRaw && testOpenAfterMs == null) {
    logger.warn(
      `[config] TEST_OPEN_AFTER="${testOpenAfterRaw}" is not a valid duration (e.g. 30m, 1h); ignoring`
    );
  }

  return {
    configPath,
    accounts,
    groups,
    strategyDefaults,
    // env-derived defaults applied to runtime (Listings-sourced) hedge groups
    groupDefaults: {
      marginUsdt: defMargin,
      leverage: defLeverage,
      openType: defOpenType,
      positionMode: defPositionMode,
      orderType: defOrderType,
      limitLevel: defLimitLevel,
      pctBasis: defPctBasis,
      hedgeMode: defHedgeMode,
      openChunks: defOpenChunks,
      secondsToOpen: defSecondsToOpen,
      withoutSl: defWithoutSl,
    },
    schedule: {
      tz: envStr('MARKET_OPEN_TZ', 'Europe/Warsaw'),
      weekday: envNum('MARKET_OPEN_WEEKDAY', 1),
      hour: envNum('MARKET_OPEN_HOUR', 0),
      minute: envNum('MARKET_OPEN_MINUTE', 0),
      leadMs: envNum('OPEN_LEAD_MS', 5000),
      repeat: envBool('MARKET_OPEN_REPEAT', true),
      openImmediately: envBool('OPEN_IMMEDIATELY', false),
      // TEST: open ONCE this long after startup (e.g. "30m", "1h"); overrides weekly schedule.
      testOpenAfter: testOpenAfterRaw,
      testOpenAfterMs,
    },
    priceSource: envStr('PRICE_SOURCE', 'last'),
    endpoints: {
      privateBase: envStr('MEXC_PRIVATE_BASE', 'https://futures.mexc.com/api/v1'),
      contractBase: envStr('MEXC_CONTRACT_BASE', 'https://contract.mexc.com/api/v1'),
      wsUrl: envStr('MEXC_WS_URL', 'wss://contract.mexc.com/edge'),
    },
    mongo: {
      // MongoDB connection string (same DB as the main Prisma app). Empty = disabled.
      url: envStr('DATABASE_URL', null),
      // optional DB name override (otherwise taken from the connection string).
      dbName: envStr('MONGO_DB_NAME', null),
      // how often to pull Listings (default 5 minutes).
      pollMs: envNum('LISTINGS_POLL_MS', 5 * 60 * 1000),
      // this server's id, matched against customFields.server_number in Listings.
      // null = no server filter (process every matching listing).
      serverNumber: (() => {
        const v = envStr('SERVER_NUMBER', null);
        if (v == null) return null;
        const n = Number(v);
        return Number.isFinite(n) ? n : v;
      })(),
      // event -> hedge mode mapping.
      eventSingle: envStr('LISTINGS_EVENT_SINGLE', 'silver_onemode'), // -> single-account hedge
      eventMulti: envStr('LISTINGS_EVENT_MULTI', 'silver_multimode'), // -> dual (long+short legs)
      // optional: restrict to a single owner (Listings.userId / Account.userId).
      userId: envStr('LISTINGS_USER_ID', null),
      // only resolve accounts whose exchange matches (case-insensitive). Empty = any.
      exchange: envStr('LISTINGS_EXCHANGE', 'mexc'),
      // Prisma model -> Mongo collection names (no @@map in schema, so identical).
      collections: {
        listings: envStr('MONGO_LISTINGS_COLLECTION', 'Listings'),
        accounts: envStr('MONGO_ACCOUNTS_COLLECTION', 'Account'),
      },
    },
    runtime: {
      positionPollMs: envNum('POSITION_POLL_MS', 3000),
      httpTimeoutMs: envNum('HTTP_TIMEOUT_MS', 15000),
      stateFile: envStr('STATE_FILE', 'data/state.json'),
      // how often (ms) to log live per-account PnL while a hedge is open.
      pnlLogMs: envNum('PNL_LOG_MS', 2000),
    },
  };
}

module.exports = { load, parseDuration };
