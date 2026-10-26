'use strict';
// Website: accounts, desktop sign-in, and the security controls. Runs against an in-memory Postgres (PGlite).
//   cd website && npm test
const test = require('node:test');
const assert = require('node:assert');
const { connect } = require('../lib/db');
const { createApp } = require('../server');

let base, server, db;
const ORIGIN = () => base;

test.before(async () => {
  db = await connect({ NODE_ENV: 'test' });
  ({ server } = createApp({ env: { NODE_ENV: 'test', GITHUB_REPO: 'example/none', TRUST_PROXY: '1' }, db }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { server.close(); await db.close(); });

// A tiny cookie-keeping client that behaves like our own pages (same Origin). Each client gets its own
// client IP through X-Forwarded-For so rate limits don't bleed between tests.
let ipSeq = 0;
function client(ip = `10.0.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`) {
  let cookie = '';
  return async (path, { body, method, origin = ORIGIN(), headers = {} } = {}) => {
    const h = { 'x-forwarded-for': ip, ...headers };
    if (cookie) h.cookie = cookie;
    if (body !== undefined) { h['content-type'] = h['content-type'] || 'application/json'; if (origin) h.origin = origin; }
    const r = await fetch(base + path, { method: method || (body !== undefined ? 'POST' : 'GET'), headers: h, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body), redirect: 'manual' });
    const set = r.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0].endsWith('=') ? '' : set.split(';')[0];
    let data = null;
    try { data = await r.clone().json(); } catch { /* not json */ }
    return { status: r.status, data, headers: r.headers, text: () => r.text() };
  };
}

const email = (n) => `user${n}-${Date.now()}@example.com`;
const PASSWORD = 'correct horse battery';

test('pages and security headers', async () => {
  const r = await client()('/');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
  assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  for (const p of ['/login', '/signup', '/account', '/app-login', '/terms', '/privacy']) assert.equal((await client()(p)).status, 200, p);
  assert.equal((await client()('/nope')).status, 404);
  assert.equal((await client()('/api/config')).data.accounts, true);
});

test('static files cannot escape the public folder', async () => {
  for (const p of ['/../server.js', '/..%2fserver.js', '/%2e%2e/package.json', '/css/../../lib/auth.js', '/.env', '/%E0%A4%A']) {
    const r = await client()(p);
    assert.ok([400, 404].includes(r.status), `${p} -> ${r.status}`);
    assert.doesNotMatch(await r.text(), /require\(|"dependencies"/);
  }
});

test('download rejects unknown and prototype platform names', async () => {
  for (const p of ['__proto__', 'constructor', 'linux']) assert.equal((await client()(`/download/${p}`)).status, 404, p);
});

test('sign up, session, sign out, sign in', async () => {
  const c = client();
  const e = email(1);
  let r = await c('/api/signup', { body: { name: 'Ada', email: e, password: PASSWORD } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.match(r.headers.get('set-cookie'), /HttpOnly; SameSite=Lax/);
  assert.equal(r.data.user.email, e);
  assert.equal(r.data.user.password_hash, undefined);
  r = await c('/api/me');
  assert.equal(r.data.user.name, 'Ada');
  r = await c('/api/logout', { body: {} });
  assert.equal((await c('/api/me')).status, 401);
  r = await c('/api/login', { body: { email: e.toUpperCase(), password: PASSWORD } });
  assert.equal(r.status, 200);
  assert.equal((await c('/api/me')).status, 200);
});

test('sign up validation and duplicates', async () => {
  const c = client();
  assert.equal((await c('/api/signup', { body: { name: 'A', email: 'bad', password: PASSWORD } })).status, 400);
  assert.equal((await c('/api/signup', { body: { name: 'A', email: email(2), password: 'short' } })).status, 400);
  const e = email(3);
  assert.equal((await client()('/api/signup', { body: { name: 'A', email: e, password: PASSWORD } })).status, 201);
  assert.equal((await client()('/api/signup', { body: { name: 'B', email: e, password: PASSWORD } })).status, 409);
});

test('wrong password and unknown email give the same answer', async () => {
  const e = email(4);
  await client()('/api/signup', { body: { name: 'A', email: e, password: PASSWORD } });
  const a = await client()('/api/login', { body: { email: e, password: 'wrong password!!' } });
  const b = await client()('/api/login', { body: { email: email(5), password: 'wrong password!!' } });
  assert.equal(a.status, 401); assert.equal(b.status, 401);
  assert.equal(a.data.error, b.data.error);
});

test('account locks after repeated failures', async () => {
  const e = email(6);
  await client()('/api/signup', { body: { name: 'A', email: e, password: PASSWORD } });
  let last;
  for (let i = 0; i < 9; i++) last = await client()('/api/login', { body: { email: e, password: `nope-${i}-xxxxxx` } });
  assert.equal(last.status, 429);
  // Even the right password is refused while locked.
  assert.equal((await client()('/api/login', { body: { email: e, password: PASSWORD } })).status, 429);
});

test('cross-site and malformed requests are refused', async () => {
  const c = client();
  await c('/api/signup', { body: { name: 'A', email: email(7), password: PASSWORD } });
  assert.equal((await c('/api/account/signout-all', { body: {}, origin: 'https://evil.example' })).status, 403);
  assert.equal((await c('/api/account/signout-all', { body: {}, origin: null })).status, 403);
  assert.equal((await c('/api/account/signout-all', { body: {}, headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal((await c('/api/me')).status, 200, 'still signed in after the blocked requests');
  assert.equal((await c('/api/login', { body: 'email=a&password=b', headers: { 'content-type': 'application/x-www-form-urlencoded' } })).status, 415);
  assert.equal((await c('/api/login', { body: '{not json' })).status, 400);
  assert.equal((await c('/api/login', { body: { email: 'x'.repeat(20000), password: 'y' } })).status, 413);
  assert.equal((await c('/api/me', { method: 'DELETE' })).status, 405);
});

test('desktop app sign-in: start, approve in browser, poll once', async () => {
  const app = client();
  const s = (await app('/api/app-login/start', { body: {}, origin: null })).data;
  assert.match(s.userCode, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  assert.equal((await app('/api/app-login/poll', { body: { deviceCode: s.deviceCode }, origin: null })).data.status, 'pending');

  const browser = client();
  assert.equal((await browser('/api/app-login/approve', { body: { userCode: s.userCode } })).status, 401, 'must be signed in to approve');
  await browser('/api/signup', { body: { name: 'Grace', email: email(8), password: PASSWORD } });
  assert.equal((await browser('/api/app-login/approve', { body: { userCode: s.userCode }, origin: 'https://evil.example' })).status, 403);
  assert.equal((await browser('/api/app-login/approve', { body: { userCode: s.userCode.toLowerCase() } })).status, 200);
  assert.equal((await browser('/api/app-login/approve', { body: { userCode: s.userCode } })).status, 404, 'codes are single use');

  const done = (await app('/api/app-login/poll', { body: { deviceCode: s.deviceCode }, origin: null })).data;
  assert.equal(done.status, 'approved');
  assert.equal(done.user.name, 'Grace');
  assert.equal((await app('/api/app-login/poll', { body: { deviceCode: s.deviceCode }, origin: null })).data.status, 'expired', 'token is handed out once');

  const me = await app('/api/me', { headers: { authorization: `Bearer ${done.token}` } });
  assert.equal(me.data.user.name, 'Grace');
  // Bearer requests carry no cookies, so the app can sign out without an Origin header.
  assert.equal((await app('/api/logout', { body: {}, origin: null, headers: { authorization: `Bearer ${done.token}` } })).status, 200);
  assert.equal((await app('/api/me', { headers: { authorization: `Bearer ${done.token}` } })).status, 401);
  assert.equal((await app('/api/app-login/poll', { body: { deviceCode: 'made-up' }, origin: null })).data.status, 'expired');
});

test('password change signs out other sessions; delete removes the account', async () => {
  const e = email(9);
  const a = client(), b = client();
  await a('/api/signup', { body: { name: 'A', email: e, password: PASSWORD } });
  await b('/api/login', { body: { email: e, password: PASSWORD } });
  assert.equal((await a('/api/account/password', { body: { current: 'wrong', password: 'another long password' } })).status, 401);
  assert.equal((await a('/api/account/password', { body: { current: PASSWORD, password: 'another long password' } })).status, 200);
  assert.equal((await a('/api/me')).status, 200, 'this session stays signed in');
  assert.equal((await b('/api/me')).status, 401, 'other session was signed out');
  assert.equal((await a('/api/account/delete', { body: { password: 'nope' } })).status, 401);
  assert.equal((await a('/api/account/delete', { body: { password: 'another long password' } })).status, 200);
  assert.equal((await a('/api/me')).status, 401);
  assert.equal((await client()('/api/login', { body: { email: e, password: 'another long password' } })).status, 401);
});

test('passwords and tokens are never stored in plain text', async () => {
  const c = client();
  const e = email(10);
  await c('/api/signup', { body: { name: 'A', email: e, password: PASSWORD } });
  const u = await db.one('select * from users where email = $1', [e]);
  assert.match(u.password_hash, /^scrypt\$/);
  assert.ok(!u.password_hash.includes(PASSWORD));
  const cookieToken = decodeURIComponent((await c('/api/login', { body: { email: e, password: PASSWORD } })).headers.get('set-cookie').split(';')[0].split('=')[1]);
  const rows = (await db.query('select id from sessions where user_id = $1', [u.id])).rows.map((r) => r.id);
  assert.ok(!rows.includes(cookieToken), 'raw token is not stored');
});

test('sign-up and sign-in are rate limited per IP', async () => {
  const statuses = [];
  for (let i = 0; i < 6; i++) statuses.push((await client('203.0.113.7')('/api/signup', { body: { name: 'R', email: email(100 + i), password: PASSWORD } })).status);
  assert.deepEqual(statuses, [201, 201, 201, 201, 201, 429]);
  const r = await client('203.0.113.7')('/api/signup', { body: { name: 'R', email: email(200), password: PASSWORD } });
  assert.ok(Number(r.headers.get('retry-after')) > 0);
  assert.equal((await client('203.0.113.8')('/api/signup', { body: { name: 'R', email: email(201), password: PASSWORD } })).status, 201, 'other IPs are unaffected');
  const login = [];
  for (let i = 0; i < 21; i++) login.push((await client('203.0.113.9')('/api/login', { body: { email: email(300 + i), password: 'x' } })).status);
  assert.equal(login.at(-1), 429);
});

test('the client IP header is ignored unless behind a trusted proxy', async () => {
  const { server: s2 } = createApp({ env: { NODE_ENV: 'test' }, db });
  await new Promise((r) => s2.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${s2.address().port}/api/signup`;
  const statuses = [];
  for (let i = 0; i < 6; i++) {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${s2.address().port}`, 'x-forwarded-for': `198.51.100.${i}` }, body: JSON.stringify({ name: 'S', email: email(400 + i), password: PASSWORD }) });
    statuses.push(r.status);
  }
  s2.close();
  assert.equal(statuses.at(-1), 429, 'spoofed IPs did not dodge the limit');
});
