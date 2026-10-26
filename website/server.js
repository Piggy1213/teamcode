'use strict';
// TeamCode website. Serves the landing page, accounts, and installers from the latest GitHub release:
// /download/<platform> redirects to a short-lived signed URL, so the repo can stay private and
// downloads never stream through this server. The desktop app's updater and sign-in use it too.
//   env: PORT
//        GITHUB_REPO (owner/name; on Railway defaults to the repo the service deploys from)
//        GITHUB_TOKEN (fine-grained, Contents: read-only; only needed for a private repo)
//        DATABASE_URL (Postgres; accounts are off without it in production)
//        PUBLIC_URL (optional, e.g. https://teamcode.example.com; otherwise taken from the request)
//        TEAMCODE_DATA, or a Railway volume (RAILWAY_VOLUME_MOUNT_PATH): where cloud team workspaces are kept.
//        Without one, TeamCode cloud hosting is off. TEAMCODE_MAX_PROJECTS caps projects per account (default 5).
const http = require('http');
const fs = require('fs');
const path = require('path');
const { connect } = require('./lib/db');
const { Accounts } = require('./lib/auth');
const { Workspaces } = require('./lib/workspaces');
const { TeamServer } = require('../server/server');
const { clientIp, RateLimiter, securityHeaders, HttpError, readJson, checkSameOrigin, parseCookies } = require('./lib/security');

const PUBLIC = path.join(__dirname, 'public');
const CACHE_MS = 5 * 60 * 1000;
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8' };
const PAGES = new Set(['login', 'signup', 'account', 'app-login', 'terms', 'privacy']);

// Which release asset each download button serves.
const PLATFORMS = {
  windows: { label: 'Windows (64-bit)', match: (n) => /\.exe$/i.test(n) },
  'mac-arm64': { label: 'macOS (Apple Silicon)', match: (n) => /arm64\.dmg$/i.test(n) },
  'mac-x64': { label: 'macOS (Intel)', match: (n) => /x64\.dmg$/i.test(n) },
};

function teamDataDir(env) {
  if (env.TEAMCODE_DATA) return env.TEAMCODE_DATA;
  if (env.RAILWAY_VOLUME_MOUNT_PATH) return path.join(env.RAILWAY_VOLUME_MOUNT_PATH, 'workspaces');
  return null;
}

function createApp({ env = process.env, db = null } = {}) {
  const railwayRepo = env.RAILWAY_GIT_REPO_OWNER && env.RAILWAY_GIT_REPO_NAME ? `${env.RAILWAY_GIT_REPO_OWNER}/${env.RAILWAY_GIT_REPO_NAME}` : '';
  const REPO = env.GITHUB_REPO || railwayRepo || 'Piggy1213/teamcode';
  const TOKEN = env.GITHUB_TOKEN || '';
  const trustProxy = !!(env.RAILWAY_ENVIRONMENT || env.TRUST_PROXY);
  const publicOrigin = env.PUBLIC_URL ? new URL(env.PUBLIC_URL).origin : '';
  const accounts = db ? new Accounts(db) : null;
  const limiter = new RateLimiter();
  // Cloud workspaces need both a place to keep files (a volume) and accounts to own them.
  const dataDir = teamDataDir(env);
  const team = dataDir && db ? new TeamServer({ dataDir, ownServer: false }) : null;
  const workspaces = team ? new Workspaces({ db, team, maxPerUser: Number(env.TEAMCODE_MAX_PROJECTS) || 5 }) : null;
  // Invites must point at the address people reach this site on.
  const baseUrl = (req, secure) => publicOrigin || `${secure ? 'https' : 'http'}://${(trustProxy && req.headers['x-forwarded-host']) || req.headers.host}`;
  let cache = { at: 0, release: null, error: null };

  const github = (url, init = {}) => fetch(url, {
    ...init,
    headers: { 'user-agent': 'teamcode-website', 'x-github-api-version': '2022-11-28', ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}), ...init.headers },
  });

  async function latestRelease() {
    if (Date.now() - cache.at < CACHE_MS) return cache;
    try {
      const r = await github(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { accept: 'application/vnd.github+json' } });
      // GitHub answers 404 both when there is no release and when the token can't see the repo.
      if (r.status === 404) cache = { at: Date.now(), release: null, error: TOKEN ? `No release found in ${REPO}. Either none is published, or GITHUB_TOKEN can't read that repo.` : `No release found in ${REPO}. If the repo is private, set GITHUB_TOKEN.` };
      else if (!r.ok) cache = { at: Date.now(), release: null, error: `GitHub API returned ${r.status}` };
      else {
        const j = await r.json();
        cache = { at: Date.now(), error: null, release: { version: j.tag_name, name: j.name, publishedAt: j.published_at, notes: j.body || '', assets: j.assets.map((a) => ({ id: a.id, name: a.name, size: a.size, digest: a.digest || null })) } };
      }
    } catch (e) {
      cache = { at: Date.now() - CACHE_MS + 15000, release: null, error: 'Could not reach GitHub' };
      console.error('release lookup failed:', e.message);
    }
    return cache;
  }

  async function handle(req, res) {
    const secure = env.NODE_ENV === 'production' || req.headers['x-forwarded-proto'] === 'https';
    const cookieName = secure ? '__Host-tc_session' : 'tc_session';
    const base = { ...securityHeaders(secure), 'cache-control': 'no-store' };
    const send = (code, body, headers = {}) => { res.writeHead(code, { ...base, ...headers }); res.end(body); };
    const json = (code, obj, headers = {}) => send(code, JSON.stringify(obj), { 'content-type': 'application/json; charset=utf-8', ...headers });
    const ip = clientIp(req, trustProxy);
    const limit = (bucket, n, windowMs, key = ip) => {
      const wait = limiter.take(`${bucket}:${key}`, n, windowMs);
      if (wait) throw new HttpError(429, 'Too many requests. Try again shortly.', { 'retry-after': String(wait) });
    };
    const cookie = (value, maxAge) => `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;

    let raw;
    try { raw = new URL(req.url, 'http://x').pathname; } catch { return send(400, 'Bad request'); }

    // Team workspace traffic (desktop sync, agent hooks and MCP calls). Hooks fire on every agent tool call,
    // so this gets its own, larger budget instead of the site-wide one. The workspace token guards each call.
    if (team && (raw === '/team' || raw.startsWith('/team/'))) {
      limit('team', 3000, 60000);
      return team.handleRequest(req, res, raw.slice(5) || '/');
    }

    if (!['GET', 'HEAD', 'POST'].includes(req.method)) return send(405, 'Method not allowed', { allow: 'GET, HEAD, POST' });
    limit('all', 600, 60000);

    let p;
    try { p = decodeURIComponent(raw); } catch { return send(400, 'Bad request'); }

    if (p === '/health') return send(200, 'ok', { 'content-type': 'text/plain' });

    if (p === '/api/release') {
      limit('release', 120, 60000);
      const { release, error } = await latestRelease();
      const platforms = Object.fromEntries(Object.entries(PLATFORMS).map(([k, v]) => {
        const a = release?.assets.find((x) => v.match(x.name));
        // size and digest ("sha256:<hex>") let the desktop app's updater verify what it downloads.
        return [k, a ? { label: v.label, file: a.name, size: a.size, sizeMb: +(a.size / 1048576).toFixed(1), digest: a.digest } : null];
      }));
      return json(200, { version: release?.version || null, publishedAt: release?.publishedAt || null, notes: (release?.notes || '').slice(0, 2000), platforms, error });
    }

    const dl = p.match(/^\/download\/([a-z0-9-]+)$/);
    if (dl) {
      limit('download', 30, 60000);
      if (!Object.hasOwn(PLATFORMS, dl[1])) return send(404, 'Unknown platform');
      const { release } = await latestRelease();
      const asset = release?.assets.find((a) => PLATFORMS[dl[1]].match(a.name));
      if (!asset) return send(302, '', { location: '/#download' });
      // Ask GitHub for the asset; it answers with a redirect to a signed, short-lived download URL.
      const r = await github(`https://api.github.com/repos/${REPO}/releases/assets/${asset.id}`, { headers: { accept: 'application/octet-stream' }, redirect: 'manual' });
      const location = r.headers.get('location');
      if (!location) return send(502, 'Download is temporarily unavailable. Please try again shortly.');
      return send(302, '', { location });
    }

    if (p.startsWith('/api/')) {
      if (p === '/api/config') return json(200, { accounts: !!accounts, cloud: !!workspaces });
      if (!accounts) throw new HttpError(503, 'Accounts are not set up on this server yet');

      const bearer = /^Bearer (\S+)$/.exec(req.headers.authorization || '')?.[1];
      const sessionToken = bearer || parseCookies(req.headers.cookie)[cookieName];
      const ua = req.headers['user-agent'];
      const auth = async () => {
        const s = await accounts.userForToken(sessionToken);
        if (!s) throw new HttpError(401, 'Sign in to continue');
        return s.user;
      };
      // Cookie-authenticated (browser) writes must come from our own pages.
      const fromBrowser = () => { if (!bearer) checkSameOrigin(req, publicOrigin); };

      if (req.method === 'GET' && p === '/api/me') {
        limit('me', 120, 60000);
        const s = await accounts.userForToken(sessionToken);
        return s ? json(200, { user: { id: s.user.id, email: s.user.email, name: s.user.name } }) : json(401, { error: 'Not signed in' });
      }
      if (req.method === 'GET' && p === '/api/workspaces') {
        if (!workspaces) throw new HttpError(503, 'TeamCode cloud hosting isn\'t set up on this server');
        limit('account', 60, 60000);
        return json(200, { workspaces: await workspaces.list(await auth(), baseUrl(req, secure)) });
      }
      if (req.method === 'GET' && p === '/api/account/sessions') {
        limit('account', 60, 60000);
        return json(200, { sessions: await accounts.sessions(await auth(), sessionToken) });
      }
      if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed');

      if (p === '/api/signup') {
        fromBrowser();
        limit('signup', 5, 60 * 60000);
        const r = await accounts.signup(await readJson(req), ua);
        return json(201, { user: r.user }, { 'set-cookie': cookie(r.session.token, r.session.maxAge) });
      }
      if (p === '/api/login') {
        fromBrowser();
        limit('login', 20, 15 * 60000);
        const body = await readJson(req);
        limit('login-email', 10, 15 * 60000, String(body.email || '').trim().toLowerCase().slice(0, 254));
        const r = await accounts.login(body, ua);
        return json(200, { user: r.user }, { 'set-cookie': cookie(r.session.token, r.session.maxAge) });
      }
      if (p === '/api/logout') {
        fromBrowser();
        if (sessionToken) await accounts.logout(sessionToken);
        return json(200, { ok: true }, bearer ? {} : { 'set-cookie': cookie('', 0) });
      }
      if (p === '/api/account/password') {
        fromBrowser();
        limit('account-write', 10, 15 * 60000);
        await accounts.changePassword(await auth(), await readJson(req), sessionToken);
        return json(200, { ok: true });
      }
      if (p === '/api/account/signout-all') {
        fromBrowser();
        limit('account-write', 10, 15 * 60000);
        await accounts.signOutEverywhere(await auth());
        return json(200, { ok: true }, bearer ? {} : { 'set-cookie': cookie('', 0) });
      }
      if (p === '/api/account/delete') {
        fromBrowser();
        limit('account-write', 10, 15 * 60000);
        await accounts.deleteAccount(await auth(), await readJson(req), workspaces ? (u) => workspaces.removeAllFor(u) : null);
        return json(200, { ok: true }, bearer ? {} : { 'set-cookie': cookie('', 0) });
      }
      if (p === '/api/workspaces' || p === '/api/workspaces/delete') {
        if (!workspaces) throw new HttpError(503, 'TeamCode cloud hosting isn\'t set up on this server');
        fromBrowser();
        if (p === '/api/workspaces') {
          limit('ws-create', 10, 60 * 60000);
          return json(201, await workspaces.create(await auth(), await readJson(req), baseUrl(req, secure)));
        }
        limit('account-write', 10, 15 * 60000);
        await workspaces.remove(await auth(), await readJson(req));
        return json(200, { ok: true });
      }
      // Desktop app sign-in. start and poll come from the app (no cookies involved); approve from the browser.
      if (p === '/api/app-login/start') {
        limit('app-start', 10, 10 * 60000);
        return json(200, await accounts.startAppLogin());
      }
      if (p === '/api/app-login/poll') {
        limit('app-poll', 60, 60000);
        const { deviceCode } = await readJson(req);
        return json(200, await accounts.pollAppLogin(deviceCode, ua));
      }
      if (p === '/api/app-login/approve') {
        fromBrowser();
        limit('app-approve', 20, 15 * 60000);
        const { userCode } = await readJson(req);
        await accounts.approveAppLogin(await auth(), userCode);
        return json(200, { ok: true });
      }
      throw new HttpError(404, 'Not found');
    }

    if (req.method === 'POST') return send(405, 'Method not allowed');

    // Static files. /login serves login.html and so on; anything else unknown is a 404.
    const name = p === '/' ? 'index.html' : PAGES.has(p.slice(1)) ? `${p.slice(1)}.html` : p.slice(1);
    const file = path.resolve(PUBLIC, name);
    const rel = path.relative(PUBLIC, file);
    let stat = null;
    if (!rel.startsWith('..') && !path.isAbsolute(rel) && !rel.split(path.sep).some((s) => s.startsWith('.'))) {
      try { stat = fs.statSync(file); } catch { /* missing */ }
    }
    if (!stat || !stat.isFile()) {
      return send(404, fs.readFileSync(path.join(PUBLIC, '404.html')), { 'content-type': TYPES['.html'] });
    }
    const ext = path.extname(file);
    res.writeHead(200, { ...base, 'content-type': TYPES[ext] || 'application/octet-stream', 'content-length': stat.size, 'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=3600' });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  }

  const server = http.createServer((req, res) => handle(req, res).catch((e) => {
    if (res.headersSent) return res.destroy();
    const known = e instanceof HttpError;
    if (!known) console.error('request failed:', req.method, req.url, e);
    const status = known ? e.status : 500;
    res.writeHead(status, { ...securityHeaders(false), 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8', ...(known ? e.headers : {}) });
    res.end(JSON.stringify({ error: known ? e.message : 'Something went wrong. Try again.' }));
  }));
  // Live team connections (desktop sync) upgrade to WebSocket at /team/ws.
  server.on('upgrade', (req, sock, head) => {
    let raw;
    try { raw = new URL(req.url, 'http://x').pathname; } catch { return sock.destroy(); }
    if (!team || !raw.startsWith('/team/ws')) return sock.destroy();
    if (limiter.take(`team-ws:${clientIp(req, trustProxy)}`, 120, 60000)) return sock.destroy();
    team.handleUpgrade(req, sock, head, raw.slice(5));
  });
  // Drop slow or stalled clients instead of holding sockets open.
  server.headersTimeout = 15000;
  server.requestTimeout = 30000;
  server.keepAliveTimeout = 5000;
  const close = () => Promise.all([new Promise((r) => server.close(() => r())), team?.close()]);
  return { server, REPO, TOKEN, accounts, team, workspaces, close };
}

if (require.main === module) {
  (async () => {
    const PORT = Number(process.env.PORT || 3000);
    let db = null;
    try { db = await connect(); } catch (e) { console.error('database unavailable, accounts are off:', e.message); }
    const { server, REPO, TOKEN, accounts, workspaces } = createApp({ db });
    if (accounts) setInterval(() => accounts.cleanup().catch(() => {}), 60 * 60 * 1000).unref();
    server.listen(PORT, () => {
      console.log(`TeamCode website on :${PORT} (releases from ${REPO}${TOKEN ? '' : ', no GITHUB_TOKEN set'}; accounts ${db ? (process.env.DATABASE_URL ? 'on' : 'on, in-memory database') : 'off'}; cloud hosting ${workspaces ? `on, data in ${teamDataDir(process.env)}` : 'off (attach a volume)'})`);
    });
  })();
}

module.exports = { createApp };
