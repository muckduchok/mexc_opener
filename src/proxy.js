'use strict';

const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');

/**
 * Normalise a proxy string into a standard URL.
 * Accepts both `scheme://user:pass@host:port` and the provider-style
 * `host:port:user:pass` / `scheme://host:port:user:pass` (e.g. proxyshard).
 */
function normalizeProxyUrl(proxyUrl) {
  let url = String(proxyUrl || '').trim();
  if (!url) return '';
  let scheme = 'http';
  const schemeMatch = url.match(/^([a-z0-9]+):\/\//i);
  if (schemeMatch) {
    scheme = schemeMatch[1].toLowerCase();
    url = url.slice(schemeMatch[0].length);
  }
  // already has credentials (user:pass@host:port) -> keep as-is
  if (url.includes('@')) return `${scheme}://${url}`;
  const parts = url.split(':');
  if (parts.length === 4) {
    // host:port:user:pass -> user:pass@host:port
    const [host, port, user, pass] = parts;
    return `${scheme}://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
  }
  // host:port (no auth) or anything else -> just prefix scheme
  return `${scheme}://${url}`;
}

/**
 * Build an http(s) agent for the given proxy URL.
 * Supports http://, https://, socks://, socks4://, socks5://, socks5h://, and the
 * provider-style host:port:user:pass format.
 * Returns null when no proxy is configured (direct connection).
 */
function buildProxyAgent(proxyUrl) {
  if (!proxyUrl) return null;
  const url = normalizeProxyUrl(proxyUrl);
  if (!url) return null;
  const scheme = (url.split('://')[0] || '').toLowerCase();
  if (scheme.startsWith('socks')) {
    return new SocksProxyAgent(url);
  }
  if (scheme === 'http' || scheme === 'https') {
    return new HttpsProxyAgent(url);
  }
  throw new Error(`Unsupported proxy scheme in "${proxyUrl}" (use http/https/socks5/...)`);
}

/**
 * Strip credentials from a proxy URL for safe logging.
 */
function describeProxy(proxyUrl) {
  if (!proxyUrl) return 'direct';
  try {
    const u = new URL(normalizeProxyUrl(proxyUrl));
    return `${u.protocol}//${u.hostname}:${u.port || ''}`;
  } catch {
    return 'proxy(set)';
  }
}

module.exports = { buildProxyAgent, describeProxy, normalizeProxyUrl };
