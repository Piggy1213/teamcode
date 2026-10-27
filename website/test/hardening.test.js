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
const goOffline = (W, id) => {
  const a = W.state.agents[id];
  a.lastSeen = Date.now() - 30 * 60 * 1000;
  for (const k of Object.keys(a.seen || {})) a.seen[k] = a.lastSeen; // its sessions went quiet with it
  W.sweep(); W.sweep();
};

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
  assert.throws(() => W.call('filePut', { path: 'new.js', baseVersion: 0, contentB64: b64('x') }, user), /storage limit/);
  assert.throws(() => W.call('preEdit', { agentId: 'agt_h', path: 'new.js' }, user), /storage limit/);
  W.call('userJoined', { user: { id: 'u9', name: 'New' } }, { user: { id: 'u9', name: 'New' } }); // joining is never refused for space
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

// ---- round 7 ----
const startOn = (W, agentId, taskId, extra = {}) => { W.call('registerAgent', { agentId, name: agentId, ...extra }, user); W.call('startTask', { taskId, agentId }, user); };

test('each Claude Code session joins as its own agent; its MCP server and hooks agree on the id', () => {
  const { loadConfig } = require('../../src/agent/api');
  const dir = tmp();
  const file = path.join(dir, 'claude-code.json');
  fs.writeFileSync(file, JSON.stringify({ TEAMCODE_URL: 'http://127.0.0.1:1', TEAMCODE_WORKSPACE: 'w-ws', TEAMCODE_TOKEN: 't', TEAMCODE_ROOT: dir, TEAMCODE_AGENT_ID: 'agt_cc_abc', TEAMCODE_AGENT_NAME: "Uma's Claude Code" }));
  const argv = ['node', 'x.js', '--config', file];
  const s1 = loadConfig({ CLAUDE_CODE_SESSION_ID: '6faf3834-95ae-4270-9138-35848b9b5a3a' }, argv);
  const s1again = loadConfig({ CLAUDE_CODE_SESSION_ID: '6faf3834-95ae-4270-9138-35848b9b5a3a' }, argv); // its hook process
  const s2 = loadConfig({ CLAUDE_CODE_SESSION_ID: '0b1c2d3e-0000-4000-8000-000000000000' }, argv);
  assert.equal(s1.agentId, s1again.agentId);
  assert.notEqual(s1.agentId, s2.agentId);
  assert.match(s1.agentId, /^agt_cc_abc_[0-9a-f]{10}$/);
  assert.equal(s1.perSession, true);
  assert.equal(s1.name, "Uma's Claude Code (6faf)");
  // Older Claude Code without the variable: one agent for the folder, as before.
  assert.equal(loadConfig({ CLAUDECODE: '1' }, argv).agentId, 'agt_cc_abc');
  // An MCP client that isn't Claude Code: one agent per window (the process running the server), the same on every
  // restart of the server inside that window.
  assert.match(loadConfig({}, argv).agentId, /^agt_cc_abc_[0-9a-f]{10}$/);
  assert.equal(loadConfig({}, argv).agentId, loadConfig({}, argv).agentId);
  // An agent TeamCode launched keeps its own identity even though Claude Code sets the variable for it too.
  const inside = loadConfig({ CLAUDE_CODE_SESSION_ID: '6faf3834-95ae-4270-9138-35848b9b5a3a', TEAMCODE_AGENT_ID: 'agt_x', TEAMCODE_URL: 'http://h', TEAMCODE_WORKSPACE: 'w-ws', TEAMCODE_TOKEN: 't', TEAMCODE_TASK_ID: 'tsk_1' }, ['node', 'x.js']);
  assert.equal(inside.agentId, 'agt_x');
  assert.equal(inside.perSession, false);
});

test('a per-session agent registering again is the same session: it keeps its task, and resumes it after sleep', () => {
  const c = new Coordinator({ dataDir: tmp() });
  const W = c.ensureWorkspace('perses-ws', { name: 'P' });
  const t = W.call('createTask', { title: 'Job' }, user);
  W.call('registerAgent', { agentId: 'agt_cc_x_1', name: 'U', perSession: true }, user);
  W.call('startTask', { taskId: t.id, agentId: 'agt_cc_x_1' }, user);
  W.state.agents.agt_cc_x_1.lastSeen = Date.now() - 2 * 60 * 1000; W.sweep(); // idle: stale
  W.call('registerAgent', { agentId: 'agt_cc_x_1', name: 'U', perSession: true }, user); // its MCP server restarted
  assert.equal(W.state.tasks[t.id].status, 'running');
  goOffline(W, 'agt_cc_x_1');
  assert.equal(W.state.tasks[t.id].status, 'ready');
  W.call('heartbeat', { agentId: 'agt_cc_x_1' }, user);
  assert.equal(W.state.tasks[t.id].status, 'running', 'back from sleep: carries on');
  c.close();
});

test('a dropped task takes the agent\'s blocked status with it', () => {
  const c = new Coordinator({ dataDir: tmp() });
  const W = c.ensureWorkspace('dropblk-ws', { name: 'D' });
  const t = W.call('createTask', { title: 'Job' }, user);
  W.call('registerAgent', { agentId: 'agt_cc_d', name: 'D' }, user);
  W.call('startTask', { taskId: t.id, agentId: 'agt_cc_d' }, user);
  W.call('reportBlocker', { agentId: 'agt_cc_d', description: 'need API' }, user);
  W.state.agents.agt_cc_d.lastSeen = Date.now() - 2 * 60 * 1000; W.sweep();
  W.call('registerAgent', { agentId: 'agt_cc_d', name: 'D' }, user); // an older Claude Code's new session
  assert.equal(W.state.tasks[t.id].status, 'ready');
  assert.notEqual(W.state.agents.agt_cc_d.status, 'blocked');
  c.close();
});

test('two real Claude Code sessions in one folder are separate agents; closing one hands back only its task', async () => {
  const { TeamServer } = require('../../server/server');
  const { spawn } = require('child_process');
  const ROOT = path.join(__dirname, '..', '..');
  const dir = tmp();
  const server = new TeamServer({ dataDir: path.join(dir, 'srv') });
  const port = await server.listen(0, '127.0.0.1');
  const SW = server.coordinator.ensureWorkspace('two-ws', { name: 'T', token: 'tok' });
  const proj = path.join(dir, 'proj'); fs.mkdirSync(proj);
  const conf = path.join(dir, 'claude-code.json');
  fs.writeFileSync(conf, JSON.stringify({ TEAMCODE_URL: `http://127.0.0.1:${port}`, TEAMCODE_WORKSPACE: 'two-ws', TEAMCODE_TOKEN: 'tok', TEAMCODE_ROOT: proj, TEAMCODE_USER_ID: 'u1', TEAMCODE_USER_NAME: 'Uma', TEAMCODE_AGENT_NAME: "Uma's Claude Code", TEAMCODE_AGENT_ID: 'agt_cc_two' }));
  const cleanEnv = (sid) => { const env = { ...process.env, CLAUDE_CODE_SESSION_ID: sid, CLAUDECODE: '1' }; for (const k of Object.keys(env)) if (k.startsWith('TEAMCODE_') || k === 'CLAUDE_PID') delete env[k]; return env; };
  let nextId = 1;
  const mcp = (sid) => {
    const p = spawn(process.execPath, [path.join(ROOT, 'src/agent/mcp-server.js'), '--config', conf], { env: cleanEnv(sid), stdio: ['pipe', 'pipe', 'ignore'] });
    let buf = ''; const waiting = new Map();
    p.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); try { const m = JSON.parse(line); waiting.get(m.id)?.(m); } catch { /* not ours */ } } });
    const tool = (name, args) => new Promise((res) => { const id = nextId++; waiting.set(id, (m) => res(m.result.content[0].text)); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) + '\n'); });
    return { p, tool, exited: new Promise((r) => p.on('exit', r)) };
  };
  const hook = (sid, input) => new Promise((res) => {
    const h = spawn(process.execPath, [path.join(ROOT, 'src/agent/hook.js'), '--config', conf], { env: cleanEnv(sid), stdio: ['pipe', 'ignore', 'ignore'] });
    h.on('exit', res); h.stdin.end(JSON.stringify(input));
  });
  const T1 = SW.call('createTask', { title: 'Export' }, user);
  const T2 = SW.call('createTask', { title: 'Docs' }, user);
  const A = mcp('aaaaaaaa-0000-4000-8000-000000000001');
  const B = mcp('bbbbbbbb-0000-4000-8000-000000000002');
  await A.tool('update_task_status', { status: 'started', task_id: T1.id });
  await B.tool('update_task_status', { status: 'started', task_id: T2.id });
  const ids = Object.keys(SW.state.agents).filter((k) => k.startsWith('agt_cc_two_'));
  assert.equal(ids.length, 2, 'one agent per session');
  assert.equal(SW.state.tasks[T1.id].status, 'running');
  assert.equal(SW.state.tasks[T2.id].status, 'running');
  assert.notEqual(SW.state.tasks[T1.id].assignee, SW.state.tasks[T2.id].assignee);
  assert.match(await B.tool('update_task_status', { status: 'started', task_id: T1.id }), /working on this task/, 'B cannot take A\'s task');
  // B's hooks attribute B's edits to B's task only.
  fs.writeFileSync(path.join(proj, 'docs.md'), 'docs');
  await hook('bbbbbbbb-0000-4000-8000-000000000002', { hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: path.join(proj, 'docs.md') }, cwd: proj });
  assert.ok(SW.state.tasks[T2.id].changes?.['docs.md']);
  assert.ok(!SW.state.tasks[T1.id].changes?.['docs.md']);
  // Session A closes: only its task goes back to the queue.
  await hook('aaaaaaaa-0000-4000-8000-000000000001', { hook_event_name: 'SessionEnd', reason: 'prompt_input_exit', cwd: proj });
  assert.equal(SW.state.tasks[T1.id].status, 'ready');
  assert.equal(SW.state.tasks[T2.id].status, 'running');
  assert.match(await B.tool('update_task_status', { status: 'completed', summary: 'docs done' }), /"status": "done"/);
  A.p.stdin.end(); B.p.stdin.end();
  await Promise.all([A.exited, B.exited]);
  await server.close?.();
});

test('a released blocked task whose blocker was resolved meanwhile resumes as running', () => {
  const c = new Coordinator({ dataDir: tmp() });
  const W = c.ensureWorkspace('unblk-ws', { name: 'U' });
  const t = W.call('createTask', { title: 'Job' }, user);
  startOn(W, 'agt_ub', t.id, { taskId: t.id });
  const b = W.call('reportBlocker', { agentId: 'agt_ub', description: 'need the API' }, user);
  goOffline(W, 'agt_ub');
  W.call('resolveBlocker', { blockerId: b.id, resolution: 'API is up' }, user);
  W.call('heartbeat', { agentId: 'agt_ub' }, user);
  assert.equal(W.state.tasks[t.id].status, 'running');
  assert.equal(W.state.agents.agt_ub.status, 'working');
  c.close();
});

test('someone else\'s edit stays visible to Revert after history trimming drops it', () => {
  const c = new Coordinator({ dataDir: tmp() });
  const W = c.ensureWorkspace('others-ws', { name: 'O' });
  const bo = { user: { id: 'u2', name: 'Bo' } };
  W.call('filePut', { path: 'a.js', baseVersion: 0, contentB64: b64('original') }, user);
  const t = W.call('createTask', { title: 'Edit a', mode: 'shared' }, user);
  startOn(W, 'agt_o', t.id, { taskId: t.id });
  const edit = (text) => { W.call('fileEdited', { agentId: 'agt_o', path: 'a.js', hash: sha(text) }, user); W.call('filePut', { path: 'a.js', baseVersion: W.state.files['a.js'].version, contentB64: b64(text) }, user); };
  edit('agent 1');
  W.call('filePut', { path: 'a.js', baseVersion: W.state.files['a.js'].version, contentB64: b64('bo was here') }, bo);
  for (let i = 0; i < 35; i++) edit(`agent ${i + 2}`);
  assert.ok(!W.state.files['a.js'].history.some((h) => h.by.name === 'Bo'), 'Bo\'s version left history');
  assert.deepEqual(W.call('taskChanges', { taskId: t.id }, user)[0].changedByOthersSince, ['Bo']);
  c.close();
});

test('the agent\'s own synced edit is not mistaken for someone else\'s on a later edit', () => {
  const c = new Coordinator({ dataDir: tmp() });
  const W = c.ensureWorkspace('own-ws', { name: 'O' });
  W.call('filePut', { path: 'a.js', baseVersion: 0, contentB64: b64('original') }, user);
  const t = W.call('createTask', { title: 'Edit a', mode: 'shared' }, user);
  startOn(W, 'agt_own', t.id, { taskId: t.id });
  W.call('fileEdited', { agentId: 'agt_own', path: 'a.js', hash: sha('one') }, user);
  W.call('filePut', { path: 'a.js', baseVersion: 1, contentB64: b64('one') }, user);
  W.call('filePut', { path: 'a.js', baseVersion: 2, contentB64: b64('two') }, user); // sync first this time
  W.call('fileEdited', { agentId: 'agt_own', path: 'a.js', hash: sha('two') }, user);
  assert.deepEqual(W.call('taskChanges', { taskId: t.id }, user)[0].changedByOthersSince, []);
  c.close();
});

test('change records saved by an older server are converted at load: gaps count as someone else, new edits by the task do not', () => {
  const dir = tmp();
  let c = new Coordinator({ dataDir: dir });
  let W = c.ensureWorkspace('legacy-ws', { name: 'L' });
  W.call('filePut', { path: 'gap.js', baseVersion: 0, contentB64: b64('original') }, user);
  W.call('filePut', { path: 'clean.js', baseVersion: 0, contentB64: b64('original') }, user);
  const t = W.call('createTask', { title: 'Old', mode: 'shared' }, user);
  startOn(W, 'agt_l', t.id, { taskId: t.id });
  W.call('fileEdited', { agentId: 'agt_l', path: 'gap.js', hash: sha('x') }, user);
  W.call('fileEdited', { agentId: 'agt_l', path: 'clean.js', hash: sha('x') }, user);
  for (let i = 0; i < 40; i++) W.call('filePut', { path: 'gap.js', baseVersion: W.state.files['gap.js'].version, contentB64: b64(`v${i}`) }, { user: { id: 'u2', name: 'Bo' } });
  for (const r of Object.values(W.state.tasks[t.id].changes)) delete r.others; // as an older server saved them
  W.saveNow(); c.close();
  c = new Coordinator({ dataDir: dir });
  W = c.ensureWorkspace('legacy-ws', { name: 'L' });
  const byPath = () => Object.fromEntries(W.call('taskChanges', { taskId: t.id }, user).map((x) => [x.path, x.changedByOthersSince]));
  assert.ok(byPath()['gap.js'].length > 0, 'trimmed history might have hidden someone else');
  assert.deepEqual(byPath()['clean.js'], []);
  const edit = (text) => { W.call('fileEdited', { agentId: 'agt_l', path: 'clean.js', hash: sha(text) }, user); W.call('filePut', { path: 'clean.js', baseVersion: W.state.files['clean.js'].version, contentB64: b64(text) }, user); };
  for (let i = 0; i < 35; i++) edit(`mine ${i}`);
  assert.deepEqual(byPath()['clean.js'], [], 'the task\'s own edits after the upgrade are not someone else\'s');
  c.close();
});

test('a fixed-id client\'s later work counts as someone else\'s on its earlier task', () => {
  const c = new Coordinator({ dataDir: tmp() });
  const W = c.ensureWorkspace('later-ws', { name: 'L' });
  W.call('filePut', { path: 'a.js', baseVersion: 0, contentB64: b64('original') }, user);
  const t1 = W.call('createTask', { title: 'One', mode: 'shared' }, user);
  W.call('registerAgent', { agentId: 'agt_cc_l', name: 'Uma\'s Claude Code' }, user);
  W.call('startTask', { taskId: t1.id, agentId: 'agt_cc_l' }, user);
  const edit = (text) => { W.call('fileEdited', { agentId: 'agt_cc_l', path: 'a.js', hash: sha(text) }, user); W.call('filePut', { path: 'a.js', baseVersion: W.state.files['a.js'].version, contentB64: b64(text) }, user); };
  edit('for one');
  W.call('completeTask', { agentId: 'agt_cc_l', taskId: t1.id, summary: 'ok' }, user);
  const t2 = W.call('createTask', { title: 'Two', mode: 'shared' }, user);
  W.call('startTask', { taskId: t2.id, agentId: 'agt_cc_l' }, user);
  edit('for two');
  assert.ok(W.call('taskChanges', { taskId: t1.id }, user)[0].changedByOthersSince.length > 0, 'Revert of One must not wipe Two\'s work');
  assert.deepEqual(W.call('taskChanges', { taskId: t2.id }, user)[0].changedByOthersSince, []);
  c.close();
});

test('a clean integration check closes every open merge record of the task, including ones from an older server', () => {
  const c = new Coordinator({ dataDir: tmp() });
  const W = c.ensureWorkspace('merge2-ws', { name: 'M' });
  const t = W.call('createTask', { title: 'Branch', mode: 'isolated' }, user);
  W.state.conflicts.c_old = { id: 'c_old', kind: 'merge', taskId: t.id, status: 'resolved', path: 'a.js', files: ['a.js'], at: 1 };
  W.state.conflicts.c_new = { id: 'c_new', kind: 'merge', taskId: t.id, status: 'open', path: 'a.js', files: ['a.js'], at: 2 };
  W.call('integrationChecked', { taskId: t.id, conflicts: [] }, user);
  assert.equal(W.state.conflicts.c_new.status, 'resolved');
  c.close();
});

test('a retried stale write is recognised even when the first attempt was credited to the agent', () => {
  const c = new Coordinator({ dataDir: tmp() });
  const W = c.ensureWorkspace('retry-ws', { name: 'R' });
  W.call('filePut', { path: 'x.js', baseVersion: 0, contentB64: b64('v1') }, user);
  W.call('filePut', { path: 'x.js', baseVersion: 1, contentB64: b64('v2') }, { user: { id: 'u2', name: 'Bo' } });
  const t = W.call('createTask', { title: 'T', mode: 'shared' }, user);
  startOn(W, 'agt_r', t.id, { taskId: t.id });
  W.call('fileEdited', { agentId: 'agt_r', path: 'x.js', hash: sha('agent') }, user); // hook first: claim
  const r1 = W.call('filePut', { path: 'x.js', baseVersion: 1, contentB64: b64('agent') }, user);
  const r2 = W.call('filePut', { path: 'x.js', baseVersion: 1, contentB64: b64('agent') }, user);
  assert.equal(r1.ok, false);
  assert.equal(r1.conflict, r2.conflict);
  c.close();
});

test('caller-sized text is clipped and hashes validated, so allowed operations cannot store huge values', () => {
  const c = new Coordinator({ dataDir: tmp() });
  const W = c.ensureWorkspace('clip-ws', { name: 'C' });
  W.call('filePut', { path: 'a.js', baseVersion: 0, contentB64: b64('x') }, user);
  const t = W.call('createTask', { title: 'T' }, user);
  startOn(W, 'agt_c', t.id, { taskId: t.id });
  W.call('agentRead', { agentId: 'agt_c', path: 'a.js', hash: 'h'.repeat(60000) }, user);
  assert.equal(W.state.agents.agt_c.reads['a.js'].hash, null);
  W.call('announceEdit', { agentId: 'agt_c', paths: ['a.js'], intent: 'i'.repeat(60000) }, user);
  assert.ok(W.state.reservations['a.js'].agt_c.intent.length <= 500);
  W.call('requestReview', { agentId: 'agt_c', taskId: t.id, summary: 's'.repeat(60000), stats: { files: 2, junk: 'j'.repeat(60000) } }, user);
  assert.ok(W.state.tasks[t.id].review.summary.length <= 4000);
  assert.deepEqual(W.state.tasks[t.id].review.stats, { files: 2, insertions: 0, deletions: 0 });
  W.call('integrationChecked', { taskId: t.id, conflicts: ['c'.repeat(60000)], risks: [{ kind: 'k', message: 'm'.repeat(60000) }] }, user);
  assert.ok(JSON.stringify(W.state.tasks[t.id].integration).length < 5000);
  assert.throws(() => W.call('resolveConflict', { conflictId: 'nope', resolution: 'x' }, user));
  c.close();
});

test('repeated conflicts reuse their records: merge checks, retried stale writes, and overlap notices', () => {
  const c = new Coordinator({ dataDir: tmp() });
  const W = c.ensureWorkspace('reuse-ws', { name: 'R' });
  const t = W.call('createTask', { title: 'Branch', mode: 'isolated' }, user);
  for (let i = 0; i < 5; i++) {
    W.call('integrationChecked', { taskId: t.id, conflicts: ['a.js'] }, user);
    W.call('integrationChecked', { taskId: t.id, conflicts: [] }, user);
  }
  W.call('integrationChecked', { taskId: t.id, conflicts: ['a.js'] }, user);
  const merges = Object.values(W.state.conflicts).filter((x) => x.kind === 'merge');
  assert.equal(merges.length, 1);
  assert.equal(merges[0].status, 'open');
  W.call('filePut', { path: 'x.js', baseVersion: 0, contentB64: b64('v1') }, user);
  W.call('filePut', { path: 'x.js', baseVersion: 1, contentB64: b64('v2') }, user);
  const bo = { user: { id: 'u2', name: 'Bo' } };
  const r1 = W.call('filePut', { path: 'x.js', baseVersion: 1, contentB64: b64('stale') }, bo);
  const r2 = W.call('filePut', { path: 'x.js', baseVersion: 1, contentB64: b64('stale') }, bo);
  assert.equal(r1.conflict, r2.conflict, 'a retried stale write reuses its conflict');
  W.call('filePut', { path: 'o.js', baseVersion: 0, contentB64: b64('o') }, user);
  W.call('registerAgent', { agentId: 'agt_1', name: 'One' }, user);
  W.call('registerAgent', { agentId: 'agt_2', name: 'Two' }, user);
  W.call('announceEdit', { agentId: 'agt_1', paths: ['o.js'] }, user);
  for (let i = 0; i < 3; i++) { W.overlapKeys.clear(); W.call('announceEdit', { agentId: 'agt_2', paths: ['o.js'] }, user); }
  const notices = () => Object.values(W.state.conflicts).filter((x) => x.kind === 'overlap');
  assert.equal(notices().length, 1);
  notices()[0].at -= 2 * 24 * 3600 * 1000;
  W._prunedAt = 0; W.sweep();
  assert.equal(notices().length, 0, 'old overlap notices are pruned');
  c.close();
});

test('people can still join a project at the storage ceiling; a project caps how many people it remembers', async () => {
  const c = new Coordinator({ dataDir: tmp(), limits: { maxBytes: 200 * 1024 } });
  const W = c.ensureWorkspace('join-ws', { name: 'J' });
  W.metaBytes = 150 * 1024; // over the ceiling
  W.call('userJoined', { user: { id: 'u_new', name: 'New' } }, user);
  for (let i = Object.keys(W.state.users).length; i < 500; i++) W.state.users[`u${i}x`] = { id: `u${i}x`, name: 'x' };
  assert.throws(() => W.call('userJoined', { user: { id: 'u_501', name: 'Late' } }, user), (e) => e.code === 'full');
  // Over WebSocket the refusal comes before any snapshot, and the desktop stops retrying.
  const { TeamServer } = require('../../server/server');
  const WebSocket = require('ws');
  const server = new TeamServer({ dataDir: tmp() });
  const port = await server.listen(0, '127.0.0.1');
  const SW = server.coordinator.ensureWorkspace('full-ppl', { name: 'F', token: 'tok' });
  for (let i = 0; i < 500; i++) SW.state.users[`p${i}`] = { id: `p${i}`, name: 'x' };
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const msgs = [];
  await new Promise((resolve) => {
    ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', workspace: 'full-ppl', token: 'tok', user: { id: 'stranger', name: 'S' } })));
    ws.on('message', (m) => msgs.push(JSON.parse(m.toString()).t));
    ws.on('close', resolve);
  });
  assert.deepEqual(msgs, ['error']);
  await server.close?.();
  c.close();
});

test('Stop on a task the server already put back in the queue turns off auto-start; a handoff in progress blocks auto-start', async () => {
  const { AgentManager } = require('../../src/main/agents');
  const calls = [];
  const fake = {
    meta: { agt_s: { taskId: 't1' } },
    running: new Map(),
    conn: { call: async (op, args) => { calls.push([op, args]); return op === 'snapshot' ? { tasks: { t1: { id: 't1', status: 'ready', assignee: 'agt_s', autoStart: true } } } : {}; } },
    getState: () => null, log: () => {}, emit: () => {},
  };
  const run = { stopping: true, handoff: false };
  await AgentManager.prototype._onExit.call(fake, 'agt_s', run, 0, '');
  const ops = calls.map(([op]) => op);
  assert.deepEqual(calls.find(([op]) => op === 'updateTask')[1], { taskId: 't1', autoStart: false });
  assert.ok(!ops.includes('reopenTask'), 'already in the queue: nothing to reopen');
  assert.equal(ops.at(-1), 'agentExited', 'reported gone only after auto-start is off');
  const mgr = Object.create(AgentManager.prototype);
  Object.assign(mgr, { meta: {}, handingOff: new Set(['t9']) });
  assert.ok(mgr.handedOffTasks().has('t9'));
});

// ---- round 10: identity per Claude Code process ----
// Every process a rig starts is stopped when the file's tests end, even after a failed assertion.
const rigChildren = new Set(), rigServers = new Set();
test.after(() => {
  for (const p of rigChildren) try { p.kill('SIGKILL'); } catch { /* gone */ }
  for (const srv of rigServers) try { srv.close(); } catch { /* closed */ }
});

async function claudeRig(name) {
  const { TeamServer } = require('../../server/server');
  const { spawn } = require('child_process');
  const ROOT = path.join(__dirname, '..', '..');
  const dir = tmp();
  const server = new TeamServer({ dataDir: path.join(dir, 'srv') });
  const port = await server.listen(0, '127.0.0.1');
  rigServers.add(server);
  const SW = server.coordinator.ensureWorkspace(`${name}-ws`, { name, token: 'tok' });
  const proj = path.join(dir, 'proj'); fs.mkdirSync(proj);
  const conf = path.join(dir, 'claude-code.json');
  fs.writeFileSync(conf, JSON.stringify({ TEAMCODE_URL: `http://127.0.0.1:${port}`, TEAMCODE_WORKSPACE: `${name}-ws`, TEAMCODE_TOKEN: 'tok', TEAMCODE_ROOT: proj, TEAMCODE_USER_ID: 'u1', TEAMCODE_USER_NAME: 'Uma', TEAMCODE_AGENT_NAME: "Uma's Claude Code", TEAMCODE_AGENT_ID: 'agt_cc_rig' }));
  const env = (sid, extra = {}) => { const e = { ...process.env, CLAUDECODE: '1', ...extra }; for (const k of Object.keys(e)) if (k.startsWith('TEAMCODE_') || k === 'CLAUDE_PID' || k === 'CLAUDE_CODE_SESSION_ID') delete e[k]; if (sid) e.CLAUDE_CODE_SESSION_ID = sid; Object.assign(e, extra); return e; };
  let nextId = 1;
  const mcpWithEnv = (e, args = [path.join(ROOT, 'src/agent/mcp-server.js'), '--config', conf]) => {
    const p = spawn(process.execPath, args, { env: e, stdio: ['pipe', 'pipe', 'ignore'] });
    rigChildren.add(p); p.on('exit', () => rigChildren.delete(p));
    let buf = ''; const waiting = new Map();
    p.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); try { const m = JSON.parse(line); waiting.get(m.id)?.(m); } catch { /* not ours */ } } });
    const tool = (tname, args) => new Promise((res) => { const id = nextId++; waiting.set(id, (m) => res(m.result.content[0].text)); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: tname, arguments: args } }) + '\n'); });
    return { p, tool, exited: new Promise((r) => p.on('exit', r)), quit() { p.stdin.end(); return this.exited; } };
  };
  const mcp = (sid) => mcpWithEnv(env(sid));
  // Hooks of the Claude Code process whose child the MCP servers are (this test process).
  const hook = (sid, input, pid = process.pid) => new Promise((res) => {
    const h = spawn(process.execPath, [path.join(ROOT, 'src/agent/hook.js'), '--config', conf], { env: env(sid, { CLAUDE_PID: String(pid) }), stdio: ['pipe', 'pipe', 'ignore'] });
    let out = ''; h.stdout.on('data', (d) => { out += d; });
    h.on('exit', () => res(out)); h.stdin.end(JSON.stringify({ session_id: sid, cwd: proj, ...input }));
  });
  const agents = () => Object.values(SW.state.agents).filter((a) => a.id.startsWith('agt_cc_rig'));
  return { server, SW, proj, conf, mcp, mcpWithEnv, hook, agents, close: () => server.close?.() };
}

test('/clear: same agent, the old task goes back to the queue and the new conversation is told; picking it up again records its edits', async () => {
  const r = await claudeRig('clear');
  const T = r.SW.call('createTask', { title: 'Export CSV' }, user);
  r.SW.call('updateTask', { taskId: T.id, autoStart: true, runner: 'u1' }, user);
  const A = 'aaaaaaaa-0000-4000-8000-00000000000a', B = 'bbbbbbbb-0000-4000-8000-00000000000b';
  const m = r.mcp(A);
  await m.tool('team_status', {});
  await r.hook(A, { hook_event_name: 'SessionStart', source: 'startup' });
  await m.tool('update_task_status', { status: 'started', task_id: T.id });
  await r.hook(A, { hook_event_name: 'SessionEnd', reason: 'clear' });
  const brief = await r.hook(B, { hook_event_name: 'SessionStart', source: 'clear' });
  assert.match(brief, /\(aaaa\)/, 'same agent as the MCP server');
  assert.match(brief, /Export CSV/, 'told about the task it left');
  assert.equal(r.SW.state.tasks[T.id].status, 'ready');
  assert.equal(r.SW.state.tasks[T.id].autoStart, false, 'not restarted by itself');
  fs.writeFileSync(path.join(r.proj, 'readme.md'), 'other work');
  await r.hook(B, { hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: path.join(r.proj, 'readme.md') } });
  assert.ok(!r.SW.state.tasks[T.id].changes?.['readme.md'], 'unrelated work after /clear is not the task\'s');
  await m.tool('update_task_status', { status: 'started', task_id: T.id }); // the person wants to carry on
  fs.writeFileSync(path.join(r.proj, 'export.js'), 'export');
  await r.hook(B, { hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: path.join(r.proj, 'export.js') } });
  assert.ok(r.SW.state.tasks[T.id].changes?.['export.js']);
  assert.equal(r.agents().length, 1, 'still one agent');
  // Quitting afterwards ends that agent (the SessionEnd hook finds it although the session id changed).
  await m.quit();
  await r.hook(B, { hook_event_name: 'SessionEnd', reason: 'prompt_input_exit' });
  assert.equal(r.agents()[0].status, 'done');
  await r.close();
});

test('/clear and then a restart of the MCP server: still the same agent, and it carries on with its task', async () => {
  const r = await claudeRig('clrmcp');
  const T = r.SW.call('createTask', { title: 'Job' }, user);
  const A = 'aaaaaaaa-1111-4000-8000-00000000000a', B = 'bbbbbbbb-1111-4000-8000-00000000000b';
  const m1 = r.mcp(A);
  await m1.tool('team_status', {});
  await r.hook(A, { hook_event_name: 'SessionEnd', reason: 'clear' });
  await r.hook(B, { hook_event_name: 'SessionStart', source: 'clear' });
  await m1.tool('update_task_status', { status: 'started', task_id: T.id });
  await m1.quit(); // /mcp reconnect
  const m2 = r.mcp(B); // Claude Code gives the new server the current session id
  await m2.tool('team_status', {});
  assert.equal(r.agents().length, 1);
  assert.equal(r.SW.state.tasks[T.id].status, 'running');
  fs.writeFileSync(path.join(r.proj, 'b.js'), 'b');
  await r.hook(B, { hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: path.join(r.proj, 'b.js') } });
  assert.ok(r.SW.state.tasks[T.id].changes?.['b.js']);
  assert.match(await m2.tool('update_task_status', { status: 'completed', summary: 'ok' }), /"status": "done"/);
  await m2.quit();
  await r.close();
});

test('an MCP client that is not Claude Code: after a restart its task is offered back, and it carries on explicitly', async () => {
  const r = await claudeRig('other');
  const T = r.SW.call('createTask', { title: 'Job' }, user);
  const spawnOther = () => {
    const env = { ...process.env }; for (const k of Object.keys(env)) if (k.startsWith('TEAMCODE_') || k.startsWith('CLAUDE')) delete env[k];
    return r.mcpWithEnv(env);
  };
  const c1 = spawnOther();
  await c1.tool('update_task_status', { status: 'started', task_id: T.id });
  await c1.quit();
  const c2 = spawnOther();
  assert.match(await c2.tool('team_status', {}), /tasksYouLeft[\s\S]*Job/);
  await c2.tool('update_task_status', { status: 'started', task_id: T.id });
  assert.match(await c2.tool('update_task_status', { status: 'completed', summary: 'ok' }), /"status": "done"/);
  await c2.quit();
  await r.close();
});

test('a new session gets the updates its predecessor missed, and coordination addressed by plain name reaches it', () => {
  const c = new Coordinator({ dataDir: tmp() });
  const W = c.ensureWorkspace('succ-ws', { name: 'S' });
  W.call('registerAgent', { agentId: 'agt_cc_p_1', name: "Uma's Claude Code (aaaa)", perSession: true, baseId: 'agt_cc_p' }, user);
  W.call('agentRead', { agentId: 'agt_cc_p_1', path: 'api.js', hash: null }, user);
  W.call('agentExited', { agentId: 'agt_cc_p_1', outcome: 'done' }, user);
  W.call('registerAgent', { agentId: 'agt_bob', name: 'Bob' }, user);
  W.call('publishContract', { agentId: 'agt_bob', name: 'export API', content: 'persist()' }, user);
  W.call('registerAgent', { agentId: 'agt_cc_p_2', name: "Uma's Claude Code (bbbb)", perSession: true, baseId: 'agt_cc_p' }, user);
  assert.ok(W.call('pullDigest', { agentId: 'agt_cc_p_2', force: true }, user).text.includes('export API'), 'missed contract delivered');
  W.call('requestCoordination', { agentId: 'agt_bob', to: "Uma's Claude Code", subject: 'rename', message: 'save() is now persist()' }, user);
  assert.equal(W.state.coordination.at(-1).to, 'agt_cc_p_2', 'the live session gets it');
  c.close();
});

test('a new Claude Code session can join a full project; finished sessions are pruned and cost snapshots nothing', () => {
  const c = new Coordinator({ dataDir: tmp(), limits: { maxBytes: 200 * 1024 } });
  const W = c.ensureWorkspace('fullsess-ws', { name: 'F' });
  W.metaBytes = 150 * 1024; // over the ceiling
  W.call('registerAgent', { agentId: 'agt_cc_f_1', name: 'U (1)', perSession: true, baseId: 'agt_cc_f' }, user);
  assert.throws(() => W.call('registerAgent', { agentId: 'agt_other', name: 'X' }, user), /storage limit/);
  W.call('agentExited', { agentId: 'agt_cc_f_1', outcome: 'done' }, user);
  assert.equal(W.call('snapshot', {}, user).agents.agt_cc_f_1.pendingEvents, 0);
  W.state.agents.agt_cc_f_1.lastSeen = Date.now() - 2 * 24 * 3600 * 1000;
  W._prunedAt = 0; W.sweep();
  assert.equal(W.state.agents.agt_cc_f_1, undefined);
  c.close();
});

test('a request addressed to one Claude Code window stays with it; once that window has closed, the newest live one gets it', () => {
  const c = new Coordinator({ dataDir: tmp() });
  const W = c.ensureWorkspace('route-ws', { name: 'R' });
  W.call('registerAgent', { agentId: 'agt_cc_q_a', name: "Uma's Claude Code (aaaa)", perSession: true, baseId: 'agt_cc_q' }, user);
  W.call('registerAgent', { agentId: 'agt_cc_q_b', name: "Uma's Claude Code (bbbb)", perSession: true, baseId: 'agt_cc_q' }, user);
  W.call('registerAgent', { agentId: 'agt_bob', name: 'Bob' }, user);
  W.call('pullDigest', { agentId: 'agt_cc_q_b', force: true }, user);
  W.call('requestCoordination', { agentId: 'agt_bob', to: "Uma's Claude Code (aaaa)", subject: 'a', message: 'window A please rename' }, user);
  assert.ok(!(W.call('pullDigest', { agentId: 'agt_cc_q_b', force: true }, user).text || '').includes('window A please'), 'the other window is not involved');
  W.call('agentExited', { agentId: 'agt_cc_q_a', outcome: 'done' }, user);
  W.call('requestCoordination', { agentId: 'agt_bob', to: 'agt_cc_q_a', subject: 'b', message: 'are you there' }, user);
  assert.ok(W.call('pullDigest', { agentId: 'agt_cc_q_b', force: true }, user).text.includes('are you there'), 'the closed window\'s request reaches the live one');
  c.close();
});

test('a sleeping Claude Code session is kept; agent records stay small even when registered past the storage gate', () => {
  const c = new Coordinator({ dataDir: tmp(), limits: { maxBytes: 4 * 1024 * 1024 } });
  const W = c.ensureWorkspace('keep2-ws', { name: 'K' });
  W.call('registerAgent', { agentId: 'agt_cc_k_1', name: 'U (1)', perSession: true, baseId: 'agt_cc_k' }, user);
  goOffline(W, 'agt_cc_k_1');
  W.state.agents.agt_cc_k_1.lastSeen = Date.now() - 2 * 24 * 3600 * 1000;
  W._prunedAt = 0; W.sweep();
  assert.ok(W.state.agents.agt_cc_k_1, 'asleep, not finished: kept');
  const big = 'x'.repeat(60000);
  W.call('registerAgent', { agentId: 'agt_cc_k_2', name: big, client: big, cwd: big, branch: big, mode: big, userId: big, perSession: true, baseId: 'agt_cc_k' }, user);
  assert.ok(JSON.stringify(W.state.agents.agt_cc_k_2).length < 3000);
  c.close();
});

// ---- round 12: one record per Claude Code process ----
test('a window that resumes another window\'s conversation stays its own agent, and quitting it leaves the other alone', async () => {
  const r = await claudeRig('resume2');
  const A = 'aaaaaaaa-2222-4000-8000-00000000000a', B = 'bbbbbbbb-2222-4000-8000-00000000000b', D = 'dddddddd-2222-4000-8000-00000000000d';
  const W1 = 11111, W2 = 22222;
  await r.hook(A, { hook_event_name: 'SessionStart', source: 'startup' }, W1);
  await r.hook(A, { hook_event_name: 'SessionEnd', reason: 'clear' }, W1);
  await r.hook(B, { hook_event_name: 'SessionStart', source: 'clear' }, W1);
  await r.hook(D, { hook_event_name: 'SessionStart', source: 'startup' }, W2);
  await r.hook(D, { hook_event_name: 'SessionEnd', reason: 'resume' }, W2);
  await r.hook(A, { hook_event_name: 'SessionStart', source: 'resume' }, W2); // W2 opens W1's old conversation
  fs.writeFileSync(path.join(r.proj, 'w2.js'), 'w2');
  await r.hook(A, { hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: path.join(r.proj, 'w2.js') } }, W2);
  const w1 = r.agents().find((a) => a.name.endsWith('(aaaa)')), w2 = r.agents().find((a) => a.name.endsWith('(dddd)'));
  assert.ok(w1 && w2 && w1.id !== w2.id);
  assert.ok(w2.edited['w2.js'] && !w1.edited['w2.js'], 'W2\'s edit is W2\'s');
  await r.hook(A, { hook_event_name: 'SessionEnd', reason: 'prompt_input_exit' }, W2);
  assert.equal(r.SW.state.agents[w2.id].status, 'done');
  assert.equal(r.SW.state.agents[w1.id].status, 'working', 'W1 is untouched');
  await r.close();
});

test('claude --continue in a new terminal does not take the live window\'s agent or its task', async () => {
  const r = await claudeRig('continue');
  const T = r.SW.call('createTask', { title: 'Job' }, user);
  const X = 'eeeeeeee-3333-4000-8000-00000000000e';
  const m = r.mcp(X); // window 1's server (this test process is window 1)
  await r.hook(X, { hook_event_name: 'SessionStart', source: 'startup' });
  await m.tool('update_task_status', { status: 'started', task_id: T.id });
  const brief = await r.hook(X, { hook_event_name: 'SessionStart', source: 'resume' }, 33333); // a new process, same conversation
  assert.ok(!/Before this conversation started/.test(brief), 'not told it left a task');
  assert.equal(r.SW.state.tasks[T.id].status, 'running');
  fs.writeFileSync(path.join(r.proj, 'p2.js'), 'p2');
  await r.hook(X, { hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: path.join(r.proj, 'p2.js') } }, 33333);
  assert.ok(!r.SW.state.tasks[T.id].changes?.['p2.js'], 'the new process\'s edits are not window 1\'s task');
  assert.equal(r.agents().length, 2);
  await m.quit();
  await r.close();
});

test('/clear after a server restart lets go of the task waiting for the agent, instead of quietly resuming it', async () => {
  const r = await claudeRig('clrwait');
  const T = r.SW.call('createTask', { title: 'Waiting job' }, user);
  r.SW.call('updateTask', { taskId: T.id, autoStart: true, runner: 'u1' }, user);
  const A = 'aaaaaaaa-4444-4000-8000-00000000000a', B = 'bbbbbbbb-4444-4000-8000-00000000000b';
  await r.hook(A, { hook_event_name: 'SessionStart', source: 'startup' });
  const m1 = r.mcp(A);
  await m1.tool('update_task_status', { status: 'started', task_id: T.id });
  await m1.quit(); // released, waiting for this agent
  assert.equal(r.SW.state.tasks[T.id].releasedFrom !== undefined, true);
  await r.hook(A, { hook_event_name: 'SessionEnd', reason: 'clear' });
  const brief = await r.hook(B, { hook_event_name: 'SessionStart', source: 'clear' });
  assert.match(brief, /Waiting job/);
  await r.hook(B, { hook_event_name: 'UserPromptSubmit' });
  assert.equal(r.SW.state.tasks[T.id].status, 'ready', 'not picked back up by the next hook');
  assert.equal(r.SW.state.tasks[T.id].autoStart, false);
  await r.close();
});

test('records of running windows are kept however old; records of dead processes go', () => {
  const { pruneProcs } = require('../../src/agent/api');
  const dir = tmp();
  const cfg = { sessionsDir: dir, baseAgentId: 'agt_cc_z' };
  const old = new Date(Date.now() - 10 * 24 * 3600 * 1000);
  for (const pid of [process.pid, 999999]) { fs.writeFileSync(path.join(dir, `proc-${pid}.json`), '{}'); fs.utimesSync(path.join(dir, `proc-${pid}.json`), old, old); }
  pruneProcs(cfg);
  assert.ok(fs.existsSync(path.join(dir, `proc-${process.pid}.json`)));
  assert.ok(!fs.existsSync(path.join(dir, 'proc-999999.json')));
});

test('a request sent to a window that closes unread goes to the window in use, or to the next one opened', () => {
  const c = new Coordinator({ dataDir: tmp() });
  const W = c.ensureWorkspace('handover-ws', { name: 'H' });
  W.call('registerAgent', { agentId: 'agt_cc_h_a', name: "Uma's Claude Code (aaaa)", perSession: true, baseId: 'agt_cc_h' }, user);
  W.call('registerAgent', { agentId: 'agt_cc_h_b', name: "Uma's Claude Code (bbbb)", perSession: true, baseId: 'agt_cc_h' }, user);
  W.call('registerAgent', { agentId: 'agt_bob', name: 'Bob' }, user);
  W.call('requestCoordination', { agentId: 'agt_bob', to: 'agt_cc_h_a', subject: 's', message: 'please leave api.ts alone' }, user);
  W.call('pullDigest', { agentId: 'agt_cc_h_b', force: true }, user); // B is busy and moves past it
  W.call('agentExited', { agentId: 'agt_cc_h_a', outcome: 'done' }, user); // A closes without reading it
  assert.ok(W.call('pullDigest', { agentId: 'agt_cc_h_b', force: true }, user).text.includes('please leave api.ts alone'));
  // No window open when the addressee closes: the next one opened gets it.
  W.call('requestCoordination', { agentId: 'agt_bob', to: 'agt_cc_h_b', subject: 's', message: 'ping second' }, user);
  W.call('agentExited', { agentId: 'agt_cc_h_b', outcome: 'done' }, user);
  W.call('registerAgent', { agentId: 'agt_cc_h_c', name: "Uma's Claude Code (cccc)", perSession: true, baseId: 'agt_cc_h' }, user);
  assert.ok(W.call('pullDigest', { agentId: 'agt_cc_h_c', force: true }, user).text.includes('ping second'));
  c.close();
});

// ---- round 13 ----
test('parallel hooks after /clear never tear the identity record', async () => {
  const r = await claudeRig('torn');
  const A = 'aaaaaaaa-5555-4000-8000-00000000000a', B = 'bbbbbbbb-5555-4000-8000-00000000000b';
  await r.hook(A, { hook_event_name: 'SessionStart', source: 'startup' });
  await r.hook(A, { hook_event_name: 'SessionEnd', reason: 'clear' });
  await r.hook(B, { hook_event_name: 'SessionStart', source: 'clear' });
  const rec = () => JSON.parse(fs.readFileSync(path.join(path.dirname(r.conf), 'sessions', `proc-${process.pid}.json`), 'utf8'));
  const id = rec().agentId;
  fs.writeFileSync(path.join(r.proj, 'f.js'), 'x');
  for (let batch = 0; batch < 15; batch++) {
    await Promise.all(Array.from({ length: 5 }, () => r.hook(B, { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: path.join(r.proj, 'f.js') } })));
  }
  assert.equal(rec().agentId, id, 'still the same agent');
  assert.equal(r.agents().length, 1);
  await r.close();
});

test('/resume back to an earlier conversation of the same window also lets go of the current task', async () => {
  const r = await claudeRig('resback');
  const A = 'aaaaaaaa-6666-4000-8000-00000000000a', B = 'bbbbbbbb-6666-4000-8000-00000000000b';
  await r.hook(A, { hook_event_name: 'SessionStart', source: 'startup' });
  await r.hook(A, { hook_event_name: 'SessionEnd', reason: 'clear' });
  await r.hook(B, { hook_event_name: 'SessionStart', source: 'clear' });
  const agentId = r.agents()[0].id;
  const T2 = r.SW.call('createTask', { title: 'Second job' }, user);
  r.SW.call('startTask', { taskId: T2.id, agentId }, user);
  await r.hook(B, { hook_event_name: 'SessionEnd', reason: 'resume' });
  const brief = await r.hook(A, { hook_event_name: 'SessionStart', source: 'resume' });
  assert.match(brief, /Second job/);
  assert.equal(r.SW.state.tasks[T2.id].status, 'ready');
  fs.writeFileSync(path.join(r.proj, 'x.js'), 'x');
  await r.hook(A, { hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: path.join(r.proj, 'x.js') } });
  assert.ok(!r.SW.state.tasks[T2.id].changes?.['x.js']);
  await r.close();
});

test('claude --continue on a live window\'s conversation gets a name of its own', async () => {
  const r = await claudeRig('cname');
  const X = 'eeeeeeee-7777-4000-8000-00000000000e';
  await r.hook(X, { hook_event_name: 'SessionStart', source: 'startup' }); // window 1 is this live process
  await r.hook(X, { hook_event_name: 'SessionStart', source: 'resume' }, 44444);
  const names = r.agents().map((a) => a.name);
  assert.equal(new Set(names).size, 2, names.join(' / '));
  await r.close();
});

test('a sleeping window keeps its unread updates and its requests; a closed window\'s requests wait for a sleeping sibling', () => {
  const c = new Coordinator({ dataDir: tmp() });
  const W = c.ensureWorkspace('sleep2-ws', { name: 'S' });
  W.call('registerAgent', { agentId: 'agt_cc_s_a', name: "Uma's Claude Code (aaaa)", perSession: true, baseId: 'agt_cc_s' }, user);
  W.call('registerAgent', { agentId: 'agt_cc_s_b', name: "Uma's Claude Code (bbbb)", perSession: true, baseId: 'agt_cc_s' }, user);
  W.call('registerAgent', { agentId: 'agt_bob', name: 'Bob' }, user);
  W.call('pullDigest', { agentId: 'agt_cc_s_a', force: true }, user);
  W.call('recordDecision', { agentId: 'agt_bob', title: 'IDs', decision: 'Use UUIDv7 everywhere' }, user);
  goOffline(W, 'agt_cc_s_a'); // A's laptop sleeps while B is in use
  W.call('heartbeat', { agentId: 'agt_cc_s_b' }, user);
  W.call('requestCoordination', { agentId: 'agt_bob', to: 'agt_cc_s_a', subject: 's', message: 'hold off on api.ts' }, user);
  W.call('heartbeat', { agentId: 'agt_cc_s_a' }, user); // A wakes
  const d = W.call('pullDigest', { agentId: 'agt_cc_s_a', force: true }, user).text;
  assert.ok(d.includes('UUIDv7'), 'its unread updates are still there');
  assert.ok(d.includes('hold off on api.ts'), 'the request addressed to it stayed with it');
  // A closes; B is asleep: a request to A waits for B.
  W.call('agentExited', { agentId: 'agt_cc_s_a', outcome: 'done' }, user);
  goOffline(W, 'agt_cc_s_b');
  W.call('requestCoordination', { agentId: 'agt_bob', to: "Uma's Claude Code (aaaa)", subject: 's', message: 'are you around' }, user);
  W.call('heartbeat', { agentId: 'agt_cc_s_b' }, user);
  assert.ok(W.call('pullDigest', { agentId: 'agt_cc_s_b', force: true }, user).text.includes('are you around'));
  c.close();
});

// ---- round 14 ----
test('/branch stays the same agent and keeps its task', async () => {
  const r = await claudeRig('branch');
  const T = r.SW.call('createTask', { title: 'Export CSV' }, user);
  const A = 'aaaaaaaa-8888-4000-8000-00000000000a', F = 'ffffffff-8888-4000-8000-00000000000f';
  const m = r.mcp(A);
  await r.hook(A, { hook_event_name: 'SessionStart', source: 'startup' });
  await m.tool('update_task_status', { status: 'started', task_id: T.id });
  await r.hook(A, { hook_event_name: 'SessionEnd', reason: 'resume' });
  const brief = await r.hook(F, { hook_event_name: 'SessionStart', source: 'fork' });
  assert.match(brief, /\(aaaa\)/);
  assert.equal(r.SW.state.tasks[T.id].status, 'running', 'the branch carries on with it');
  fs.writeFileSync(path.join(r.proj, 'export.js'), 'x');
  await r.hook(F, { hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: path.join(r.proj, 'export.js') } });
  assert.ok(r.SW.state.tasks[T.id].changes?.['export.js']);
  assert.equal(r.agents().length, 1);
  await m.quit();
  await r.close();
});

test('a window that has cleared many times still lists the session its MCP server started with', async () => {
  const r = await claudeRig('many');
  const sid = (i) => `${String(i).padStart(8, '0')}-9999-4000-8000-000000000000`;
  await r.hook(sid(0), { hook_event_name: 'SessionStart', source: 'startup' });
  for (let i = 1; i <= 25; i++) {
    await r.hook(sid(i - 1), { hook_event_name: 'SessionEnd', reason: 'clear' });
    await r.hook(sid(i), { hook_event_name: 'SessionStart', source: 'clear' });
  }
  const rec = JSON.parse(fs.readFileSync(path.join(path.dirname(r.conf), 'sessions', `proc-${process.pid}.json`), 'utf8'));
  assert.equal(rec.sids[0], sid(0));
  assert.ok(rec.sids.includes(sid(25)));
  await r.close();
});

test('another MCP client that quits and is opened again (a new process) carries on with its task', async () => {
  const r = await claudeRig('client');
  const { spawn } = require('child_process');
  const ROOT = path.join(__dirname, '..', '..');
  // Each "client" is its own process, with the MCP server as its child (as Cursor or Codex would run it).
  const client = () => {
    const env = { ...process.env }; for (const k of Object.keys(env)) if (k.startsWith('TEAMCODE_') || k.startsWith('CLAUDE')) delete env[k];
    const wrapper = `const c=require('child_process').spawn(process.execPath,[${JSON.stringify(path.join(ROOT, 'src/agent/mcp-server.js'))},'--config',${JSON.stringify(r.conf)}],{stdio:'inherit'});c.on('exit',(x)=>process.exit(x||0));`;
    return r.mcpWithEnv(env, ['-e', wrapper]);
  };
  const X = r.SW.call('createTask', { title: 'Login page' }, user);
  const w1 = client();
  await w1.tool('update_task_status', { status: 'started', task_id: X.id });
  await w1.quit(); // the client quits
  assert.equal(r.SW.state.tasks[X.id].status, 'ready');
  const w1b = client(); // and is opened again: a new process, so a new agent
  assert.match(await w1b.tool('team_status', {}), /tasksYouLeft[\s\S]*Login page/, 'told about the task it left');
  assert.match(await w1b.tool('update_task_status', { status: 'completed', summary: 'x' }), /not on a TeamCode task[\s\S]*Login page/, 'and reminded instead of an obscure error');
  await w1b.tool('update_task_status', { status: 'started', task_id: X.id }); // carries on, explicitly
  assert.match(await w1b.tool('update_task_status', { status: 'completed', summary: 'login page done' }), /"status": "done"/);
  await w1b.quit();
  await r.close();
});

test('requests for a crashed window reach the next window opened; a sleeping window keeps its own and a new window gets a copy', () => {
  const c = new Coordinator({ dataDir: tmp() });
  const W = c.ensureWorkspace('crash-ws', { name: 'C' });
  const reg = (id, n) => W.call('registerAgent', { agentId: id, name: `Uma's Claude Code (${n})`, perSession: true, baseId: 'agt_cc_c' }, user);
  reg('agt_cc_c_z', 'zzzz'); reg('agt_cc_c_a', 'aaaa');
  W.call('registerAgent', { agentId: 'agt_bob', name: 'Bob' }, user);
  goOffline(W, 'agt_cc_c_z'); // Z crashed (no SessionEnd)
  W.call('requestCoordination', { agentId: 'agt_bob', to: 'agt_cc_c_a', subject: 's', message: 'rename save() to persist()' }, user);
  W.call('agentExited', { agentId: 'agt_cc_c_a', outcome: 'done' }, user); // A quits normally, unread
  W.call('requestCoordination', { agentId: 'agt_bob', to: 'agt_cc_c_z', subject: 's', message: 'do not touch db.ts' }, user);
  reg('agt_cc_c_c', 'cccc'); // the next morning
  const d = W.call('pullDigest', { agentId: 'agt_cc_c_c', force: true }, user).text;
  assert.ok(d.includes('rename save()'), 'the closed window\'s request moved to the new one');
  assert.ok(d.includes('do not touch db.ts'), 'a copy of the sleeping window\'s request');
  W.call('heartbeat', { agentId: 'agt_cc_c_z' }, user); // Z was only asleep after all
  assert.ok(W.call('pullDigest', { agentId: 'agt_cc_c_z', force: true }, user).text.includes('do not touch db.ts'), 'and it still has its own');
  c.close();
});

// ---- round 15 ----
test('each request reaches each window once: moved back to its first window, copied at most once, kept until a window takes it', () => {
  const c = new Coordinator({ dataDir: tmp() });
  const W = c.ensureWorkspace('once-ws', { name: 'O' });
  const reg = (id) => W.call('registerAgent', { agentId: id, name: `Uma's Claude Code (${id.slice(-4)})`, perSession: true, baseId: 'agt_cc_o' }, user);
  W.call('registerAgent', { agentId: 'agt_bob', name: 'Bob' }, user);
  const count = (id, text) => (W.call('pullDigest', { agentId: id, force: true }, user).text.match(new RegExp(text, 'g')) || []).length;
  // Moved away and back: once.
  reg('agt_cc_o_oooo'); reg('agt_cc_o_hhhh');
  W.call('requestCoordination', { agentId: 'agt_bob', to: 'agt_cc_o_oooo', subject: 's', message: 'first request' }, user);
  W.call('agentExited', { agentId: 'agt_cc_o_oooo', outcome: 'done' }, user); // moves to H
  W.call('agentExited', { agentId: 'agt_cc_o_hhhh', outcome: 'done' }, user); // H closes unread too
  W.call('heartbeat', { agentId: 'agt_cc_o_oooo' }, user); // O resumed (same conversation, same agent)
  W.state.agents.agt_cc_o_oooo.status = 'working';
  W._handOverRequests(W.state.agents.agt_cc_o_hhhh, W.state.agents.agt_cc_o_oooo);
  assert.equal(count('agt_cc_o_oooo', 'first request'), 1);
  // A crashed window's request: one copy, to the first window opened after it.
  reg('agt_cc_o_zzzz');
  W.call('requestCoordination', { agentId: 'agt_bob', to: 'agt_cc_o_zzzz', subject: 's', message: 'crashed request' }, user);
  goOffline(W, 'agt_cc_o_zzzz');
  reg('agt_cc_o_cccc'); reg('agt_cc_o_dddd');
  assert.equal(count('agt_cc_o_cccc', 'crashed request'), 1);
  assert.equal(count('agt_cc_o_dddd', 'crashed request'), 0);
  // No window open: a closed window's request survives the one-day clean-up until the next window opens.
  for (const id of ['agt_cc_o_oooo', 'agt_cc_o_cccc', 'agt_cc_o_dddd']) W.call('agentExited', { agentId: id, outcome: 'done' }, user);
  W.call('requestCoordination', { agentId: 'agt_bob', to: "Uma's Claude Code", subject: 's', message: 'weekend request' }, user);
  for (const a of Object.values(W.state.agents)) if (a.perSession) a.lastSeen = Date.now() - 2 * 24 * 3600 * 1000;
  W._prunedAt = 0; W.sweep();
  reg('agt_cc_o_mmmm');
  assert.equal(count('agt_cc_o_mmmm', 'weekend request'), 1);
  c.close();
});

// ---- v1.0.3 ----
function clientRig(r) {
  const ROOT = path.join(__dirname, '..', '..');
  return () => {
    const env = { ...process.env }; for (const k of Object.keys(env)) if (k.startsWith('TEAMCODE_') || k.startsWith('CLAUDE')) delete env[k];
    const wrapper = `const c=require('child_process').spawn(process.execPath,[${JSON.stringify(path.join(ROOT, 'src/agent/mcp-server.js'))},'--config',${JSON.stringify(r.conf)}],{stdio:'inherit'});c.on('exit',(x)=>process.exit(x||0));`;
    return r.mcpWithEnv(env, ['-e', wrapper]);
  };
}

test('two windows of another MCP client are separate agents; a window reopened later is told what it left', async () => {
  const r = await claudeRig('client2');
  const client = clientRig(r);
  const X = r.SW.call('createTask', { title: 'Login page' }, user);
  const Y = r.SW.call('createTask', { title: 'Billing export' }, user);
  const w1 = client();
  await w1.tool('update_task_status', { status: 'started', task_id: X.id });
  const w2 = client();
  await w2.tool('update_task_status', { status: 'started', task_id: Y.id });
  assert.notEqual(r.SW.state.tasks[X.id].assignee, r.SW.state.tasks[Y.id].assignee, 'separate agents');
  assert.equal(r.SW.state.tasks[X.id].status, 'running');
  assert.match(await w2.tool('update_task_status', { status: 'completed', summary: 'billing done' }), /Billing export/);
  assert.equal(r.SW.state.tasks[X.id].status, 'running', 'the other window\'s task is untouched');
  await w2.quit();
  await w1.quit();
  // Closed for a long time: the agent went stale and offline meanwhile.
  const first = r.SW.state.tasks[X.id].assignee;
  r.SW.state.agents[first].lastSeen = Date.now() - 30 * 60 * 1000; r.SW.sweep(); r.SW.sweep();
  const w1b = client();
  assert.match(await w1b.tool('team_status', {}), /Login page/);
  assert.equal(r.SW.state.tasks[X.id].status, 'ready', 'not taken by guessing');
  await w1b.tool('update_task_status', { status: 'started', task_id: X.id });
  assert.match(await w1b.tool('update_task_status', { status: 'completed', summary: 'login done' }), /Login page/);
  await w1b.quit();
  await r.close();
});

test('claude --continue of a closed conversation does not file its edits under the task that conversation left', () => {
  const c = new Coordinator({ dataDir: tmp() });
  const W = c.ensureWorkspace('cont2-ws', { name: 'C' });
  const T = W.call('createTask', { title: 'Export CSV', mode: 'shared' }, user);
  W.call('registerAgent', { agentId: 'agt_cc_k_1', name: 'U (aaaa)', perSession: true, baseId: 'agt_cc_k' }, user);
  W.call('startTask', { taskId: T.id, agentId: 'agt_cc_k_1' }, user);
  W.call('agentExited', { agentId: 'agt_cc_k_1', outcome: 'done' }, user); // quit
  W.call('registerAgent', { agentId: 'agt_cc_k_1', name: 'U (aaaa)', perSession: true, baseId: 'agt_cc_k' }, user); // --continue
  W.call('fileEdited', { agentId: 'agt_cc_k_1', path: 'unrelated.md', hash: sha('x') }, user);
  assert.ok(!W.state.tasks[T.id].changes?.['unrelated.md']);
  assert.deepEqual(W.call('getContext', { agentId: 'agt_cc_k_1' }, user).tasksYouLeft.map((t) => t.title), ['Export CSV'], 'the resumed conversation is told');
  W.call('registerAgent', { agentId: 'agt_cc_k_2', name: 'U (bbbb)', perSession: true, baseId: 'agt_cc_k' }, user); // or a fresh session
  assert.deepEqual(W.call('getContext', { agentId: 'agt_cc_k_2' }, user).tasksYouLeft.map((t) => t.title), ['Export CSV'], 'told it can carry on');
  assert.throws(() => W.call('completeTask', { agentId: 'agt_cc_k_2', summary: 'x' }, user), /Export CSV/);
  c.close();
});

test('a copied request is not delivered again when the sleeping window closes; a reconnecting window gets closed windows\' requests', () => {
  const c = new Coordinator({ dataDir: tmp() });
  const W = c.ensureWorkspace('dup-ws', { name: 'D' });
  const reg = (id) => W.call('registerAgent', { agentId: id, name: `U (${id.slice(-4)})`, perSession: true, baseId: 'agt_cc_d' }, user);
  W.call('registerAgent', { agentId: 'agt_bob', name: 'Bob' }, user);
  reg('agt_cc_d_zzzz');
  W.call('requestCoordination', { agentId: 'agt_bob', to: 'agt_cc_d_zzzz', subject: 's', message: 'only once please' }, user);
  goOffline(W, 'agt_cc_d_zzzz');
  reg('agt_cc_d_cccc');
  const once = (id, text = 'only once please') => (W.call('pullDigest', { agentId: id, force: true }, user).text.match(new RegExp(text, 'g')) || []).length;
  assert.equal(once('agt_cc_d_cccc'), 1);
  W.call('heartbeat', { agentId: 'agt_cc_d_zzzz' }, user);
  W.call('agentExited', { agentId: 'agt_cc_d_zzzz', outcome: 'done' }, user);
  assert.equal(once('agt_cc_d_cccc'), 0, 'not again');
  // A window that closed with a request unread; another window reconnects by registering again.
  W.call('requestCoordination', { agentId: 'agt_bob', to: 'agt_cc_d_cccc', subject: 's', message: 'for whoever is next' }, user);
  reg('agt_cc_d_oooo'); W.call('agentExited', { agentId: 'agt_cc_d_oooo', outcome: 'done' }, user);
  W.call('agentExited', { agentId: 'agt_cc_d_cccc', outcome: 'done' }, user);
  reg('agt_cc_d_oooo'); // resumed: registers again before any heartbeat
  assert.equal(once('agt_cc_d_oooo', 'for whoever is next'), 1);
  c.close();
});

// ---- v1.0.4 ----
test('quitting Claude Code in its real order (server closes, then SessionEnd) still tells the next session about the task', async () => {
  const r = await claudeRig('quitorder');
  const T = r.SW.call('createTask', { title: 'Export CSV' }, user);
  const S1 = 'aaaaaaaa-aaaa-4000-8000-00000000000a', S2 = 'bbbbbbbb-bbbb-4000-8000-00000000000b';
  const m = r.mcp(S1);
  await r.hook(S1, { hook_event_name: 'SessionStart', source: 'startup' });
  await m.tool('update_task_status', { status: 'started', task_id: T.id });
  await m.quit(); // Claude Code closes its MCP servers first
  await r.hook(S1, { hook_event_name: 'SessionEnd', reason: 'prompt_input_exit' }); // then runs SessionEnd hooks
  assert.match(await r.hook(S1, { hook_event_name: 'SessionStart', source: 'resume' }, 44444), /Export CSV/, 'claude --continue is told');
  assert.match(await r.hook(S2, { hook_event_name: 'SessionStart', source: 'startup' }, 55555), /Export CSV/, 'a new window is told');
  await r.close();
});

test('another client\'s window reopened right after closing is told what it left; two servers in one process are separate agents', async () => {
  const r = await claudeRig('reopen');
  const client = clientRig(r);
  const X = r.SW.call('createTask', { title: 'Login page' }, user);
  const w1 = client();
  await w1.tool('update_task_status', { status: 'started', task_id: X.id });
  await w1.quit();
  const w2 = client(); // reopened at once: a new window
  assert.match(await w2.tool('team_status', {}), /tasksYouLeft[\s\S]*Login page/);
  await w2.quit();
  // Two servers started by the same process (this test process).
  const env = { ...process.env }; for (const k of Object.keys(env)) if (k.startsWith('TEAMCODE_') || k.startsWith('CLAUDE')) delete env[k];
  const a = r.mcpWithEnv(env), b = r.mcpWithEnv(env);
  const Y = r.SW.call('createTask', { title: 'Billing export' }, user), Z = r.SW.call('createTask', { title: 'Docs' }, user);
  await a.tool('update_task_status', { status: 'started', task_id: Y.id });
  await b.tool('update_task_status', { status: 'started', task_id: Z.id });
  assert.notEqual(r.SW.state.tasks[Y.id].assignee, r.SW.state.tasks[Z.id].assignee);
  assert.equal(r.SW.state.tasks[Y.id].status, 'running');
  await a.quit(); await b.quit();
  await r.close();
});

test('a task handed to someone else on the board is no longer offered back; request_review can name its task', () => {
  const c = new Coordinator({ dataDir: tmp() });
  const W = c.ensureWorkspace('handed-ws', { name: 'H' });
  const T = W.call('createTask', { title: 'Export CSV' }, user);
  W.call('registerAgent', { agentId: 'agt_cc_h_1', name: 'U (1)', perSession: true, baseId: 'agt_cc_h', userId: 'u1' }, user);
  W.call('startTask', { taskId: T.id, agentId: 'agt_cc_h_1' }, user);
  W.call('agentExited', { agentId: 'agt_cc_h_1', outcome: 'done' }, user);
  W.call('registerAgent', { agentId: 'agt_cc_h_2', name: 'U (2)', perSession: true, baseId: 'agt_cc_h', userId: 'u1' }, user);
  assert.equal(W.call('getContext', { agentId: 'agt_cc_h_2' }, user).tasksYouLeft.length, 1);
  W.call('updateTask', { taskId: T.id, runner: 'u_bob', runnerName: 'Bob', autoStart: true }, user);
  assert.equal(W.call('getContext', { agentId: 'agt_cc_h_2' }, user).tasksYouLeft.length, 0);
  // A finished task sent for review by naming it.
  const D = W.call('createTask', { title: 'Docs' }, user);
  W.call('startTask', { taskId: D.id, agentId: 'agt_cc_h_2' }, user);
  W.call('completeTask', { agentId: 'agt_cc_h_2', summary: 'done' }, user);
  W.call('agentExited', { agentId: 'agt_cc_h_2', outcome: 'done' }, user);
  W.call('registerAgent', { agentId: 'agt_cc_h_2', name: 'U (2)', perSession: true, baseId: 'agt_cc_h' }, user);
  assert.equal(W.call('requestReview', { agentId: 'agt_cc_h_2', taskId: D.id, summary: 'please review' }, user).type, 'changes.review_requested');
  c.close();
});

// ---- v1.0.5 ----
test('/clear while TeamCode is unreachable: the hand-back is retried by the next hook, and the conversation is told', async () => {
  const r = await claudeRig('offline');
  const T = r.SW.call('createTask', { title: 'Export CSV' }, user);
  const A = 'aaaaaaaa-cccc-4000-8000-00000000000a', B = 'bbbbbbbb-cccc-4000-8000-00000000000b';
  const m = r.mcp(A);
  await r.hook(A, { hook_event_name: 'SessionStart', source: 'startup' });
  await m.tool('update_task_status', { status: 'started', task_id: T.id });
  const good = fs.readFileSync(r.conf, 'utf8');
  fs.writeFileSync(r.conf, good.replace(/127\.0\.0\.1:\d+/, '127.0.0.1:9')); // the app is closed
  await r.hook(A, { hook_event_name: 'SessionEnd', reason: 'clear' });
  await r.hook(B, { hook_event_name: 'SessionStart', source: 'clear' });
  fs.writeFileSync(r.conf, good); // back
  assert.equal(r.SW.state.tasks[T.id].status, 'running');
  const out = await r.hook(B, { hook_event_name: 'UserPromptSubmit' });
  assert.equal(r.SW.state.tasks[T.id].status, 'ready', 'handed back once TeamCode is reachable');
  assert.match(out, /Export CSV/, 'and the conversation is told');
  fs.writeFileSync(path.join(r.proj, 'new-topic.js'), 'x');
  await r.hook(B, { hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: path.join(r.proj, 'new-topic.js') } });
  assert.ok(!r.SW.state.tasks[T.id].changes?.['new-topic.js']);
  await m.quit();
  await r.close();
});

test('a fixed-id client (older Claude Code) keeps its task through a restart of its server', async () => {
  const r = await claudeRig('fixed');
  const T = r.SW.call('createTask', { title: 'Job' }, user);
  const env = { ...process.env, CLAUDECODE: '1' }; for (const k of Object.keys(env)) if (k.startsWith('TEAMCODE_') || k === 'CLAUDE_CODE_SESSION_ID' || k === 'CLAUDE_PID') delete env[k];
  const c1 = r.mcpWithEnv(env);
  await c1.tool('update_task_status', { status: 'started', task_id: T.id });
  await c1.quit();
  const c2 = r.mcpWithEnv(env);
  await c2.tool('team_status', {});
  assert.equal(r.SW.state.tasks[T.id].status, 'running');
  await c2.quit();
  await r.close();
});

test('a task whose "Run on" is a teammate is still offered back to whoever left it; quitting logs no false reconnect', () => {
  const c = new Coordinator({ dataDir: tmp() });
  const W = c.ensureWorkspace('runner2-ws', { name: 'R' });
  const T = W.call('createTask', { title: 'Export CSV', runner: 'u_bob' }, user);
  W.call('updateTask', { taskId: T.id, runner: 'u_bob', runnerName: 'Bob' }, user);
  W.call('registerAgent', { agentId: 'agt_cc_r_1', name: 'Alice (1)', perSession: true, baseId: 'agt_cc_r', userId: 'u1' }, user);
  W.call('startTask', { taskId: T.id, agentId: 'agt_cc_r_1' }, user);
  W.call('releaseTask', { agentId: 'agt_cc_r_1', resumable: true }, user); // the MCP server closes first
  W.call('agentExited', { agentId: 'agt_cc_r_1', outcome: 'done' }, user); // then SessionEnd
  assert.ok(!W.events.slice(-6).some((e) => e.type === 'agent.status_changed' && e.data.detail === 'reconnected'), 'no false reconnect');
  W.call('registerAgent', { agentId: 'agt_cc_r_2', name: 'Alice (2)', perSession: true, baseId: 'agt_cc_r', userId: 'u1' }, user);
  assert.deepEqual(W.call('getContext', { agentId: 'agt_cc_r_2' }, user).tasksYouLeft.map((t) => t.title), ['Export CSV']);
  c.close();
});

// ---- v1.0.6 ----
test('a hand-back still pending from /clear never lets go of a task the new conversation has just claimed', async () => {
  const r = await claudeRig('pendclaim');
  const T = r.SW.call('createTask', { title: 'Old job' }, user);
  const Y = r.SW.call('createTask', { title: 'New job' }, user);
  r.SW.call('updateTask', { taskId: Y.id, autoStart: true, runner: 'u1' }, user);
  const A = 'aaaaaaaa-dddd-4000-8000-00000000000a', B = 'bbbbbbbb-dddd-4000-8000-00000000000b';
  const m = r.mcp(A);
  await r.hook(A, { hook_event_name: 'SessionStart', source: 'startup' });
  await m.tool('update_task_status', { status: 'started', task_id: T.id });
  const good = fs.readFileSync(r.conf, 'utf8');
  fs.writeFileSync(r.conf, good.replace(/127\.0\.0\.1:\d+/, '127.0.0.1:9'));
  await r.hook(A, { hook_event_name: 'SessionEnd', reason: 'clear' });
  await r.hook(B, { hook_event_name: 'SessionStart', source: 'clear' });
  await r.hook(B, { hook_event_name: 'UserPromptSubmit' });
  fs.writeFileSync(r.conf, good); // TeamCode is back, and the new conversation claims Y first
  await m.tool('update_task_status', { status: 'started', task_id: Y.id });
  const out = await r.hook(B, { hook_event_name: 'PostToolUse', tool_name: 'mcp__teamcode__update_task_status', tool_input: {} });
  assert.equal(r.SW.state.tasks[Y.id].status, 'running', 'the task just claimed stays claimed');
  assert.equal(r.SW.state.tasks[Y.id].autoStart, true);
  assert.ok(!/New job[\s\S]*gone back to the queue/.test(out), 'no false notice');
  assert.equal(r.SW.state.tasks[T.id].status, 'ready');
  assert.deepEqual(r.SW.call('getContext', { agentId: r.SW.state.tasks[Y.id].assignee }, user).tasksYouLeft.map((t) => t.title), ['Old job'], 'the old one is offered back');
  await m.quit();
  await r.close();
});

test('an agent whose blocked task was taken over while it was away comes back working', () => {
  const c = new Coordinator({ dataDir: tmp() });
  const W = c.ensureWorkspace('blktake-ws', { name: 'B' });
  const T = W.call('createTask', { title: 'Job' }, user);
  W.call('registerAgent', { agentId: 'agt_cc_b_1', name: 'W1', perSession: true, baseId: 'agt_cc_b' }, user);
  W.call('startTask', { taskId: T.id, agentId: 'agt_cc_b_1' }, user);
  W.call('reportBlocker', { agentId: 'agt_cc_b_1', description: 'need API' }, user);
  W.call('releaseTask', { agentId: 'agt_cc_b_1', resumable: true }, user); // its server restarts: away
  W.call('registerAgent', { agentId: 'agt_cc_b_2', name: 'W2', perSession: true, baseId: 'agt_cc_b' }, user);
  W.call('startTask', { taskId: T.id, agentId: 'agt_cc_b_2' }, user);
  W.call('heartbeat', { agentId: 'agt_cc_b_1' }, user);
  assert.equal(W.state.agents.agt_cc_b_1.status, 'working');
  c.close();
});
