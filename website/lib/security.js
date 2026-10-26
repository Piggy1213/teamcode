'use strict';
// Request hardening shared by every route: client IP, rate limits, security headers, JSON bodies, CSRF, cookies.

// Railway (and most hosts) sit behind a proxy that appends the real client IP to X-Forwarded-For.
// Only trust that header when told we're behind one, or anyone could spoof their IP to dodge rate limits.
function clientIp(req, trustProxy) {
  if (trustProxy) {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (xff.length) return xff[xff.length - 1];
  }
  return req.socket.remoteAddress || 'unknown';
}

// Fixed-window counters kept in memory. One instance is enough for this site; limits reset on deploy.
class RateLimiter {
  constructor() {
    this.hits = new Map();
    this.sweep = setInterval(() => {
      const now = Date.now();
      for (const [k, v] of this.hits) if (v.reset <= now) this.hits.delete(k);
    }, 60000);
    this.sweep.unref();
  }

  // Returns 0 when allowed, otherwise the seconds until the caller may retry.
  take(key, limit, windowMs) {
    const now = Date.now();
    let h = this.hits.get(key);
    if (!h || h.reset <= now) { h = { n: 0, reset: now + windowMs }; this.hits.set(key, h); }
    h.n += 1;
    return h.n > limit ? Math.ceil((h.reset - now) / 1000) : 0;
  }
}

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self'",
  "form-action 'self'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join('; ');

function securityHeaders(secure) {
  return {
    'content-security-policy': CSP,
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
    ...(secure ? { 'strict-transport-security': 'max-age=31536000; includeSubDomains' } : {}),
  };
}

class HttpError extends Error {
  constructor(status, message, headers = {}) { super(message); this.status = status; this.headers = headers; }
}

async function readJson(req, maxBytes = 16 * 1024) {
  if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) throw new HttpError(415, 'Send JSON');
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > maxBytes) throw new HttpError(413, 'Request too large');
    chunks.push(c);
  }
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error();
    return v;
  } catch { throw new HttpError(400, 'Invalid JSON'); }
}

// Cookie-authenticated writes must come from our own pages. Browsers send Origin on POST; Sec-Fetch-Site
// covers the rest. Requests carrying a bearer token (the desktop app) are not exposed to CSRF.
function checkSameOrigin(req, publicOrigin) {
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin') throw new HttpError(403, 'Cross-site request blocked');
  const origin = req.headers.origin;
  if (!origin) { if (!site) throw new HttpError(403, 'Missing origin'); return; }
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const ok = (publicOrigin && origin === publicOrigin) || origin === `https://${host}` || origin === `http://${host}`;
  if (!ok) throw new HttpError(403, 'Cross-site request blocked');
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) {
      const k = part.slice(0, i).trim();
      try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* skip malformed */ }
    }
  }
  return out;
}

module.exports = { clientIp, RateLimiter, securityHeaders, HttpError, readJson, checkSameOrigin, parseCookies };
