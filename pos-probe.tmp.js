'use strict';

// Throwaway probe: measures real REST latency of open_positions and dumps the
// full position object so we can see whether unrealized PnL / mark price is
// returned directly (i.e. whether "just poll positions" is even viable).
//   MEXC_WEB_TOKEN=WEB... node pos-probe.tmp.js ADA_USDT
require('dotenv').config();
const { MexcRest } = require('./src/mexc/rest');

const SYMBOL = process.argv[2] || 'ADA_USDT';
const N = Number(process.argv[3] || 6);

async function main() {
  const token = process.env.MEXC_WEB_TOKEN;
  if (!token) { console.error('set MEXC_WEB_TOKEN'); process.exit(1); }
  const rest = new MexcRest({ name: 'probe', webToken: token });

  const lats = [];
  let sample = null;
  for (let i = 0; i < N; i++) {
    const t = Date.now();
    const positions = await rest.getOpenPositions();
    const ms = Date.now() - t;
    lats.push(ms);
    if (!sample) sample = positions.find((p) => p.symbol === SYMBOL) || positions[0];
    console.log(`call ${i + 1}: ${ms}ms  (positions=${positions.length})`);
    await new Promise((r) => setTimeout(r, 250));
  }

  const sorted = [...lats].sort((a, b) => a - b);
  const avg = lats.reduce((a, b) => a + b, 0) / lats.length;
  console.log(`\nlatency: min=${sorted[0]}ms median=${sorted[Math.floor(sorted.length / 2)]}ms max=${sorted[sorted.length - 1]}ms avg=${avg.toFixed(0)}ms`);

  console.log('\nfull position object (look for mark/fair price & unrealized pnl):');
  console.log(JSON.stringify(sample, null, 2));
}

main().catch((e) => { console.error('probe failed:', e.message); process.exit(1); });
