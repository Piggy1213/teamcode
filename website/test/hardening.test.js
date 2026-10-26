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
    try { W.call('createTask', { title: `t${i}`, description: 'y'.repeat(30000) }, user); W.saveNow(); } catch (e) { refused = e; }
  }
  assert.match(refused.message, /storage limit/, 'record growth stops at the cap');
  // Re-checking integration replaces the task's result rather than adding records, so it keeps working.
  W.call('integrationChecked', { taskId: t.id, conflicts: [], risks: [] }, user);
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

const sha = (s) => require('crypto').createHash('sha256').update(s).digest('hex');
const b64 = (s) => Buffer.from(s).toString('base64');
const goOffline = (W, id) => { W.state.agents[id].lastSeen = Date.now() - 30 * 60 * 1000; W.sweep(); W.sweep(); };

test('history trimming keeps the version a task would Revert to and the base of an open conflict', () => {
  const c = new Coordinator({ dataDir: tmp() });
  const W = c.ensureWorkspace('keep-ws', { name: 'K' });
  W.call('filePut', { path: 'a.js', baseVersion: 0, contentB64: b64('original') }, user);
  const t = W.call('createTask', { title: 'Edit a', mode: 'shared' }, user);
  W.call('registerAgent', { agentId: 'agt_k', name: 'K', taskId: t.id }, user);
  W.call('startTask', { taskId: t.id, agentId: 'agt_k' }, user);
  W.call('fileEdited', { agentId: 'agt_k', path: 'a.js', hash: sha('k') }, user);
  W.call('filePut', { path: 'a.js', baseVersion: 1, contentB64: b64('k') }, user);
  const conflict = W.call('filePut', { path: 'a.js', baseVersion: 2, contentB64: b64('stale base') }, user);
  W.call('filePut', { path: 'a.js', baseVersion: 2, contentB64: b64('base of a conflict') }, { user: { id: 'u2', name: 'Bo' } });
  assert.equal(conflict.unchanged || conflict.ok, true);
  const base = W.state.files['a.js'].version;
  const r = W.call('filePut', { path: 'a.js', baseVersion: base - 1, contentB64: b64('conflicting') }, user);
  assert.equal(r.ok, false, 'a sync conflict is open');
  for (let i = 0; i < 40; i++) W.call('filePut', { path: 'a.js', baseVersion: W.state.files['a.js'].version, contentB64: b64(`edit ${i}`) }, { user: { id: 'u2', name: 'Bo' } });
  const versions = W.state.files['a.js'].history.map((h) => h.version);
  assert.ok(versions.includes(1), 'the version before the task is kept');
  assert.ok(versions.includes(W.state.conflicts[r.conflict].baseVersion), 'the conflict base is kept');
  assert.ok(W.call('conflictData', { conflictId: r.conflict }, user).baseB64, 'the conflict can still be merged');
  assert.equal(Buffer.from(W.call('fileGet', { path: 'a.js', version: 1 }, user).contentB64, 'base64').toString(), 'original');
  assert.throws(() => W.call('fileRevert', { path: 'a.js', version: 3 }, user), (e) => e.code === 'gone');
  c.close();
});

test('an agent is credited only for its own person\'s fresh sync of its edit, never someone else\'s version', () => {
  const c = new Coordinator({ dataDir: tmp() });
  const W = c.ensureWorkspace('credit2-ws', { name: 'C' });
  W.call('filePut', { path: 'a.txt', baseVersion: 0, contentB64: b64('original') }, user);
  const t = W.call('createTask', { title: 'T', mode: 'shared' }, user);
  W.call('registerAgent', { agentId: 'agt_c', name: 'Cy', taskId: t.id }, user);
  W.call('startTask', { taskId: t.id, agentId: 'agt_c' }, user);
  W.call('filePut', { path: 'a.txt', baseVersion: 1, contentB64: b64('same text') }, { user: { id: 'u2', name: 'Bo' } }); // Bo wrote it
  W.call('fileEdited', { agentId: 'agt_c', path: 'a.txt', hash: sha('same text') }, user);
  assert.equal(W.state.files['a.txt'].by.name, 'Bo', 'Bo keeps the credit');
  assert.equal(W.state.files['a.txt'].history.at(-1).by.name, 'Bo');
  assert.equal(W.call('taskChanges', { taskId: t.id }, user)[0].beforeVersion, 1, 'the change is still recorded against the right version');
  // Uma's own sync, but long ago: not this agent's edit either.
  W.call('filePut', { path: 'b.txt', baseVersion: 0, contentB64: b64('old') }, user);
  W.state.files['b.txt'].at -= 5 * 60 * 1000;
  W.call('fileEdited', { agentId: 'agt_c', path: 'b.txt', hash: sha('old') }, user);
  assert.equal(W.state.files['b.txt'].by.name, 'Uma');
  c.close();
});

test('records have a hard ceiling: updates stop there, while sync of existing files, finishing and cleanup go on', () => {
  const c = new Coordinator({ dataDir: tmp(), limits: { maxBytes: 400 * 1024 } });
  const W = c.ensureWorkspace('ceiling-ws', { name: 'H' });
  W.call('userJoined', { user: { id: 'u1', name: 'Uma' } }, user);
  W.call('filePut', { path: 'keep.js', baseVersion: 0, contentB64: b64('v1') }, user);
  const tasks = [];
  for (let i = 0; i < 12; i++) tasks.push(W.call('createTask', { title: `t${i}` }, user));
  W.call('registerAgent', { agentId: 'agt_h', name: 'H', taskId: tasks[0].id }, user);
  W.call('startTask', { taskId: tasks[0].id, agentId: 'agt_h' }, user);
  let refused = null;
  for (const t of tasks) {
    try { W.call('updateTask', { taskId: t.id, description: 'd'.repeat(60000) }, user); W.saveNow(); } catch (e) { refused = e; break; }
  }
  assert.match(refused?.message || '', /storage limit/, 'growing existing records stops at the ceiling');
  assert.ok(W.metaBytes < 400 * 1024 * 0.75, `records stay well under the whole budget (${W.metaBytes})`);
  // While over the ceiling: nothing new, but everything that only touches what exists still works.
  assert.throws(() => W.call('userJoined', { user: { id: 'u9', name: 'New' } }, { user: { id: 'u9', name: 'New' } }), /storage limit/);
  assert.throws(() => W.call('filePut', { path: 'new.js', baseVersion: 0, contentB64: b64('x') }, user), /storage limit/);
  assert.throws(() => W.call('preEdit', { agentId: 'agt_h', path: 'new.js' }, user), /storage limit/);
  W.call('userJoined', { user: { id: 'u1', name: 'Uma' } }, user);
  W.call('filePut', { path: 'keep.js', baseVersion: 1, contentB64: b64('v2') }, user);
  W.call('fileEdited', { agentId: 'agt_h', path: 'keep.js', hash: sha('v2') }, user);
  assert.equal(W.call('completeTask', { agentId: 'agt_h', summary: 'done' }, user).status, 'done');
  for (const t of tasks.slice(1)) W.call('deleteTask', { taskId: t.id }, user);
  W.saveNow();
  W.call('createTask', { title: 'room again' }, user);
  c.close();
});

test('the event log has a byte budget, so huge events cannot fill a hosted project', () => {
  const c = new Coordinator({ dataDir: tmp(), limits: { maxBytes: 800 * 1024 } });
  const W = c.ensureWorkspace('evbytes-ws', { name: 'E' });
  const t = W.call('createTask', { title: 'T' }, user);
  for (let i = 0; i < 40; i++) W.call('updateTask', { taskId: t.id, description: `${i}`.repeat(30000) }, user);
  assert.ok(W.eventBytes <= 100 * 1024, `events.jsonl stays within an eighth of the budget (${W.eventBytes})`);
  assert.equal(W.eventBytes, fs.statSync(path.join(W.dataDir, 'events.jsonl')).size);
  c.close();
});

test('only work brings a released task back: finishing, reopening or exiting does not, and exiting frees a running task', () => {
  const c = new Coordinator({ dataDir: tmp() });
  const W = c.ensureWorkspace('term-ws', { name: 'T' });
  const t = W.call('createTask', { title: 'Job' }, user);
  W.call('registerAgent', { agentId: 'agt_t', name: 'T', taskId: t.id }, user);
  W.call('startTask', { taskId: t.id, agentId: 'agt_t' }, user);
  goOffline(W, 'agt_t');
  assert.equal(W.state.tasks[t.id].status, 'ready');
  W.call('agentExited', { agentId: 'agt_t', outcome: 'stopped' }, user);
  assert.equal(W.state.tasks[t.id].status, 'ready', 'not resumed by its own exit');
  assert.equal(W.state.tasks[t.id].releasedFrom, undefined);
  W.call('heartbeat', { agentId: 'agt_t' }, user);
  assert.equal(W.state.tasks[t.id].status, 'ready', 'an exited agent never takes it back');
  // An agent that exits while still on its task hands it back to the queue instead of leaving it "running".
  const t2 = W.call('createTask', { title: 'Job 2' }, user);
  W.call('registerAgent', { agentId: 'agt_u', name: 'U', taskId: t2.id }, user);
  W.call('startTask', { taskId: t2.id, agentId: 'agt_u' }, user);
  W.call('agentExited', { agentId: 'agt_u', outcome: 'error' }, user);
  assert.equal(W.state.tasks[t2.id].status, 'ready');
  // Reopening it while offline: no resume either.
  const t3 = W.call('createTask', { title: 'Job 3' }, user);
  W.call('registerAgent', { agentId: 'agt_v', name: 'V', taskId: t3.id }, user);
  W.call('startTask', { taskId: t3.id, agentId: 'agt_v' }, user);
  goOffline(W, 'agt_v');
  W.call('reopenTask', { taskId: t3.id, agentId: 'agt_v' }, user);
  W.call('heartbeat', { agentId: 'agt_v' }, user);
  assert.equal(W.state.tasks[t3.id].status, 'ready');
  c.close();
});

test('a stopped agent registering again does not resume; a TeamCode agent naming its task does', () => {
  const c = new Coordinator({ dataDir: tmp() });
  const W = c.ensureWorkspace('rereg-ws', { name: 'R' });
  const t = W.call('createTask', { title: 'Job' }, user);
  W.call('registerAgent', { agentId: 'agt_r', name: 'R', taskId: t.id }, user);
  W.call('startTask', { taskId: t.id, agentId: 'agt_r' }, user);
  W.call('agentExited', { agentId: 'agt_r', outcome: 'done' }, user);
  W.call('registerAgent', { agentId: 'agt_r', name: 'R', taskId: t.id }, user);
  assert.equal(W.state.tasks[t.id].status, 'ready', 'stopped, not swept: stays in the queue');
  W.call('startTask', { taskId: t.id, agentId: 'agt_r' }, user);
  goOffline(W, 'agt_r');
  W.call('registerAgent', { agentId: 'agt_r', name: 'R', taskId: t.id }, user);
  assert.equal(W.state.tasks[t.id].status, 'running', 'back from sleep for the same task: carries on');
  c.close();
});

test('a new session of a fixed-id Claude Code does not reclaim the old session\'s task', () => {
  const c = new Coordinator({ dataDir: tmp() });
  const W = c.ensureWorkspace('fixed-ws', { name: 'F' });
  const t = W.call('createTask', { title: 'Job' }, user);
  W.call('registerAgent', { agentId: 'agt_cc_1', name: 'Uma\'s Claude Code' }, user);
  W.call('startTask', { taskId: t.id, agentId: 'agt_cc_1' }, user);
  goOffline(W, 'agt_cc_1');
  W.call('registerAgent', { agentId: 'agt_cc_1', name: 'Uma\'s Claude Code' }, user); // days later
  W.call('heartbeat', { agentId: 'agt_cc_1' }, user);
  assert.equal(W.state.tasks[t.id].status, 'ready');
  assert.equal(W.state.agents.agt_cc_1.taskId, null);
  c.close();
});

test('a blocked task released by the sweep comes back blocked, not running', () => {
  const c = new Coordinator({ dataDir: tmp() });
  const W = c.ensureWorkspace('blk-ws', { name: 'B' });
  const t = W.call('createTask', { title: 'Job' }, user);
  W.call('registerAgent', { agentId: 'agt_b', name: 'B', taskId: t.id }, user);
  W.call('startTask', { taskId: t.id, agentId: 'agt_b' }, user);
  W.call('reportBlocker', { agentId: 'agt_b', description: 'need the API' }, user);
  goOffline(W, 'agt_b');
  assert.equal(W.state.tasks[t.id].status, 'ready');
  W.call('heartbeat', { agentId: 'agt_b' }, user);
  assert.equal(W.state.tasks[t.id].status, 'blocked');
  c.close();
});

test('re-checking integration keeps one merge-conflict record per task and closes it once clean', () => {
  const c = new Coordinator({ dataDir: tmp() });
  const W = c.ensureWorkspace('int-ws', { name: 'I' });
  const t = W.call('createTask', { title: 'Branch work', mode: 'isolated' }, user);
  for (let i = 0; i < 5; i++) W.call('integrationChecked', { taskId: t.id, conflicts: ['a.js', `b${i}.js`] }, user);
  const merges = Object.values(W.state.conflicts).filter((x) => x.kind === 'merge');
  assert.equal(merges.length, 1);
  assert.deepEqual(merges[0].files, ['a.js', 'b4.js']);
  W.call('integrationChecked', { taskId: t.id, conflicts: [] }, user);
  assert.equal(merges[0].status, 'resolved');
  c.close();
});

test('reopening hands the task to its new runner in the same step', () => {
  const c = new Coordinator({ dataDir: tmp() });
  const W = c.ensureWorkspace('reopen-ws', { name: 'O' });
  const t = W.call('createTask', { title: 'Job' }, user);
  W.call('cancelTask', { taskId: t.id }, user);
  const seen = [];
  W.on('event', (e) => { if (e.task === t.id) seen.push({ status: W.state.tasks[t.id].status, runner: W.state.tasks[t.id].runner }); });
  const r = W.call('reopenTask', { taskId: t.id, runner: 'u2', runnerName: 'Bo', autoStart: true }, user);
  assert.equal(r.status, 'ready');
  assert.equal(r.runner, 'u2');
  assert.equal(r.autoStart, true);
  assert.ok(seen.every((s) => s.runner === 'u2'), 'no moment where it is ready under the old runner');
  c.close();
});

test('Revert skips files whose old version is gone for good, and still records the revert', async () => {
  const { ProjectSession } = require('../../src/main/session');
  const calls = [];
  const fake = {
    _task: () => ({ id: 't1', mode: 'shared' }),
    project: { root: tmp() },
    call: async (op, args) => {
      calls.push(op);
      if (op === 'taskChanges') return [{ path: 'gone.js', beforeVersion: 3, changedByOthersSince: [] }, { path: 'flaky.js', beforeVersion: 2, changedByOthersSince: [] }];
      if (op === 'fileRevert' && args.path === 'gone.js') { const e = new Error('v3 of gone.js is no longer stored'); e.code = 'gone'; throw e; }
      return {};
    },
  };
  const r = await ProjectSession.prototype.revert.call(fake, 't1');
  assert.equal(r.ok, true);
  assert.equal(r.skipped[0].path, 'gone.js');
  assert.ok(calls.includes('markReverted'));
  fake.call = async (op, args) => { if (op === 'taskChanges') return [{ path: 'flaky.js', beforeVersion: 2, changedByOthersSince: [] }]; if (op === 'fileRevert') throw new Error('network down'); calls.push(`again:${op}`); return {}; };
  const r2 = await ProjectSession.prototype.revert.call(fake, 't1');
  assert.equal(r2.ok, false, 'a temporary failure can be retried');
  assert.ok(!calls.includes('again:markReverted'));
});
