'use strict';
// TeamCode coordination core: one Workspace per shared project.
// Holds the live project state (agents, tasks, files, reservations, contracts, decisions, blockers,
// reviews, conflicts) and an append-only, persisted event log with monotonically increasing seq numbers.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { merge3 } = require('./merge');

const EVENT_TYPES = [
  'workspace.created', 'settings.updated', 'user.joined', 'user.left', 'chat.message',
  'agent.joined', 'agent.status_changed', 'agent.progress', 'agent.error', 'agent.approach_changed',
  'task.created', 'task.updated', 'task.assigned', 'task.ready', 'task.started', 'task.blocked',
  'task.completed', 'task.failed', 'task.cancelled', 'task.deleted',
  'file.edit_started', 'file.changed', 'file.edit_completed', 'file.deleted', 'file.reverted',
  'branch.created', 'changes.review_requested', 'changes.approved', 'changes.rejected',
  'changes.merged', 'changes.reverted', 'conflict.detected', 'conflict.resolved',
  'test.completed', 'integration.checked', 'note.added', 'decision.recorded',
  'blocker.reported', 'blocker.resolved', 'contract.updated', 'coordination.requested',
];

const AGENT_OPS = new Set(['heartbeat', 'setAgentStatus', 'agentRead', 'preEdit', 'fileEdited', 'announceEdit', 'releaseFiles', 'pullDigest', 'getUpdates']);
const ACTIVE = new Set(['starting', 'working', 'idle', 'waiting', 'blocked']);
const STALE_MS = 90 * 1000;
const OFFLINE_MS = 10 * 60 * 1000;
const RESERVATION_MS = 15 * 60 * 1000;
const RECENT_EDIT_MS = 10 * 60 * 1000;
const DIGEST_INTERVAL_MS = 45 * 1000;
const MAX_HISTORY = 30;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_ARGS_BYTES = 512 * 1024; // any op other than filePut
const MAX_EVENTS = 20000; // kept in memory and on disk; older events are dropped
// Names that would reach Object.prototype (or Object itself) when used as a key on the plain-object state.
const POISON = new Set(['__proto__', 'constructor', 'prototype']);

const rid = (p) => `${p}_${crypto.randomBytes(5).toString('hex')}`;
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const isBinary = (buf) => buf.subarray(0, 8000).includes(0);
const normPath = (p) => String(p || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
const clip = (s, n = 160) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const arr = (v) => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v]);
// True if any value (as a whole, or as a normalized path) or any object key is a prototype-reaching name.
function poisoned(v, depth = 0) {
  if (depth > 10 || v == null) return false;
  if (typeof v === 'string') return POISON.has(v) || POISON.has(normPath(v));
  if (Array.isArray(v)) return v.some((x) => poisoned(x, depth + 1));
  if (typeof v === 'object') return Object.keys(v).some((k) => POISON.has(k) || poisoned(v[k], depth + 1));
  return false;
}

class CoordError extends Error {
  constructor(message, code = 'bad_request') { super(message); this.code = code; }
}

class Workspace extends EventEmitter {
  constructor({ id, name, token, dataDir, limits = {} }) {
    super();
    this.id = id;
    this.dataDir = dataDir;
    // Hosted (cloud) servers cap each workspace; the desktop app and self-hosted servers don't.
    this.limits = limits;
    this.blobBytes = 0;
    this.events = [];
    this.delivered = new Map(); // seq -> Set(agentId)
    this.claims = new Map(); // path -> { agentId, hash, at } recent agent edit claims, used to attribute synced writes
    this.overlapKeys = new Map();
    this.state = {
      meta: { id, name: name || id, token: token || crypto.randomBytes(16).toString('hex'), createdAt: Date.now() },
      seq: 0,
      users: {}, agents: {}, tasks: {}, files: {}, reservations: {}, contracts: {},
      decisions: [], notes: [], blockers: {}, conflicts: {}, coordination: [],
      settings: { testCommand: '' },
    };
    if (dataDir) this._load();
    if (!this.events.length) this.emitEvent('workspace.created', { kind: 'system', id: 'system', name: 'TeamCode' }, { data: { name: this.state.meta.name } });
  }

  get token() { return this.state.meta.token; }

  // ---------- persistence ----------
  _load() {
    fs.mkdirSync(path.join(this.dataDir, 'blobs'), { recursive: true });
    if (this.limits.maxBytes) {
      for (const f of fs.readdirSync(path.join(this.dataDir, 'blobs'))) {
        try { this.blobBytes += fs.statSync(path.join(this.dataDir, 'blobs', f)).size; } catch { /* vanished */ }
      }
    }
    const sf = path.join(this.dataDir, 'state.json');
    if (fs.existsSync(sf)) {
      try { Object.assign(this.state, JSON.parse(fs.readFileSync(sf, 'utf8'))); } catch { /* corrupt snapshot: rebuild from defaults */ }
    }
    const ef = path.join(this.dataDir, 'events.jsonl');
    if (fs.existsSync(ef)) {
      for (const line of fs.readFileSync(ef, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try { this.events.push(JSON.parse(line)); } catch { /* skip torn line */ }
      }
      const last = this.events[this.events.length - 1];
      if (last && last.seq > this.state.seq) this.state.seq = last.seq;
    }
    for (const [seq, ids] of Object.entries(this.state.delivered || {})) this.delivered.set(Number(seq), new Set(ids));
    delete this.state.delivered;
  }

  _saveSoon() {
    if (!this.dataDir || this._saveTimer || this._removed) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      // A failed save (full disk, removed folder) must not take the whole server down.
      try { this.saveNow(); } catch (e) { console.error(`workspace ${this.id}: save failed: ${e.message}`); }
    }, 400);
  }

  saveNow() {
    if (!this.dataDir || this._removed) return;
    const delivered = {};
    const keys = [...this.delivered.keys()].slice(-3000);
    for (const k of keys) delivered[k] = [...this.delivered.get(k)];
    const tmp = path.join(this.dataDir, 'state.json.tmp');
    fs.writeFileSync(tmp, JSON.stringify({ ...this.state, delivered }));
    fs.renameSync(tmp, path.join(this.dataDir, 'state.json'));
  }

  _putBlob(buf) {
    const h = sha(buf);
    if (this.dataDir) {
      const p = path.join(this.dataDir, 'blobs', h);
      if (!fs.existsSync(p)) {
        if (this.limits.maxBytes && this.blobBytes + buf.length > this.limits.maxBytes) throw new CoordError(`This project has reached its storage limit (${Math.round(this.limits.maxBytes / 1048576)} MB) on this server`, 'too_large');
        fs.writeFileSync(p, buf);
        this.blobBytes += buf.length;
      }
    } else {
      (this._mem ||= new Map()).set(h, buf);
    }
    return h;
  }

  _getBlob(h) {
    if (!h) return null;
    if (!this.dataDir) return this._mem?.get(h) || null;
    const p = path.join(this.dataDir, 'blobs', h);
    return fs.existsSync(p) ? fs.readFileSync(p) : null;
  }

  // ---------- events ----------
  emitEvent(type, actor, { task = null, files = [], branch = null, version = null, data = {} } = {}) {
    const e = {
      seq: ++this.state.seq,
      id: rid('evt'),
      type,
      ts: Date.now(),
      workspace: this.id,
      actor: actor ? { kind: actor.kind, id: actor.id, name: actor.name } : { kind: 'system', id: 'system', name: 'TeamCode' },
      task: task || null,
      files: arr(files).map(normPath),
      branch: branch || null,
      version,
      data,
    };
    e.summary = this._describe(e);
    this.events.push(e);
    if (this.dataDir && !this._removed) fs.appendFileSync(path.join(this.dataDir, 'events.jsonl'), JSON.stringify(e) + '\n');
    if (this.events.length > MAX_EVENTS) this._trimEvents();
    this._saveSoon();
    this.emit('event', e);
    return e;
  }

  _describe(e) {
    const d = e.data || {};
    const t = e.task && this.state.tasks[e.task];
    const tt = t ? ` "${clip(t.title, 60)}"` : '';
    const f = e.files.length ? e.files.slice(0, 4).join(', ') + (e.files.length > 4 ? ` +${e.files.length - 4} more` : '') : '';
    switch (e.type) {
      case 'settings.updated': return `${e.actor.name} updated workspace settings`;
      case 'workspace.created': return `Workspace "${d.name}" created`;
      case 'user.joined': return `${e.actor.name} joined`;
      case 'user.left': return `${e.actor.name} left`;
      case 'chat.message': return `${e.actor.name}: ${clip(d.text, 200)}`;
      case 'agent.joined': return `${e.actor.name} (${d.client || 'AI agent'}) joined${tt ? ' for task' + tt : ''}`;
      case 'agent.status_changed': return `${e.actor.name} is now ${d.to}${d.detail ? `: ${clip(d.detail, 100)}` : ''}`;
      case 'agent.progress': return `${e.actor.name}: ${clip(d.message, 200)}`;
      case 'agent.error': return `${e.actor.name} hit an error: ${clip(d.message, 200)}`;
      case 'agent.approach_changed': return `${e.actor.name} changed approach: ${clip(d.message, 200)}`;
      case 'task.created': return `Task${tt} created${d.dependsOn?.length ? ` (depends on ${d.dependsOn.length})` : ''}`;
      case 'task.updated': return `Task${tt} updated (${Object.keys(d.changes || {}).join(', ')})`;
      case 'task.assigned': return `Task${tt} assigned to ${d.assigneeName || d.runnerName || 'someone'}`;
      case 'task.ready': return `Task${tt} is ready; all dependencies done`;
      case 'task.started': return `${e.actor.name} started task${tt}${e.branch ? ` on ${e.branch}` : ''}`;
      case 'task.blocked': return `Task${tt} blocked: ${clip(d.reason, 120)}`;
      case 'task.completed': return `Task${tt} completed${d.summary ? `: ${clip(d.summary, 160)}` : ''}`;
      case 'task.failed': return `Task${tt} failed: ${clip(d.error, 140)}`;
      case 'task.cancelled': return `Task${tt} cancelled`;
      case 'task.deleted': return `Task "${clip(d.title, 60)}" deleted`;
      case 'file.edit_started': return `${e.actor.name} started editing ${f}${d.intent ? `: ${clip(d.intent, 100)}` : ''}${d.exclusive ? ' (exclusive)' : ''}`;
      case 'file.changed': return `${e.actor.name} changed ${f}${e.version ? ` (v${e.version})` : ''}${e.branch && e.branch !== 'main' ? ` on ${e.branch}` : ''}${d.merged ? ' (auto-merged)' : ''}`;
      case 'file.edit_completed': return `${e.actor.name} finished editing ${f}${d.expired ? ' (reservation expired)' : ''}`;
      case 'file.deleted': return `${e.actor.name} deleted ${f}`;
      case 'file.reverted': return `${e.actor.name} reverted ${f} to v${d.toVersion}`;
      case 'branch.created': return `Branch ${e.branch} created for task${tt}`;
      case 'changes.review_requested': return `Review requested for task${tt}${d.fileCount != null ? ` (${d.fileCount} files)` : ''}`;
      case 'changes.approved': return `${e.actor.name} approved task${tt}`;
      case 'changes.rejected': return `${e.actor.name} rejected task${tt}${d.note ? `: ${clip(d.note, 100)}` : ''}`;
      case 'changes.merged': return `Task${tt} merged into ${d.into || 'main'}${d.commit ? ` (${String(d.commit).slice(0, 8)})` : ''}`;
      case 'changes.reverted': return `Task${tt} changes reverted`;
      case 'conflict.detected': return `Conflict (${d.kind}) on ${f || 'task' + tt}: ${clip(d.message, 160)}`;
      case 'conflict.resolved': return `Conflict on ${f} resolved (${d.resolution})`;
      case 'test.completed': return `Tests ${d.passed ? 'passed' : 'FAILED'} for task${tt || ' (workspace)'}`;
      case 'integration.checked': return `Integration check for task${tt}: ${d.state}${d.risks?.length ? `, ${d.risks.length} risk(s)` : ''}`;
      case 'note.added': return `${e.actor.name} noted (${d.kind}): ${clip(d.message, 180)}`;
      case 'decision.recorded': return `Decision: ${clip(d.title, 80)}. ${clip(d.decision, 160)}`;
      case 'blocker.reported': return `Blocker reported by ${e.actor.name}: ${clip(d.description, 160)}`;
      case 'blocker.resolved': return `Blocker resolved: ${clip(d.description, 120)}`;
      case 'contract.updated': return `Contract "${d.name}" v${d.version} published by ${e.actor.name}${d.description ? `: ${clip(d.description, 100)}` : ''}`;
      case 'coordination.requested': return `${e.actor.name} → ${d.toName || 'all agents'}: ${clip(d.subject, 80)}. ${clip(d.message, 140)}`;
      default: return e.type;
    }
  }

  // Keeps the newest events in memory and rewrites events.jsonl to match, so neither grows forever.
  _trimEvents() {
    this.events.splice(0, this.events.length - Math.floor(MAX_EVENTS * 0.8));
    if (!this.dataDir || this._removed) return;
    const f = path.join(this.dataDir, 'events.jsonl');
    try {
      fs.writeFileSync(`${f}.tmp`, this.events.map((e) => JSON.stringify(e)).join('\n') + '\n');
      fs.renameSync(`${f}.tmp`, f);
    } catch (e) { console.error(`workspace ${this.id}: event log trim failed: ${e.message}`); }
  }

  eventsSince(since = 0, limit = 1000) {
    // events are ordered by seq; binary search for the first event after `since`
    let lo = 0, hi = this.events.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (this.events[mid].seq <= since) lo = mid + 1; else hi = mid; }
    return this.events.slice(lo, lo + limit);
  }

  _markDelivered(agentId, events) {
    for (const e of events) {
      if (!this.delivered.has(e.seq)) this.delivered.set(e.seq, new Set());
      this.delivered.get(e.seq).add(agentId);
    }
  }

  // ---------- actors ----------
  _actor(args = {}, ctx = {}) {
    if (args.agentId) {
      const a = this.state.agents[args.agentId];
      if (!a) throw new CoordError(`Unknown agent ${args.agentId}. Register first.`, 'unknown_agent');
      return { kind: 'agent', id: a.id, name: a.name, agent: a };
    }
    const u = ctx.user || args.user;
    if (u && u.id) return { kind: 'user', id: u.id, name: u.name || 'Someone' };
    return { kind: 'system', id: 'system', name: 'TeamCode' };
  }

  _touchAgent(a) {
    a.lastSeen = Date.now();
    if (a.status === 'stale' || a.status === 'offline') {
      const from = a.status;
      a.status = a.prevStatus || 'working';
      this.emitEvent('agent.status_changed', a, { task: a.taskId, data: { from, to: a.status, detail: 'reconnected' } });
    }
  }

  _setAgentStatus(a, to, detail) {
    if (a.status === to && !detail) return;
    const from = a.status;
    a.status = to;
    a.detail = detail || '';
    if (ACTIVE.has(to)) a.prevStatus = to;
    this.emitEvent('agent.status_changed', a, { task: a.taskId, data: { from, to, detail } });
  }

  _activeAgents() { return Object.values(this.state.agents).filter((a) => ACTIVE.has(a.status)); }

  // ---------- dispatcher ----------
  call(op, args = {}, ctx = {}) {
    const fn = this[`op_${op}`];
    if (typeof fn !== 'function') throw new CoordError(`Unknown operation: ${op}`, 'unknown_op');
    if (poisoned(args) || poisoned(ctx.user)) throw new CoordError('Invalid name', 'invalid');
    if (op !== 'filePut' && JSON.stringify(args || {}).length > MAX_ARGS_BYTES) throw new CoordError('Request too large', 'too_large');
    if (op !== 'registerAgent') {
      if (args.agentId && !this.state.agents[args.agentId]) throw new CoordError(`Unknown agent ${args.agentId}. Register first.`, 'unknown_agent');
      if (AGENT_OPS.has(op) && !args.agentId) throw new CoordError(`${op} requires agentId`, 'unknown_agent');
      if (args.agentId) this._touchAgent(this.state.agents[args.agentId]);
    }
    const res = fn.call(this, args, ctx);
    this._saveSoon();
    return res;
  }

  // ---------- users ----------
  op_userJoined({ user }, ctx) {
    const u = user || ctx.user;
    const existing = this.state.users[u.id];
    this.state.users[u.id] = { id: u.id, name: u.name, online: true, lastSeen: Date.now() };
    if (!existing || !existing.online) this.emitEvent('user.joined', { kind: 'user', ...u });
    return this.state.users[u.id];
  }

  op_userLeft({ user }, ctx) {
    const u = user || ctx.user;
    const s = this.state.users[u.id];
    if (s && s.online) { s.online = false; s.lastSeen = Date.now(); this.emitEvent('user.left', { kind: 'user', ...u }); }
    return true;
  }

  op_chat({ text }, ctx) {
    if (!String(text || '').trim()) throw new CoordError('Empty message');
    return this.emitEvent('chat.message', this._actor({}, ctx), { data: { text: String(text).slice(0, 4000) } });
  }

  op_updateSettings({ settings }, ctx) {
    Object.assign(this.state.settings, settings || {});
    this.emitEvent('settings.updated', this._actor({}, ctx), { data: { settings: this.state.settings } });
    return this.state.settings;
  }

  // ---------- agents ----------
  op_registerAgent({ agentId, name, client, taskId, userId, mode, branch, cwd }, ctx) {
    let a = agentId && this.state.agents[agentId];
    if (a) {
      const wasInactive = !ACTIVE.has(a.status);
      Object.assign(a, { client: client || a.client, cwd: cwd || a.cwd, lastSeen: Date.now() });
      if (taskId && taskId !== a.taskId) this._assign(a, taskId);
      if (wasInactive) this._setAgentStatus(a, 'working', 'reconnected');
      const missed = this._relevantSince(a, a.cursor);
      return { agent: this._agentView(a), reconnected: true, missedCount: missed.length, missed: this._digestText(missed) };
    }
    a = {
      id: agentId || rid('agt'), name: name || 'Agent', client: client || 'MCP client', userId: userId || ctx.user?.id || null,
      taskId: null, status: 'working', prevStatus: 'working', detail: '', mode: mode || 'shared', branch: branch || 'main',
      cwd: cwd || null, startedAt: Date.now(), lastSeen: Date.now(), cursor: this.state.seq, lastDigestAt: 0,
      reads: {}, touched: {}, edited: {}, warned: {}, updates: [], contractsSeen: {},
    };
    this.state.agents[a.id] = a;
    this.emitEvent('agent.joined', a, { data: { client: a.client, mode: a.mode }, branch: a.branch });
    if (taskId) this._assign(a, taskId);
    return { agent: this._agentView(a), reconnected: false, missedCount: 0, missed: '' };
  }

  _assign(a, taskId) {
    const t = this.state.tasks[taskId];
    if (!t) throw new CoordError(`Unknown task ${taskId}`);
    a.taskId = taskId;
    if (t.assignee !== a.id) {
      t.assignee = a.id; t.assigneeName = a.name; t.updatedAt = Date.now();
      this.emitEvent('task.assigned', a, { task: t.id, data: { assignee: a.id, assigneeName: a.name } });
    }
  }

  op_heartbeat({ agentId, status, detail }) {
    const a = this.state.agents[agentId];
    if (!a) throw new CoordError('Unknown agent', 'unknown_agent');
    if (status) this._setAgentStatus(a, status, detail);
    return { ok: true, pending: this._relevantSince(a, a.cursor).length };
  }

  op_setAgentStatus({ agentId, status, detail }) {
    const a = this.state.agents[agentId];
    if (!a) throw new CoordError('Unknown agent', 'unknown_agent');
    this._setAgentStatus(a, status, detail);
    return this._agentView(a);
  }

  op_agentExited({ agentId, outcome, detail }) {
    const a = this.state.agents[agentId];
    if (!a) return false;
    this._releaseAll(a);
    this._setAgentStatus(a, outcome || 'done', detail);
    return true;
  }

  _releaseAll(a, expired = false) {
    const released = [];
    for (const [p, holders] of Object.entries(this.state.reservations)) {
      if (holders[a.id]) { delete holders[a.id]; released.push(p); }
      if (!Object.keys(holders).length) delete this.state.reservations[p];
    }
    if (released.length) this.emitEvent('file.edit_completed', a, { task: a.taskId, files: released, branch: a.branch, data: { expired } });
    return released;
  }

  _agentView(a) {
    const files = Object.entries(this.state.reservations).filter(([, h]) => h[a.id]).map(([p, h]) => ({ path: p, mode: h[a.id].mode, intent: h[a.id].intent }));
    const t = a.taskId && this.state.tasks[a.taskId];
    return {
      id: a.id, name: a.name, client: a.client, userId: a.userId, status: a.status, detail: a.detail, mode: a.mode, branch: a.branch,
      task: t ? { id: t.id, title: t.title, status: t.status } : null, lastSeen: a.lastSeen, startedAt: a.startedAt,
      editing: files, edited: Object.keys(a.edited || {}), updates: a.updates.slice(-8), cursor: a.cursor,
      pendingEvents: this._relevantSince(a, a.cursor).length,
    };
  }

  // ---------- tasks ----------
  _taskView(t) { return t; }

  op_createTask(args, ctx) {
    const actor = this._actor(args, ctx);
    const title = String(args.title || '').trim();
    if (!title) throw new CoordError('Task title is required');
    const deps = arr(args.dependsOn).filter((d) => this.state.tasks[d]);
    const t = {
      id: rid('tsk'), title, description: String(args.description || ''), status: 'waiting',
      priority: Number.isFinite(+args.priority) ? +args.priority : 2, dependsOn: deps, files: arr(args.files).map(normPath),
      mode: args.mode === 'isolated' ? 'isolated' : 'shared', assignee: null, assigneeName: null,
      runner: args.runner || null, runnerName: args.runnerName || null, autoStart: !!args.autoStart,
      createdBy: { id: actor.id, name: actor.name }, createdAt: Date.now(), updatedAt: Date.now(),
      startedAt: null, completedAt: null, summary: '', branch: null, worktree: null, baseCommit: null, headCommit: null,
      review: { state: 'none' }, tests: { state: 'none' }, integration: { state: 'none', conflicts: [], risks: [] },
      contractsUsed: {}, parallelNotes: [],
    };
    this.state.tasks[t.id] = t;
    this.emitEvent('task.created', actor, { task: t.id, files: t.files, data: { title, dependsOn: deps, mode: t.mode } });
    if (t.runner) this.emitEvent('task.assigned', actor, { task: t.id, data: { runner: t.runner, runnerName: t.runnerName } });
    this._recomputeReadiness(actor);
    this._annotateParallelism();
    return t;
  }

  // Create several tasks at once (orchestrator). dependsOn may reference other new tasks by index or title.
  op_createTasks({ tasks, ...rest }, ctx) {
    const created = [];
    const list = arr(tasks);
    for (const spec of list) {
      const t = this.op_createTask({ ...rest, ...spec, dependsOn: arr(spec.dependsOn).filter((d) => this.state.tasks[d]) }, ctx);
      created.push(t);
    }
    list.forEach((spec, i) => {
      const deps = arr(spec.dependsOn).map((d) => {
        if (this.state.tasks[d]) return d;
        if (Number.isInteger(d) && created[d]) return created[d].id;
        const byTitle = created.find((c) => c.title.toLowerCase() === String(d).toLowerCase());
        return byTitle ? byTitle.id : null;
      }).filter((d) => d && d !== created[i].id);
      if (deps.length) this.op_updateTask({ taskId: created[i].id, dependsOn: deps }, ctx);
    });
    return created.map((t) => this.state.tasks[t.id]);
  }

  op_updateTask({ taskId, ...fields }, ctx) {
    const t = this._task(taskId);
    const allowed = ['title', 'description', 'priority', 'dependsOn', 'files', 'mode', 'autoStart', 'runner', 'runnerName', 'order'];
    const changes = {};
    for (const k of allowed) {
      if (!(k in fields)) continue;
      let v = fields[k];
      if (k === 'dependsOn') {
        v = arr(v).filter((d) => this.state.tasks[d] && d !== taskId);
        for (const d of v) if (this._dependsOn(d, taskId)) throw new CoordError(`Dependency cycle: "${this.state.tasks[d].title}" already depends on this task`);
      }
      if (k === 'files') v = arr(v).map(normPath);
      if (k === 'priority') v = +v;
      if (JSON.stringify(t[k]) !== JSON.stringify(v)) { changes[k] = v; t[k] = v; }
    }
    if (!Object.keys(changes).length) return t;
    t.updatedAt = Date.now();
    const actor = this._actor(fields, ctx);
    this.emitEvent('task.updated', actor, { task: t.id, data: { changes } });
    if ('runner' in changes) this.emitEvent('task.assigned', actor, { task: t.id, data: { runner: t.runner, runnerName: t.runnerName } });
    this._recomputeReadiness(actor);
    this._annotateParallelism();
    return t;
  }

  _dependsOn(a, b, seen = new Set()) {
    if (a === b) return true;
    if (seen.has(a)) return false;
    seen.add(a);
    return (this.state.tasks[a]?.dependsOn || []).some((d) => this._dependsOn(d, b, seen));
  }

  _task(id) {
    const t = this.state.tasks[id];
    if (!t) throw new CoordError(`Unknown task ${id}`, 'unknown_task');
    return t;
  }

  _recomputeReadiness(actor) {
    for (const t of Object.values(this.state.tasks)) {
      if (!['waiting', 'ready'].includes(t.status)) continue;
      const pending = t.dependsOn.filter((d) => this.state.tasks[d] && !this._depSatisfied(this.state.tasks[d], t));
      const next = pending.length ? 'waiting' : 'ready';
      if (next !== t.status) {
        t.status = next;
        if (next === 'ready') this.emitEvent('task.ready', actor || null, { task: t.id, data: { title: t.title } });
      }
    }
  }

  // An isolated dependent can start from the dependency's branch once it is completed; work in the shared
  // working copy only sees an isolated dependency after it has been merged.
  _depSatisfied(dep, t) {
    if (dep.status !== 'done') return false;
    if (dep.mode !== 'isolated' || t.mode === 'isolated') return true;
    return dep.integration?.state === 'merged';
  }

  // Flags tasks that should not run in parallel because they expect to touch the same files.
  _annotateParallelism() {
    const open = Object.values(this.state.tasks).filter((t) => !['done', 'cancelled', 'failed'].includes(t.status));
    for (const t of open) t.parallelNotes = [];
    for (let i = 0; i < open.length; i++) {
      for (let j = i + 1; j < open.length; j++) {
        const a = open[i], b = open[j];
        if (this._dependsOn(a.id, b.id) || this._dependsOn(b.id, a.id)) continue;
        const shared = a.files.filter((f) => b.files.includes(f));
        if (shared.length) {
          a.parallelNotes.push({ task: b.id, title: b.title, files: shared });
          b.parallelNotes.push({ task: a.id, title: a.title, files: shared });
        }
      }
    }
  }

  op_assignTask({ taskId, agentId, runner, runnerName }, ctx) {
    const t = this._task(taskId);
    if (agentId) this._assign(this.state.agents[agentId] || (() => { throw new CoordError('Unknown agent'); })(), taskId);
    if (runner !== undefined) {
      t.runner = runner; t.runnerName = runnerName || null; t.updatedAt = Date.now();
      this.emitEvent('task.assigned', this._actor({}, ctx), { task: t.id, data: { runner, runnerName } });
    }
    return t;
  }

  op_startTask({ taskId, agentId, branch, worktree, baseCommit, force }, ctx) {
    const t = this._task(taskId);
    if (t.status === 'running') throw new CoordError('Task is already running');
    // Restarting a failed, finished or cancelled task is a deliberate choice (Retry / Reopen), never automatic.
    if (['failed', 'done', 'cancelled'].includes(t.status) && !force) throw new CoordError(`Task is ${t.status}. Start it again from the board.`, 'not_ready');
    if (t.status === 'waiting' && !force) {
      const pending = t.dependsOn.map((d) => this.state.tasks[d]).filter((d) => d && !this._depSatisfied(d, t)).map((d) => (d.status === 'done' ? `${d.title} (needs merge)` : d.title));
      throw new CoordError(`Task is waiting on: ${pending.join(', ')}`, 'waiting');
    }
    const actor = this._actor({ agentId }, ctx);
    if (agentId) this._assign(actor.agent, taskId);
    Object.assign(t, {
      status: 'running', startedAt: Date.now(), updatedAt: Date.now(), branch: branch || t.branch || 'main',
      worktree: worktree || t.worktree, baseCommit: baseCommit || t.baseCommit,
      review: { state: 'none' }, tests: { state: 'none' }, integration: { state: 'none', conflicts: [], risks: [] },
    });
    t.contractsUsed = Object.fromEntries(Object.values(this.state.contracts).map((c) => [c.name, c.version]));
    this.emitEvent('task.started', actor, { task: t.id, branch: t.branch, files: t.files, data: { title: t.title, mode: t.mode } });
    return t;
  }

  op_completeTask({ taskId, agentId, summary }, ctx) {
    const actor = this._actor({ agentId }, ctx);
    taskId = taskId || actor.agent?.taskId;
    const t = this._task(taskId);
    if (t.status === 'done') return t;
    Object.assign(t, { status: 'done', completedAt: Date.now(), updatedAt: Date.now(), summary: String(summary || t.summary || '') });
    this.emitEvent('task.completed', actor, { task: t.id, branch: t.branch, data: { summary: t.summary } });
    this._recomputeReadiness(actor);
    this._annotateParallelism();
    return t;
  }

  op_failTask({ taskId, agentId, error }, ctx) {
    const actor = this._actor({ agentId }, ctx);
    const t = this._task(taskId || actor.agent?.taskId);
    Object.assign(t, { status: 'failed', updatedAt: Date.now(), error: String(error || 'unknown error') });
    this.emitEvent('task.failed', actor, { task: t.id, data: { error: t.error } });
    return t;
  }

  op_cancelTask({ taskId }, ctx) {
    const t = this._task(taskId);
    t.status = 'cancelled'; t.updatedAt = Date.now();
    this.emitEvent('task.cancelled', this._actor({}, ctx), { task: t.id });
    return t;
  }

  op_reopenTask({ taskId }, ctx) {
    const t = this._task(taskId);
    t.status = 'waiting'; t.updatedAt = Date.now();
    this._recomputeReadiness(this._actor({}, ctx));
    this.emitEvent('task.updated', this._actor({}, ctx), { task: t.id, data: { changes: { status: t.status } } });
    return t;
  }

  op_deleteTask({ taskId }, ctx) {
    const t = this._task(taskId);
    if (t.status === 'running') throw new CoordError('Stop the task before deleting it');
    delete this.state.tasks[taskId];
    for (const o of Object.values(this.state.tasks)) o.dependsOn = o.dependsOn.filter((d) => d !== taskId);
    this.emitEvent('task.deleted', this._actor({}, ctx), { data: { title: t.title, id: taskId } });
    this._recomputeReadiness();
    this._annotateParallelism();
    return true;
  }

  // ---------- agent communication ----------
  op_publishUpdate({ agentId, kind = 'progress', message, files }, ctx) {
    const actor = this._actor({ agentId }, ctx);
    const a = actor.agent;
    const msg = String(message || '').trim();
    if (!msg) throw new CoordError('message is required');
    const type = { progress: 'agent.progress', error: 'agent.error', approach: 'agent.approach_changed', approach_change: 'agent.approach_changed' }[kind] || 'note.added';
    if (a) { a.updates.push({ kind, message: clip(msg, 400), at: Date.now() }); a.updates = a.updates.slice(-20); }
    if (type === 'note.added' || type === 'agent.error') {
      this.state.notes.push({ id: rid('note'), kind, message: msg, taskId: a?.taskId || null, files: arr(files).map(normPath), by: { id: actor.id, name: actor.name }, at: Date.now() });
      this.state.notes = this.state.notes.slice(-300);
    }
    return this.emitEvent(type, actor, { task: a?.taskId, files, data: { kind, message: msg } });
  }

  op_recordDecision({ agentId, title, decision, rationale, files }, ctx) {
    const actor = this._actor({ agentId }, ctx);
    if (!title || !decision) throw new CoordError('title and decision are required');
    const d = { id: rid('dec'), title, decision, rationale: rationale || '', taskId: actor.agent?.taskId || null, files: arr(files).map(normPath), by: { id: actor.id, name: actor.name }, at: Date.now() };
    this.state.decisions.push(d);
    this.emitEvent('decision.recorded', actor, { task: d.taskId, files: d.files, data: { id: d.id, title, decision, rationale: d.rationale } });
    return d;
  }

  op_reportBlocker({ agentId, description, taskId, needs, blockingTask }, ctx) {
    const actor = this._actor({ agentId }, ctx);
    if (!description) throw new CoordError('description is required');
    const tid = taskId || actor.agent?.taskId || null;
    const b = { id: rid('blk'), description, taskId: tid, needs: needs || '', blockingTask: blockingTask || null, status: 'open', by: { id: actor.id, name: actor.name }, at: Date.now() };
    this.state.blockers[b.id] = b;
    this.emitEvent('blocker.reported', actor, { task: tid, data: { id: b.id, description, needs: b.needs, blockingTask: b.blockingTask } });
    if (tid && this.state.tasks[tid]?.status === 'running') {
      this.state.tasks[tid].status = 'blocked';
      this.emitEvent('task.blocked', actor, { task: tid, data: { reason: description } });
    }
    if (actor.agent) this._setAgentStatus(actor.agent, 'blocked', description);
    return b;
  }

  op_resolveBlocker({ blockerId, resolution, agentId }, ctx) {
    const b = this.state.blockers[blockerId];
    if (!b) throw new CoordError('Unknown blocker');
    const actor = this._actor({ agentId }, ctx);
    Object.assign(b, { status: 'resolved', resolution: resolution || '', resolvedBy: { id: actor.id, name: actor.name }, resolvedAt: Date.now() });
    this.emitEvent('blocker.resolved', actor, { task: b.taskId, data: { id: b.id, description: b.description, resolution: b.resolution } });
    const t = b.taskId && this.state.tasks[b.taskId];
    if (t && t.status === 'blocked' && !Object.values(this.state.blockers).some((o) => o.taskId === t.id && o.status === 'open')) {
      t.status = 'running';
      const a = t.assignee && this.state.agents[t.assignee];
      if (a && a.status === 'blocked') this._setAgentStatus(a, 'working', 'unblocked');
    }
    return b;
  }

  op_publishContract({ agentId, name, content, description }, ctx) {
    const actor = this._actor({ agentId }, ctx);
    if (!name || !content) throw new CoordError('name and content are required');
    const prev = this.state.contracts[name];
    const c = {
      name, version: (prev?.version || 0) + 1, content: String(content), description: description || prev?.description || '',
      taskId: actor.agent?.taskId || prev?.taskId || null, by: { id: actor.id, name: actor.name }, at: Date.now(),
      history: [...(prev?.history || []), { version: (prev?.version || 0) + 1, at: Date.now(), by: actor.name }].slice(-20),
    };
    this.state.contracts[name] = c;
    // Running tasks that started against an older version of this contract are now at risk.
    const stale = Object.values(this.state.tasks).filter((t) => ['running', 'blocked'].includes(t.status) && t.contractsUsed[name] && t.contractsUsed[name] < c.version);
    this.emitEvent('contract.updated', actor, { task: c.taskId, version: c.version, data: { name, version: c.version, description: c.description, staleTasks: stale.map((t) => t.id) } });
    return c;
  }

  op_getContract({ agentId, name }) {
    const a = agentId && this.state.agents[agentId];
    if (!name) return Object.values(this.state.contracts).map((c) => ({ name: c.name, version: c.version, description: c.description, by: c.by.name, at: c.at }));
    const c = this.state.contracts[name];
    if (!c) throw new CoordError(`No contract named "${name}"`);
    if (a) a.contractsSeen[name] = c.version;
    if (a?.taskId && this.state.tasks[a.taskId]) this.state.tasks[a.taskId].contractsUsed[name] = c.version;
    return c;
  }

  op_requestCoordination({ agentId, to, subject, message, files }, ctx) {
    const actor = this._actor({ agentId }, ctx);
    let target = null;
    if (to) {
      target = this.state.agents[to] || Object.values(this.state.agents).find((a) => a.name.toLowerCase() === String(to).toLowerCase());
      if (!target) throw new CoordError(`No agent named "${to}". Use team_status to list agents.`);
    }
    const r = { id: rid('crd'), from: { id: actor.id, name: actor.name }, to: target ? target.id : null, toName: target?.name || null, subject: subject || 'Coordination', message: message || '', files: arr(files).map(normPath), at: Date.now(), status: 'open' };
    this.state.coordination.push(r);
    this.state.coordination = this.state.coordination.slice(-200);
    this.emitEvent('coordination.requested', actor, { task: actor.agent?.taskId, files: r.files, data: { id: r.id, to: r.to, toName: r.toName, subject: r.subject, message: r.message } });
    return r;
  }

  // ---------- file awareness (hooks + MCP) ----------
  _liveReservations(p, exceptAgentId) {
    const holders = this.state.reservations[p] || {};
    const now = Date.now();
    return Object.entries(holders)
      .filter(([id, r]) => id !== exceptAgentId && r.expires > now && ACTIVE.has(this.state.agents[id]?.status))
      .map(([id, r]) => ({ agentId: id, agentName: this.state.agents[id].name, taskId: r.taskId, taskTitle: this.state.tasks[r.taskId]?.title || null, mode: r.mode, intent: r.intent, branch: this.state.agents[id].branch, at: r.at }));
  }

  _reserve(a, p, mode = 'shared', intent = '') {
    const holders = (this.state.reservations[p] ||= {});
    const isNew = !holders[a.id];
    holders[a.id] = { mode, intent: intent || holders[a.id]?.intent || '', at: holders[a.id]?.at || Date.now(), expires: Date.now() + RESERVATION_MS, taskId: a.taskId };
    return isNew;
  }

  _lastChange(p, exceptAgentId) {
    for (let i = this.events.length - 1; i >= 0 && i > this.events.length - 5000; i--) {
      const e = this.events[i];
      if ((e.type === 'file.changed' || e.type === 'file.deleted') && e.files.includes(p) && e.actor.id !== exceptAgentId) return e;
    }
    return null;
  }

  _overlap(a, p, others, kind) {
    const key = `${kind}|${p}|${[a.id, ...others.map((o) => o.agentId)].sort().join(',')}`;
    if (this.overlapKeys.get(key) > Date.now() - RECENT_EDIT_MS) return;
    this.overlapKeys.set(key, Date.now());
    const id = rid('cfl');
    const message = kind === 'integration_risk'
      ? `${a.name} and ${others.map((o) => o.agentName).join(', ')} are changing ${p} on different branches. Merge carefully.`
      : `${a.name} and ${others.map((o) => o.agentName).join(', ')} are editing ${p} at the same time`;
    this.state.conflicts[id] = { id, kind, path: p, agents: [a.id, ...others.map((o) => o.agentId)], message, status: kind === 'overlap' ? 'open' : 'watch', at: Date.now() };
    this.emitEvent('conflict.detected', a, { task: a.taskId, files: [p], branch: a.branch, data: { id, kind, message, agents: this.state.conflicts[id].agents } });
  }

  op_agentRead({ agentId, path: p, hash }) {
    const a = this.state.agents[agentId];
    p = normPath(p);
    const f = this.state.files[p];
    a.reads[p] = { hash: hash || null, version: f && f.hash === hash ? f.version : null, at: Date.now() };
    a.touched[p] = Date.now();
    return { ok: true };
  }

  // Called by the PreToolUse hook before an agent writes a file.
  op_preEdit({ agentId, path: p, diskHash, exists }) {
    const a = this.state.agents[agentId];
    p = normPath(p);
    a.touched[p] = Date.now();
    const lastRead = a.reads[p];
    if (exists && lastRead && lastRead.hash && diskHash && lastRead.hash !== diskHash) {
      const ch = this._lastChange(p, a.id);
      const who = ch ? `${ch.actor.name} (${new Date(ch.ts).toLocaleTimeString()}${ch.task && this.state.tasks[ch.task] ? `, task "${this.state.tasks[ch.task].title}"` : ''})` : 'someone else';
      return { decision: 'deny', reason: `TeamCode: ${p} was changed by ${who} after you last read it. Read the file again and re-apply your edit on top of the latest version so their work is not overwritten.` };
    }
    const others = this._liveReservations(p, a.id);
    const sameBranch = others.filter((o) => o.branch === a.branch);
    const otherBranch = others.filter((o) => o.branch !== a.branch);
    const exclusive = sameBranch.find((o) => o.mode === 'exclusive');
    if (exclusive) {
      this._overlap(a, p, [exclusive], 'overlap');
      return { decision: 'deny', reason: `TeamCode: ${exclusive.agentName} has an exclusive reservation on ${p}${exclusive.taskTitle ? ` for task "${exclusive.taskTitle}"` : ''}${exclusive.intent ? ` (${exclusive.intent})` : ''}. Work on other files first, or call the teamcode request_coordination tool to agree on a sequence with them.` };
    }
    if (otherBranch.length) this._overlap(a, p, otherBranch, 'integration_risk');
    if (sameBranch.length && !(a.warned[p] > Date.now() - RECENT_EDIT_MS)) {
      a.warned[p] = Date.now();
      this._overlap(a, p, sameBranch, 'overlap');
      const desc = sameBranch.map((o) => `${o.agentName}${o.taskTitle ? ` (task "${o.taskTitle}")` : ''}${o.intent ? `: ${o.intent}` : ''}`).join('; ');
      return { decision: 'deny', reason: `TeamCode: heads up, ${desc} is also editing ${p} right now. Re-read the file, keep your change to the parts you own, and avoid restructuring their sections (use request_coordination if you need to). Retry your edit once you have accounted for this; it will be allowed.` };
    }
    if (this._reserve(a, p, 'shared', '')) this.emitEvent('file.edit_started', a, { task: a.taskId, files: [p], branch: a.branch, data: {} });
    return { decision: 'allow' };
  }

  // Called by the PostToolUse hook after an agent wrote a file.
  op_fileEdited({ agentId, path: p, hash, deleted, summary }) {
    const a = this.state.agents[agentId];
    p = normPath(p);
    a.reads[p] = { hash: hash || null, version: null, at: Date.now() };
    a.touched[p] = Date.now();
    a.edited[p] = Date.now();
    if (this._reserve(a, p, this.state.reservations[p]?.[a.id]?.mode || 'shared')) this.emitEvent('file.edit_started', a, { task: a.taskId, files: [p], branch: a.branch, data: {} });
    let version = null;
    if (a.branch === 'main' || !a.branch) {
      this.claims.set(p, { agentId: a.id, hash, at: Date.now() });
      const f = this.state.files[p];
      if (f && f.hash === hash) { version = f.version; f.by = { kind: 'agent', id: a.id, name: a.name }; }
    }
    return this.emitEvent(deleted ? 'file.deleted' : 'file.changed', a, { task: a.taskId, files: [p], branch: a.branch || 'main', version, data: { hash, summary: summary || '' } });
  }

  op_announceEdit({ agentId, paths, intent, exclusive }) {
    const a = this.state.agents[agentId];
    const ps = arr(paths).map(normPath);
    if (!ps.length) throw new CoordError('paths is required');
    const overlaps = [];
    for (const p of ps) {
      const others = this._liveReservations(p, a.id);
      if (others.length) {
        overlaps.push({ path: p, with: others });
        const same = others.filter((o) => o.branch === a.branch), diff = others.filter((o) => o.branch !== a.branch);
        if (same.length) this._overlap(a, p, same, 'overlap');
        if (diff.length) this._overlap(a, p, diff, 'integration_risk');
      }
      this._reserve(a, p, exclusive ? 'exclusive' : 'shared', intent);
    }
    this.emitEvent('file.edit_started', a, { task: a.taskId, files: ps, branch: a.branch, data: { intent: intent || '', exclusive: !!exclusive } });
    const blocked = exclusive ? [] : overlaps.filter((o) => o.with.some((w) => w.mode === 'exclusive' && w.branch === a.branch)).map((o) => o.path);
    return { reserved: ps, overlaps, blockedByExclusive: blocked };
  }

  op_releaseFiles({ agentId, paths }) {
    const a = this.state.agents[agentId];
    const ps = paths ? arr(paths).map(normPath) : Object.keys(this.state.reservations).filter((p) => this.state.reservations[p][a.id]);
    const released = [];
    for (const p of ps) {
      if (this.state.reservations[p]?.[a.id]) { delete this.state.reservations[p][a.id]; released.push(p); }
      if (this.state.reservations[p] && !Object.keys(this.state.reservations[p]).length) delete this.state.reservations[p];
    }
    if (released.length) this.emitEvent('file.edit_completed', a, { task: a.taskId, files: released, branch: a.branch });
    return { released };
  }

  op_checkFiles({ agentId, paths, hashes = {} }) {
    const a = agentId && this.state.agents[agentId];
    return arr(paths).map(normPath).map((p) => {
      const f = this.state.files[p];
      const last = this._lastChange(p, null);
      const read = a?.reads[p];
      const currentHash = hashes[p] || f?.hash || null;
      const changedSinceRead = read ? (read.hash && currentHash ? read.hash !== currentHash : last ? last.ts > read.at && last.actor.id !== a.id : false) : null;
      const recent = this.events.filter((e) => e.type === 'file.changed' && e.files.includes(p) && (!a || e.actor.id !== a.id)).slice(-3)
        .map((e) => ({ by: e.actor.name, at: e.ts, branch: e.branch, task: e.task && this.state.tasks[e.task]?.title, seq: e.seq }));
      return {
        path: p, exists: f ? !f.deleted : null, version: f?.version || null,
        lastChangedBy: last ? last.actor.name : f?.by?.name || null, lastChangedAt: last ? last.ts : f?.at || null,
        youLastReadAt: read?.at || null, changedSinceYouRead: changedSinceRead,
        reservedBy: this._liveReservations(p, a?.id), recentChangesByOthers: recent,
      };
    });
  }

  // ---------- targeted context & delivery ----------
  _isRelevant(e, a) {
    if (e.actor.id === a.id) return false;
    if (['chat.message', 'user.joined', 'user.left', 'workspace.created'].includes(e.type)) return false;
    if (['decision.recorded', 'contract.updated', 'blocker.reported', 'changes.merged'].includes(e.type)) return true;
    if (e.type === 'coordination.requested') return !e.data.to || e.data.to === a.id;
    if (e.type === 'conflict.detected') return (e.data.agents || []).includes(a.id) || e.files.some((f) => a.touched[f]);
    const t = a.taskId && this.state.tasks[a.taskId];
    if (t && e.task) {
      if (e.task === t.id) return true;
      if (t.dependsOn.includes(e.task)) return true; // my upstream dependencies
      const other = this.state.tasks[e.task];
      if (other && other.dependsOn.includes(t.id) && ['task.started', 'task.blocked', 'blocker.reported'].includes(e.type)) return true;
    }
    if (e.files.length) {
      const mine = new Set([...Object.keys(a.touched), ...(t ? t.files : [])]);
      if (e.files.some((f) => mine.has(f))) return true;
    }
    if (e.type === 'agent.joined' || e.type === 'task.started') return true; // concise awareness of new parallel work
    return false;
  }

  _relevantSince(a, cursor) {
    return this.eventsSince(cursor || 0, 100000).filter((e) => this._isRelevant(e, a));
  }

  _urgent(e, a) {
    if (['conflict.detected', 'contract.updated', 'decision.recorded', 'coordination.requested', 'blocker.reported', 'changes.merged'].includes(e.type)) return true;
    if ((e.type === 'file.changed' || e.type === 'file.deleted') && e.files.some((f) => a.reads[f] || this.state.reservations[f]?.[a.id])) return true;
    if (e.task && a.taskId && this.state.tasks[a.taskId]?.dependsOn.includes(e.task)) return true;
    return false;
  }

  // De-duplicate: keep only the latest file.changed per (actor, file), and the latest status per agent.
  _dedupe(events) {
    const seen = new Set();
    const out = [];
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      let key = null;
      if (e.type === 'file.changed' || e.type === 'file.edit_started' || e.type === 'file.edit_completed') key = `${e.type}|${e.actor.id}|${e.files.join(',')}`;
      else if (e.type === 'agent.status_changed') key = `status|${e.actor.id}`;
      if (key) { if (seen.has(key)) continue; seen.add(key); }
      out.push(e);
    }
    return out.reverse();
  }

  _digestText(events, max = 25) {
    const list = this._dedupe(events);
    if (!list.length) return '';
    const shown = list.slice(-max);
    const lines = shown.map((e) => `- #${e.seq} ${e.type}: ${e.summary}`);
    if (list.length > shown.length) lines.unshift(`- (${list.length - shown.length} older updates omitted; call get_updates for more)`);
    return lines.join('\n');
  }

  // Delivery for hooks: returns text to inject into the agent's context, or '' when nothing worth interrupting for.
  op_pullDigest({ agentId, force }) {
    const a = this.state.agents[agentId];
    const pending = this._relevantSince(a, a.cursor);
    if (!pending.length) { a.cursor = this.state.seq; return { text: '', count: 0 }; }
    const urgent = pending.some((e) => this._urgent(e, a));
    if (!force && !urgent && Date.now() - a.lastDigestAt < DIGEST_INTERVAL_MS) return { text: '', count: 0, deferred: pending.length };
    a.cursor = this.state.seq;
    a.lastDigestAt = Date.now();
    this._markDelivered(a.id, pending);
    return { text: `TeamCode team updates since your last check (relevant to your work):\n${this._digestText(pending)}`, count: pending.length, events: pending.map((e) => e.seq) };
  }

  op_getUpdates({ agentId, all, since }) {
    const a = this.state.agents[agentId];
    const from = since != null ? since : a.cursor;
    const evs = this.eventsSince(from, 100000).filter((e) => e.actor.id !== a.id && (all ? e.type !== 'chat.message' : this._isRelevant(e, a)));
    a.cursor = Math.max(a.cursor, this.state.seq);
    a.lastDigestAt = Date.now();
    this._markDelivered(a.id, evs);
    return { cursor: a.cursor, count: evs.length, text: this._digestText(evs, 60) || 'No new relevant updates.', events: this._dedupe(evs).slice(-60).map((e) => ({ seq: e.seq, type: e.type, ts: e.ts, actor: e.actor.name, task: e.task, files: e.files, branch: e.branch, summary: e.summary })) };
  }

  op_getContext({ agentId, taskId, files, topic }) {
    const a = agentId && this.state.agents[agentId];
    const t = this.state.tasks[taskId || a?.taskId];
    const fileSet = new Set([...(t?.files || []), ...arr(files).map(normPath), ...(a ? Object.keys(a.edited) : [])]);
    const deps = (t?.dependsOn || []).map((d) => this.state.tasks[d]).filter(Boolean);
    const dependents = t ? Object.values(this.state.tasks).filter((o) => o.dependsOn.includes(t.id)) : [];
    const relatedTaskIds = new Set([t?.id, ...deps.map((d) => d.id), ...dependents.map((d) => d.id)].filter(Boolean));
    const topicRe = topic ? new RegExp(String(topic).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') : null;
    const ctx = {
      workspace: this.state.meta.name,
      you: a ? { id: a.id, name: a.name, branch: a.branch, mode: a.mode } : null,
      task: t ? { id: t.id, title: t.title, description: t.description, status: t.status, files: t.files, mode: t.mode, parallelNotes: t.parallelNotes } : null,
      dependencies: deps.map((d) => ({ id: d.id, title: d.title, status: d.status, summary: d.summary, assignee: d.assigneeName, branch: d.branch })),
      dependents: dependents.map((d) => ({ id: d.id, title: d.title, status: d.status, assignee: d.assigneeName })),
      activeAgents: this._activeAgents().filter((o) => o.id !== a?.id).map((o) => ({
        name: o.name, client: o.client, status: o.status, task: this.state.tasks[o.taskId]?.title || null, branch: o.branch,
        editing: Object.keys(this.state.reservations).filter((p) => this.state.reservations[p][o.id]).slice(0, 12),
      })),
      reservationsOnYourFiles: [...fileSet].flatMap((p) => this._liveReservations(p, a?.id).map((r) => ({ path: p, ...r }))),
      contracts: Object.values(this.state.contracts)
        .filter((c) => !topicRe || topicRe.test(c.name + c.description + c.content))
        .map((c) => ({ name: c.name, version: c.version, description: c.description, fromTask: this.state.tasks[c.taskId]?.title || null, content: relatedTaskIds.has(c.taskId) || topicRe ? c.content : undefined })),
      decisions: this.state.decisions.filter((d) => !topicRe || topicRe.test(d.title + d.decision)).slice(-15).map((d) => ({ title: d.title, decision: d.decision, rationale: d.rationale, by: d.by.name })),
      openBlockers: Object.values(this.state.blockers).filter((b) => b.status === 'open').map((b) => ({ id: b.id, description: b.description, needs: b.needs, task: this.state.tasks[b.taskId]?.title || null, by: b.by.name })),
      notes: this.state.notes.filter((n) => (topicRe ? topicRe.test(n.message) : relatedTaskIds.has(n.taskId) || n.files.some((f) => fileSet.has(f)) || n.kind === 'discovery')).slice(-12).map((n) => ({ kind: n.kind, message: n.message, by: n.by.name })),
      recentChangesToYourFiles: this.events.filter((e) => e.type === 'file.changed' && e.actor.id !== a?.id && e.files.some((f) => fileSet.has(f))).slice(-10).map((e) => ({ seq: e.seq, summary: e.summary, at: e.ts })),
      openConflicts: Object.values(this.state.conflicts).filter((c) => c.status === 'open' && (!a || c.agents?.includes(a.id) || fileSet.has(c.path))).map((c) => ({ id: c.id, kind: c.kind, path: c.path, message: c.message })),
      pendingReviews: Object.values(this.state.tasks).filter((x) => x.review.state === 'pending').map((x) => ({ title: x.title, branch: x.branch })),
    };
    if (t && Object.keys(t.contractsUsed || {}).length) {
      ctx.staleContracts = Object.entries(t.contractsUsed).filter(([n, v]) => this.state.contracts[n] && this.state.contracts[n].version > v).map(([n, v]) => ({ name: n, youStartedWith: v, latest: this.state.contracts[n].version }));
    }
    return ctx;
  }

  op_teamStatus({ agentId }) {
    const a = agentId && this.state.agents[agentId];
    return {
      agents: Object.values(this.state.agents).filter((o) => ACTIVE.has(o.status) || o.status === 'stale').map((o) => ({ ...this._agentView(o), you: o.id === a?.id })),
      tasks: Object.values(this.state.tasks).filter((t) => t.status !== 'cancelled').map((t) => ({ id: t.id, title: t.title, status: t.status, assignee: t.assigneeName, dependsOn: t.dependsOn, review: t.review.state })),
      unreadUpdates: a ? this._relevantSince(a, a.cursor).length : undefined,
    };
  }

  op_getAgent({ agent }) {
    const a = this.state.agents[agent] || Object.values(this.state.agents).find((o) => o.name.toLowerCase() === String(agent || '').toLowerCase());
    if (!a) throw new CoordError(`No agent "${agent}"`);
    const t = this.state.tasks[a.taskId];
    return { ...this._agentView(a), taskDescription: t?.description || null, recentEvents: this.events.filter((e) => e.actor.id === a.id).slice(-12).map((e) => e.summary) };
  }

  op_findOverlaps({ agentId, taskId }) {
    const a = agentId && this.state.agents[agentId];
    const t = this.state.tasks[taskId || a?.taskId];
    const myFiles = new Set([...(t?.files || []), ...(a ? Object.keys(a.edited) : []), ...(a ? Object.keys(this.state.reservations).filter((p) => this.state.reservations[p][a.id]) : [])]);
    const tasks = Object.values(this.state.tasks).filter((o) => o.id !== t?.id && !['done', 'cancelled', 'failed'].includes(o.status))
      .map((o) => {
        const ag = o.assignee && this.state.agents[o.assignee];
        const theirFiles = new Set([...o.files, ...(ag ? Object.keys(ag.edited) : [])]);
        return { task: o.title, taskId: o.id, status: o.status, agent: o.assigneeName, sharedFiles: [...myFiles].filter((f) => theirFiles.has(f)), dependency: t ? (t.dependsOn.includes(o.id) ? 'you depend on it' : o.dependsOn.includes(t.id) ? 'it depends on you' : null) : null };
      })
      .filter((o) => o.sharedFiles.length || o.dependency);
    const reservations = [...myFiles].flatMap((p) => this._liveReservations(p, a?.id).map((r) => ({ path: p, agent: r.agentName, mode: r.mode, intent: r.intent })));
    return { yourFiles: [...myFiles], overlappingTasks: tasks, reservations };
  }

  // ---------- review / integration ----------
  op_branchCreated({ taskId, branch, worktree, baseCommit }, ctx) {
    const t = this._task(taskId);
    Object.assign(t, { branch, worktree, baseCommit });
    return this.emitEvent('branch.created', this._actor({}, ctx), { task: t.id, branch, data: { worktree, baseCommit } });
  }

  op_requestReview({ agentId, taskId, summary, files, headCommit, stats }, ctx) {
    const actor = this._actor({ agentId }, ctx);
    const t = this._task(taskId || actor.agent?.taskId);
    const changed = arr(files).length ? arr(files).map(normPath) : this._taskChangedFiles(t);
    t.review = { state: 'pending', requestedBy: actor.name, at: Date.now(), summary: summary || t.summary || '', files: changed, stats: stats || null };
    if (headCommit) t.headCommit = headCommit;
    return this.emitEvent('changes.review_requested', actor, { task: t.id, branch: t.branch, files: changed, data: { summary: t.review.summary, fileCount: changed.length } });
  }

  _taskChangedFiles(t) {
    const files = new Set();
    for (const e of this.events) if (e.task === t.id && (e.type === 'file.changed' || e.type === 'file.deleted')) e.files.forEach((f) => files.add(f));
    return [...files];
  }

  op_reviewDecision({ taskId, decision, note }, ctx) {
    const t = this._task(taskId);
    const actor = this._actor({}, ctx);
    if (!['approve', 'reject'].includes(decision)) throw new CoordError('decision must be approve or reject');
    t.review = { ...t.review, state: decision === 'approve' ? 'approved' : 'rejected', by: actor.name, decidedAt: Date.now(), note: note || '' };
    return this.emitEvent(decision === 'approve' ? 'changes.approved' : 'changes.rejected', actor, { task: t.id, branch: t.branch, data: { note: note || '' } });
  }

  op_testCompleted({ taskId, passed, output, command, durationMs }, ctx) {
    const t = taskId ? this._task(taskId) : null;
    if (t) t.tests = { state: passed ? 'passed' : 'failed', at: Date.now(), command, output: String(output || '').slice(-8000), durationMs };
    return this.emitEvent('test.completed', this._actor({}, ctx), { task: t?.id, branch: t?.branch, data: { passed: !!passed, command, durationMs } });
  }

  op_integrationChecked({ taskId, conflicts = [], risks = [] }, ctx) {
    const t = this._task(taskId);
    const actor = this._actor({}, ctx);
    // Contract drift: this task used contract versions that have since changed.
    for (const [n, v] of Object.entries(t.contractsUsed || {})) {
      const c = this.state.contracts[n];
      if (c && c.version > v && !(c.taskId === t.id)) risks.push({ kind: 'contract', message: `Built against contract "${n}" v${v}; latest is v${c.version}` });
    }
    // Other unmerged tasks touching the same files.
    const mine = new Set(t.review?.files || this._taskChangedFiles(t));
    for (const o of Object.values(this.state.tasks)) {
      if (o.id === t.id || o.integration?.state === 'merged' || ['cancelled', 'failed'].includes(o.status)) continue;
      const theirs = new Set(o.review?.files || this._taskChangedFiles(o));
      const shared = [...mine].filter((f) => theirs.has(f));
      if (shared.length && o.status !== 'waiting') risks.push({ kind: 'overlap', message: `Also changed by unmerged task "${o.title}": ${shared.slice(0, 5).join(', ')}` });
    }
    const state = conflicts.length ? 'conflicts' : 'clean';
    t.integration = { state, conflicts, risks, at: Date.now() };
    if (conflicts.length) {
      const id = rid('cfl');
      this.state.conflicts[id] = { id, kind: 'merge', path: conflicts[0], files: conflicts, taskId: t.id, message: `Merging "${t.title}" conflicts with main in ${conflicts.length} file(s)`, status: 'open', at: Date.now() };
      this.emitEvent('conflict.detected', actor, { task: t.id, files: conflicts, branch: t.branch, data: { id, kind: 'merge', message: this.state.conflicts[id].message } });
    }
    this.emitEvent('integration.checked', actor, { task: t.id, branch: t.branch, data: { state, conflicts, risks } });
    return t.integration;
  }

  op_markMerged({ taskId, commit, into }, ctx) {
    const t = this._task(taskId);
    t.integration = { ...t.integration, state: 'merged', mergedAt: Date.now(), commit, conflicts: [] };
    if (t.review.state !== 'approved') t.review = { ...t.review, state: 'approved', by: this._actor({}, ctx).name, decidedAt: Date.now() };
    for (const c of Object.values(this.state.conflicts)) if (c.taskId === t.id && c.kind === 'merge' && c.status === 'open') c.status = 'resolved';
    const e = this.emitEvent('changes.merged', this._actor({}, ctx), { task: t.id, branch: t.branch, files: t.review.files || [], data: { commit, into: into || 'main' } });
    this._recomputeReadiness(this._actor({}, ctx));
    return e;
  }

  op_markReverted({ taskId, commit }, ctx) {
    const t = this._task(taskId);
    t.integration = { ...t.integration, state: 'reverted', revertedAt: Date.now(), revertCommit: commit };
    t.review = { ...t.review, state: 'reverted' };
    return this.emitEvent('changes.reverted', this._actor({}, ctx), { task: t.id, branch: t.branch, data: { commit } });
  }

  // Files changed by a shared-mode task, with the version before the task first touched them.
  op_taskChanges({ taskId }) {
    const t = this._task(taskId);
    const out = {};
    for (const e of this.events) {
      if (e.task !== t.id || !['file.changed', 'file.deleted'].includes(e.type)) continue;
      for (const p of e.files) {
        const f = this.state.files[p];
        if (!out[p]) {
          const before = f?.history.filter((h) => h.at < e.ts - 0).slice(-1)[0] || null;
          out[p] = { path: p, beforeVersion: before ? before.version : 0, by: e.actor.name, branch: e.branch };
        }
        out[p].afterVersion = f?.version || null;
        out[p].lastBy = e.actor.name;
      }
    }
    for (const c of Object.values(out)) {
      const f = this.state.files[c.path];
      c.changedByOthersSince = f ? f.history.filter((h) => h.version > (c.beforeVersion || 0) && h.by?.id && !this.events.some((e) => e.task === t.id && e.actor.id === h.by.id)).map((h) => h.by.name) : [];
    }
    return Object.values(out);
  }

  op_resolveConflictRecord({ conflictId, resolution }, ctx) {
    const c = this.state.conflicts[conflictId];
    if (!c) throw new CoordError('Unknown conflict');
    c.status = 'resolved'; c.resolution = resolution || 'acknowledged';
    this.emitEvent('conflict.resolved', this._actor({}, ctx), { task: c.taskId, files: [c.path], data: { id: c.id, resolution: c.resolution } });
    return c;
  }

  // ---------- file sync ----------
  op_fileIndex() {
    const idx = {};
    for (const [p, f] of Object.entries(this.state.files)) idx[p] = { version: f.version, hash: f.hash, deleted: !!f.deleted };
    return idx;
  }

  op_fileGet({ path: p, version }) {
    p = normPath(p);
    const f = this.state.files[p];
    if (!f) throw new CoordError(`No file ${p}`);
    const h = version ? f.history.find((x) => x.version === +version)?.hash : f.hash;
    const buf = this._getBlob(h);
    return { path: p, version: version ? +version : f.version, hash: h, deleted: version ? !h : !!f.deleted, contentB64: buf ? buf.toString('base64') : null, binary: f.binary };
  }

  _applyFile(p, buf, deleted, actor, extra = {}) {
    const prev = this.state.files[p];
    const hash = deleted ? null : this._putBlob(buf);
    const f = prev || { version: 0, history: [] };
    f.version += 1;
    Object.assign(f, { hash, deleted: !!deleted, size: deleted ? 0 : buf.length, binary: deleted ? false : isBinary(buf), by: { kind: actor.kind, id: actor.id, name: actor.name }, at: Date.now() });
    f.history.push({ version: f.version, hash, deleted: !!deleted, by: f.by, at: f.at });
    if (f.history.length > MAX_HISTORY) f.history = f.history.slice(-MAX_HISTORY);
    this.state.files[p] = f;
    this.emit('file', { path: p, version: f.version, hash, deleted: !!deleted, contentB64: deleted ? null : buf.toString('base64'), by: f.by, ...extra });
    return f;
  }

  // Sync write from a desktop client. Never silently overwrites: stale writes are 3-way merged or turned into conflicts.
  op_filePut({ path: p, baseVersion = 0, contentB64, deleted, origin }, ctx) {
    p = normPath(p);
    if (!p || p.startsWith('..')) throw new CoordError('Invalid path');
    let actor = this._actor({}, ctx);
    const buf = deleted ? null : Buffer.from(contentB64 || '', 'base64');
    if (buf && buf.length > MAX_FILE_BYTES) throw new CoordError(`${p} is larger than 5 MB and is not synced`);
    const hash = buf ? sha(buf) : null;
    const cur = this.state.files[p];
    const curVersion = cur?.version || 0;
    if (cur && ((deleted && cur.deleted) || (!deleted && cur.hash === hash))) return { ok: true, version: cur.version, hash: cur.hash, unchanged: true };
    if (!cur && deleted) return { ok: true, version: 0, unchanged: true };
    if (!cur && this.limits.maxFiles && Object.keys(this.state.files).length >= this.limits.maxFiles) throw new CoordError(`This project has reached its file limit (${this.limits.maxFiles}) on this server`, 'too_large');

    // Attribute the write to the agent whose hook just reported this exact content.
    const claim = this.claims.get(p);
    let claimed = false;
    if (claim && claim.hash === hash && Date.now() - claim.at < 60000 && this.state.agents[claim.agentId]) {
      const a = this.state.agents[claim.agentId];
      actor = { kind: 'agent', id: a.id, name: a.name, agent: a, via: actor };
      claimed = true;
      this.claims.delete(p);
    }

    // No server record of the file (new file, or the server's data was reset): nothing to merge against.
    if (baseVersion === curVersion || !cur) {
      const f = this._applyFile(p, buf, deleted, actor, { origin });
      if (!claimed) this.emitEvent(deleted ? 'file.deleted' : 'file.changed', actor, { task: actor.agent?.taskId, files: [p], branch: 'main', version: f.version, data: { hash } });
      return { ok: true, version: f.version, hash };
    }

    // Stale base: someone else changed the file since this client last synced it.
    const baseBuf = baseVersion ? this._getBlob(cur.history.find((h) => h.version === baseVersion)?.hash) : Buffer.alloc(0);
    const curBuf = cur.deleted ? null : this._getBlob(cur.hash);
    const canMerge = buf && curBuf && baseBuf && !isBinary(buf) && !isBinary(curBuf) && !isBinary(baseBuf);
    if (canMerge) {
      const m = merge3(baseBuf.toString('utf8'), curBuf.toString('utf8'), buf.toString('utf8'), { ours: `${cur.by?.name || 'current'} (v${cur.version})`, theirs: actor.name });
      if (m && m.clean) {
        const mergedBuf = Buffer.from(m.content, 'utf8');
        const f = this._applyFile(p, mergedBuf, false, actor, { origin: null, merged: true });
        this.emitEvent('file.changed', actor, { task: actor.agent?.taskId, files: [p], branch: 'main', version: f.version, data: { hash: f.hash, merged: true, baseVersion } });
        this.emitEvent('conflict.resolved', { kind: 'system', id: 'system', name: 'TeamCode' }, { files: [p], data: { resolution: 'auto-merged', message: `Concurrent edits by ${cur.by?.name} and ${actor.name} merged cleanly` } });
        return { ok: true, version: f.version, hash: f.hash, merged: true, contentB64: mergedBuf.toString('base64') };
      }
    }
    const id = rid('cfl');
    const incomingHash = buf ? this._putBlob(buf) : null;
    this.state.conflicts[id] = {
      id, kind: 'sync', path: p, status: 'open', at: Date.now(), baseVersion, currentVersion: cur.version, currentBy: cur.by?.name,
      incomingHash, incomingDeleted: !!deleted, incomingBy: { id: actor.id, name: actor.name },
      message: `${actor.name} changed ${p} based on v${baseVersion}, but ${cur.by?.name || 'someone'} already saved v${cur.version}. Both versions are kept.`,
    };
    this.emitEvent('conflict.detected', actor, { files: [p], branch: 'main', version: cur.version, data: { id, kind: 'sync', message: this.state.conflicts[id].message, agents: [actor.id, cur.by?.id].filter(Boolean) } });
    return { ok: false, conflict: id, version: cur.version };
  }

  op_conflictData({ conflictId }) {
    const c = this.state.conflicts[conflictId];
    if (!c) throw new CoordError('Unknown conflict');
    const f = this.state.files[c.path];
    const get = (h) => { const b = this._getBlob(h); return b ? b.toString('base64') : null; };
    const baseHash = f?.history.find((h) => h.version === c.baseVersion)?.hash;
    return { ...c, currentB64: f && !f.deleted ? get(f.hash) : null, incomingB64: get(c.incomingHash), baseB64: get(baseHash) };
  }

  // resolution: 'current' (keep what's on the server), 'incoming' (take the stale writer's version), or 'content' (custom merged content)
  op_resolveConflict({ conflictId, resolution, contentB64 }, ctx) {
    const c = this.state.conflicts[conflictId];
    if (!c || c.kind !== 'sync') throw new CoordError('Unknown sync conflict');
    const actor = this._actor({}, ctx);
    let buf = null, deleted = false;
    if (resolution === 'incoming') { deleted = c.incomingDeleted; buf = deleted ? null : this._getBlob(c.incomingHash); }
    else if (resolution === 'content') buf = Buffer.from(contentB64 || '', 'base64');
    if (resolution !== 'current') {
      const f = this._applyFile(c.path, buf, deleted, actor, { origin: null });
      this.emitEvent('file.changed', actor, { files: [c.path], branch: 'main', version: f.version, data: { hash: f.hash, resolution } });
    } else {
      // Re-broadcast current content so the stale client converges.
      const f = this.state.files[c.path];
      this.emit('file', { path: c.path, version: f.version, hash: f.hash, deleted: !!f.deleted, contentB64: f.deleted ? null : this._getBlob(f.hash).toString('base64'), by: f.by, origin: null });
    }
    c.status = 'resolved'; c.resolution = resolution;
    this.emitEvent('conflict.resolved', actor, { files: [c.path], data: { id: c.id, resolution } });
    return c;
  }

  op_fileHistory({ path: p }) {
    const f = this.state.files[normPath(p)];
    return f ? f.history.slice().reverse() : [];
  }

  op_fileRevert({ path: p, version }, ctx) {
    p = normPath(p);
    const f = this.state.files[p];
    const h = f?.history.find((x) => x.version === +version);
    if (!h) throw new CoordError('Version not found');
    const actor = this._actor({}, ctx);
    const buf = h.deleted ? null : this._getBlob(h.hash);
    const nf = this._applyFile(p, buf, h.deleted, actor, { origin: null });
    this.emitEvent('file.reverted', actor, { files: [p], version: nf.version, data: { toVersion: +version } });
    return { version: nf.version };
  }

  // ---------- views ----------
  op_snapshot() {
    const s = this.state;
    const recentFiles = Object.entries(s.files).filter(([, f]) => f.by).sort((a, b) => b[1].at - a[1].at).slice(0, 150)
      .map(([p, f]) => ({ path: p, version: f.version, by: f.by, at: f.at, deleted: f.deleted, size: f.size }));
    const branchChanges = this.events.filter((e) => e.type === 'file.changed' && e.branch && e.branch !== 'main').slice(-150)
      .map((e) => ({ path: e.files[0], by: e.actor, at: e.ts, branch: e.branch, task: e.task }));
    return {
      meta: { id: s.meta.id, name: s.meta.name, createdAt: s.meta.createdAt }, seq: s.seq, settings: s.settings,
      users: s.users, agents: Object.fromEntries(Object.values(s.agents).map((a) => [a.id, this._agentView(a)])),
      tasks: s.tasks, contracts: s.contracts, decisions: s.decisions.slice(-100), notes: s.notes.slice(-100),
      blockers: s.blockers, conflicts: s.conflicts, coordination: s.coordination.slice(-50),
      reservations: Object.fromEntries(Object.entries(s.reservations).map(([p, h]) => [p, this._liveReservations(p)]).filter(([, r]) => r.length)),
      recentFiles, branchChanges, fileCount: Object.values(s.files).filter((f) => !f.deleted).length,
    };
  }

  op_events({ since = 0, limit = 300 }) {
    const evs = this.eventsSince(since, 100000);
    return evs.slice(-limit).map((e) => ({ ...e, deliveredTo: [...(this.delivered.get(e.seq) || [])].map((id) => this.state.agents[id]?.name || id) }));
  }

  // ---------- liveness ----------
  sweep() {
    const now = Date.now();
    for (const a of Object.values(this.state.agents)) {
      if (ACTIVE.has(a.status) && now - a.lastSeen > STALE_MS) this._setAgentStatus(a, 'stale', 'no heartbeat for 90s');
      else if (a.status === 'stale' && now - a.lastSeen > OFFLINE_MS) {
        this._releaseAll(a, true);
        this._setAgentStatus(a, 'offline', 'disconnected');
        const t = a.taskId && this.state.tasks[a.taskId];
        if (t && t.status === 'running') {
          t.status = 'ready';
          this.emitEvent('task.updated', null, { task: t.id, data: { changes: { status: 'ready' }, reason: `${a.name} disconnected; task returned to queue` } });
        }
      }
    }
    for (const [p, holders] of Object.entries(this.state.reservations)) {
      for (const [id, r] of Object.entries(holders)) {
        if (r.expires < now) {
          delete holders[id];
          const a = this.state.agents[id];
          if (a) this.emitEvent('file.edit_completed', a, { task: a.taskId, files: [p], data: { expired: true } });
        }
      }
      if (!Object.keys(holders).length) delete this.state.reservations[p];
    }
  }
}

class Coordinator {
  constructor({ dataDir, limits = {} } = {}) {
    this.dataDir = dataDir || null;
    this.limits = limits;
    this.workspaces = new Map();
    if (this.dataDir) {
      fs.mkdirSync(this.dataDir, { recursive: true });
      for (const id of fs.readdirSync(this.dataDir)) {
        const sf = path.join(this.dataDir, id, 'state.json');
        if (fs.existsSync(sf)) {
          try { this._open(id); } catch { /* skip unreadable workspace */ }
        }
      }
    }
    this._sweeper = setInterval(() => { for (const w of this.workspaces.values()) w.sweep(); }, 10000);
    this._sweeper.unref?.();
  }

  _open(id, opts = {}) {
    const w = new Workspace({ id, ...opts, limits: this.limits, dataDir: this.dataDir ? path.join(this.dataDir, id) : null });
    this.workspaces.set(id, w);
    return w;
  }

  ensureWorkspace(id, { name, token } = {}) {
    if (!/^[a-zA-Z0-9_-]{3,64}$/.test(id)) throw new CoordError('Invalid workspace id');
    return this.workspaces.get(id) || this._open(id, { name, token });
  }

  get(id) { return this.workspaces.get(id) || null; }

  removeWorkspace(id) {
    if (!/^[a-zA-Z0-9_-]{3,64}$/.test(String(id))) return false;
    const w = this.workspaces.get(id);
    if (w) {
      clearTimeout(w._saveTimer);
      w._removed = true;
      this.workspaces.delete(id);
    }
    // Remove the files even if the workspace couldn't be loaded at boot.
    if (this.dataDir) fs.rmSync(path.join(this.dataDir, id), { recursive: true, force: true });
    return true;
  }

  close() {
    clearInterval(this._sweeper);
    for (const w of this.workspaces.values()) { clearTimeout(w._saveTimer); w.saveNow(); }
  }
}

module.exports = { Coordinator, Workspace, CoordError, EVENT_TYPES, sha, normPath, isBinary };
