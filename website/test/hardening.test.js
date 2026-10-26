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
  const blobs = fs.readdirSync(path.join(dir, 'gc-ws', 'blobs')).length;
  assert.ok(blobs <= 31, `kept ${blobs} versions`);
  assert.equal(W.state.files['lock.json'].version, 120);
  c.close();
});

test('event trimming keeps the file events of tasks that are still open', () => {
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
  assert.throws(() => W.call('startTask', { taskId: t.id, agentId: 'agt_other' }, user), /blocked/);
  W.call('reopenTask', { taskId: t.id, force: true }, user); // the owner's own app releasing it
  assert.throws(() => W.call('startTask', { taskId: t.id, agentId: 'agt_other' }, user), /still working on this task/);
  W.call('agentExited', { agentId: 'agt_live', outcome: 'stopped' }, user);
  assert.equal(W.call('startTask', { taskId: t.id, agentId: 'agt_other' }, user).status, 'running');
  c.close();
});
