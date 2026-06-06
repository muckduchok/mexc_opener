'use strict';

/**
 * Read-only validation:
 *  - loads config
 *  - fetches public contract detail for each group's symbol
 *  - calls open_positions per account (verifies web token + signing)
 *  - opens the public price WS briefly to confirm a live price
 *  - prints the next scheduled market open
 *
 * Does NOT place or close any orders.
 */
const config = require('../src/config');
const { MexcRest } = require('../src/mexc/rest');
const { PriceFeed } = require('../src/mexc/ws');
const { ContractCache } = require('../src/contracts');
const { describeNext } = require('../src/scheduler');
const { sleep } = require('../src/util');

async function main() {
  const cfg = config.load();
  console.log('── config ───────────────────────────────────────────────');
  console.log(`config file: ${cfg.configPath}`);
  console.log(`accounts: ${Object.keys(cfg.accounts).join(', ')}`);
  console.log(
    `groups: ${cfg.groups
      .map((g) => `${g.name}[${g.mode}:${g.mode === 'single' ? g.longAccount : `${g.longAccount}+${g.shortAccount}`}]`)
      .join(', ')}`
  );
  const next = describeNext(cfg.schedule);
  console.log(`next market open: ${next.human} (in ${(next.inMs / 60000).toFixed(1)} min)`);

  const rest = new Map();
  for (const name of Object.keys(cfg.accounts)) {
    rest.set(name, new MexcRest(cfg.accounts[name], {
      privateBase: cfg.endpoints.privateBase,
      contractBase: cfg.endpoints.contractBase,
      timeoutMs: cfg.runtime.httpTimeoutMs,
    }));
  }

  const anyRest = rest.values().next().value;
  const contracts = new ContractCache(anyRest);

  console.log('\n── contracts (public) ───────────────────────────────────');
  const symbols = [...new Set(cfg.groups.map((g) => g.symbol))];
  for (const s of symbols) {
    try {
      const spec = await contracts.get(s);
      console.log(`  OK  ${s}: size=${spec.contractSize} priceUnit=${spec.priceUnit} volUnit=${spec.volUnit} minVol=${spec.minVol} maxLev=${spec.maxLeverage}`);
    } catch (e) {
      console.log(`  ERR ${s}: ${e.message}`);
    }
  }

  console.log('\n── order book / marketable limit prices ─────────────────');
  for (const g of cfg.groups) {
    if (g.orderType !== 'limit') {
      console.log(`  ${g.name}: orderType=market (no limit price)`);
      continue;
    }
    try {
      const spec = await contracts.get(g.symbol);
      const depth = await anyRest.getDepth(g.symbol, Math.max(20, g.limitLevel));
      const asks = depth.asks || [];
      const bids = depth.bids || [];
      const ai = Math.min(g.limitLevel, asks.length) - 1;
      const bi = Math.min(g.limitLevel, bids.length) - 1;
      const longPrice = contracts.roundPrice(spec, Number(asks[ai][0]), 'ceil');
      const shortPrice = contracts.roundPrice(spec, Number(bids[bi][0]), 'floor');
      console.log(
        `  ${g.name} (${g.symbol}, L${g.limitLevel}): best ask=${asks[0] && asks[0][0]} bid=${bids[0] && bids[0][0]} ` +
          `-> LONG buy @${longPrice}, SHORT sell @${shortPrice}`
      );
    } catch (e) {
      console.log(`  ${g.name}: depth ERR — ${e.message}`);
    }
  }

  console.log('\n── accounts (web token + signing) ──────────────────────');
  for (const [name, client] of rest) {
    process.stdout.write(`  ${name}: `);
    try {
      const positions = await client.getOpenPositions();
      const open = positions.filter((p) => Number(p.holdVol) > 0);
      console.log(`OK — ${open.length} open position(s)`);
      for (const p of open) {
        const side = p.positionType === 1 ? 'LONG' : 'SHORT';
        console.log(`        ${p.symbol} ${side} vol=${p.holdVol} entry=${p.openAvgPrice} lev=${p.leverage} posId=${p.positionId}`);
      }
    } catch (e) {
      console.log(`FAIL — ${e.message}`);
    }
  }

  console.log('\n── price WebSocket ──────────────────────────────────────');
  const feed = new PriceFeed({ wsUrl: cfg.endpoints.wsUrl, priceSource: cfg.priceSource });
  feed.start();
  for (const s of symbols) feed.subscribe(s);
  await sleep(5000);
  for (const s of symbols) {
    const l = feed.getLatest(s);
    console.log(l ? `  OK  ${s}: last=${l.last} fair=${l.fair} bid=${l.bid} ask=${l.ask}` : `  ERR ${s}: no price received (WS blocked?)`);
  }
  feed.stop();

  console.log('\nDone. If accounts show FAIL, refresh the WEB token (u_id cookie).');
  process.exit(0);
}

main().catch((e) => {
  console.error('check failed:', e.message);
  process.exit(1);
});
