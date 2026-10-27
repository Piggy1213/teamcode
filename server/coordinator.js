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

const AGENT_OPS = new Set(['heartbeat', 'releaseTask', 'setAgentStatus', 'agentRead', 'preEdit', 'fileEdited', 'announceEdit', 'releaseFiles', 'pullDigest', 'getUpdates']);
const ACTIVE = new Set(['starting', 'working', 'idle', 'waiting', 'blocked']);
const STALE_MS = 90 * 1000;
const OFFLINE_MS = 10 * 60 * 1000;
const RESERVATION_MS = 15 * 60 * 1000;
const RECENT_EDIT_MS = 10 * 60 * 1000;
const DIGEST_INTERVAL_MS = 45 * 1000;
const MAX_HISTORY = 30;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_ARGS_BYTES = 512 * 1024; // any op that doesn't carry file content
const CONTENT_OPS = new Set(['filePut', 'resolveConflict']); // bounded by MAX_FILE_BYTES instead
const SETTINGS_KEYS = { testCommand: 500 }; // shared workspace settings and their max length
const MAX_EVENTS = 20000; // kept in memory and on disk; older events are dropped
// Names that would reach Object.prototype (or Object itself) when used as a key on the plain-object state.
const POISON = new Set(['__proto__', 'constructor', 'prototype']);
// Operations that add records to a workspace. On a hosted server they stop once the project's records
// (state + event log) use a quarter of its storage; everything else, including finishing work, keeps working.
const GROWTH_OPS = new Set(['createTask', 'createTasks', 'chat', 'publishUpdate', 'recordDecision', 'publishContract', 'requestCoordination', 'reportBlocker']);
// Records also have a hard ceiling (half the budget), so they can never squeeze out file sync. At the ceiling
// only these still run: reading, finishing and cleaning up work, and changes to files the project already has.
const CEILING_OK = new Set([
  'getContract', 'checkFiles', 'pullDigest', 'getUpdates', 'getContext', 'teamStatus', 'getAgent', 'findOverlaps', 'taskChanges',
  'fileIndex', 'fileGet', 'conflictData', 'fileHistory', 'snapshot', 'events', 'userJoined', 'userLeft', 'heartbeat', 'releaseTask', 'setAgentStatus', 'agentExited',
  'releaseFiles', 'completeTask', 'failTask', 'cancelTask', 'deleteTask', 'reopenTask', 'requestReview', 'reviewDecision', 'testCompleted',
  'integrationChecked', 'markMerged', 'markReverted', 'resolveBlocker', 'resolveConflictRecord', 'resolveConflict', 'fileRevert',
]);
const PATH_OPS = new Set(['filePut', 'agentRead', 'preEdit', 'fileEdited', 'announceEdit']); // allowed at the ceiling for known files
// Work an agent only does while it is actually working; any of these brings back a task the sweep took off it.
const RESUME_OPS = new Set(['heartbeat', 'agentRead', 'preEdit', 'fileEdited', 'announceEdit', 'pullDigest', 'getUpdates', 'publishUpdate']);
const MAX_STRING = 64 * 1024; // any single text field, other than file/contract content and test output
const MAX_LIST = 5000; // any single list
const FREE_TEXT_OK = new Set(['contentB64', 'content', 'output']); // bounded elsewhere (file cap, args cap, output kept as last 8000 chars)
const PRUNE_AFTER = 7 * 24 * 3600 * 1000; // finished agents and resolved conflicts are forgotten after a week
const NOTICE_PRUNE_AFTER = 24 * 3600 * 1000; // overlap and integration-risk notices are advice; they go after a day
const MAX_USERS = 500; // people one project remembers
const MAX_OTHERS = 20; // other people's versions remembered per file a task changed
const MAX_AGENTS = 1000; // agent records one project keeps; the oldest finished ones make room for new sessions
const SESSION_PRUNE_AFTER = 24 * 3600 * 1000; // a finished Claude Code session's agent is forgotten after a day
const MAX_PER_AGENT = 2000; // files remembered per agent (reads, touched, edited, warned); the oldest go first
const HASH_RE = /^[0-9a-f]{64}$/;
const cleanHash = (h) => (typeof h === 'string' && HASH_RE.test(h) ? h : null);

const rid = (p) => `${p}_${crypto.randomBytes(5).toString('hex')}`;
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const isBinary = (buf) => buf.subarray(0, 8000).includes(0);
const normPath = (p) => String(p || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
const clip = (s, n = 160) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const fmtBytes = (n) => (n >= 1048576 ? `${Math.round(n / 1048576)} MB` : `${Math.round(n / 1024)} KB`);
const arr = (v) => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v]);
// Keyed workspace state lives in objects without a prototype, so a key like "__proto__" or "constructor"
// (or an array that stringifies to one) is just an ordinary key: nothing can reach Object.prototype.
const dict = (o) => { const d = Object.create(null); if (o) for (const k of Object.keys(o)) d[k] = o[k]; return d; };
const DICT_KEYS = ['users', 'agents', 'tasks', 'files', 'reservations', 'contracts', 'blockers', 'conflicts', 'settings', 'handedOver'];
// No single text field or list may be huge (file and contract content are bounded by their own limits).
function oversized(v, key = '', depth = 0) {
  if (typeof v === 'string') return v.length > MAX_STRING && !FREE_TEXT_OK.has(key);
  if (!v || typeof v !== 'object' || depth > 8) return false;
  if (Array.isArray(v)) return v.length > MAX_LIST || v.some((x) => oversized(x, key, depth + 1));
  return Object.keys(v).some((k) => oversized(v[k], k, depth + 1));
}

// Defense in depth for merges: request objects may not carry prototype-reaching keys, and absurd nesting
// is refused outright (no TeamCode request nests more than a few levels).
function poisoned(v, depth = 0) {
  if (v == null || typeof v !== 'object') return false;
  if (depth > 8) return true;
  if (Array.isArray(v)) return v.some((x) => poisoned(x, depth + 1));
  return Object.keys(v).some((k) => POISON.has(k) || poisoned(v[k], depth + 1));
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
    this.blobBytes = 0; // bytes in blobs/
    this.metaBytes = 0; // state.json + events.jsonl
    this.eventBytes = 0; // events.jsonl alone
    this.refs = new Map(); // blob hash -> references from file history and open conflicts
    this.unreferenced = new Set(); // blobs to delete once the state that no longer needs them is saved
    this.events = [];
    this.delivered = new Map(); // seq -> Set(agentId)
    this.claims = new Map(); // path -> { agentId, hash, at } recent agent edit claims, used to attribute synced writes
    this.overlapKeys = new Map();
    this.state = {
      meta: { id, name: name || id, token: token || crypto.randomBytes(16).toString('hex'), createdAt: Date.now() },
      seq: 0,
      users: dict(), agents: dict(), tasks: dict(), files: dict(), reservations: dict(), contracts: dict(),
      decisions: [], notes: [], blockers: dict(), conflicts: dict(), coordination: [],
      settings: dict({ testCommand: '' }), handedOver: dict(), // request id -> the window it was moved to
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
      try {
        const saved = JSON.parse(fs.readFileSync(sf, 'utf8'));
        for (const k of Object.keys(saved)) if (!POISON.has(k)) this.state[k] = saved[k];
      } catch { /* corrupt snapshot: rebuild from defaults */ }
      this._normalize();
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
    this._migrateChanges();
    for (const f of Object.values(this.state.files)) for (const h of f.history || []) this._ref(h.hash, 1);
    for (const c of Object.values(this.state.conflicts)) if (!c.released) this._ref(c.incomingHash, 1);
    for (const n of ['state.json', 'events.jsonl']) { try { this.metaBytes += fs.statSync(path.join(this.dataDir, n)).size; } catch { /* not written yet */ } }
    try { this.eventBytes = fs.statSync(ef).size; } catch { /* not written yet */ }
    delete this.state.delivered;
  }

  // Rebuilds every keyed map as a null-prototype dict (state loaded from JSON has ordinary objects).
  _normalize() {
    for (const k of DICT_KEYS) this.state[k] = dict(this.state[k]);
    for (const p of Object.keys(this.state.reservations)) this.state.reservations[p] = dict(this.state.reservations[p]);
    for (const a of Object.values(this.state.agents)) for (const k of ['reads', 'touched', 'edited', 'warned', 'contractsSeen']) a[k] = dict(a[k]);
    for (const t of Object.values(this.state.tasks)) {
      t.contractsUsed = dict(t.contractsUsed);
      if (t.changes) { t.changes = dict(t.changes); t.changeActors = dict(t.changeActors); }
    }
  }

  // Versions of a file that must outlive history trimming: the one each task would Revert to, and the base
  // of each open sync conflict (resolving it merges against that base).
  _neededVersions(p) {
    const keep = new Set();
    for (const t of Object.values(this.state.tasks)) {
      const c = t.changes?.[p];
      if (c && c.beforeVersion && t.status !== 'cancelled' && t.integration?.state !== 'reverted') keep.add(c.beforeVersion);
    }
    for (const c of Object.values(this.state.conflicts)) if (c.path === p && c.status === 'open' && c.baseVersion) keep.add(c.baseVersion);
    return keep;
  }

  // Someone outside a task wrote a file that task changed: remember it on the task, so Revert skips the file
  // even after history trimming has dropped that version.
  _noteOthers(p, version, actor) {
    if (!actor?.id) return;
    for (const t of Object.values(this.state.tasks)) {
      const c = t.changes?.[p];
      if (!c?.others || t.status === 'cancelled' || t.integration?.state === 'reverted') continue;
      // Work for this task (any of its agents, on it right now) is the task's own. Anything else is someone
      // else's, even from an agent id that once worked on it (a fixed-id client's later sessions or tasks).
      if (actor.agent && actor.agent.taskId === t.id) continue;
      c.others[version] = clip(actor.name, 60);
      const vs = Object.keys(c.others).map(Number).sort((x, y) => x - y);
      for (const v of vs.slice(0, Math.max(0, vs.length - MAX_OTHERS))) delete c.others[v];
    }
  }

  // Drops old versions (and their content) except the newest `newest` entries and the versions in `keep`.
  _dropHistory(f, newest, keep) {
    const cut = f.history.length - newest;
    for (const h of f.history.slice(0, Math.max(0, cut))) if (!keep.has(h.version)) this._ref(h.hash, -1);
    f.history = f.history.filter((h, i) => i >= cut || keep.has(h.version));
  }

  // Space recovery for a nearly full hosted project: when a file is deleted, drop its older versions except
  // the last content (so the file can be restored) and any version a task or conflict still needs.
  _freeHistory(p, f) {
    const keep = this._neededVersions(p);
    const lastContent = [...f.history].reverse().find((h) => h.hash);
    if (lastContent) keep.add(lastContent.version);
    this._dropHistory(f, 1, keep);
  }

  // Tasks from before change records existed: build their record from the event log, once, at load.
  _migrateChanges() {
    for (const t of Object.values(this.state.tasks)) {
      if (t.changes) continue;
      const out = dict(), actors = dict();
      for (const e of this.events) {
        if (e.task !== t.id || !['file.changed', 'file.deleted'].includes(e.type)) continue;
        for (const p of e.files) {
          if (!out[p]) {
            const before = this.state.files[p]?.history.filter((h) => h.at < e.ts).slice(-1)[0] || null;
            out[p] = { beforeVersion: before ? before.version : 0, by: e.actor.name, branch: e.branch };
          }
          out[p].lastBy = e.actor.name;
        }
        actors[e.actor.id] = true;
      }
      if (Object.keys(out).length) { t.changes = out; t.changeActors = actors; }
    }
    // Records saved before other people's versions were remembered get that record now, from history. Where
    // history after the starting point already has gaps, those versions might have been anyone's.
    for (const t of Object.values(this.state.tasks)) {
      for (const [p, c] of Object.entries(t.changes || {})) {
        if (c.others) continue;
        const f = this.state.files[p];
        const before = c.beforeVersion || 0;
        c.others = {};
        if (!f) continue;
        for (const h of f.history) if (h.version > before && h.by?.id && !t.changeActors?.[h.by.id]) c.others[h.version] = clip(h.by.name, 60);
        const kept = new Set(f.history.map((h) => h.version));
        for (let v = before + 1; v <= f.version; v++) if (!kept.has(v)) { c.others[v] = 'someone (older history was trimmed)'; break; }
      }
    }
  }

  // Agents long finished and conflicts long resolved are dropped, so a long-lived workspace doesn't grow forever.
  _prune(now) {
    if (now - (this._prunedAt || 0) < 3600 * 1000) return;
    this._prunedAt = now;
    const holding = new Set(Object.values(this.state.tasks).filter((t) => t.assignee).map((t) => t.assignee));
    // A finished Claude Code session's agent goes after a day unless it still has work it could resume (tasks it
    // finished keep the name they were done under).
    const live = new Set(Object.values(this.state.tasks).filter((t) => ['running', 'blocked'].includes(t.status) || t.releasedFrom).map((t) => t.assignee));
    let changed = false;
    for (const a of Object.values(this.state.agents)) {
      if (ACTIVE.has(a.status) || a.status === 'stale') continue;
      const old = now - (a.lastSeen || 0);
      // Asleep ('offline') may come back: only a session that actually ended goes after a day.
      const ended = a.perSession && a.status !== 'offline';
      if (!(ended ? old > SESSION_PRUNE_AFTER && !live.has(a.id) : old > PRUNE_AFTER && !(a.perSession ? live : holding).has(a.id))) continue;
      if (a.perSession && old < PRUNE_AFTER && this._pendingRequests(a).length) continue; // waiting for the person's next window
      delete this.state.agents[a.id]; changed = true;
    }
    for (const c of Object.values(this.state.conflicts)) {
      const notice = c.kind === 'overlap' || c.kind === 'integration_risk';
      if ((c.status === 'resolved' && now - (c.resolvedAt || c.at || 0) > PRUNE_AFTER) || (notice && now - (c.at || 0) > NOTICE_PRUNE_AFTER)) { this._releaseConflict(c); delete this.state.conflicts[c.id]; changed = true; }
    }
    if (changed) this._saveSoon();
  }

  _ref(hash, delta) {
    if (!hash) return;
    const n = (this.refs.get(hash) || 0) + delta;
    if (n > 0) { this.refs.set(hash, n); return; }
    this.refs.delete(hash);
    // Nothing needs this content any more. Delete it after the next save, so a crash before that save
    // can't leave the saved state pointing at missing content.
    if (this.dataDir) { this.unreferenced.add(hash); this._saveSoon(); } else this._mem?.delete(hash);
  }

  _deleteUnreferenced() {
    for (const hash of this.unreferenced) {
      if (this.refs.has(hash)) continue; // referenced again since
      const p = path.join(this.dataDir, 'blobs', hash);
      try { const size = fs.statSync(p).size; fs.unlinkSync(p); this.blobBytes = Math.max(0, this.blobBytes - size); } catch { /* already gone */ }
    }
    this.unreferenced.clear();
  }

  // Everything a hosted project keeps on disk: file content plus its state and event log.
  _usedBytes() { return this.blobBytes + this.metaBytes; }

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
    const json = JSON.stringify({ ...this.state, delivered });
    let before = 0;
    try { before = fs.statSync(path.join(this.dataDir, 'state.json')).size; } catch { /* first save */ }
    fs.writeFileSync(tmp, json);
    fs.renameSync(tmp, path.join(this.dataDir, 'state.json'));
    this.metaBytes += Buffer.byteLength(json) - before;
    if (this.unreferenced.size) this._deleteUnreferenced();
  }

  _putBlob(buf) {
    const h = sha(buf);
    if (this.dataDir) {
      const p = path.join(this.dataDir, 'blobs', h);
      if (!fs.existsSync(p)) {
        // Old versions waiting to be deleted still count; delete them now rather than refuse the write.
        if (this.limits.maxBytes && this._usedBytes() + buf.length > this.limits.maxBytes && this.unreferenced.size) {
          clearTimeout(this._saveTimer); this._saveTimer = null;
          this.saveNow();
        }
        if (this.limits.maxBytes && this._usedBytes() + buf.length > this.limits.maxBytes) throw new CoordError(`This project has reached its storage limit (${fmtBytes(this.limits.maxBytes)}) on this server`, 'too_large');
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
    if (e.task && (type === 'file.changed' || type === 'file.deleted')) this._recordChange(e);
    this.events.push(e);
    if (this.dataDir && !this._removed) {
      const line = JSON.stringify(e) + '\n';
      fs.appendFileSync(path.join(this.dataDir, 'events.jsonl'), line);
      this.metaBytes += Buffer.byteLength(line);
      this.eventBytes += Buffer.byteLength(line);
    }
    if (this.events.length > (this.limits.maxEvents || MAX_EVENTS) || (this._eventBudget() && this.eventBytes > this._eventBudget())) this._trimEvents();
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
  // Which files a task changed, and from which version, live on the task itself (Review and Revert read
  // them there), so the event log can be trimmed freely.
  _recordChange(e) {
    const t = this.state.tasks[e.task];
    if (!t) return;
    t.changes ||= dict();
    t.changeActors ||= dict();
    for (const p of e.files) {
      if (!t.changes[p]) {
        // By version, not time: if the event names the version this change produced (sync got there first),
        // the version before the task is the one before that; otherwise it is the file's current version.
        const f = this.state.files[p];
        const before = e.version ? (f?.history.filter((h) => h.version < e.version).slice(-1)[0]?.version ?? e.version - 1) : (f?.version || 0);
        t.changes[p] = { beforeVersion: before, by: e.actor.name, branch: e.branch, others: {} };
      }
      t.changes[p].lastBy = e.actor.name;
    }
    t.changeActors[e.actor.id] = true;
  }

  // A hosted project's event log may use an eighth of its storage (a few huge events can't fill the disk).
  _eventBudget() { return this.dataDir && this.limits.maxBytes ? Math.floor(this.limits.maxBytes / 8) : 0; }

  _trimEvents() {
    this.events.splice(0, this.events.length - Math.floor((this.limits.maxEvents || MAX_EVENTS) * 0.8));
    if (!this.dataDir || this._removed) return;
    const lines = this.events.map((e) => JSON.stringify(e) + '\n');
    const budget = this._eventBudget();
    if (budget) {
      // Oldest first, down to 80% of the budget (the newest event always stays).
      let total = lines.reduce((n, l) => n + Buffer.byteLength(l), 0), drop = 0;
      while (total > budget * 0.8 && lines.length - drop > 1) total -= Buffer.byteLength(lines[drop++]);
      this.events.splice(0, drop);
      lines.splice(0, drop);
    }
    const f = path.join(this.dataDir, 'events.jsonl');
    try {
      const text = lines.join('');
      let before = 0;
      try { before = fs.statSync(f).size; } catch { /* missing */ }
      fs.writeFileSync(`${f}.tmp`, text);
      fs.renameSync(`${f}.tmp`, f);
      this.metaBytes += Buffer.byteLength(text) - before;
      this.eventBytes = Buffer.byteLength(text);
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

  _touchAgent(a, op) {
    a.lastSeen = Date.now();
    if (op !== 'heartbeat' && op !== 'releaseTask') a.lastActive = a.lastSeen;
    // Letting go and exiting aren't signs of life: an agent on its way out isn't revived by them.
    const revive = op !== 'releaseTask' && op !== 'agentExited' && (a.status === 'stale' || a.status === 'offline' || (a.perSession && a.status === 'done' && op === 'heartbeat'));
    if (revive) {
      const from = a.status;
      a.status = a.prevStatus || 'working';
      this.emitEvent('agent.status_changed', a, { task: a.taskId, data: { from, to: a.status, detail: 'reconnected' } });
      // Requests left on the person's windows that closed meanwhile come to this one, now in use.
      if (a.baseId) for (const o of Object.values(this.state.agents)) if (o.id !== a.id && o.baseId === a.baseId && this._ended(o)) this._handOverRequests(o, a);
    }
    // Finishing, reopening or exiting never brings a task back; carrying on with the work does.
    if (RESUME_OPS.has(op)) this._resumeTask(a);
  }

  // An agent back from sleep whose task the sweep put back in the queue, and nobody has touched since,
  // carries on with it, in the state it left it (a blocked task stays blocked).
  _resumeTask(a) {
    const t = a.taskId && this.state.tasks[a.taskId];
    if (!t || t.status !== 'ready' || t.assignee !== a.id || t.releasedFrom !== a.id) return;
    // Still blocked only if its blocker is still open (someone may have resolved it meanwhile).
    const blocked = t.releasedStatus === 'blocked' && Object.values(this.state.blockers).some((b) => b.taskId === t.id && b.status === 'open');
    t.status = blocked ? 'blocked' : 'running'; t.updatedAt = Date.now();
    this._unrelease(t);
    this.emitEvent('task.updated', a, { task: t.id, data: { changes: { status: t.status }, reason: `${a.name} reconnected` } });
    if (!blocked && a.status === 'blocked') this._setAgentStatus(a, 'working', 'unblocked');
  }

  // The agent lets go of its task: back to the queue if it was still running or blocked under it.
  _dropTask(a, t, reason, forget = true) {
    const mine = t.assignee === a.id;
    const running = mine && ['running', 'blocked'].includes(t.status);
    const waiting = mine && t.status === 'ready' && t.releasedFrom === a.id; // its server already let go (quit order)
    this._unrelease(t);
    if (running) {
      t.status = 'ready'; t.updatedAt = Date.now();
      this.emitEvent('task.updated', a, { task: t.id, data: { changes: { status: 'ready' }, reason } });
    }
    // A later session of the same person and folder is told it can carry on with it (see _tasksLeftFor).
    if ((running || waiting) && a.baseId) t.leftBy = { baseId: a.baseId, agentId: a.id, name: a.name, at: Date.now() };
    if (forget && a.taskId === t.id) a.taskId = null;
    if (a.status === 'blocked') this._setAgentStatus(a, 'working', reason); // its blocker was about that task
    else if (a.prevStatus === 'blocked') a.prevStatus = 'working'; // away now; it comes back working, not blocked
  }

  // Whatever happens to a task after the sweep released it (started, reassigned, reopened, finished...)
  // means its old agent no longer picks it back up.
  _unrelease(t) { delete t.releasedFrom; delete t.releasedStatus; delete t.leftBy; }

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
    if (poisoned(args) || poisoned(ctx.user)) throw new CoordError('Invalid request', 'invalid');
    if (!CONTENT_OPS.has(op) && JSON.stringify(args || {}).length > MAX_ARGS_BYTES) throw new CoordError('Request too large', 'too_large');
    if (oversized(args)) throw new CoordError('Request too large', 'too_large');
    // Two budgets on hosted servers. File content is checked when new bytes are stored (_putBlob), so reverts,
    // conflict resolutions and deletes always work. Records (tasks, chat, notes...) stop growing at a quarter
    // of the budget; finishing, reviewing, reopening and cleaning up are never refused.
    // A new Claude Code session's agent is bounded by MAX_AGENTS (finished ones make way), not by the budget, so a
    // full project can still be worked on from a new session.
    const newAgent = op === 'registerAgent' && !this.state.agents[args.agentId];
    const addsRecords = GROWTH_OPS.has(op) || (newAgent && !args.perSession);
    const full = this.limits.maxBytes && ((addsRecords && this.metaBytes > this.limits.maxBytes / 4) || (this.metaBytes > this.limits.maxBytes / 2 && !this._okAtCeiling(op, args, ctx)));
    if (full) throw new CoordError(`This project has reached its storage limit (${fmtBytes(this.limits.maxBytes)}) for tasks and history on this server. Delete finished tasks or old files to make room.`, 'too_large');
    if (op !== 'registerAgent') {
      if (args.agentId && !this.state.agents[args.agentId]) throw new CoordError(`Unknown agent ${args.agentId}. Register first.`, 'unknown_agent');
      if (AGENT_OPS.has(op) && !args.agentId) throw new CoordError(`${op} requires agentId`, 'unknown_agent');
      if (args.agentId) this._touchAgent(this.state.agents[args.agentId], op);
    }
    const res = fn.call(this, args, ctx);
    this._saveSoon();
    return res;
  }

  _okAtCeiling(op, args, ctx) {
    if (CEILING_OK.has(op)) return true;
    if (PATH_OPS.has(op)) { const ps = arr(args.path ?? args.paths); return ps.length > 0 && ps.every((p) => this.state.files[normPath(p)]); }
    if (op === 'registerAgent') return !!this.state.agents[args.agentId] || !!args.perSession;
    return false;
  }

  // ---------- users ----------
  op_userJoined({ user }, ctx) {
    const u = user || ctx.user;
    const existing = this.state.users[u.id];
    if (!existing && Object.keys(this.state.users).length >= MAX_USERS) throw new CoordError(`This project already has ${MAX_USERS} people.`, 'full');
    this.state.users[u.id] = { id: u.id, name: clip(u.name, 60), online: true, lastSeen: Date.now() };
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
    const changes = {};
    for (const [k, max] of Object.entries(SETTINGS_KEYS)) {
      if (settings && k in settings) changes[k] = String(settings[k] ?? '').slice(0, max);
    }
    Object.assign(this.state.settings, changes);
    this.emitEvent('settings.updated', this._actor({}, ctx), { data: { settings: changes } });
    return this.state.settings;
  }

  // ---------- agents ----------
  op_registerAgent({ agentId, name, client, taskId, userId, mode, branch, cwd, perSession, baseId }, ctx) {
    let a = agentId && this.state.agents[agentId];
    // Every field an agent record keeps is bounded (new Claude Code sessions may register past the storage gate).
    name = name ? clip(name, 80) : name; client = client ? clip(client, 80) : client; cwd = cwd ? String(cwd).slice(0, 500) : cwd;
    branch = branch ? clip(branch, 200) : branch; userId = userId ? clip(userId, 80) : userId; mode = mode === 'isolated' ? 'isolated' : mode ? 'shared' : mode;
    if (a) {
      const wasInactive = !ACTIVE.has(a.status);
      Object.assign(a, { client: client || a.client, cwd: cwd || a.cwd, lastSeen: Date.now() });
      if (perSession) a.perSession = true;
      // A reconnecting agent whose task has moved on to another live agent rejoins without it.
      if (taskId && taskId !== a.taskId) { try { this._assign(a, taskId); } catch (e) { if (e.code !== 'busy') throw e; } }
      const held = a.taskId && this.state.tasks[a.taskId];
      if (held && held.assignee && held.assignee !== a.id) a.taskId = null;
      // Claude Code sessions each have an agent of their own (perSession), so registering again is the same
      // session. An older Claude Code shares one id between sessions and never names a task: registering after
      // it went quiet is a new session, which starts without the old session's task (back to the queue).
      if (!taskId && held && a.taskId === held.id && wasInactive && !a.perSession) this._dropTask(a, held, `${a.name} started a new session`);
      if (wasInactive) {
        this._setAgentStatus(a, 'working', 'reconnected');
        // A TeamCode agent names its task when it registers, so it can carry on with it.
        if (taskId && taskId === a.taskId) this._resumeTask(a);
        // Requests left on the person's windows that closed meanwhile come to this one.
        if (a.baseId) for (const o of Object.values(this.state.agents)) if (o.id !== a.id && o.baseId === a.baseId && this._ended(o)) this._handOverRequests(o, a);
      }
      const missed = this._relevantSince(a, a.cursor);
      return { agent: this._agentView(a), reconnected: true, missedCount: missed.length, missed: this._digestText(missed) };
    }
    if (Object.keys(this.state.agents).length >= MAX_AGENTS) this._makeRoomForAgent();
    baseId = perSession && typeof baseId === 'string' && baseId ? clip(baseId, 80) : null;
    // A new Claude Code session picks up where the person's previous session in this folder left off: the team
    // updates it missed are still delivered.
    const prev = baseId && Object.values(this.state.agents).filter((o) => o.perSession && o.baseId === baseId && Date.now() - (o.lastSeen || 0) < PRUNE_AFTER).sort((x, y) => (y.lastSeen || 0) - (x.lastSeen || 0))[0];
    a = {
      id: agentId || rid('agt'), name: name || 'Agent', baseId, client: client || 'MCP client', userId: userId || ctx.user?.id || null,
      taskId: null, perSession: !!perSession, status: 'working', prevStatus: 'working', detail: '', mode: mode || 'shared', branch: branch || 'main',
      cwd: cwd || null, startedAt: Date.now(), lastSeen: Date.now(), cursor: prev ? Math.min(prev.cursor || 0, this.state.seq) : this.state.seq, lastDigestAt: 0,
      reads: dict(), touched: dict(), edited: dict(), warned: dict(), updates: [], contractsSeen: dict(),
    };
    this.state.agents[a.id] = a;
    this.emitEvent('agent.joined', a, { data: { client: a.client, mode: a.mode }, branch: a.branch });
    if (baseId) {
      for (const o of Object.values(this.state.agents)) {
        if (o.id === a.id || o.baseId !== baseId || ACTIVE.has(o.status)) continue;
        this._handOverRequests(o, a, !this._ended(o));
      }
    }
    if (taskId) this._assign(a, taskId);
    return { agent: this._agentView(a), reconnected: false, missedCount: 0, missed: '' };
  }

  // A Claude Code window that was closed (not one that is asleep and may come back).
  _ended(a) { return !!a && !ACTIVE.has(a.status) && a.status !== 'stale' && a.status !== 'offline'; }

  // Coordination requests addressed to a Claude Code window that didn't read them go to another window of the same
  // person and folder. From a window that closed they move (to the window in use, or the next one opened). A window
  // that is only asleep keeps its own, and a newly opened window gets a copy (it may never wake up). Only those
  // requests are affected; the window's other unread updates stay where they were.
  //
  // Each request has one live event per recipient: state.handedOver[id] = { to, seq } names the event that carries it
  // now (and { copy: { to, seq } } a copy given to a new window while the holder is asleep, at most one).
  _liveRequest(e, a) {
    const h = this.state.handedOver[e.data.id];
    if (!h) return e.data.to === a.id;
    return (h.to === a.id && h.seq === e.seq) || (h.copy?.to === a.id && h.copy.seq === e.seq);
  }

  _pendingRequests(a) {
    return this.eventsSince(a.cursor || 0, 100000).filter((e) => e.type === 'coordination.requested' && e.data.to === a.id && this._liveRequest(e, a));
  }

  _handOverRequests(from, to, copy = false) {
    if (!from?.baseId || !to || to.id === from.id || to.baseId !== from.baseId) return;
    for (const e of this._pendingRequests(from)) {
      const id = e.data.id;
      const h = this.state.handedOver[id] || { to: from.id, seq: e.seq };
      if (copy && h.copy) continue; // one copy per request
      if (!copy && h.copy?.to === to.id) {
        // The new window already has it as a copy: that copy becomes the request.
        h.to = to.id; h.seq = h.copy.seq; delete h.copy;
        const r = this.state.coordination.find((c) => c.id === id);
        if (r) { r.to = to.id; r.toName = to.name; }
        this.state.handedOver[id] = h;
        continue;
      }
      const ev = this.emitEvent('coordination.requested', e.actor, { task: e.task, files: e.files, data: { ...e.data, to: to.id, toName: to.name, handedOverFrom: from.name } });
      if (copy) h.copy = { to: to.id, seq: ev.seq };
      else {
        if (h.copy?.to === from.id) delete h.copy;
        h.to = to.id; h.seq = ev.seq;
        const r = this.state.coordination.find((c) => c.id === id);
        if (r) { r.to = to.id; r.toName = to.name; }
      }
      this.state.handedOver[id] = h;
    }
    const ids = Object.keys(this.state.handedOver);
    for (const k of ids.slice(0, Math.max(0, ids.length - 5000))) delete this.state.handedOver[k];
  }

  // The window in use that a closed one's requests go to (none: they wait for the next window opened).
  _heirOf(a) {
    if (!a.baseId) return null;
    const used = (o) => o.lastActive || o.startedAt || 0;
    return Object.values(this.state.agents).filter((o) => o.id !== a.id && o.baseId === a.baseId && ACTIVE.has(o.status)).sort((x, y) => used(y) - used(x))[0] || null;
  }

  // Over MAX_AGENTS: forget the longest-finished agents that hold no live work. Refuse only if none can go.
  _makeRoomForAgent() {
    const live = new Set(Object.values(this.state.tasks).filter((t) => ['running', 'blocked'].includes(t.status) || t.releasedFrom).map((t) => t.assignee));
    const done = Object.values(this.state.agents).filter((a) => !ACTIVE.has(a.status) && a.status !== 'stale' && !live.has(a.id)).sort((x, y) => (x.lastSeen || 0) - (y.lastSeen || 0));
    const excess = Object.keys(this.state.agents).length - MAX_AGENTS + 1;
    if (done.length < excess) throw new CoordError(`This project already has ${MAX_AGENTS} agents at work.`, 'full');
    for (const a of done.slice(0, Math.max(excess, 50))) delete this.state.agents[a.id];
  }

  // Tasks an earlier session of this person and folder left in the queue (closed, crashed, or released when its
  // server stopped and never came back), that nobody has picked up since. Sessions are told about them, so
  // carrying on is an explicit step.
  _tasksLeftFor(a) {
    if (!a?.baseId) return [];
    return Object.values(this.state.tasks).filter((t) => t.status === 'ready' && (
      t.leftBy?.baseId === a.baseId || // including by this same agent: claude --continue of the conversation that left it
      (t.releasedFrom && t.releasedFrom !== a.id && this.state.agents[t.releasedFrom]?.baseId === a.baseId && !ACTIVE.has(this.state.agents[t.releasedFrom].status))
    )).map((t) => ({ id: t.id, title: t.title }));
  }

  // completeTask / failTask / requestReview / reportBlocker without a task: say what to do instead of failing obscurely.
  _noTask(a) {
    const left = this._tasksLeftFor(a);
    return new CoordError(`You're not on a TeamCode task right now.${left.length ? ` Earlier you left: ${left.map((t) => `"${t.title}" (${t.id})`).join(', ')}.` : ''} Pass task_id, or start one with update_task_status "started" (see team_status).`, 'no_task');
  }

  // The agent that currently has a task: it is running or blocked under that agent, and the agent is
  // alive and still on it. Nobody else may start, claim or reopen the task while this returns someone.
  _liveOwner(t) {
    if (!t || !['running', 'blocked'].includes(t.status) || !t.assignee) return null;
    const a = this.state.agents[t.assignee];
    // A 'stale' agent (no heartbeat for 90s, e.g. a sleeping laptop) still owns its task until the sweep
    // marks it offline and returns the task to the queue.
    return a && (ACTIVE.has(a.status) || a.status === 'stale') && a.taskId === t.id ? a : null;
  }

  // completeTask / failTask / reportBlocker / requestReview from an agent that no longer has the task.
  _mustOwn(t, agentId) {
    const owner = this._liveOwner(t);
    if (agentId && owner && owner.id !== agentId) throw new CoordError(`${owner.name} has this task now.`, 'busy');
  }

  _assign(a, taskId) {
    const t = this.state.tasks[taskId];
    if (!t) throw new CoordError(`Unknown task ${taskId}`);
    const owner = this._liveOwner(t);
    if (owner && owner.id !== a.id) throw new CoordError(`${owner.name} is working on this task.`, 'busy');
    // The previous assignee no longer has this task (so a woken agent can't act on it).
    const prev = t.assignee && t.assignee !== a.id && this.state.agents[t.assignee];
    if (prev && prev.taskId === t.id) prev.taskId = null;
    // An agent moving to a new task gives its old one back to the queue.
    const old = a.taskId && a.taskId !== taskId && this.state.tasks[a.taskId];
    if (old && ['running', 'blocked'].includes(old.status) && old.assignee === a.id) {
      old.status = 'ready'; old.updatedAt = Date.now();
      this.emitEvent('task.updated', a, { task: old.id, data: { changes: { status: 'ready' }, reason: `${a.name} moved to another task` } });
    }
    a.taskId = taskId;
    if (t.assignee !== a.id) {
      this._unrelease(t);
      t.assignee = a.id; t.assigneeName = a.name; t.updatedAt = Date.now();
      this.emitEvent('task.assigned', a, { task: t.id, data: { assignee: a.id, assigneeName: a.name } });
    }
  }

  op_heartbeat({ agentId, status, detail }) {
    const a = this.state.agents[agentId];
    if (!a) throw new CoordError('Unknown agent', 'unknown_agent');
    if (status) this._setAgentStatus(a, clip(status, 40), clip(detail, 300));
    return { ok: true, pending: this._relevantSince(a, a.cursor).length };
  }

  // Lets go of the agent's task. resumable: the client is going away but may be back (its MCP server is being
  // restarted, or Claude Code is quitting): the task goes back to the queue now, and only this agent can carry
  // on with it if it returns first. Otherwise the task is simply handed back.
  // offer: the client is going away and can't be recognised when it comes back (another MCP client's window): the
  // task goes back to the queue and is offered to the person's sessions (tasksYouLeft), autoStart untouched.
  op_releaseTask({ agentId, resumable, offer }) {
    const a = this.state.agents[agentId];
    const leaving = resumable || offer;
    if (leaving && a.perSession) this._goingAway(a); // fixed-id agents keep their task through a restart
    const t = a.taskId && this.state.tasks[a.taskId];
    if (!t || t.assignee !== a.id) return null;
    // Waiting for this agent to come back (its server restarted, or the computer slept) also counts as holding it.
    const held = ['running', 'blocked'].includes(t.status) || (t.status === 'ready' && t.releasedFrom === a.id);
    if (!held || (leaving && t.status === 'ready')) return null;
    const out = { taskId: t.id, title: t.title };
    if (offer) { this._dropTask(a, t, `${a.name} disconnected; task returned to queue`); return out; }
    if (!resumable) {
      // Like Stop on the board: back to the queue, but not straight into another agent.
      if (t.autoStart) { t.autoStart = false; this.emitEvent('task.updated', a, { task: t.id, data: { changes: { autoStart: false } } }); }
      this._dropTask(a, t, `${a.name} let go of the task`);
      return out;
    }
    t.releasedFrom = a.id; t.releasedStatus = t.status;
    t.status = 'ready'; t.updatedAt = Date.now();
    this.emitEvent('task.updated', a, { task: t.id, data: { changes: { status: 'ready' }, reason: `${a.name} disconnected; task returned to queue` } });
    return out;
  }

  // The agent's server is going away (quitting, or restarting): it counts as away at once, so the person's other
  // windows see what it left; if it was a restart, the agent's next call brings it straight back.
  _goingAway(a) { if (ACTIVE.has(a.status)) this._setAgentStatus(a, 'stale', 'disconnected'); }

  op_setAgentStatus({ agentId, status, detail }) {
    const a = this.state.agents[agentId];
    if (!a) throw new CoordError('Unknown agent', 'unknown_agent');
    this._setAgentStatus(a, clip(status, 40), clip(detail, 300));
    return this._agentView(a);
  }

  op_agentExited({ agentId, outcome, detail }) {
    const a = this.state.agents[agentId];
    if (!a) return false;
    this._releaseAll(a);
    // A task it was still on goes back to the queue rather than staying "running" under an agent that's gone.
    const t = a.taskId && this.state.tasks[a.taskId];
    // A TeamCode agent still shows what it worked on; a closed Claude Code window lets go of it completely (a later
    // `claude --continue` of that conversation is the same agent and must not file its edits under it).
    if (t && t.assignee === a.id) this._dropTask(a, t, `${a.name} stopped`, !!a.perSession);
    this._setAgentStatus(a, clip(outcome || 'done', 40), clip(detail, 300));
    this._handOverRequests(a, this._heirOf(a));
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
      pendingEvents: ACTIVE.has(a.status) || a.status === 'stale' ? this._relevantSince(a, a.cursor).length : 0,
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
      contractsUsed: dict(), parallelNotes: [],
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
    if ('runner' in changes) {
      this._unrelease(t); // handed to someone: no longer waiting for, or left by, an earlier agent
      this.emitEvent('task.assigned', actor, { task: t.id, data: { runner: t.runner, runnerName: t.runnerName } });
    }
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
      t.runner = runner ? clip(runner, 80) : null; t.runnerName = runnerName ? clip(runnerName, 60) : null; t.updatedAt = Date.now();
      this._unrelease(t);
      this.emitEvent('task.assigned', this._actor({}, ctx), { task: t.id, data: { runner: t.runner, runnerName: t.runnerName } });
    }
    return t;
  }

  op_startTask({ taskId, agentId, branch, worktree, baseCommit, force }, ctx) {
    const t = this._task(taskId);
    // Already running under this same agent (e.g. it just reconnected and resumed it): nothing to do.
    // Running with no live agent (it crashed or quit without releasing the task) can be picked up below.
    if (t.status === 'running' && agentId && this._liveOwner(t)?.id === agentId) return t;
    if (t.status === 'running' && !agentId) throw new CoordError('Task is already running');
    // A live agent keeps its task, whatever the caller asks for.
    const owner = this._liveOwner(t);
    if (owner && owner.id !== agentId) throw new CoordError(`${owner.name} is working on this task.`, 'busy');
    // Restarting a failed, finished or cancelled task is a deliberate choice (Retry / Reopen), never automatic.
    if (['failed', 'done', 'cancelled'].includes(t.status) && !force) throw new CoordError(`Task is ${t.status}. Start it again from the board.`, 'not_ready');
    if (t.status === 'done' && t.integration?.state === 'merged') throw new CoordError('This task was merged. Reopen it from the board to work on it again.', 'merged');
    if (t.status === 'waiting' && !force) {
      const pending = t.dependsOn.map((d) => this.state.tasks[d]).filter((d) => d && !this._depSatisfied(d, t)).map((d) => (d.status === 'done' ? `${d.title} (needs merge)` : d.title));
      throw new CoordError(`Task is waiting on: ${pending.join(', ')}`, 'waiting');
    }
    const actor = this._actor({ agentId }, ctx);
    if (agentId) this._assign(actor.agent, taskId);
    this._unrelease(t);
    Object.assign(t, {
      status: 'running', startedAt: Date.now(), updatedAt: Date.now(), branch: branch || t.branch || 'main',
      worktree: worktree || t.worktree, baseCommit: baseCommit || t.baseCommit,
      review: { state: 'none' }, tests: { state: 'none' }, integration: { state: 'none', conflicts: [], risks: [] },
    });
    t.contractsUsed = dict(Object.fromEntries(Object.values(this.state.contracts).map((c) => [c.name, c.version])));
    this.emitEvent('task.started', actor, { task: t.id, branch: t.branch, files: t.files, data: { title: t.title, mode: t.mode } });
    return t;
  }

  op_completeTask({ taskId, agentId, summary }, ctx) {
    const actor = this._actor({ agentId }, ctx);
    taskId = taskId || actor.agent?.taskId;
    if (!taskId) throw this._noTask(actor.agent);
    const t = this._task(taskId);
    this._mustOwn(t, agentId);
    if (t.status === 'done') return t;
    this._unrelease(t);
    Object.assign(t, { status: 'done', completedAt: Date.now(), updatedAt: Date.now(), summary: clip(summary || t.summary || '', 4000) });
    this.emitEvent('task.completed', actor, { task: t.id, branch: t.branch, data: { summary: t.summary } });
    this._recomputeReadiness(actor);
    this._annotateParallelism();
    return t;
  }

  op_failTask({ taskId, agentId, error }, ctx) {
    const actor = this._actor({ agentId }, ctx);
    if (!taskId && !actor.agent?.taskId) throw this._noTask(actor.agent);
    const t = this._task(taskId || actor.agent?.taskId);
    this._mustOwn(t, agentId);
    this._unrelease(t);
    Object.assign(t, { status: 'failed', updatedAt: Date.now(), error: clip(error || 'unknown error', 4000) });
    this.emitEvent('task.failed', actor, { task: t.id, data: { error: t.error } });
    return t;
  }

  op_cancelTask({ taskId }, ctx) {
    const t = this._task(taskId);
    t.status = 'cancelled'; t.updatedAt = Date.now();
    this._unrelease(t);
    this.emitEvent('task.cancelled', this._actor({}, ctx), { task: t.id });
    return t;
  }

  // runner / runnerName / autoStart are set in the same step, so no other computer can pick the task up
  // between it reopening and it being handed to the new runner.
  op_reopenTask({ taskId, agentId, runner, runnerName, autoStart }, ctx) {
    const t = this._task(taskId);
    const owner = this._liveOwner(t);
    if (owner && owner.id !== agentId) throw new CoordError(`${owner.name} has this task; it can't be reopened until that agent stops.`, 'busy');
    const actor = this._actor({}, ctx);
    const changes = {};
    if (runner !== undefined) { t.runner = runner ? clip(runner, 80) : null; t.runnerName = runnerName ? clip(runnerName, 60) : null; changes.runner = t.runner; }
    if (autoStart !== undefined) { t.autoStart = !!autoStart; changes.autoStart = t.autoStart; }
    t.status = 'waiting'; t.updatedAt = Date.now();
    this._unrelease(t);
    this._recomputeReadiness(actor);
    this.emitEvent('task.updated', actor, { task: t.id, data: { changes: { status: t.status, ...changes } } });
    if ('runner' in changes) this.emitEvent('task.assigned', actor, { task: t.id, data: { runner: t.runner, runnerName: t.runnerName } });
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
    if (tid && this.state.tasks[tid]) this._mustOwn(this.state.tasks[tid], agentId);
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
    Object.assign(b, { status: 'resolved', resolution: clip(resolution || '', 2000), resolvedBy: { id: actor.id, name: actor.name }, resolvedAt: Date.now() });
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
      const want = String(to).toLowerCase();
      const named = Object.values(this.state.agents).filter((a) => { const n = a.name.toLowerCase(); return n === want || (n.startsWith(`${want} (`) && n.endsWith(')')); });
      // Of a person's windows, the one they are actually using (heartbeats alone don't count).
      const used = (o) => o.lastActive || o.startedAt || 0;
      target = this.state.agents[to] || named.sort((x, y) => Number(ACTIVE.has(y.status)) - Number(ACTIVE.has(x.status)) || used(y) - used(x))[0];
      // A Claude Code window that has closed: the person's window in use (or asleep) gets it instead.
      if (target?.perSession && this._ended(target)) target = this._heirOf(target) || target;
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
    const holders = (this.state.reservations[p] ||= dict());
    const isNew = !holders[a.id];
    holders[a.id] = { mode, intent: clip(intent || holders[a.id]?.intent || '', 500), at: holders[a.id]?.at || Date.now(), expires: Date.now() + RESERVATION_MS, taskId: a.taskId };
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
    const message = kind === 'integration_risk'
      ? `${a.name} and ${others.map((o) => o.agentName).join(', ')} are changing ${p} on different branches. Merge carefully.`
      : `${a.name} and ${others.map((o) => o.agentName).join(', ')} are editing ${p} at the same time`;
    // The same agents on the same file again: refresh the notice rather than adding another.
    const prev = Object.values(this.state.conflicts).find((c) => c.key === key);
    const id = prev?.id || rid('cfl');
    this.state.conflicts[id] = { id, key, kind, path: p, agents: [a.id, ...others.map((o) => o.agentId)], message, status: kind === 'overlap' ? 'open' : 'watch', at: Date.now() };
    this.emitEvent('conflict.detected', a, { task: a.taskId, files: [p], branch: a.branch, data: { id, kind, message, agents: this.state.conflicts[id].agents } });
  }

  // Keeps an agent's per-file memory bounded: past MAX_PER_AGENT entries, the oldest tenth goes.
  _capFiles(a) {
    for (const k of ['reads', 'touched', 'edited', 'warned']) {
      const d = a[k];
      const keys = d ? Object.keys(d) : [];
      if (keys.length <= MAX_PER_AGENT) continue;
      const at = (v) => (typeof v === 'number' ? v : v?.at || 0);
      for (const p of keys.sort((x, y) => at(d[x]) - at(d[y])).slice(0, keys.length - MAX_PER_AGENT + Math.floor(MAX_PER_AGENT / 10))) delete d[p];
    }
  }

  op_agentRead({ agentId, path: p, hash }) {
    const a = this.state.agents[agentId];
    p = normPath(p);
    hash = cleanHash(hash);
    this._capFiles(a);
    const f = this.state.files[p];
    a.reads[p] = { hash: hash || null, version: f && f.hash === hash ? f.version : null, at: Date.now() };
    a.touched[p] = Date.now();
    return { ok: true };
  }

  // Called by the PreToolUse hook before an agent writes a file.
  op_preEdit({ agentId, path: p, diskHash, exists }) {
    const a = this.state.agents[agentId];
    p = normPath(p);
    diskHash = cleanHash(diskHash);
    this._capFiles(a);
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
    hash = cleanHash(hash);
    summary = clip(summary || '', 500);
    this._capFiles(a);
    a.reads[p] = { hash: hash || null, version: null, at: Date.now() };
    a.touched[p] = Date.now();
    a.edited[p] = Date.now();
    if (this._reserve(a, p, this.state.reservations[p]?.[a.id]?.mode || 'shared')) this.emitEvent('file.edit_started', a, { task: a.taskId, files: [p], branch: a.branch, data: {} });
    let version = null;
    if (a.branch === 'main' || !a.branch) {
      this.claims.set(p, { agentId: a.id, hash, at: Date.now() });
      const f = this.state.files[p];
      if (f && f.hash === hash) {
        // Sync uploaded the agent's edit first: this change produced that version.
        version = f.version;
        // Credit it to the agent, in history too, only when it came from this agent's own person moments ago.
        // Never rewrite another agent's or person's version.
        if (f.by?.kind === 'user' && a.userId && f.by.id === a.userId && Date.now() - (f.at || 0) < 60000) {
          f.by = { kind: 'agent', id: a.id, name: a.name };
          const h = f.history.find((x) => x.version === f.version);
          if (h) h.by = f.by;
          const mine = a.taskId && this.state.tasks[a.taskId]?.changes?.[p];
          if (mine?.others) delete mine.others[f.version];
        }
      }
    }
    return this.emitEvent(deleted ? 'file.deleted' : 'file.changed', a, { task: a.taskId, files: [p], branch: a.branch || 'main', version, data: { hash, summary } });
  }

  op_announceEdit({ agentId, paths, intent, exclusive }) {
    const a = this.state.agents[agentId];
    intent = clip(intent || '', 500);
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
  _isRelevant(e, a, mine) {
    if (e.actor.id === a.id) return false;
    if (['chat.message', 'user.joined', 'user.left', 'workspace.created'].includes(e.type)) return false;
    if (['decision.recorded', 'contract.updated', 'blocker.reported', 'changes.merged'].includes(e.type)) return true;
    if (e.type === 'coordination.requested') return !e.data.to || (e.data.to === a.id && this._liveRequest(e, a));
    if (e.type === 'conflict.detected') return (e.data.agents || []).includes(a.id) || e.files.some((f) => a.touched[f]);
    const t = a.taskId && this.state.tasks[a.taskId];
    if (t && e.task) {
      if (e.task === t.id) return true;
      if (t.dependsOn.includes(e.task)) return true; // my upstream dependencies
      const other = this.state.tasks[e.task];
      if (other && other.dependsOn.includes(t.id) && ['task.started', 'task.blocked', 'blocker.reported'].includes(e.type)) return true;
    }
    if (e.files.length) {
      mine ||= new Set([...Object.keys(a.touched), ...(t ? t.files : [])]);
      if (e.files.some((f) => mine.has(f))) return true;
    }
    if (e.type === 'agent.joined' || e.type === 'task.started') return true; // concise awareness of new parallel work
    return false;
  }

  _relevantSince(a, cursor) {
    const t = a.taskId && this.state.tasks[a.taskId];
    const mine = new Set([...Object.keys(a.touched || {}), ...(t ? t.files : [])]);
    return this.eventsSince(cursor || 0, 100000).filter((e) => this._isRelevant(e, a, mine));
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
      tasksYouLeft: this._tasksLeftFor(a),
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
      tasksYouLeft: this._tasksLeftFor(a),
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
    if (!taskId && !actor.agent?.taskId) throw this._noTask(actor.agent);
    const t = this._task(taskId || actor.agent?.taskId);
    this._mustOwn(t, agentId);
    const changed = (arr(files).length ? arr(files).map(normPath) : this._taskChangedFiles(t)).slice(0, 2000).map((f) => clip(f, 500));
    const st = stats && typeof stats === 'object' ? { files: +stats.files || 0, insertions: +stats.insertions || 0, deletions: +stats.deletions || 0 } : null;
    t.review = { state: 'pending', requestedBy: actor.name, at: Date.now(), summary: clip(summary || t.summary || '', 4000), files: changed, stats: st };
    if (headCommit) t.headCommit = clip(headCommit, 100);
    return this.emitEvent('changes.review_requested', actor, { task: t.id, branch: t.branch, files: changed, data: { summary: t.review.summary, fileCount: changed.length } });
  }

  _taskChangedFiles(t) {
    if (t.changes) return Object.keys(t.changes);
    const files = new Set();
    for (const e of this.events) if (e.task === t.id && (e.type === 'file.changed' || e.type === 'file.deleted')) e.files.forEach((f) => files.add(f));
    return [...files];
  }

  op_reviewDecision({ taskId, decision, note }, ctx) {
    const t = this._task(taskId);
    const actor = this._actor({}, ctx);
    if (!['approve', 'reject'].includes(decision)) throw new CoordError('decision must be approve or reject');
    note = clip(note || '', 2000);
    t.review = { ...t.review, state: decision === 'approve' ? 'approved' : 'rejected', by: actor.name, decidedAt: Date.now(), note };
    return this.emitEvent(decision === 'approve' ? 'changes.approved' : 'changes.rejected', actor, { task: t.id, branch: t.branch, data: { note } });
  }

  op_testCompleted({ taskId, passed, output, command, durationMs }, ctx) {
    const t = taskId ? this._task(taskId) : null;
    command = clip(command || '', 500);
    durationMs = +durationMs || 0;
    if (t) t.tests = { state: passed ? 'passed' : 'failed', at: Date.now(), command, output: String(output || '').slice(-8000), durationMs };
    return this.emitEvent('test.completed', this._actor({}, ctx), { task: t?.id, branch: t?.branch, data: { passed: !!passed, command, durationMs } });
  }

  op_integrationChecked({ taskId, conflicts = [], risks = [] }, ctx) {
    const t = this._task(taskId);
    const actor = this._actor({}, ctx);
    conflicts = arr(conflicts).slice(0, 500).map((f) => clip(normPath(f), 500));
    risks = arr(risks).slice(0, 200).map((r) => ({ kind: clip(r?.kind || 'risk', 40), message: clip(r?.message || '', 1000) }));
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
    // One merge-conflict record per task: a re-check updates it (reopening it if needed), or closes it once clean.
    const records = Object.values(this.state.conflicts).filter((c) => c.kind === 'merge' && c.taskId === t.id);
    const record = records.find((c) => c.status === 'open') || records[0];
    if (conflicts.length) {
      const message = `Merging "${t.title}" conflicts with main in ${conflicts.length} file(s)`;
      let c = record;
      if (!c) { const id = rid('cfl'); c = this.state.conflicts[id] = { id, kind: 'merge', taskId: t.id }; }
      delete c.resolution; delete c.resolvedAt;
      Object.assign(c, { status: 'open', path: conflicts[0], files: conflicts, message, at: Date.now() });
      this.emitEvent('conflict.detected', actor, { task: t.id, files: conflicts, branch: t.branch, data: { id: c.id, kind: 'merge', message } });
    } else {
      for (const open of records.filter((c) => c.status === 'open')) {
        Object.assign(open, { status: 'resolved', resolution: 'merge is clean', resolvedAt: Date.now() });
        this.emitEvent('conflict.resolved', actor, { task: t.id, files: [open.path], data: { id: open.id, resolution: open.resolution } });
      }
    }
    this.emitEvent('integration.checked', actor, { task: t.id, branch: t.branch, data: { state, conflicts, risks } });
    return t.integration;
  }

  op_markMerged({ taskId, commit, into }, ctx) {
    const t = this._task(taskId);
    commit = commit ? clip(commit, 100) : commit;
    into = into ? clip(into, 200) : into;
    t.integration = { ...t.integration, state: 'merged', mergedAt: Date.now(), commit, conflicts: [] };
    if (t.review.state !== 'approved') t.review = { ...t.review, state: 'approved', by: this._actor({}, ctx).name, decidedAt: Date.now() };
    for (const c of Object.values(this.state.conflicts)) if (c.taskId === t.id && c.kind === 'merge' && c.status === 'open') c.status = 'resolved';
    const e = this.emitEvent('changes.merged', this._actor({}, ctx), { task: t.id, branch: t.branch, files: t.review.files || [], data: { commit, into: into || 'main' } });
    this._recomputeReadiness(this._actor({}, ctx));
    return e;
  }

  op_markReverted({ taskId, commit }, ctx) {
    const t = this._task(taskId);
    commit = commit ? clip(commit, 100) : commit;
    t.integration = { ...t.integration, state: 'reverted', revertedAt: Date.now(), revertCommit: commit };
    t.review = { ...t.review, state: 'reverted' };
    return this.emitEvent('changes.reverted', this._actor({}, ctx), { task: t.id, branch: t.branch, data: { commit } });
  }

  // Files changed by a shared-mode task, with the version before the task first touched them.
  op_taskChanges({ taskId }) {
    const t = this._task(taskId);
    if (t.changes) {
      return Object.entries(t.changes).map(([p, c]) => {
        const f = this.state.files[p];
        const before = c.beforeVersion || 0;
        const others = new Map();
        for (const h of f?.history || []) if (h.version > before && h.by?.id && !t.changeActors[h.by.id]) others.set(h.version, h.by.name);
        for (const [v, name] of Object.entries(c.others || {})) if (+v > before) others.set(+v, name);
        return {
          path: p, beforeVersion: c.beforeVersion, by: c.by, branch: c.branch, afterVersion: f?.version || null, lastBy: c.lastBy,
          changedByOthersSince: [...others.values()],
        };
      });
    }
    // Tasks from before change records existed: rebuild from the event log.
    const out = dict();
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

  // A resolved sync conflict no longer needs the content that was uploaded with it.
  _releaseConflict(c) {
    if (c.incomingHash && !c.released) { this._ref(c.incomingHash, -1); c.released = true; }
  }

  op_resolveConflictRecord({ conflictId, resolution }, ctx) {
    const c = this.state.conflicts[conflictId];
    if (!c) throw new CoordError('Unknown conflict');
    c.status = 'resolved'; c.resolution = clip(resolution || 'acknowledged', 200); c.resolvedAt = Date.now();
    this.emitEvent('conflict.resolved', this._actor({}, ctx), { task: c.taskId, files: [c.path], data: { id: c.id, resolution: c.resolution } });
    return c;
  }

  // ---------- file sync ----------
  op_fileIndex() {
    const idx = dict();
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
    this._ref(hash, 1);
    this._noteOthers(p, f.version, actor);
    if (deleted && this.limits.maxBytes && this._usedBytes() > this.limits.maxBytes * 0.9) this._freeHistory(p, f);
    if (f.history.length > MAX_HISTORY) this._dropHistory(f, MAX_HISTORY, this._neededVersions(p));
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
    if ((!cur || cur.deleted) && this.limits.maxFiles && Object.values(this.state.files).filter((x) => !x.deleted).length >= this.limits.maxFiles) throw new CoordError(`This project has reached its file limit (${this.limits.maxFiles}) on this server`, 'too_large');

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
    // The same stale write again (a retry): the conflict already holds it.
    const same = Object.values(this.state.conflicts).find((c) => c.kind === 'sync' && c.status === 'open' && c.path === p && c.baseVersion === baseVersion && c.incomingHash === hash && !!c.incomingDeleted === !!deleted);
    if (same) return { ok: false, conflict: same.id, version: cur.version };
    const id = rid('cfl');
    const incomingHash = buf ? this._putBlob(buf) : null;
    this._ref(incomingHash, 1);
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
    if (!['current', 'incoming', 'content'].includes(resolution)) throw new CoordError('resolution must be current, incoming or content');
    if (c.status === 'resolved' && c.released) throw new CoordError('This conflict was already resolved');
    const actor = this._actor({}, ctx);
    let buf = null, deleted = false;
    if (resolution === 'incoming') { deleted = c.incomingDeleted; buf = deleted ? null : this._getBlob(c.incomingHash); }
    else if (resolution === 'content') {
      buf = Buffer.from(contentB64 || '', 'base64');
      if (buf.length > MAX_FILE_BYTES) throw new CoordError(`${c.path} is larger than 5 MB and is not synced`);
    }
    if (resolution !== 'current') {
      const f = this._applyFile(c.path, buf, deleted, actor, { origin: null });
      this.emitEvent('file.changed', actor, { files: [c.path], branch: 'main', version: f.version, data: { hash: f.hash, resolution } });
    } else {
      // Re-broadcast current content so the stale client converges.
      const f = this.state.files[c.path];
      this.emit('file', { path: c.path, version: f.version, hash: f.hash, deleted: !!f.deleted, contentB64: f.deleted ? null : this._getBlob(f.hash).toString('base64'), by: f.by, origin: null });
    }
    c.status = 'resolved'; c.resolution = resolution; c.resolvedAt = Date.now();
    this._releaseConflict(c);
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
    if (!h) throw new CoordError(`v${version} of ${p} is no longer stored`, 'gone');
    const actor = this._actor({}, ctx);
    const buf = h.deleted ? null : this._getBlob(h.hash);
    if (!h.deleted && !buf) throw new CoordError(`v${version} of ${p} is no longer stored`, 'gone');
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
    this._prune(now);
    for (const a of Object.values(this.state.agents)) {
      if (ACTIVE.has(a.status) && now - a.lastSeen > STALE_MS) this._setAgentStatus(a, 'stale', 'no heartbeat for 90s');
      else if (a.status === 'stale' && now - a.lastSeen > OFFLINE_MS) {
        this._releaseAll(a, true);
        this._setAgentStatus(a, 'offline', 'disconnected');
        const t = a.taskId && this.state.tasks[a.taskId];
        if (t && ['running', 'blocked'].includes(t.status) && t.assignee === a.id) {
          // Marked, so this agent (and only this agent) can carry on with it if it comes back first.
          t.releasedFrom = a.id; t.releasedStatus = t.status;
          t.status = 'ready'; t.updatedAt = now;
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
