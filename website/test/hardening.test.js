'use strict';
// Coordinator hardening for hosted (cloud) workspaces: prototype safety, storage accounting, history
// cleanup, event trimming, and not taking tasks away from live agents.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Coordinator } = require('../../server/coordinator');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tc-hard-'));
const user = { user: { id: 'u1', name: 'Uma' } };

test('no request shape reaches Object.prototype, and ordinary words still work', () => {
  const c = new Coordinator({ dataDir: tmp() });
  const W = c.ensureWorkspace('proto-ws', { name: 'P' });
  let deep = '__proto__';
  for (let i = 0; i < 12; i++) deep = [deep];
  const tries = [
    ['registerAgent', { agentId: deep, name: 'x', client: 'POLLUTED', cwd: '/evil' }],
    ['registerAgent', { agentId: ['__proto__'], name: 'x', client: 'POLLUTED' }],
    ['registerAgent', { agentId: 'constructor', name: 'x', client: 'POLLUTED' }],
    ['heartbeat', { agentId: '__proto__' }],
    ['updateSettings', { settings: JSON.parse('{"__proto__":{"polluted":1},"testCommand":"npm test"}') }],
    ['filePut', { path: '__proto__', baseVersion: 0, contentB64: Buffer.from('x').toString('base64') }],
    ['filePut', { path: 'constructor', baseVersion: 0, contentB64: Buffer.from('x').toString('base64') }],
  ];
  for (const [op, args] of tries) { try { W.call(op, args, user); } catch { /* refused is fine */ } }
  assert.deepEqual(Object.keys(Object.prototype), []);
  assert.equal(({}).client, undefined);
  assert.equal(typeof Object.lastSeen, 'undefined', 'Object itself untouched');
  // Words that happen to be those names are ordinary data.
  const t = W.call('createTask', { title: 'prototype', description: 'constructor' }, user);
  assert.equal(t.title, 'prototype');
  W.call('chat', { text: '__proto__' }, user);
  c.close();
});

test('state survives a save and reload with prototype-free maps', () => {
  const dir = tmp();
  const c1 = new Coordinator({ dataDir: dir });
  const W1 = c1.ensureWorkspace('reload-ws', { name: 'R' });
  W1.call('filePut', { path: 'constructor', baseVersion: 0, contentB64: Buffer.from('hi').toString('base64') }, user);
  W1.saveNow();
  c1.close();
  const c2 = new Coordinator({ dataDir: dir });
  const W2 = c2.get('reload-ws');
  assert.equal(Object.getPrototypeOf(W2.state.files), null);
  assert.equal(W2.state.files.constructor.version, 1);
  assert.deepEqual(Object.keys(Object.prototype), []);
  c2.close();
});

test('settings accept only known keys and the event carries only the change', () => {
  const c = new Coordinator({ dataDir: tmp() });
  const W = c.ensureWorkspace('settings-ws', { name: 'S' });
  W.call('updateSettings', { settings: { testCommand: 'npm test', junk: 'x'.repeat(400000) } }, user);
  assert.equal(W.state.settings.junk, undefined);
  const ev = W.events.at(-1);
  assert.deepEqual(ev.data.settings, { testCommand: 'npm test' });
  c.close();
});

test('the storage limit counts state and events, not just files', () => {
  const c = new Coordinator({ dataDir: tmp(), limits: { maxBytes: 200 * 1024 } });
  const W = c.ensureWorkspace('budget-ws', { name: 'B' });
  let refused = null;
  for (let i = 0; i < 40 && !refused; i++) {
    try { W.call('createTask', { title: `T${i}`, description: 'x'.repeat(20 * 1024) }, user); W.saveNow(); } catch (e) { refused = e; }
  }
  assert.ok(refused, 'growth stopped');
  assert.match(refused.message, /storage limit/);
  assert.ok(W.call('snapshot', {}, user), 'still readable');
  c.close();
});

test('old file versions are deleted once they leave history, so editing never fills the project', () => {
  const dir = tmp();
  const c = new Coordinator({ dataDir: dir, limits: { maxBytes: 2 * 1024 * 1024 } });
  const W = c.ensureWorkspace('gc-ws', { name: 'G' });
  for (let v = 0; v < 120; v++) {
    const buf = Buffer.alloc(50 * 1024, v % 256);
    W.call('filePut', { path: 'lock.json', baseVersion: v, contentB64: buf.toString('base64') }, user);
  }
  W.saveNow(); // old versions are deleted once the state that no longer needs them is saved
  const blobs = fs.readdirSync(path.join(dir, 'gc-ws', 'blobs')).length;
  assert.ok(blobs <= 31, `kept ${blobs} versions`);
  assert.equal(W.state.files['lock.json'].version, 120);
  c.close();
});

test('a task keeps its record of changed files after the event log is trimmed', () => {
  const c = new Coordinator({ dataDir: tmp(), limits: { maxEvents: 200 } });
  const W = c.ensureWorkspace('trim-ws', { name: 'T' });
  const t = W.call('createTask', { title: 'Open task', mode: 'shared' }, user);
  W.call('registerAgent', { agentId: 'agt_a', name: 'A', taskId: t.id }, user);
  W.call('startTask', { taskId: t.id, agentId: 'agt_a' }, user);
  W.call('fileEdited', { agentId: 'agt_a', path: 'early.js', hash: 'h' }, user);
  for (let i = 0; i < 600; i++) W.call('chat', { text: `noise ${i}` }, user);
  assert.ok(W.events.length < 600, 'log was trimmed');
  assert.ok(W.call('taskChanges', { taskId: t.id }, user).some((ch) => ch.path === 'early.js'), 'the open task still knows its early change');
  c.close();
});

test('a live agent keeps its running or blocked task', () => {
  const c = new Coordinator({ dataDir: tmp() });
  const W = c.ensureWorkspace('owner-ws', { name: 'O' });
  const t = W.call('createTask', { title: 'Mine' }, user);
  W.call('registerAgent', { agentId: 'agt_live', name: 'Live', taskId: t.id }, user);
  W.call('startTask', { taskId: t.id, agentId: 'agt_live' }, user);
  W.call('registerAgent', { agentId: 'agt_other', name: 'Other' }, user);
  assert.throws(() => W.call('reopenTask', { taskId: t.id }, user), /can't be reopened/);
  W.call('reportBlocker', { agentId: 'agt_live', description: 'need API' }, user);
  assert.equal(W.state.tasks[t.id].status, 'blocked');
  assert.throws(() => W.call('reopenTask', { taskId: t.id }, user), /can't be reopened/);
  assert.throws(() => W.call('startTask', { taskId: t.id, agentId: 'agt_other' }, user), /working on this task/);
  assert.throws(() => W.call('reopenTask', { taskId: t.id, force: true }, user), /can't be reopened/, 'force does not override a live owner');
  assert.throws(() => W.call('startTask', { taskId: t.id, agentId: 'agt_other', force: true }, user), /working on this task/);
  assert.throws(() => W.call('registerAgent', { agentId: 'agt_new', name: 'New', taskId: t.id }, user), /working on this task/, 'registering cannot take it either');
  // The owner itself can carry on with its own blocked task.
  assert.equal(W.call('startTask', { taskId: t.id, agentId: 'agt_live' }, user).status, 'running');
  W.call('agentExited', { agentId: 'agt_live', outcome: 'stopped' }, user);
  assert.equal(W.call('startTask', { taskId: t.id, agentId: 'agt_other' }, user).status, 'running', 'free once the owner is gone');
  c.close();
});

test('an orphaned blocked task can be recovered once its agent is gone', () => {
  const c = new Coordinator({ dataDir: tmp() });
  const W = c.ensureWorkspace('orphan-ws', { name: 'O' });
  const t = W.call('createTask', { title: 'Orphan' }, user);
  W.call('registerAgent', { agentId: 'agt_dead', name: 'Dead', taskId: t.id }, user);
  W.call('startTask', { taskId: t.id, agentId: 'agt_dead' }, user);
  W.call('reportBlocker', { agentId: 'agt_dead', description: 'stuck' }, user);
  W.state.agents.agt_dead.lastSeen = Date.now() - 20 * 60 * 1000; // crashed long ago, never said goodbye
  W.sweep(); W.sweep();
  assert.equal(W.state.tasks[t.id].status, 'ready', 'the sweep returns it to the queue');
  c.close();
});

test('a merged task is not silently restarted; Revert still knows its changes after the log is trimmed', () => {
  const c = new Coordinator({ dataDir: tmp(), limits: { maxEvents: 100 } });
  const W = c.ensureWorkspace('merged-ws', { name: 'M' });
  W.call('filePut', { path: 'app.js', baseVersion: 0, contentB64: Buffer.from('v1').toString('base64') }, user);
  const t = W.call('createTask', { title: 'Rewrite', mode: 'shared' }, user);
  W.call('registerAgent', { agentId: 'agt_m', name: 'M', taskId: t.id }, user);
  W.call('startTask', { taskId: t.id, agentId: 'agt_m' }, user);
  W.call('fileEdited', { agentId: 'agt_m', path: 'app.js', hash: 'x' }, user);
  W.call('filePut', { path: 'app.js', baseVersion: 1, contentB64: Buffer.from('agent rewrite').toString('base64') }, user);
  W.call('completeTask', { agentId: 'agt_m', summary: 'done' }, user);
  W.call('markMerged', { taskId: t.id, into: 'shared working copy' }, user);
  for (let i = 0; i < 300; i++) W.call('chat', { text: `n${i}` }, user);
  const ch = W.call('taskChanges', { taskId: t.id }, user);
  assert.deepEqual(ch.map((x) => [x.path, x.beforeVersion]), [['app.js', 1]]);
  assert.throws(() => W.call('startTask', { taskId: t.id, agentId: 'agt_m', force: true }, user), /merged/);
  W.call('reopenTask', { taskId: t.id }, user);
  W.call('registerAgent', { agentId: 'agt_m2', name: 'M2' }, user);
  assert.equal(W.call('startTask', { taskId: t.id, agentId: 'agt_m2' }, user).status, 'running', 'after Reopen it can start again');
  c.close();
});
