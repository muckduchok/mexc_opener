'use strict';

/**
 * Read-only diagnostic for the MongoDB (Listings) path.
 *  - connects to Mongo and resolves Listings -> accounts EXACTLY like the bot
 *  - prints each plan, its readiness, and the resolved account's token shape
 *  - performs a LIVE open_positions call per resolved account to verify the
 *    web token actually authenticates (the real "does the cookie work?")
 *
 * Places/closes NOTHING. Run: node scripts/check-listings.js
 */
const config = require('../src/config');
const { Mongo } = require('../src/db/mongo');
const { ListingsWatcher } = require('../src/listings');
const { MexcRest } = require('../src/mexc/rest');

// Describe a token's SHAPE without leaking it (helps spot cookie-vs-token issues).
function describeToken(v) {
  if (v == null) return 'NULL';
  const s = String(v);
  const mask = s.length <= 12 ? '***' : `${s.slice(0, 6)}…${s.slice(-4)}`;
  return [
    `len=${s.length}`,
    `mask=${mask}`,
    `startsWithWEB=${s.startsWith('WEB')}`,
    `needsTrim=${s !== s.trim()}`,
    `hasSpace=${/\s/.test(s)}`,
    `hasSemicolon=${s.includes(';')}`,
    `hasEquals=${s.includes('=')}`,
    `hasUidKey=${/u_id/i.test(s)}`,
  ].join(' ');
}

async function main() {
  const cfg = config.load();
  if (!cfg.mongo.url) {
    console.log('DATABASE_URL not set — nothing to check.');
    process.exit(1);
  }
  const mongo = new Mongo({ url: cfg.mongo.url, dbName: cfg.mongo.dbName });
  await mongo.connect();

  const watcher = new ListingsWatcher({
    mongo,
    pollMs: cfg.mongo.pollMs,
    serverNumber: cfg.mongo.serverNumber,
    eventSingle: cfg.mongo.eventSingle,
    eventMulti: cfg.mongo.eventMulti,
    userId: cfg.mongo.userId,
    exchange: cfg.mongo.exchange,
    collections: cfg.mongo.collections,
  });

  const { items, plans } = await watcher.fetch();
  console.log('── listings ─────────────────────────────────────────────');
  console.log(`server=${cfg.mongo.serverNumber != null ? cfg.mongo.serverNumber : 'any'} listings=${items.length} plans=${plans.length}`);
  for (const p of plans) {
    const status = p.ready ? 'READY' : `NOT READY (${p.issues.join('; ')})`;
    console.log(`  ${p.mode} srv=${p.serverNumber} ${p.symbol} margin=${p.margin} lev=${p.leverage} -> ${status}`);
  }

  // unique resolved accounts across all plans
  const accts = new Map();
  for (const p of plans) {
    for (const a of [p.account, p.longAccount, p.shortAccount]) {
      if (a && a.id) accts.set(a.id, a);
    }
  }

  console.log(`\n── resolved accounts: ${accts.size} (live auth test) ─────────`);
  for (const a of accts.values()) {
    console.log(`\n● ${a.label || a.id} (id=${a.id}) exchange=${a.exchange} disabled=${a.disabled} cookieExpired=${a.cookieExpired}`);
    console.log(`  token: ${describeToken(a.webToken)}`);
    if (!a.webToken) {
      console.log('  AUTH SKIP — no token on account');
      continue;
    }
    const client = new MexcRest(
      { name: a.label || a.id, webToken: a.webToken },
      { privateBase: cfg.endpoints.privateBase, contractBase: cfg.endpoints.contractBase, timeoutMs: cfg.runtime.httpTimeoutMs }
    );
    try {
      const pos = await client.getOpenPositions();
      console.log(`  AUTH OK — ${pos.filter((p) => Number(p.holdVol) > 0).length} open position(s)`);
    } catch (e) {
      console.log(`  AUTH FAIL — ${e.message}`);
    }
  }

  await mongo.close();
  console.log('\nDone (read-only).');
  process.exit(0);
}

main().catch((e) => {
  console.error('check-listings failed:', e.message);
  process.exit(1);
});
