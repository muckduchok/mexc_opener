'use strict';

// Throwaway benchmark: compares the CURRENT PnL price source (push.ticker, ~1Hz)
// against the PROPOSED one (push.deal, per-trade) for an OPEN position.
//
// Measures:
//   1. update frequency  (updates/s, mean/median/max gap between ticks) -> speed
//   2. ROE accuracy      (|ROE(last) - ROE(fair)| ; fair = exchange mark price) -> safety
//
// Token is read from env only (never hardcoded):
//   MEXC_WEB_TOKEN=WEB... node pnl-bench.tmp.js ADA_USDT 60
require('dotenv').config();
const WebSocket = require('ws');
const { MexcRest } = require('./src/mexc/rest');

const SYMBOL = process.argv[2] || 'ADA_USDT';
const SECONDS = Number(process.argv[3] || 60);
const TOKEN = process.env.MEXC_WEB_TOKEN;

const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};
const gaps = (ts) => ts.slice(1).map((t, i) => t - ts[i]);

async function main() {
  if (!TOKEN) {
    console.error('Set MEXC_WEB_TOKEN (env). Example: MEXC_WEB_TOKEN=WEB... node pnl-bench.tmp.js ADA_USDT 60');
    process.exit(1);
  }

  const rest = new MexcRest({ name: 'bench', webToken: TOKEN });
  const positions = await rest.getOpenPositions();
  const pos = positions.find((p) => p.symbol === SYMBOL && Number(p.holdVol) > 0);
  if (!pos) {
    console.error(`No open position on ${SYMBOL}. Open symbols: ${positions.map((p) => p.symbol).join(', ') || '(none)'}`);
    process.exit(1);
  }

  const isLong = pos.positionType === 1;
  const entry = Number(pos.holdAvgPrice);
  const lev = Number(pos.leverage);
  const dir = isLong ? 1 : -1;
  // ROE% (return on margin) = priceMove% * leverage. last vs fair cancels everything
  // else, so this isolates exactly the price-source difference we care about.
  const roe = (price) => ((price - entry) / entry) * 100 * lev * dir;

  console.log(`position: ${isLong ? 'LONG' : 'SHORT'} ${SYMBOL} entry=${entry} lev=${lev}x holdVol=${pos.holdVol}`);
  console.log(`collecting ${SECONDS}s from wss://contract.mexc.com/edge ...\n`);

  const tk = { ts: [], last: [], fair: [] };
  const dl = { ts: [], price: [] };
  const devDealVsFair = []; // |ROE(deal.last) - ROE(latest fair)| at each deal tick
  let lastFair = null;
  let lastTkLast = null;
  let lastDeal = null;
  let dumpedTicker = false;
  let dumpedDeal = false;

  const ws = new WebSocket('wss://contract.mexc.com/edge');
  ws.on('open', () => {
    ws.send(JSON.stringify({ method: 'sub.ticker', param: { symbol: SYMBOL } }));
    ws.send(JSON.stringify({ method: 'sub.deal', param: { symbol: SYMBOL } }));
    const ping = setInterval(() => ws.send(JSON.stringify({ method: 'ping' })), 15000);
    ping.unref();
  });
  ws.on('error', (e) => console.error('ws error:', e.message));

  ws.on('message', (buf) => {
    let m;
    try { m = JSON.parse(buf.toString()); } catch { return; }
    const now = Date.now();
    if (m.channel === 'push.ticker' && m.data) {
      if (!dumpedTicker) { console.error('first push.ticker:', JSON.stringify(m.data).slice(0, 200)); dumpedTicker = true; }
      const last = Number(m.data.lastPrice);
      const fair = Number(m.data.fairPrice);
      tk.ts.push(now); tk.last.push(last); tk.fair.push(fair);
      lastFair = fair; lastTkLast = last;
    } else if (m.channel === 'push.deal' && m.data) {
      if (!dumpedDeal) { console.error('first push.deal:', JSON.stringify(m.data).slice(0, 200)); dumpedDeal = true; }
      const d = Array.isArray(m.data) ? m.data[m.data.length - 1] : m.data;
      const p = Number(d.p);
      if (!p) return;
      dl.ts.push(now); dl.price.push(p); lastDeal = p;
      if (lastFair) devDealVsFair.push(Math.abs(roe(p) - roe(lastFair)));
    }
  });

  setTimeout(() => {
    const line = (name, ts) => {
      const g = gaps(ts);
      console.log(
        `${name.padEnd(7)} updates=${String(ts.length).padStart(4)} ` +
          `(${(ts.length / SECONDS).toFixed(1)}/s)  gap mean=${avg(g).toFixed(0)}ms median=${median(g)}ms max=${Math.max(0, ...g)}ms`
      );
    };
    console.log('\n── SPEED (how fresh the price is) ─────────────────────────');
    line('ticker', tk.ts);
    line('deal', dl.ts);

    console.log('\n── ACCURACY (ROE vs exchange fair/mark basis) ─────────────');
    const tkLastVsFair = tk.last.map((l, i) => Math.abs(roe(l) - roe(tk.fair[i])));
    console.log(`ticker.last vs fair: avg=${avg(tkLastVsFair).toFixed(4)}%  max=${Math.max(0, ...tkLastVsFair).toFixed(4)}%`);
    console.log(`deal.last   vs fair: avg=${avg(devDealVsFair).toFixed(4)}%  max=${Math.max(0, ...devDealVsFair).toFixed(4)}%`);

    console.log('\n── FINAL ROE snapshot ─────────────────────────────────────');
    console.log(`deal(last)=${lastDeal != null ? roe(lastDeal).toFixed(3) : 'n/a'}%  ` +
      `ticker.last=${lastTkLast != null ? roe(lastTkLast).toFixed(3) : 'n/a'}%  ` +
      `fair(mark)=${lastFair != null ? roe(lastFair).toFixed(3) : 'n/a'}%`);

    ws.close();
    process.exit(0);
  }, SECONDS * 1000);
}

main().catch((e) => { console.error('bench failed:', e.message); process.exit(1); });
