'use strict';

const crypto = require('crypto');

function md5(value) {
  return crypto.createHash('md5').update(value, 'utf8').digest('hex');
}

/**
 * MEXC web-token signature (reverse-engineered, used by the browser frontend):
 *   nonce = ms timestamp
 *   g     = md5(token + nonce).slice(7)
 *   sign  = md5(nonce + compactJsonBody + g)
 *
 * The body string MUST be the exact string sent over the wire. For GET/empty
 * requests the browser signs an empty object "{}".
 *
 * Returns { nonce, sign, body } where `body` is the compact JSON string that
 * the caller must send verbatim as the request payload.
 */
function signWeb(token, payloadObj) {
  const nonce = Date.now().toString();
  const body = JSON.stringify(payloadObj == null ? {} : payloadObj);
  const g = md5(token + nonce).slice(7);
  const sign = md5(nonce + body + g);
  return { nonce, sign, body };
}

function buildHeaders(token, nonce, sign) {
  return {
    accept: '*/*',
    'accept-language': 'en-US,en;q=0.9',
    authorization: token,
    'content-type': 'application/json',
    'x-mxc-nonce': nonce,
    'x-mxc-sign': sign,
    'user-agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  };
}

module.exports = { md5, signWeb, buildHeaders };
