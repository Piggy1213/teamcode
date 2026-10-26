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
  W.call('updateSettings', { settings: { testCommand: 'npm test', junk: 'x'.repeat(1000) } }, user);
  assert.throws(() => W.call('updateSettings', { settings: { junk: 'x'.repeat(400000) } }, user), /too large/);
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

test('a full hosted project refuses growth but can still finish, review and clean up', () => {
  const c = new Coordinator({ dataDir: tmp(), limits: { maxBytes: 300 * 1024 } });
  const W = c.ensureWorkspace('full-ws', { name: 'F' });
  const t = W.call('createTask', { title: 'Finish me' }, user);
  W.call('registerAgent', { agentId: 'agt_f', name: 'F', taskId: t.id }, user);
  W.call('startTask', { taskId: t.id, agentId: 'agt_f' }, user);
  let refused = null;
  for (let i = 0; i < 60 && !refused; i++) {
    try { W.call('integrationChecked', { taskId: t.id, conflicts: [], risks: [{ kind: 'x', message: 'y'.repeat(30000) }] }, user); W.saveNow(); } catch (e) { refused = e; }
  }
  assert.match(refused.message, /storage limit/, 'record growth stops at the cap');
  assert.throws(() => W.call('registerAgent', { agentId: 'agt_n', name: 'n'.repeat(70000) }, user), /too large/);
  assert.equal(W.call('completeTask', { agentId: 'agt_f', summary: 'ok' }, user).status, 'done', 'finishing still works');
  W.call('reviewDecision', { taskId: t.id, decision: 'approve' }, user);
  W.call('deleteTask', { taskId: t.id }, user);
  c.close();
});

test('deleting a file keeps its history, so Revert can restore it', () => {
  const c = new Coordinator({ dataDir: tmp(), limits: { maxBytes: 1024 * 1024 } });
  const W = c.ensureWorkspace('del-ws', { name: 'D' });
  W.call('filePut', { path: 'old.js', baseVersion: 0, contentB64: Buffer.alloc(600 * 1024, 1).toString('base64') }, user);
  W.call('filePut', { path: 'old.js', baseVersion: 1, deleted: true }, user);
  W.saveNow();
  assert.ok(W.call('fileGet', { path: 'old.js', version: 1 }, user).contentB64, 'the deleted content is still there');
  W.call('fileRevert', { path: 'old.js', version: 1 }, user);
  assert.equal(W.state.files['old.js'].deleted, false);
  c.close();
});

test('the version before a change is recorded by version, even when sync arrives before the hook', () => {
  const c = new Coordinator({ dataDir: tmp() });
  const W = c.ensureWorkspace('order-ws', { name: 'O' });
  W.call('filePut', { path: 'a.js', baseVersion: 0, contentB64: Buffer.from('original').toString('base64') }, user);
  const t = W.call('createTask', { title: 'Rewrite a', mode: 'shared' }, user);
  W.call('registerAgent', { agentId: 'agt_o', name: 'O', taskId: t.id }, user);
  W.call('startTask', { taskId: t.id, agentId: 'agt_o' }, user);
  const hash = require('crypto').createHash('sha256').update('agent rewrite').digest('hex');
  W.call('filePut', { path: 'a.js', baseVersion: 1, contentB64: Buffer.from('agent rewrite').toString('base64') }, user); // sync first
  W.call('fileEdited', { agentId: 'agt_o', path: 'a.js', hash }, user); // then the agent's hook
  assert.equal(W.call('taskChanges', { taskId: t.id }, user)[0].beforeVersion, 1, 'Revert goes back to the original, not the agent\'s version');
  c.close();
});

test('a sleeping agent keeps its task until it is actually offline; a displaced agent cannot finish it', () => {
  const c = new Coordinator({ dataDir: tmp() });
  const W = c.ensureWorkspace('stale-ws', { name: 'S' });
  const t = W.call('createTask', { title: 'Long job' }, user);
  W.call('registerAgent', { agentId: 'agt_a', name: 'A', taskId: t.id }, user);
  W.call('startTask', { taskId: t.id, agentId: 'agt_a' }, user);
  W.state.agents.agt_a.lastSeen = Date.now() - 2 * 60 * 1000; // asleep for 2 minutes
  W.sweep();
  assert.equal(W.state.agents.agt_a.status, 'stale');
  W.call('registerAgent', { agentId: 'agt_b', name: 'B' }, user);
  assert.throws(() => W.call('startTask', { taskId: t.id, agentId: 'agt_b' }, user), /A is working on this task/);
  W.state.agents.agt_a.lastSeen = Date.now() - 20 * 60 * 1000; // gone for good
  W.sweep();
  assert.equal(W.state.tasks[t.id].status, 'ready');
  W.call('startTask', { taskId: t.id, agentId: 'agt_b' }, user);
  // A wakes up: it no longer has the task and can't complete or fail it.
  W.call('registerAgent', { agentId: 'agt_a', name: 'A', taskId: t.id }, user);
  assert.equal(W.state.agents.agt_a.taskId, null);
  assert.throws(() => W.call('completeTask', { agentId: 'agt_a', taskId: t.id, summary: 'mine' }, user), /B has this task now/);
  assert.throws(() => W.call('failTask', { agentId: 'agt_a', taskId: t.id, error: 'x' }, user), /B has this task now/);
  assert.equal(W.state.tasks[t.id].status, 'running');
  c.close();
});

test('acknowledging a sync conflict keeps the unapplied edit until it is pruned a week later', () => {
  const c = new Coordinator({ dataDir: tmp() });
  const W = c.ensureWorkspace('ack-ws', { name: 'A' });
  W.call('filePut', { path: 'x.js', baseVersion: 0, contentB64: Buffer.from('v1').toString('base64') }, user);
  W.call('filePut', { path: 'x.js', baseVersion: 1, contentB64: Buffer.from('v2').toString('base64') }, user);
  const r = W.call('filePut', { path: 'x.js', baseVersion: 1, contentB64: Buffer.from('mine').toString('base64') }, { user: { id: 'u2', name: 'Bo' } });
  W.call('resolveConflictRecord', { conflictId: r.conflict, resolution: 'acknowledged' }, user);
  W.saveNow();
  assert.ok(W.call('conflictData', { conflictId: r.conflict }, user).incomingB64, 'still available');
  W.state.conflicts[r.conflict].resolvedAt = Date.now() - 8 * 24 * 3600 * 1000;
  W._prunedAt = 0; W.sweep(); W.saveNow();
  assert.equal(W.state.conflicts[r.conflict], undefined, 'pruned after a week');
  c.close();
});

test('a project whose file storage is full can still revert, resolve, review, and free space by deleting', () => {
  const c = new Coordinator({ dataDir: tmp(), limits: { maxBytes: 960 * 1024 } }); // three 300 KB versions put it over 90%
  const W = c.ensureWorkspace('fullc-ws', { name: 'FC' });
  const big = (n, fill) => Buffer.alloc(n, fill).toString('base64');
  W.call('filePut', { path: 'a.bin', baseVersion: 0, contentB64: big(300 * 1024, 1) }, user);
  W.call('filePut', { path: 'a.bin', baseVersion: 1, contentB64: big(300 * 1024, 2) }, user);
  W.call('filePut', { path: 'b.bin', baseVersion: 0, contentB64: big(300 * 1024, 3) }, user);
  assert.throws(() => W.call('filePut', { path: 'c.bin', baseVersion: 0, contentB64: big(300 * 1024, 4) }, user), /storage limit/, 'new content is refused');
  for (let i = 0; i < 40; i++) W.call('userJoined', { user: { id: 'u1', name: 'Uma' } }, user); // routine activity keeps adding records
  W.call('fileRevert', { path: 'a.bin', version: 1 }, user); // reuses stored content: allowed
  assert.equal(W.state.files['a.bin'].hash, W.state.files['a.bin'].history[0].hash);
  const t = W.call('createTask', { title: 'Review me' }, user);
  W.call('requestReview', { taskId: t.id, summary: 'x' }, user);
  // Deleting a file on a nearly full project frees its old versions but keeps the last one to restore.
  W.call('filePut', { path: 'a.bin', baseVersion: W.state.files['a.bin'].version, deleted: true }, user);
  W.saveNow();
  assert.ok(W.state.files['a.bin'].history.some((h) => h.hash), 'still restorable');
  W.call('filePut', { path: 'c.bin', baseVersion: 0, contentB64: big(300 * 1024, 4) }, user); // there is room again
  c.close();
});

test('when sync arrives before the hook, the version is credited to the agent and Revert does not skip it', () => {
  const c = new Coordinator({ dataDir: tmp() });
  const W = c.ensureWorkspace('credit-ws', { name: 'C' });
  W.call('filePut', { path: 'a.txt', baseVersion: 0, contentB64: Buffer.from('original').toString('base64') }, user);
  const t = W.call('createTask', { title: 'T', mode: 'shared' }, user);
  W.call('registerAgent', { agentId: 'agt_n', name: 'Nova', taskId: t.id }, user);
  W.call('startTask', { taskId: t.id, agentId: 'agt_n' }, user);
  W.call('filePut', { path: 'a.txt', baseVersion: 1, contentB64: Buffer.from('nova').toString('base64') }, user);
  W.call('fileEdited', { agentId: 'agt_n', path: 'a.txt', hash: require('crypto').createHash('sha256').update('nova').digest('hex') }, user);
  const [ch] = W.call('taskChanges', { taskId: t.id }, user);
  assert.equal(ch.beforeVersion, 1);
  assert.deepEqual(ch.changedByOthersSince, [], 'not mistaken for someone else\'s edit');
  assert.equal(W.state.files['a.txt'].history.at(-1).by.name, 'Nova');
  c.close();
});

test('a laptop back from sleep resumes its task if nobody took it; claiming another task releases the first', () => {
  const c = new Coordinator({ dataDir: tmp() });
  const W = c.ensureWorkspace('wake-ws', { name: 'W' });
  const t1 = W.call('createTask', { title: 'One' }, user);
  const t2 = W.call('createTask', { title: 'Two' }, user);
  W.call('registerAgent', { agentId: 'agt_w', name: 'W', taskId: t1.id }, user);
  W.call('startTask', { taskId: t1.id, agentId: 'agt_w' }, user);
  W.state.agents.agt_w.lastSeen = Date.now() - 30 * 60 * 1000;
  W.sweep(); W.sweep();
  assert.equal(W.state.tasks[t1.id].status, 'ready');
  W.call('heartbeat', { agentId: 'agt_w' }, user);
  assert.equal(W.state.tasks[t1.id].status, 'running', 'resumed');
  W.call('startTask', { taskId: t2.id, agentId: 'agt_w' }, user);
  assert.equal(W.state.tasks[t1.id].status, 'ready', 'the first task went back to the queue');
  assert.equal(W.state.agents.agt_w.taskId, t2.id);
  c.close();
});
