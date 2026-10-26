'use strict';
// TeamCode download site. Serves the landing page and hands out installers from the latest
// GitHub release of a (private) repo: /download/<platform> redirects to a short-lived signed URL,
// so the code stays private and downloads never stream through this server.
//   env: PORT, GITHUB_REPO (owner/name), GITHUB_TOKEN (fine-grained, Contents: read-only; only needed for a private repo)
//   On Railway, GITHUB_REPO defaults to the repo the service deploys from.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 3000);
const RAILWAY_REPO = process.env.RAILWAY_GIT_REPO_OWNER && process.env.RAILWAY_GIT_REPO_NAME ? `${process.env.RAILWAY_GIT_REPO_OWNER}/${process.env.RAILWAY_GIT_REPO_NAME}` : '';
const REPO = process.env.GITHUB_REPO || RAILWAY_REPO || 'lbakes111/teamcode';
const TOKEN = process.env.GITHUB_TOKEN || '';
const PUBLIC = path.join(__dirname, 'public');
const CACHE_MS = 5 * 60 * 1000;

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json' };

// Which release asset each download button serves.
const PLATFORMS = {
  windows: { label: 'Windows (64-bit)', match: (n) => /\.exe$/i.test(n) },
  'mac-arm64': { label: 'macOS (Apple Silicon)', match: (n) => /arm64\.dmg$/i.test(n) },
  'mac-x64': { label: 'macOS (Intel)', match: (n) => /x64\.dmg$/i.test(n) },
};

let cache = { at: 0, release: null, error: null };

async function github(url, init = {}) {
  return fetch(url, {
    ...init,
    headers: { 'user-agent': 'teamcode-website', 'x-github-api-version': '2022-11-28', ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}), ...init.headers },
  });
}

async function latestRelease() {
  if (Date.now() - cache.at < CACHE_MS) return cache;
  try {
    const r = await github(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { accept: 'application/vnd.github+json' } });
    if (r.status === 404) cache = { at: Date.now(), release: null, error: TOKEN ? 'No release published yet' : 'No release published yet, or the repo is private and GITHUB_TOKEN is not set' };
    else if (!r.ok) cache = { at: Date.now(), release: null, error: `GitHub API returned ${r.status}` };
    else {
      const j = await r.json();
      cache = { at: Date.now(), error: null, release: { version: j.tag_name, name: j.name, publishedAt: j.published_at, notes: j.body || '', assets: j.assets.map((a) => ({ id: a.id, name: a.name, size: a.size })) } };
    }
  } catch (e) {
    cache = { at: Date.now() - CACHE_MS + 15000, release: null, error: e.message };
  }
  return cache;
}

function send(res, code, body, headers = {}) {
  res.writeHead(code, { 'cache-control': 'no-store', ...headers });
  res.end(body);
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = decodeURIComponent(url.pathname);

  if (p === '/health') return send(res, 200, 'ok');

  if (p === '/api/release') {
    const { release, error } = await latestRelease();
    const platforms = Object.fromEntries(Object.entries(PLATFORMS).map(([k, v]) => {
      const a = release?.assets.find((x) => v.match(x.name));
      return [k, a ? { label: v.label, file: a.name, sizeMb: +(a.size / 1048576).toFixed(1) } : null];
    }));
    return send(res, 200, JSON.stringify({ version: release?.version || null, publishedAt: release?.publishedAt || null, platforms, error }), { 'content-type': 'application/json' });
  }

  const dl = p.match(/^\/download\/([\w-]+)$/);
  if (dl) {
    const plat = PLATFORMS[dl[1]];
    if (!plat) return send(res, 404, 'Unknown platform');
    const { release } = await latestRelease();
    const asset = release?.assets.find((a) => plat.match(a.name));
    if (!asset) return send(res, 302, '', { location: '/#download' });
    // Ask GitHub for the asset; it answers with a redirect to a signed, short-lived download URL.
    const r = await github(`https://api.github.com/repos/${REPO}/releases/assets/${asset.id}`, { headers: { accept: 'application/octet-stream' }, redirect: 'manual' });
    const location = r.headers.get('location');
    if (!location) return send(res, 502, 'Download is temporarily unavailable — please try again shortly.');
    return send(res, 302, '', { location });
  }

  // Static files; unknown paths fall back to the landing page.
  let file = path.normalize(path.join(PUBLIC, p === '/' ? 'index.html' : p));
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(PUBLIC, 'index.html');
  const ext = path.extname(file);
  res.writeHead(200, { 'content-type': TYPES[ext] || 'application/octet-stream', 'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=3600' });
  fs.createReadStream(file).pipe(res);
}

http.createServer((req, res) => handle(req, res).catch((e) => send(res, 500, `Server error: ${e.message}`))).listen(PORT, () => {
  console.log(`TeamCode website on :${PORT} (releases from ${REPO}${TOKEN ? '' : ', no GITHUB_TOKEN set'})`);
});
