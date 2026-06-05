'use strict';

const fs = require('fs');
const path = require('path');
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

// 'roe'/'roi'/'leverage' -> 'roe' (leveraged), anything else normalised lower-case.
function normPctBasis(v) {
  const s = String(v == null ? 'roe' : v).toLowerCase();
  if (s === 'roi' || s === 'leverage' || s === 'leveraged') return 'roe';
  return s;
}

function loadConfigFile(configPath) {
  if (!fs.existsSync(configPath)) {
    fail(
      `config file not found: ${configPath}. Copy config.example.json -> ${path.basename(
        configPath
      )} and fill in your accounts/groups.`
    );
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
    tp2Pct: envNum('TP2_PCT', 0.4),
  };
}

function validateStrategy(s, label) {
  if (!(s.profitTriggerPct > 0)) fail(`${label}: profitTriggerPct must be > 0`);
  if (!(s.stopLockPct > 0)) fail(`${label}: stopLockPct must be > 0`);
  if (s.stopLockPct >= s.profitTriggerPct)
    fail(`${label}: stopLockPct (${s.stopLockPct}) must be < profitTriggerPct (${s.profitTriggerPct})`);
  // tp2TriggerPct is no longer used (TP is armed the instant the winner's SL fills); only tp2Pct matters
  if (!(s.tp2Pct > 0)) fail(`${label}: tp2Pct must be > 0`);
}

function load() {
  const configFile = envStr('CONFIG_FILE', 'config.json');
  const configPath = path.isAbsolute(configFile)
    ? configFile
    : path.resolve(process.cwd(), configFile);
  const raw = loadConfigFile(configPath);

  const strategyDefaults = buildStrategyDefaults();

  // ── accounts ────────────────────────────────────────────────────────────────
  const accounts = {};
  const accObj = raw.accounts || {};
  const accNames = Object.keys(accObj);
  if (accNames.length === 0) fail('no accounts defined in config');
  for (const name of accNames) {
    const a = accObj[name] || {};
    if (!a.webToken || String(a.webToken).startsWith('WEB_PASTE')) {
      fail(`account "${name}": webToken is missing (paste the u_id cookie that starts with "WEB")`);
    }
    accounts[name] = {
      name,
      webToken: String(a.webToken),
      proxy: a.proxy ? String(a.proxy) : null,
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

  // ── groups ────────────────────────────────────────────────────────────────────
  const groups = [];
  const rawGroups = Array.isArray(raw.groups) ? raw.groups : [];
  if (rawGroups.length === 0) fail('no hedge groups defined in config');
  const seenNames = new Set();
  for (let i = 0; i < rawGroups.length; i++) {
    const g = rawGroups[i] || {};
    const name = g.name || `group_${i + 1}`;
    if (seenNames.has(name)) fail(`duplicate group name "${name}"`);
    seenNames.add(name);
    if (g.enabled === false) continue;

    const symbol = g.symbol || 'SILVER_USDT';
    if (!accounts[g.longAccount]) fail(`group "${name}": longAccount "${g.longAccount}" not found in accounts`);
    if (!accounts[g.shortAccount]) fail(`group "${name}": shortAccount "${g.shortAccount}" not found in accounts`);
    if (g.longAccount === g.shortAccount)
      fail(`group "${name}": longAccount and shortAccount must be different accounts`);

    const strategy = { ...strategyDefaults, ...(g.strategy || {}) };
    validateStrategy(strategy, `group "${name}"`);

    const marginUsdt = g.marginUsdt != null ? Number(g.marginUsdt) : defMargin;
    const leverage = g.leverage != null ? Number(g.leverage) : defLeverage;
    const openType = g.openType != null ? Number(g.openType) : defOpenType;
    const positionMode = g.positionMode != null ? Number(g.positionMode) : defPositionMode;
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

    groups.push({
      name,
      symbol,
      longAccount: g.longAccount,
      shortAccount: g.shortAccount,
      marginUsdt,
      leverage,
      openType,
      positionMode,
      volContracts,
      orderType,
      limitLevel,
      pctBasis,
      strategy,
    });
  }
  if (groups.length === 0) fail('all groups are disabled');

  return {
    configPath,
    accounts,
    groups,
    strategyDefaults,
    schedule: {
      tz: envStr('MARKET_OPEN_TZ', 'Etc/UTC'),
      weekday: envNum('MARKET_OPEN_WEEKDAY', 1),
      hour: envNum('MARKET_OPEN_HOUR', 0),
      minute: envNum('MARKET_OPEN_MINUTE', 0),
      leadMs: envNum('OPEN_LEAD_MS', 5000),
      repeat: envBool('MARKET_OPEN_REPEAT', true),
      openImmediately: envBool('OPEN_IMMEDIATELY', false),
    },
    priceSource: envStr('PRICE_SOURCE', 'last'),
    endpoints: {
      privateBase: envStr('MEXC_PRIVATE_BASE', 'https://futures.mexc.com/api/v1'),
      contractBase: envStr('MEXC_CONTRACT_BASE', 'https://contract.mexc.com/api/v1'),
      wsUrl: envStr('MEXC_WS_URL', 'wss://contract.mexc.com/edge'),
      wsProxy: envStr('WS_PROXY', null),
    },
    runtime: {
      positionPollMs: envNum('POSITION_POLL_MS', 3000),
      httpTimeoutMs: envNum('HTTP_TIMEOUT_MS', 15000),
      stateFile: envStr('STATE_FILE', 'data/state.json'),
    },
  };
}

module.exports = { load };
