'use strict';
// Acceptance tests for multi-agent coordination (spec section J). Run with: npm test
// Everything here is real: HTTP/WS server, sync clients on disk, the MCP server and hook processes, and git.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { TeamServer } = require('../server/server');
const { Connection } = require('../src/main/connection');
const { SyncClient } = require('../src/main/sync');
const { ProjectSession } = require('../src/main/session');
const git = require('../src/main/git');

const ROOT = path.join(__dirname, '..');
const HOOK = path.join(ROOT, 'src', 'agent', 'hook.js');
const MCP = path.join(ROOT, 'src', 'agent', 'mcp-server.js');
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `tc-${name}-`));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

async function waitFor(fn, { timeout = 8000, label = 'condition' } = {}) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e; }
    await sleep(60);
  }
  throw new Error(`Timed out waiting for ${label}${last instanceof Error ? `: ${last.message}` : ''}`);
}

let server, port, dataDir, ws, url;
const WS_ID = 'acceptance-ws';

before(async () => {
  dataDir = tmp('server');
  server = new TeamServer({ dataDir });
  port = await server.listen(0, '127.0.0.1');
  url = `http://127.0.0.1:${port}`;
  ws = server.coordinator.ensureWorkspace(WS_ID, { name: 'Acceptance' });
});

after(async () => { await server.close(); });

// ---------- helpers that drive the real agent-side processes ----------
function agentEnv(agent) {
  return {
    ...process.env, TEAMCODE_URL: url, TEAMCODE_WORKSPACE: WS_ID, TEAMCODE_TOKEN: ws.token,
    TEAMCODE_AGENT_ID: agent.id, TEAMCODE_AGENT_NAME: agent.name, TEAMCODE_ROOT: agent.root,
    TEAMCODE_BRANCH: agent.branch || 'main', TEAMCODE_TASK_ID: agent.taskId || '', TEAMCODE_CLIENT: 'Test agent',
  };
}

function hook(agent, payload) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [HOOK], { env: agentEnv(agent) });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('error', reject);
    p.on('close', () => resolve(out.trim() ? JSON.parse(out) : null));
    p.stdin.end(JSON.stringify({ session_id: 's', cwd: agent.root, ...payload }));
  });
}

// Simulate the Claude Code tool lifecycle for one file operation, including hooks.
async function agentRead(agent, rel) {
  return hook(agent, { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: path.join(agent.root, rel) } });
}
async function agentWrite(agent, rel, content) {
  const file = path.join(agent.root, rel);
  const pre = await hook(agent, { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: file, content } });
  if (pre?.hookSpecificOutput?.permissionDecision === 'deny') return { denied: true, reason: pre.hookSpecificOutput.permissionDecisionReason };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  const post = await hook(agent, { hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: file, content } });
  return { denied: false, context: post?.hookSpecificOutput?.additionalContext || '' };
}

class McpClient {
  constructor(agent) {
    this.p = spawn(process.execPath, [MCP], { env: agentEnv(agent) });
    this.pending = new Map();
    this.id = 0;
    let buf = '';
    this.p.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        const m = JSON.parse(line);
        this.pending.get(m.id)?.(m);
      }
    });
  }
  request(method, params) {
    const id = ++this.id;
    return new Promise((resolve) => { this.pending.set(id, resolve); this.p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  }
  async init() { return this.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } }); }
  async tool(name, args = {}) {
    const r = await this.request('tools/call', { name, arguments: args });
    const text = r.result.content[0].text;
    if (r.result.isError) throw new Error(text);
    const jsonPart = text.split('\n\nTeamCode team updates')[0];
    try { return { data: JSON.parse(jsonPart), text }; } catch { return { data: null, text }; }
  }
  kill() { this.p.kill(); }
}

async function desktop(name, root, opts = {}) {
  const conn = new Connection({ url, workspace: WS_ID, token: ws.token, user: { id: `usr_${name}`, name } });
  const sync = new SyncClient({ root, connection: conn, manifestPath: path.join(tmp('manifest'), 'm.json'), ...opts });
  await sync.start();
  const reconciled = new Promise((r) => sync.once('reconciled', r));
  conn.start();
  await reconciled;
  return { conn, sync, root, async close() { await sync.stop(); conn.close(); } };
}

function register(agent) {
  return ws.call('registerAgent', { agentId: agent.id, name: agent.name, client: 'Test agent', taskId: agent.taskId, mode: agent.mode || 'shared', branch: agent.branch || 'main', cwd: agent.root });
}

const read = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');

// ---------- 1 ----------
test('1. two agents edit separate files at the same time and both changes are preserved', async () => {
  const dirA = tmp('a1'), dirB = tmp('b1');
  const A = await desktop('Alice', dirA), B = await desktop('Bob', dirB, { preferRemoteOnFirstSync: true });
  const nova = { id: 'agt_t1_nova', name: 'Nova', root: dirA }, atlas = { id: 'agt_t1_atlas', name: 'Atlas', root: dirB };
  register(nova); register(atlas);
  await Promise.all([agentWrite(nova, 'src/editor.js', 'export const editor = 1;\n'), agentWrite(atlas, 'src/export.js', 'export const exporter = 2;\n')]);
  await waitFor(() => fs.existsSync(path.join(dirA, 'src/export.js')) && fs.existsSync(path.join(dirB, 'src/editor.js')), { label: 'files to sync both ways' });
  assert.equal(read(dirA, 'src/export.js'), 'export const exporter = 2;\n');
  assert.equal(read(dirB, 'src/editor.js'), 'export const editor = 1;\n');
  assert.equal(read(dirA, 'src/editor.js'), 'export const editor = 1;\n');
  // attribution: synced writes are credited to the agents, not the desktop users
  await waitFor(() => ws.state.files['src/editor.js']?.by?.name === 'Nova' && ws.state.files['src/export.js']?.by?.name === 'Atlas', { label: 'agent attribution' });
  await A.close(); await B.close();
});

// ---------- 2 ----------
test('2. an agent discovers another agent\'s change before modifying the same file', async () => {
  const dirA = tmp('a2'), dirB = tmp('b2');
  fs.writeFileSync(path.join(dirA, 'api.js'), 'v1\n');
  const A = await desktop('Alice', dirA), B = await desktop('Bob', dirB, { preferRemoteOnFirstSync: true });
  await waitFor(() => fs.existsSync(path.join(dirB, 'api.js')), { label: 'initial sync' });
  const nova = { id: 'agt_t2_nova', name: 'Nova', root: dirA }, atlas = { id: 'agt_t2_atlas', name: 'Atlas', root: dirB };
  register(nova); register(atlas);
  await agentRead(atlas, 'api.js'); // Atlas has seen v1
  await agentRead(nova, 'api.js');
  await agentWrite(nova, 'api.js', 'v2 from nova\n');
  await waitFor(() => read(dirB, 'api.js') === 'v2 from nova\n', { label: 'change to reach Atlas\'s folder' });

  // Discovery via MCP before editing
  const mcp = new McpClient(atlas);
  await mcp.init();
  const { data: updates } = await mcp.tool('get_updates');
  assert.ok(updates.events.some((e) => e.type === 'file.changed' && e.files.includes('api.js') && e.actor === 'Nova'));
  const { data: checks } = await mcp.tool('check_files', { paths: ['api.js'] });
  assert.equal(checks[0].changedSinceYouRead, true);
  assert.equal(checks[0].lastChangedBy, 'Nova');
  mcp.kill();

  // And the edit guard: writing on top of the stale read is refused until Atlas re-reads.
  const attempt = await agentWrite(atlas, 'api.js', 'v1 + atlas change\n');
  assert.equal(attempt.denied, true);
  assert.match(attempt.reason, /changed by Nova/);
  assert.equal(read(dirB, 'api.js'), 'v2 from nova\n', 'Nova\'s work must not be overwritten');
  await A.close(); await B.close();
});

// ---------- 3 ----------
test('3. two agents modifying the same file: overlap detected, edits merged, real conflicts preserved', async () => {
  const dirA = tmp('a3'), dirB = tmp('b3');
  const base = ['line 1', 'line 2', 'line 3', 'line 4', 'line 5', 'line 6', 'line 7', 'line 8'].join('\n') + '\n';
  fs.writeFileSync(path.join(dirA, 'shared.js'), base);
  const A = await desktop('Alice', dirA), B = await desktop('Bob', dirB, { preferRemoteOnFirstSync: true });
  await waitFor(() => fs.existsSync(path.join(dirB, 'shared.js')), { label: 'initial sync' });
  const nova = { id: 'agt_t3_nova', name: 'Nova', root: dirA }, atlas = { id: 'agt_t3_atlas', name: 'Atlas', root: dirB };
  register(nova); register(atlas);
  await agentRead(nova, 'shared.js'); await agentRead(atlas, 'shared.js');

  // Overlap detection: Nova starts editing, Atlas is warned (and the overlap is published to both).
  const pre1 = await hook(nova, { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(dirA, 'shared.js') } });
  assert.equal(pre1, null, 'first editor is allowed');
  const pre2 = await hook(atlas, { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(dirB, 'shared.js') } });
  assert.equal(pre2.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(pre2.hookSpecificOutput.permissionDecisionReason, /Nova.* is also editing shared\.js/);
  assert.ok(ws.events.some((e) => e.type === 'conflict.detected' && e.data.kind === 'overlap' && e.files.includes('shared.js')));
  const pre3 = await hook(atlas, { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(dirB, 'shared.js') } });
  assert.equal(pre3, null, 'second attempt after the warning is allowed (no hard lock)');

  // Simultaneous edits to different regions of the same file are 3-way merged; nothing is lost.
  fs.writeFileSync(path.join(dirA, 'shared.js'), base.replace('line 2', 'line 2 (nova)'));
  fs.writeFileSync(path.join(dirB, 'shared.js'), base.replace('line 7', 'line 7 (atlas)'));
  const merged = base.replace('line 2', 'line 2 (nova)').replace('line 7', 'line 7 (atlas)');
  await waitFor(() => read(dirA, 'shared.js') === merged && read(dirB, 'shared.js') === merged, { label: 'both folders to converge on the merged file', timeout: 10000 });

  // Same-line edits cannot be merged: a conflict is recorded and BOTH versions are kept.
  const v = ws.state.files['shared.js'].version;
  const r1 = ws.call('filePut', { path: 'shared.js', baseVersion: v, contentB64: Buffer.from(merged.replace('line 4', 'line 4 = A')).toString('base64') }, { user: { id: 'usr_x', name: 'X' } });
  const r2 = ws.call('filePut', { path: 'shared.js', baseVersion: v, contentB64: Buffer.from(merged.replace('line 4', 'line 4 = B')).toString('base64') }, { user: { id: 'usr_y', name: 'Y' } });
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, false);
  const c = ws.call('conflictData', { conflictId: r2.conflict });
  assert.match(Buffer.from(c.currentB64, 'base64').toString(), /line 4 = A/);
  assert.match(Buffer.from(c.incomingB64, 'base64').toString(), /line 4 = B/);
  ws.call('resolveConflict', { conflictId: r2.conflict, resolution: 'content', contentB64: Buffer.from(merged.replace('line 4', 'line 4 = A and B')).toString('base64') }, { user: { id: 'usr_y', name: 'Y' } });
  await waitFor(() => read(dirA, 'shared.js').includes('line 4 = A and B') && read(dirB, 'shared.js').includes('line 4 = A and B'), { label: 'resolution to sync' });
  await A.close(); await B.close();
});

// ---------- 4 ----------
test('4. an API contract published by one agent reaches dependent agents', async () => {
  const user = { user: { id: 'usr_lead', name: 'Lead' } };
  const api = ws.call('createTask', { title: 'Track export API', files: ['src/export.ts'] }, user);
  const ui = ws.call('createTask', { title: 'Export button UI', dependsOn: [api.id] }, user);
  assert.equal(ws.state.tasks[ui.id].status, 'waiting');
  const dir = tmp('a4');
  const nova = { id: 'agt_t4_nova', name: 'Nova', root: dir, taskId: api.id };
  const pixel = { id: 'agt_t4_pixel', name: 'Pixel', root: dir, taskId: ui.id };
  const mNova = new McpClient(nova); await mNova.init();
  await waitFor(() => ws.state.agents[nova.id], { label: 'MCP auto-registration' });
  ws.call('startTask', { taskId: api.id, agentId: nova.id });
  await mNova.tool('publish_contract', { name: 'track-export', content: 'export function exportTrack(track: Track, format: "json" | "svg"): Promise<Blob>', description: 'Export a track' });
  await mNova.tool('update_task_status', { status: 'completed', summary: 'Export API implemented' });
  assert.equal(ws.state.tasks[ui.id].status, 'ready', 'dependent task is unblocked when the API task completes');

  const mPixel = new McpClient(pixel); await mPixel.init();
  await waitFor(() => ws.state.agents[pixel.id], { label: 'Pixel registration' });
  ws.call('startTask', { taskId: ui.id, agentId: pixel.id });
  const { data: ctx } = await mPixel.tool('get_context');
  const contract = ctx.contracts.find((c) => c.name === 'track-export');
  assert.match(contract.content, /exportTrack\(track: Track/, 'contract content is included for dependent tasks');
  assert.equal(ctx.dependencies[0].status, 'done');

  // The API agent revises the contract while Pixel works: Pixel is notified and integration flags the drift.
  ws.call('registerAgent', { agentId: nova.id });
  await mNova.tool('publish_contract', { name: 'track-export', content: 'export function exportTrack(track: Track, opts: { format: "json" | "svg" }): Promise<Blob>' });
  const digest = await hook(pixel, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: {} });
  assert.match(digest.hookSpecificOutput.additionalContext, /Contract "track-export" v2/);
  const integ = ws.call('integrationChecked', { taskId: ui.id, conflicts: [], risks: [] });
  assert.ok(integ.risks.some((r) => r.kind === 'contract' && /v1; latest is v2/.test(r.message)));
  mNova.kill(); mPixel.kill();
});

// ---------- 5 ----------
test('5. a disconnected agent reconnects and retrieves the events it missed', async () => {
  const dir = tmp('a5');
  const echo = { id: 'agt_t5_echo', name: 'Echo', root: dir };
  const sage = { id: 'agt_t5_sage', name: 'Sage', root: dir };
  fs.writeFileSync(path.join(dir, 'model.js'), 'x');
  let m = new McpClient(echo); await m.init();
  await waitFor(() => ws.state.agents[echo.id]);
  await agentRead(echo, 'model.js');
  await m.tool('get_updates');
  m.kill(); // Echo disconnects

  register(sage);
  await agentWrite(sage, 'model.js', 'y');
  ws.call('recordDecision', { agentId: sage.id, title: 'IDs', decision: 'Use UUIDv7 for all new ids' });

  // Restart the whole server too: the event log and agent cursors are persisted.
  await server.close();
  server = new TeamServer({ dataDir });
  await server.listen(port, '127.0.0.1');
  ws = server.coordinator.get(WS_ID);

  m = new McpClient(echo); await m.init();
  const { data } = await m.tool('get_updates');
  const types = data.events.map((e) => e.type);
  assert.ok(types.includes('file.changed'), 'missed file change is delivered');
  assert.ok(types.includes('decision.recorded'), 'missed decision is delivered');
  const again = await m.tool('get_updates');
  assert.equal(again.data.count, 0, 'events are not delivered twice');
  m.kill();

  // Desktop clients also resume from their last seen seq.
  const conn = new Connection({ url, workspace: WS_ID, token: ws.token, user: { id: 'usr_r', name: 'R' } });
  const welcomed = new Promise((r) => conn.once('welcome', r));
  conn.start(); await welcomed;
  const seen = conn.lastSeq;
  conn.close();
  ws.call('chat', { text: 'while you were away' }, { user: { id: 'usr_s', name: 'S' } });
  const conn2 = new Connection({ url, workspace: WS_ID, token: ws.token, user: { id: 'usr_r', name: 'R' } });
  conn2.lastSeq = seen;
  const w2 = await new Promise((r) => { conn2.once('welcome', r); conn2.start(); });
  assert.ok(w2.events.some((e) => e.type === 'chat.message' && e.data.text === 'while you were away'));
  assert.ok(w2.events.every((e) => e.seq > seen));
  conn2.close();
});

// ---------- 6 ----------
test('6. the desktop app state shows active agents, their tasks and changed files', async () => {
  const user = { user: { id: 'usr_lead', name: 'Lead' } };
  const t = ws.call('createTask', { title: 'Editor canvas' }, user);
  const dir = tmp('a6');
  const kite = { id: 'agt_t6_kite', name: 'Kite', root: dir, taskId: t.id };
  register(kite);
  ws.call('startTask', { taskId: t.id, agentId: kite.id });
  await agentWrite(kite, 'src/canvas.ts', 'canvas');
  ws.call('announceEdit', { agentId: kite.id, paths: ['src/canvas.ts', 'src/tools.ts'], intent: 'Add pan/zoom' });
  ws.call('publishUpdate', { agentId: kite.id, kind: 'progress', message: 'Canvas renders tracks' });
  // What the desktop renders comes from the snapshot sent over the desktop websocket.
  const conn = new Connection({ url, workspace: WS_ID, token: ws.token, user: { id: 'usr_lead', name: 'Lead' } });
  conn.start();
  await new Promise((r) => conn.once('welcome', r));
  const snap = await conn.call('snapshot');
  const a = snap.agents[kite.id];
  assert.equal(a.task.title, 'Editor canvas');
  assert.equal(a.status, 'working');
  assert.deepEqual(a.editing.map((f) => f.path).sort(), ['src/canvas.ts', 'src/tools.ts']);
  assert.equal(a.updates.at(-1).message, 'Canvas renders tracks');
  assert.equal(snap.tasks[t.id].status, 'running');
  assert.ok(snap.reservations['src/tools.ts'].some((r) => r.agentName === 'Kite' && r.intent === 'Add pan/zoom'));
  conn.close();
});

// ---------- 7 ----------
test('7. changes through MCP and through the desktop app land in the same shared workspace', async () => {
  const dirA = tmp('a7'), dirB = tmp('b7');
  const A = await desktop('Alice', dirA), B = await desktop('Bob', dirB, { preferRemoteOnFirstSync: true });
  const ext = { id: 'agt_t7_ext', name: 'Cursor agent', root: dirA };
  const m = new McpClient(ext); await m.init();
  fs.writeFileSync(path.join(dirA, 'README.md'), '# via an MCP-only agent\n');
  await m.tool('record_file_change', { path: 'README.md', summary: 'Wrote README' });
  fs.writeFileSync(path.join(dirB, 'NOTES.md'), 'typed by Bob in the desktop app\n');
  await waitFor(() => fs.existsSync(path.join(dirB, 'README.md')) && fs.existsSync(path.join(dirA, 'NOTES.md')), { label: 'sync of both changes' });
  const snapA = await A.conn.call('snapshot'), snapB = await B.conn.call('snapshot');
  for (const snap of [snapA, snapB]) {
    const files = Object.fromEntries(snap.recentFiles.map((f) => [f.path, f.by]));
    assert.equal(files['README.md'].name, 'Cursor agent');
    assert.equal(files['NOTES.md'].name, 'Bob');
  }
  const evs = await B.conn.call('events', { since: 0, limit: 2000 });
  assert.ok(evs.some((e) => e.type === 'file.changed' && e.files[0] === 'README.md' && e.actor.name === 'Cursor agent'));
  assert.ok(evs.some((e) => e.type === 'file.changed' && e.files[0] === 'NOTES.md' && e.actor.name === 'Bob'));
  assert.equal(evs.filter((e) => e.type === 'file.changed' && e.files[0] === 'README.md').length, 1, 'MCP report + sync of the same write is one event');
  m.kill(); await A.close(); await B.close();
});

// ---------- 8 ----------
test('8. completed agent work is reviewed and integrated without discarding anyone\'s changes', async () => {
  const W = server.coordinator.ensureWorkspace('accept-git-ws', { name: 'Git' });
  const repo = tmp('repo8');
  await git.git(repo, ['init', '-b', 'main']);
  await git.git(repo, ['config', 'core.autocrlf', 'false']);
  fs.writeFileSync(path.join(repo, 'app.js'), 'const a = 1;\nconst b = 2;\nconst c = 3;\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n');
  await git.git(repo, ['add', '-A']);
  await git.git(repo, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'init']);
  const sessDir = tmp('sess8');
  const session = new ProjectSession({
    project: { root: repo, name: 'repo8', role: 'host', url, workspace: W.id, token: W.token },
    user: { id: 'usr_lead', name: 'Lead' }, getSettings: () => ({ autoRun: false }), send: () => {}, dataDir: sessDir, scripts: {}, notify: () => {},
  });
  await session.start();
  await waitFor(() => session.state, { label: 'session snapshot' });
  const user = { user: { id: 'usr_lead', name: 'Lead' } };

  // Two agents on isolated branches: one changes app.js line 1, the other adds a new file.
  async function agentBranch(title, edit) {
    const t = W.call('createTask', { title, mode: 'isolated' }, user);
    const branch = `teamcode/${title.replace(/\W+/g, '-').toLowerCase()}`;
    const dir = path.join(sessDir, 'wt', t.id);
    const wt = await git.createWorktree(repo, dir, branch);
    const agentId = `agt_t8_${t.id.slice(-4)}`;
    W.call('registerAgent', { agentId, name: `Agent ${title}`, taskId: t.id, mode: 'isolated', branch });
    W.call('startTask', { taskId: t.id, agentId, branch, worktree: dir, baseCommit: wt.baseCommit });
    edit(dir);
    const head = await git.commitAll(dir, title, { name: 'Agent', email: 'a@t' });
    W.call('completeTask', { agentId, summary: `${title} done` });
    W.call('requestReview', { agentId, taskId: t.id, files: (await git.changedFiles(repo, wt.baseCommit, branch)).map((f) => f.path), headCommit: head });
    return t;
  }
  const t1 = await agentBranch('Rename a', (d) => fs.writeFileSync(path.join(d, 'app.js'), 'const alpha = 1;\nconst b = 2;\nconst c = 3;\n'));
  const t2 = await agentBranch('Add util', (d) => fs.writeFileSync(path.join(d, 'util.js'), 'export const util = true;\n'));
  const t3 = await agentBranch('Rename a differently', (d) => fs.writeFileSync(path.join(d, 'app.js'), 'const A = 1;\nconst b = 2;\nconst c = 3;\n'));
  await waitFor(() => session.state.tasks[t3.id]?.review.state === 'pending', { label: 'snapshot refresh' });

  assert.equal(session.state.tasks[t1.id].status, 'done');
  assert.equal(session.state.tasks[t1.id].review.state, 'pending', 'completion is not approval');

  const diff = await session.reviewDiff(t1.id);
  assert.equal(diff.kind, 'git');
  assert.match(diff.diff, /\+const alpha = 1;/);

  const check1 = await session.checkIntegration(t1.id);
  assert.equal(check1.state, 'clean');
  assert.ok(check1.risks.some((r) => r.kind === 'overlap' && /Rename a differently/.test(r.message)), 'overlap with another unmerged task is flagged');

  assert.equal((await session.approve(t1.id)).ok, true);
  await waitFor(() => session.state.tasks[t1.id].integration.state === 'merged', { label: 'merge recorded' });
  assert.equal((await session.approve(t2.id)).ok, true);
  assert.equal(read(repo, 'app.js').split('\n')[0], 'const alpha = 1;');
  assert.equal(read(repo, 'util.js'), 'export const util = true;\n');

  // The third branch conflicts with what was merged: nothing is overwritten, the conflict is surfaced.
  const r3 = await session.approve(t3.id);
  assert.equal(r3.ok, false);
  assert.deepEqual(r3.conflicts, ['app.js']);
  assert.equal(read(repo, 'app.js').split('\n')[0], 'const alpha = 1;', 'merged work is kept');
  assert.equal((await git.dirtyFiles(repo)).length, 0, 'failed merge leaves the working copy clean');
  await waitFor(() => session.state.tasks[t3.id].integration.state === 'conflicts', { label: 'conflict recorded' });
  assert.ok(Object.values(session.state.conflicts).some((c) => c.kind === 'merge' && c.taskId === t3.id));

  // Rejected work can be reverted after merge: revert t2 and the file disappears via a recorded revert.
  const rev = await session.revert(t2.id);
  assert.equal(rev.ok, true);
  assert.equal(fs.existsSync(path.join(repo, 'util.js')), false);
  assert.equal(read(repo, 'app.js').split('\n')[0], 'const alpha = 1;', 'reverting one task keeps the other');
  await session.stop();
});

// ---------- agent runner wiring ----------
test('agent runner: launches Claude Code with hooks + MCP, publishes the agent\'s work and requests review', async () => {
  const W = server.coordinator.ensureWorkspace('accept-runner-ws', { name: 'Runner' });
  const dir = tmp('runner');
  const fake = path.join(__dirname, 'fixtures', 'fake-claude.js');
  let cli = fake;
  if (process.platform === 'win32') {
    cli = path.join(tmp('fakebin'), 'claude.cmd');
    fs.writeFileSync(cli, `@echo off\r\n"${process.execPath}" "${fake}" %*\r\n`);
  } else fs.chmodSync(fake, 0o755);
  const session = new ProjectSession({
    project: { root: dir, name: 'runner', role: 'host', url, workspace: W.id, token: W.token },
    user: { id: 'usr_runner', name: 'Runner' }, getSettings: () => ({ claudePath: cli, autoRun: true, maxParallel: 2, permissionMode: 'acceptEdits' }),
    send: () => {}, dataDir: tmp('runnerdata'), scripts: { hook: HOOK, mcp: MCP }, notify: () => {},
  });
  await session.start();
  await waitFor(() => session.state, { label: 'session snapshot' });
  process.env.FAKE_CLAUDE_FILE = 'feature.txt';
  const t = await session.call('createTask', { title: 'Write feature file', mode: 'shared', runner: 'usr_runner', runnerName: 'Runner', autoStart: true });
  const done = await waitFor(() => W.state.tasks[t.id].status === 'done' && W.state.tasks[t.id].review.state === 'pending' && W.state.tasks[t.id], { label: 'agent to finish', timeout: 30000 });
  assert.equal(read(dir, 'feature.txt'), 'hello from fake agent\n');
  const agent = Object.values(W.state.agents).find((a) => a.taskId === t.id);
  assert.equal(agent.status, 'done');
  const evs = W.events.filter((e) => e.actor.id === agent.id).map((e) => e.type);
  assert.ok(evs.includes('file.changed'), 'PostToolUse hook published the change');
  assert.ok(evs.includes('agent.progress'), 'MCP server from --mcp-config worked');
  assert.ok(evs.includes('changes.review_requested'));
  assert.match(done.summary, /wrote feature.txt/);
  const log = session.agents.getLog(agent.id).map((e) => e.kind);
  assert.ok(log.includes('tool') && log.includes('result'));
  delete process.env.FAKE_CLAUDE_FILE;
  await session.stop();
});
