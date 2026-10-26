'use strict';
// TeamCode cloud: team workspaces hosted inside the website at /team, owned by accounts.
//   cd website && npm test
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const { connect } = require('../lib/db');
const { createApp } = require('../server');

let base, app, db, dataDir;
test.before(async () => {
  db = await connect({ NODE_ENV: 'test' });
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-cloud-'));
  app = createApp({ env: { NODE_ENV: 'test', TEAMCODE_DATA: dataDir, TEAMCODE_MAX_PROJECTS: '2', TRUST_PROXY: '1' }, db });
  // Short request timeout, to prove it doesn't cut long-lived WebSocket connections.
  app.server.requestTimeout = 1500;
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});
test.after(async () => { await app.close(); await db.close(); });

let ipSeq = 0;
async function account(name) {
  let cookie = '';
  const ip = `10.9.0.${++ipSeq}`;
  const call = async (p, body, method) => {
    const headers = { 'x-forwarded-for': ip };
    if (cookie) headers.cookie = cookie;
    if (body !== undefined) { headers['content-type'] = 'application/json'; headers.origin = base; }
    const r = await fetch(base + p, { method: method || (body !== undefined ? 'POST' : 'GET'), headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = r.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    let data = null;
    try { data = await r.json(); } catch { /* none */ }
    return { status: r.status, data };
  };
  const r = await call('/api/signup', { name, email: `${name.toLowerCase()}-${Date.now()}@example.com`, password: 'correct horse battery' });
  assert.equal(r.status, 201);
  return call;
}

function wsJoin(url, workspace, token, user) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url.replace(/^http/, 'ws') + '/ws');
    const timer = setTimeout(() => reject(new Error('no welcome')), 5000);
    ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      if (m.t === 'welcome') { clearTimeout(timer); resolve({ ws, welcome: m }); }
      if (m.t === 'error') { clearTimeout(timer); reject(new Error(m.error)); }
    });
    ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', workspace, token, user })));
    ws.on('error', reject);
  });
}

test('cloud is advertised and the team server answers health checks under /team', async () => {
  assert.equal((await (await fetch(`${base}/api/config`)).json()).cloud, true);
  const h = await (await fetch(`${base}/team/health`)).json();
  assert.equal(h.app, 'teamcode', 'the desktop app checks for this before joining');
  assert.equal(h.workspaces, undefined, 'does not reveal how many workspaces exist');
});

test('an account creates a cloud workspace; teammates connect over WebSocket and agents over HTTP', async () => {
  const ada = await account('Ada');
  const created = await ada('/api/workspaces', { name: 'Track Studio' });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const inv = created.data;
  assert.equal(inv.url, `${base}/team`);
  assert.match(inv.workspace, /^track-studio-[0-9a-f]{8}$/);
  assert.ok(inv.token.length >= 32);
  assert.ok(fs.existsSync(path.join(dataDir, inv.workspace)), 'stored on the volume');

  // Desktop client: live connection, held past the server's request timeout.
  const { ws, welcome } = await wsJoin(inv.url, inv.workspace, inv.token, { id: 'usr_ada', name: 'Ada' });
  assert.ok(welcome.snapshot);
  await new Promise((r) => setTimeout(r, 2500));
  const reply = await new Promise((resolve) => {
    // Events are broadcast before the call's own result arrives; wait for the result.
    ws.on('message', (raw) => { const m = JSON.parse(raw); if (m.t === 'result' && m.id === 1) resolve(m); });
    ws.send(JSON.stringify({ t: 'call', id: 1, op: 'createTask', args: { title: 'From the desktop' } }));
  });
  assert.equal(reply.ok, true, 'connection still works after the request timeout');
  ws.close();

  // Agent hook / MCP server: HTTP with the workspace token.
  const ok = await fetch(`${inv.url}/api/${inv.workspace}/snapshot`, { method: 'POST', headers: { authorization: `Bearer ${inv.token}`, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(ok.status, 200);
  assert.equal(Object.values((await ok.json()).result.tasks)[0].title, 'From the desktop');
  const bad = await fetch(`${inv.url}/api/${inv.workspace}/snapshot`, { method: 'POST', headers: { authorization: 'Bearer nope' }, body: '{}' });
  assert.equal(bad.status, 401);
  await assert.rejects(() => wsJoin(inv.url, inv.workspace, 'wrong', { id: 'x', name: 'X' }), /Invalid workspace token/);

  const list = await ada('/api/workspaces');
  assert.deepEqual(list.data.workspaces.map((w) => w.workspace), [inv.workspace]);
});

test('accounts are required, projects are capped, and only owners can delete', async () => {
  const anon = await fetch(`${base}/api/workspaces`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: '{"name":"x"}' });
  assert.equal(anon.status, 401);
  const bea = await account('Bea');
  const one = await bea('/api/workspaces', { name: 'One' });
  assert.equal((await bea('/api/workspaces', { name: 'Two' })).status, 201);
  const three = await bea('/api/workspaces', { name: 'Three' });
  assert.equal(three.status, 403);
  assert.match(three.data.error, /up to 2 projects/);

  const cal = await account('Cal');
  assert.equal((await cal('/api/workspaces/delete', { id: one.data.workspace })).status, 404, 'not yours');
  assert.equal((await bea('/api/workspaces/delete', { id: one.data.workspace })).status, 200);
  assert.equal(fs.existsSync(path.join(dataDir, one.data.workspace)), false, 'files removed');
  const h = await fetch(`${one.data.url}/api/${one.data.workspace}/snapshot`, { method: 'POST', headers: { authorization: `Bearer ${one.data.token}` }, body: '{}' });
  assert.equal(h.status, 404, 'deleted workspace no longer answers');
});

test('deleting an account removes its cloud workspaces, but only with the right password', async () => {
  const dee = await account('Dee');
  const w = (await dee('/api/workspaces', { name: 'Keep me' })).data;
  assert.equal((await dee('/api/account/delete', { password: 'wrong password!' })).status, 401);
  assert.ok(fs.existsSync(path.join(dataDir, w.workspace)), 'a wrong password changes nothing');
  assert.equal((await dee('/api/account/delete', { password: 'correct horse battery' })).status, 200);
  assert.equal(fs.existsSync(path.join(dataDir, w.workspace)), false);
});

test('without a volume, cloud hosting is off and says so', async () => {
  const off = createApp({ env: { NODE_ENV: 'test' }, db });
  await new Promise((r) => off.server.listen(0, '127.0.0.1', r));
  const u = `http://127.0.0.1:${off.server.address().port}`;
  assert.equal((await (await fetch(`${u}/api/config`)).json()).cloud, false);
  assert.equal((await fetch(`${u}/team/health`)).status, 404);
  await off.close();
});

test('end to end: a folder hosted on TeamCode cloud syncs to a teammate who joins with an empty folder', async () => {
  const { ProjectSession } = require('../../src/main/session');
  const owner = await account('Owen');
  const w = (await owner('/api/workspaces', { name: 'Lapwerks' })).data;

  const mk = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `tc-e2e-${name}-`));
  const ownerDir = mk('owner');
  fs.mkdirSync(path.join(ownerDir, 'src'));
  fs.writeFileSync(path.join(ownerDir, 'src', 'app.js'), 'console.log("hello from the owner");\n');
  fs.writeFileSync(path.join(ownerDir, 'README.md'), '# Lapwerks\n');
  const session = (dir, user) => new ProjectSession({
    project: { root: dir, name: w.name, role: 'member', cloud: true, url: w.url, workspace: w.workspace, token: w.token },
    user, getSettings: () => ({ autoRun: false }), send: () => {}, dataDir: mk(`${user.id}-data`), scripts: {}, notify: () => {},
  });
  const waitFor = async (fn, label, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 100)); } throw new Error(`timed out: ${label}`); };

  const a = session(ownerDir, { id: 'usr_owen', name: 'Owen' });
  await a.start();
  const W = app.team.coordinator.get(w.workspace);
  await waitFor(() => W.state.files['src/app.js'] && W.state.files['README.md'], 'owner files uploaded to the cloud');

  const mateDir = mk('mate');
  const b = session(mateDir, { id: 'usr_mia', name: 'Mia' });
  await b.start();
  await waitFor(() => fs.existsSync(path.join(mateDir, 'src', 'app.js')), 'teammate received the files');
  assert.equal(fs.readFileSync(path.join(mateDir, 'src', 'app.js'), 'utf8'), 'console.log("hello from the owner");\n');

  fs.writeFileSync(path.join(mateDir, 'README.md'), '# Lapwerks\n\nEdited by Mia.\n');
  await waitFor(() => fs.readFileSync(path.join(ownerDir, 'README.md'), 'utf8').includes('Edited by Mia'), 'teammate edit reached the owner');
  await b.stop();
  await a.stop();
});

test('a workspace member cannot reach Object.prototype through file paths, ids or names', async () => {
  const eve = await account('Eve');
  const w = (await eve('/api/workspaces', { name: 'Poison' })).data;
  const call = (op, args) => fetch(`${w.url}/api/${w.workspace}/${op}`, { method: 'POST', headers: { authorization: `Bearer ${w.token}`, 'content-type': 'application/json' }, body: JSON.stringify(args) });
  const attempts = [
    ['registerAgent', { agentId: '__proto__', name: 'x' }],
    ['registerAgent', { agentId: 'agt_ok', name: 'ok' }],
    ['fileEdited', { agentId: 'agt_ok', path: '__proto__', hash: 'h' }],
    ['fileEdited', { agentId: 'agt_ok', path: './constructor', hash: 'h' }],
    ['announceEdit', { agentId: 'agt_ok', paths: ['prototype'] }],
    ['publishContract', { agentId: 'agt_ok', name: '__proto__', content: 'x' }],
    ['updateSettings', { settings: JSON.parse('{"__proto__":{"polluted":true}}') }],
  ];
  for (const [op, args] of attempts) await call(op, args);
  const raw = await fetch(`${w.url}/api/${w.workspace}/updateSettings`, { method: 'POST', headers: { authorization: `Bearer ${w.token}`, 'content-type': 'application/json' }, body: '{"settings":{"__proto__":{"polluted":true}}}' });
  assert.equal(raw.status, 400);
  assert.equal({}.polluted, undefined, 'Object.prototype untouched');
  assert.equal(typeof Object.prototype.agt_ok, 'undefined');
  assert.equal(Object.keys(Object.prototype).length, 0);
  // Ordinary names that merely contain those words still work.
  assert.equal((await call('fileEdited', { agentId: 'agt_ok', path: 'src/constructor/index.js', hash: 'h' })).status, 200);
});

test('the team API checks the token before reading a request body, and idle sockets must say hello', async () => {
  const fin = await account('Finn');
  const w = (await fin('/api/workspaces', { name: 'Gate' })).data;
  const started = Date.now();
  const r = await fetch(`${w.url}/api/${w.workspace}/snapshot`, { method: 'POST', headers: { authorization: 'Bearer wrong', 'content-length': String(50 * 1024 * 1024) }, body: Buffer.alloc(64 * 1024), duplex: 'half' }).catch((e) => ({ status: 'socket-closed', e }));
  assert.ok(r.status === 401 || r.status === 'socket-closed', String(r.status));
  assert.ok(Date.now() - started < 3000, 'answered without waiting for the body');

  const ws = new WebSocket(`${w.url.replace(/^http/, 'ws')}/ws`);
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  const closedAt = await new Promise((res) => ws.on('close', () => res(Date.now())));
  assert.ok(closedAt - started < 15000, 'a socket that never says hello is dropped');
});

test('hosted projects are capped in size and file count', async () => {
  const lim = createApp({ env: { NODE_ENV: 'test', TEAMCODE_DATA: fs.mkdtempSync(path.join(os.tmpdir(), 'tc-lim-')), TEAMCODE_MAX_PROJECT_FILES: '3', TEAMCODE_MAX_PROJECT_MB: '1', TRUST_PROXY: '1' }, db });
  const W = lim.team.coordinator.ensureWorkspace('limits-test', { name: 'L' });
  const put = (p, bytes) => W.call('filePut', { path: p, baseVersion: 0, contentB64: Buffer.alloc(bytes, p).toString('base64') }, { user: { id: 'u', name: 'U' } });
  put('a.txt', 10); put('b.txt', 10); put('c.txt', 10);
  assert.throws(() => put('d.txt', 10), /file limit \(3\)/);
  // Updating an existing file is fine until the project's stored bytes would pass 1 MB.
  W.call('filePut', { path: 'a.txt', baseVersion: 1, contentB64: Buffer.alloc(600 * 1024, 1).toString('base64') }, { user: { id: 'u', name: 'U' } });
  assert.throws(() => W.call('filePut', { path: 'a.txt', baseVersion: 2, contentB64: Buffer.alloc(600 * 1024, 2).toString('base64') }, { user: { id: 'u', name: 'U' } }), /storage limit \(1 MB\)/);
  await lim.close();
});

test('parallel project creation cannot exceed the per-account cap', async () => {
  const gus = await account('Gus');
  const results = await Promise.all([1, 2, 3, 4, 5].map((i) => gus('/api/workspaces', { name: `P${i}` })));
  assert.equal(results.filter((r) => r.status === 201).length, 2, results.map((r) => r.status).join(','));
});
