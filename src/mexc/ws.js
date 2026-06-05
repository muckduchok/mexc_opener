'use strict';

const EventEmitter = require('events');
const WebSocket = require('ws');
const { buildProxyAgent } = require('../proxy');
const { safeNum } = require('../util');
const logger = require('../logger');

const PING_INTERVAL_MS = 15000;
const MAX_BACKOFF_MS = 30000;

/**
 * Public MEXC contract price feed over WebSocket.
 * One connection, many symbols. Emits:
 *   'price' -> { symbol, price, last, fair, bid, ask, ts }
 *   'open', 'close', 'error'
 */
class PriceFeed extends EventEmitter {
  constructor({ wsUrl, proxy, priceSource = 'last' } = {}) {
    super();
    this.setMaxListeners(0); // many hedge monitors may subscribe to 'price'
    this.wsUrl = wsUrl || 'wss://contract.mexc.com/edge';
    this.proxy = proxy || null;
    this.priceSource = priceSource;
    this.symbols = new Set();
    this.latest = new Map(); // symbol -> { price, last, fair, bid, ask, ts }
    this.ws = null;
    this.pingTimer = null;
    this.backoff = 1000;
    this.stopped = false;
  }

  subscribe(symbol) {
    if (!symbol) return;
    this.symbols.add(symbol);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this._sendSub(symbol);
    }
  }

  getLatest(symbol) {
    return this.latest.get(symbol) || null;
  }

  getPrice(symbol) {
    const l = this.latest.get(symbol);
    return l ? l.price : null;
  }

  start() {
    this.stopped = false;
    this._connect();
  }

  stop() {
    this.stopped = true;
    this._clearPing();
    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
  }

  _connect() {
    const agent = buildProxyAgent(this.proxy);
    const opts = agent ? { agent } : {};
    logger.info(`[ws] connecting to ${this.wsUrl}${this.proxy ? ' (via proxy)' : ''}`);
    const ws = new WebSocket(this.wsUrl, opts);
    this.ws = ws;

    ws.on('open', () => {
      this.backoff = 1000;
      logger.info('[ws] connected');
      for (const s of this.symbols) this._sendSub(s);
      this._startPing();
      this.emit('open');
    });

    ws.on('message', (buf) => this._onMessage(buf));

    ws.on('close', (code) => {
      logger.warn(`[ws] closed (code ${code})`);
      this._clearPing();
      this.emit('close', code);
      this._scheduleReconnect();
    });

    ws.on('error', (err) => {
      logger.warn(`[ws] error: ${err.message}`);
      this.emit('error', err);
      // 'close' will follow and trigger reconnect
    });
  }

  _scheduleReconnect() {
    if (this.stopped) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
    logger.info(`[ws] reconnecting in ${delay}ms`);
    setTimeout(() => {
      if (!this.stopped) this._connect();
    }, delay);
  }

  _sendSub(symbol) {
    this._send({ method: 'sub.ticker', param: { symbol } });
  }

  _send(obj) {
    try {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify(obj));
      }
    } catch (e) {
      logger.warn(`[ws] send failed: ${e.message}`);
    }
  }

  _startPing() {
    this._clearPing();
    this.pingTimer = setInterval(() => this._send({ method: 'ping' }), PING_INTERVAL_MS);
  }

  _clearPing() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  _onMessage(buf) {
    let msg;
    try {
      msg = JSON.parse(buf.toString());
    } catch {
      return;
    }
    const channel = msg.channel;
    if (!channel) return;
    if (channel === 'pong' || channel === 'clientId') return;
    if (channel === 'push.ticker' && msg.data) {
      const d = msg.data;
      const symbol = d.symbol;
      if (!symbol) return;
      const last = safeNum(d.lastPrice, 0);
      const fair = safeNum(d.fairPrice, last);
      const bid = safeNum(d.bid1, 0);
      const ask = safeNum(d.ask1, 0);
      const price = this.priceSource === 'fair' && fair ? fair : last;
      if (!price) return;
      const rec = { symbol, price, last, fair, bid, ask, ts: msg.ts || Date.now() };
      this.latest.set(symbol, rec);
      this.emit('price', rec);
    }
  }
}

module.exports = { PriceFeed };
