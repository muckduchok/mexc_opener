'use strict';

const http = require('http');
const https = require('https');
const axios = require('axios');
const { signWeb, buildHeaders } = require('./sign');

// Shared keep-alive agents so repeated calls (sizing, order submit, stop-loss
// placement, position polling) reuse warm TCP/TLS connections instead of paying
// a fresh handshake each time — this measurably cuts order-placement latency.
const keepAliveHttp = new http.Agent({ keepAlive: true, maxSockets: 64 });
const keepAliveHttps = new https.Agent({ keepAlive: true, maxSockets: 64 });

// MEXC order sides
const SIDE = {
  OPEN_LONG: 1,
  CLOSE_SHORT: 2,
  OPEN_SHORT: 3,
  CLOSE_LONG: 4,
};

// position type
const POSITION_TYPE = { LONG: 1, SHORT: 2 };

// order type
const ORDER_TYPE = { LIMIT: 1, MARKET: 5 };

class MexcRestError extends Error {
  constructor(message, { code, raw, httpStatus } = {}) {
    super(message);
    this.name = 'MexcRestError';
    this.code = code;
    this.raw = raw;
    this.httpStatus = httpStatus;
  }
}

class MexcRest {
  /**
   * @param {object} account  { name, webToken }
   * @param {object} opts      { privateBase, contractBase, timeoutMs }
   */
  constructor(account, opts = {}) {
    this.account = account;
    this.privateBase = opts.privateBase || 'https://futures.mexc.com/api/v1';
    this.contractBase = opts.contractBase || 'https://contract.mexc.com/api/v1';
    this.timeoutMs = opts.timeoutMs || 15000;

    this.http = axios.create({
      timeout: this.timeoutMs,
      httpAgent: keepAliveHttp,
      httpsAgent: keepAliveHttps,
      proxy: false,
      // never throw on non-2xx; we decode the JSON body ourselves
      validateStatus: () => true,
      // do not let axios re-serialize our pre-signed string body
      transformRequest: [(data) => data],
    });
  }

  get name() {
    return this.account.name;
  }

  // ── low-level signed requests ─────────────────────────────────────────────
  async _signedPost(base, endpoint, payload) {
    const { nonce, sign, body } = signWeb(this.account.webToken, payload);
    const headers = buildHeaders(this.account.webToken, nonce, sign);
    const url = `${base}${endpoint}`;
    const res = await this.http.post(url, body, { headers });
    return this._handle(res, `POST ${endpoint}`);
  }

  async _signedGet(base, endpoint, signPayload = {}) {
    const { nonce, sign } = signWeb(this.account.webToken, signPayload);
    const headers = buildHeaders(this.account.webToken, nonce, sign);
    const url = `${base}${endpoint}`;
    const res = await this.http.get(url, { headers });
    return this._handle(res, `GET ${endpoint}`);
  }

  async _publicGet(base, endpoint, params) {
    const url = `${base}${endpoint}`;
    const res = await this.http.get(url, {
      params,
      headers: {
        accept: '*/*',
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      },
    });
    return this._handle(res, `GET ${endpoint}`);
  }

  _handle(res, label) {
    const status = res.status;
    let body = res.data;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch {
        /* leave as string */
      }
    }
    if (status < 200 || status >= 300) {
      throw new MexcRestError(`[${this.name}] ${label} HTTP ${status}: ${JSON.stringify(body)}`, {
        httpStatus: status,
        raw: body,
      });
    }
    if (body && typeof body === 'object' && body.success === false) {
      throw new MexcRestError(
        `[${this.name}] ${label} failed (code ${body.code}): ${body.message || 'unknown'}`,
        { code: body.code, raw: body }
      );
    }
    return body;
  }

  // ── public ─────────────────────────────────────────────────────────────────
  async getContractDetail(symbol) {
    const body = await this._publicGet(this.contractBase, '/contract/detail', { symbol });
    return body && body.data ? body.data : body;
  }

  async getTicker(symbol) {
    const body = await this._publicGet(this.contractBase, '/contract/ticker', { symbol });
    return body && body.data ? body.data : body;
  }

  /**
   * Order book depth. Returns { asks:[[price,vol,orders],...], bids:[...] }.
   * asks ascending (asks[0] = best ask), bids descending (bids[0] = best bid).
   */
  async getDepth(symbol, limit = 20) {
    const body = await this._publicGet(this.contractBase, `/contract/depth/${symbol}`, { limit });
    return body && body.data ? body.data : body;
  }

  // ── account / positions ──────────────────────────────────────────────────────
  async getOpenPositions() {
    const body = await this._signedGet(this.contractBase, '/private/position/open_positions', {});
    return Array.isArray(body.data) ? body.data : [];
  }

  async getPositionById(positionId) {
    const positions = await this.getOpenPositions();
    return positions.find((p) => String(p.positionId) === String(positionId)) || null;
  }

  async getPositionBySymbolSide(symbol, side /* 'long'|'short' */) {
    const positions = await this.getOpenPositions();
    const want = side === 'short' ? POSITION_TYPE.SHORT : POSITION_TYPE.LONG;
    return (
      positions.find((p) => p.symbol === symbol && p.positionType === want && Number(p.holdVol) > 0) ||
      null
    );
  }

  // ── trading ────────────────────────────────────────────────────────────────
  /**
   * Open a market position.
   * @param {object} p { symbol, side, vol, leverage, openType, positionMode }
   *   side: SIDE.OPEN_LONG | SIDE.OPEN_SHORT
   */
  async submitMarketOpen({ symbol, side, vol, leverage, openType = 1, positionMode = 1 }) {
    const payload = {
      symbol,
      side,
      openType,
      type: ORDER_TYPE.MARKET,
      vol,
      leverage,
      price: '0',
      positionMode,
    };
    const body = await this._signedPost(this.privateBase, '/private/order/submit', payload);
    return body.data != null ? body.data : body;
  }

  /**
   * Open a limit position (use a marketable price to fill immediately with a buffer).
   * @param {object} p { symbol, side, vol, leverage, price, openType, positionMode }
   */
  async submitLimitOpen({ symbol, side, vol, leverage, price, openType = 1, positionMode = 1 }) {
    const payload = {
      symbol,
      side,
      openType,
      type: ORDER_TYPE.LIMIT,
      vol,
      leverage,
      price: String(price),
      positionMode,
    };
    const body = await this._signedPost(this.privateBase, '/private/order/submit', payload);
    return body.data != null ? body.data : body;
  }

  /**
   * Cancel specific orders by id.
   * @param {Array<string|number>} orderIds
   */
  async cancelOrders(orderIds) {
    const arr = Array.isArray(orderIds) ? orderIds : [orderIds];
    const body = await this._signedPost(this.privateBase, '/private/order/cancel', arr);
    return body.data != null ? body.data : body;
  }

  /**
   * Cancel all open (resting) orders, optionally scoped to a symbol.
   */
  async cancelAllOpenOrders(symbol) {
    const payload = symbol ? { symbol } : {};
    const body = await this._signedPost(this.privateBase, '/private/order/cancel_all', payload);
    return body.data != null ? body.data : body;
  }

  /**
   * Close an open position at market. Pass `vol` to close only part of it
   * (defaults to the full holdVol).
   * @param {object} position open_positions entry
   */
  async closePositionMarket(position, vol = null) {
    const side =
      position.positionType === POSITION_TYPE.LONG ? SIDE.CLOSE_LONG : SIDE.CLOSE_SHORT;
    const payload = {
      symbol: position.symbol,
      side,
      openType: position.openType,
      type: ORDER_TYPE.MARKET,
      vol: vol != null ? vol : position.holdVol,
      leverage: position.leverage,
      price: '0',
      positionId: position.positionId,
      positionMode: 1,
    };
    const body = await this._signedPost(this.privateBase, '/private/order/submit', payload);
    return body.data || body;
  }

  /**
   * Place a take-profit / stop-loss order tied to an existing position.
   * Endpoint: POST /private/stoporder/place  (rate limit 5/2s)
   * `vol` (the position's contract quantity) is REQUIRED — MEXC returns
   * code 2011 "Order quantity error" without it.
   * @param {object} p { symbol, positionId, vol, stopLossPrice?, takeProfitPrice?, priceProtect? }
   */
  async placeTpSlByPosition({ symbol, positionId, vol, stopLossPrice, takeProfitPrice, priceProtect = '0' }) {
    const payload = { symbol, positionId, priceProtect };
    if (vol != null) payload.vol = Number(vol);
    if (stopLossPrice != null) payload.stopLossPrice = stopLossPrice;
    if (takeProfitPrice != null) payload.takeProfitPrice = takeProfitPrice;
    const body = await this._signedPost(this.privateBase, '/private/stoporder/place', payload);
    return body.data || body;
  }
}

module.exports = { MexcRest, MexcRestError, SIDE, POSITION_TYPE, ORDER_TYPE };
