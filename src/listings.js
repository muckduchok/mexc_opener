'use strict';

const { EventEmitter } = require('events');
const { ObjectId } = require('mongodb');
const logger = require('./logger');

// ── helpers ───────────────────────────────────────────────────────────────────

// customFields is stored as a JSON STRING, e.g.
//   {"leverage":500,"open_type":1,"server_number":1}
function parseCustomFields(v) {
  if (v == null) return {};
  if (typeof v === 'object') return v;
  try {
    const o = JSON.parse(v);
    return o && typeof o === 'object' ? o : {};
  } catch {
    return {};
  }
}

function numOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// numeric compare when both look numeric, else string compare
function sameServer(a, b) {
  if (a == null || b == null) return false;
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na === nb;
  return String(a) === String(b);
}

// derive the MEXC contract symbol from the listing token (SILVER -> SILVER_USDT)
function symbolFromListing(l) {
  const token = String(l.tokenInteract || l.tokenWaiting || '').trim().toUpperCase();
  if (!token) return null;
  return token.includes('_') ? token : `${token}_USDT`;
}

/**
 * MEXC web auth needs ONLY the `u_id` cookie value (the token that starts with
 * "WEB") in the Authorization header. The main app, however, stores the FULL
 * browser cookie string (e.g. "mxc_theme=...; u_id=WEB...; ...") in
 * `Account.cookie`. Extract just the token; pass through a value that is already
 * a bare token. Returns null when no token can be found.
 */
function extractWebToken(cookie) {
  if (cookie == null) return null;
  const s = String(cookie).trim();
  if (!s) return null;
  // already a bare token (no cookie separators / whitespace)
  if (!s.includes(';') && !s.includes('=') && !/\s/.test(s)) return s;
  // parse a "name=value; name2=value2" cookie string and pull out u_id
  for (const part of s.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim().toLowerCase() === 'u_id') {
      const val = part.slice(eq + 1).trim();
      if (val) return val;
    }
  }
  // fallback: grab a WEB... token anywhere in the string
  const m = s.match(/WEB[A-Za-z0-9]+/);
  return m ? m[0] : null;
}

/**
 * Map a raw `Account` document to the fields this bot cares about.
 * MEXC web auth uses the browser `cookie` (u_id) as the token.
 */
function normalizeAccount(doc) {
  if (!doc) return null;
  return {
    id: String(doc._id),
    userId: doc.userId != null ? String(doc.userId) : null,
    exchange: doc.exchange || null,
    label: doc.label || null,
    webToken: extractWebToken(doc.cookie), // MEXC web token (u_id) extracted from the cookie string
    leverage: doc.leverage != null ? Number(doc.leverage) : null,
    margin: doc.margin != null ? doc.margin : null,
    takeProfit: doc.takeProfit != null ? doc.takeProfit : null,
    side: doc.side || null,
    disabled: !!doc.disabled,
    cookieExpired: !!doc.cookieExpired,
    groupId: doc.groupId || null,
    raw: doc,
  };
}

/**
 * Periodically pulls `Listings` (filtered by `event`) from MongoDB and resolves
 * the linked MEXC `Account` for each. Emits `listings` with the resolved items
 * and calls the optional `onListings(items)` callback.
 *
 * Each item: { id, event, mode, userId, accountId, accountLabel, exchange,
 *              side, margin, takeProfit, account, exchangeMismatch, raw }
 */
class ListingsWatcher extends EventEmitter {
  constructor({
    mongo,
    pollMs,
    serverNumber,
    eventSingle,
    eventMulti,
    userId,
    exchange,
    collections,
    onListings,
  } = {}) {
    super();
    this.mongo = mongo;
    this.pollMs = pollMs || 5 * 60 * 1000;
    this.serverNumber = serverNumber != null && serverNumber !== '' ? serverNumber : null;
    this.eventSingle = eventSingle || 'silver_onemode';
    this.eventMulti = eventMulti || 'silver_multimode';
    this.events = [...new Set([this.eventSingle, this.eventMulti])];
    this.modeByEvent = { [this.eventSingle]: 'single', [this.eventMulti]: 'dual' };
    this.userId = userId || null;
    this.exchange = exchange || null;
    this.collections = collections || { listings: 'Listings', accounts: 'Account' };
    this.onListings = typeof onListings === 'function' ? onListings : null;
    this.timer = null;
    this.running = false;
    this.busy = false;
  }

  eventToMode(event) {
    return this.modeByEvent[event] || null;
  }

  async start() {
    if (!this.mongo || !this.mongo.enabled) {
      logger.warn('[listings] DATABASE_URL not set -> listings watcher disabled');
      return false;
    }
    await this.mongo.connect();
    this.running = true;
    logger.info(
      `[listings] watching events [${this.events.join(', ')}]` +
        `${this.serverNumber != null ? ` server=${this.serverNumber}` : ' (no server filter)'}` +
        `${this.userId ? ` userId=${this.userId}` : ''}` +
        `${this.exchange ? ` exchange=${this.exchange}` : ''} every ${Math.round(this.pollMs / 1000)}s`
    );
    await this.poll(); // immediate first pull
    this.timer = setInterval(
      () => this.poll().catch((e) => logger.warn(`[listings] poll failed: ${e.message}`)),
      this.pollMs
    );
    return true;
  }

  stop() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async poll() {
    if (this.busy || !this.running) return { items: [], plans: [] };
    this.busy = true;
    try {
      const result = await this.fetch();
      this._logSummary(result);
      if (this.onListings) await this.onListings(result);
      this.emit('listings', result);
      return result;
    } finally {
      this.busy = false;
    }
  }

  async fetch() {
    const listingsCol = this.mongo.collection(this.collections.listings);
    const accountsCol = this.mongo.collection(this.collections.accounts);

    const query = { event: { $in: this.events } };
    const uid = this._userObjectId();
    if (uid) query.userId = uid;

    let listings = await listingsCol.find(query).toArray();

    // server_number lives inside the customFields JSON string -> filter in JS
    if (this.serverNumber != null) {
      listings = listings.filter((l) =>
        sameServer(parseCustomFields(l.customFields).server_number, this.serverNumber)
      );
    }
    if (!listings.length) return { items: [], plans: [] };

    // resolve all linked accounts in a single query
    const accMap = new Map();
    const accIds = [...new Set(listings.filter((l) => l.accountId).map((l) => String(l.accountId)))];
    const objIds = accIds.filter((s) => ObjectId.isValid(s)).map((s) => new ObjectId(s));
    if (objIds.length) {
      const accFilter = { _id: { $in: objIds } };
      if (uid) accFilter.userId = uid;
      const accDocs = await accountsCol.find(accFilter).toArray();
      for (const a of accDocs) accMap.set(String(a._id), a);
    }

    const wantEx = this.exchange ? String(this.exchange).toLowerCase() : null;
    const items = listings.map((l) => {
      const cf = parseCustomFields(l.customFields);
      const accountId = l.accountId ? String(l.accountId) : null;
      let accDoc = accountId ? accMap.get(accountId) || null : null;
      let exchangeMismatch = false;
      if (accDoc && wantEx && String(accDoc.exchange || '').toLowerCase() !== wantEx) {
        exchangeMismatch = true;
        accDoc = null;
      }
      return {
        id: String(l._id),
        event: l.event,
        mode: this.eventToMode(l.event),
        side: l.side ? String(l.side).toLowerCase() : null,
        userId: l.userId != null ? String(l.userId) : null,
        accountId,
        accountLabel: l.accountLabel || null,
        exchange: l.exchange || null,
        symbol: symbolFromListing(l),
        serverNumber: cf.server_number != null ? cf.server_number : null,
        margin: numOrNull(l.margin), // FINAL position value (notional USDT) per leg, from the listing
        leverage: numOrNull(cf.leverage), // from customFields
        openType: numOrNull(cf.open_type), // 1=isolated, 2=cross, from customFields
        takeProfit: l.takeProfit != null ? l.takeProfit : null,
        customFields: cf,
        account: normalizeAccount(accDoc),
        exchangeMismatch,
        raw: l,
      };
    });

    return { items, plans: this.buildPlans(items) };
  }

  /**
   * Turn enriched listing items into hedge "plans" ready to open:
   *  - single (silver_onemode): one plan per listing (account holds both legs).
   *  - dual (silver_multimode): group by server_number, pair side=long + side=short.
   */
  buildPlans(items) {
    const plans = [];

    for (const it of items.filter((i) => i.mode === 'single')) {
      const p = {
        mode: 'single',
        serverNumber: it.serverNumber,
        symbol: it.symbol,
        margin: it.margin,
        leverage: it.leverage,
        openType: it.openType,
        side: it.side,
        account: it.account,
        longAccount: it.account,
        shortAccount: it.account,
        listings: [it],
        issues: [],
      };
      this._assessPlan(p);
      plans.push(p);
    }

    const byServer = new Map();
    for (const it of items.filter((i) => i.mode === 'dual')) {
      const key = it.serverNumber != null ? String(it.serverNumber) : `__noserver_${it.id}`;
      if (!byServer.has(key)) byServer.set(key, []);
      byServer.get(key).push(it);
    }
    for (const group of byServer.values()) {
      const long = group.find((i) => i.side === 'long') || null;
      const short = group.find((i) => i.side === 'short') || null;
      const canon = long || short || group[0];
      const p = {
        mode: 'dual',
        serverNumber: canon ? canon.serverNumber : null,
        symbol: canon ? canon.symbol : null,
        margin: canon ? canon.margin : null,
        leverage: canon ? canon.leverage : null,
        openType: canon ? canon.openType : null,
        long,
        short,
        longAccount: long ? long.account : null,
        shortAccount: short ? short.account : null,
        listings: group,
        issues: [],
      };
      if (!long) p.issues.push('missing long leg');
      if (!short) p.issues.push('missing short leg');
      if (group.length > 2) p.issues.push(`expected 2 legs, got ${group.length}`);
      this._assessPlan(p);
      plans.push(p);
    }

    return plans;
  }

  // Validate a plan, set p.ready and collect issues (never throws).
  _assessPlan(p) {
    const accountOk = (a) => !!(a && a.webToken && !a.disabled && !a.cookieExpired);
    if (!(p.margin > 0)) p.issues.push('missing/invalid margin');
    if (!(p.leverage > 0)) p.issues.push('missing/invalid leverage');
    if (!p.symbol) p.issues.push('missing symbol');
    if (p.mode === 'single') {
      if (!accountOk(p.account)) p.issues.push('account not usable (token/disabled/expired)');
    } else {
      if (!accountOk(p.longAccount)) p.issues.push('long account not usable');
      if (!accountOk(p.shortAccount)) p.issues.push('short account not usable');
      if (p.longAccount && p.shortAccount && p.longAccount.id === p.shortAccount.id)
        p.issues.push('long and short resolve to the same account');
    }
    p.ready = p.issues.length === 0;
    return p;
  }

  _userObjectId() {
    if (!this.userId) return null;
    if (!ObjectId.isValid(this.userId)) {
      logger.warn(`[listings] LISTINGS_USER_ID "${this.userId}" is not a valid ObjectId; ignoring filter`);
      return null;
    }
    return new ObjectId(this.userId);
  }

  _logSummary(result) {
    const items = result.items || [];
    const plans = result.plans || [];
    const byEvent = items.reduce((acc, it) => {
      acc[it.event] = (acc[it.event] || 0) + 1;
      return acc;
    }, {});
    const counts = Object.entries(byEvent).map(([k, v]) => `${k}=${v}`).join(' ') || 'none';
    logger.info(
      `[listings] server=${this.serverNumber != null ? this.serverNumber : 'any'}: ` +
        `${items.length} listing(s) [${counts}], ${plans.length} plan(s)`
    );
    const label = (a) => (a ? a.label || a.id : '-');
    for (const p of plans) {
      const status = p.ready ? 'READY' : `NOT READY (${p.issues.join('; ')})`;
      const who =
        p.mode === 'single'
          ? `acct=${label(p.account)}`
          : `long=${label(p.longAccount)} short=${label(p.shortAccount)}`;
      logger.info(
        `[listings]   ${p.mode} srv=${p.serverNumber} ${p.symbol} ${who} ` +
          `margin=${p.margin} lev=${p.leverage} openType=${p.openType} -> ${status}`
      );
    }
  }
}

module.exports = {
  ListingsWatcher,
  normalizeAccount,
  extractWebToken,
  parseCustomFields,
  symbolFromListing,
  sameServer,
  numOrNull,
};
