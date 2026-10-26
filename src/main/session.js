'use strict';
// A ProjectSession ties one local folder to one TeamCode workspace: live connection, file sync,
// agent runner, auto-scheduling of ready tasks, and the review/integration workflow.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Connection } = require('./connection');
const { SyncClient } = require('./sync');
const { AgentManager } = require('./agents');
const git = require('./git');

const TEXT_LIMIT = 400 * 1024;

class ProjectSession {
  constructor({ project, user, getSettings, send, dataDir, scripts, notify }) {
    Object.assign(this, { project, user, getSettings, send, dataDir, scripts, notify });
    this.state = null;
    this.events = [];
    this.presence = [];
    this.starting = new Set();
    // taskId -> { seq, updatedAt, failed } for the last automatic start. The task is skipped until a
    // newer snapshot arrives (so a stale snapshot can't start it twice), and a failed start is not
    // retried until the task itself changes. Server values only, so clock skew doesn't matter.
    this.autoTried = new Map();
    this.autoPaused = null; // set when Claude Code itself is broken; cleared when settings change
    const key = crypto.createHash('sha1').update(`${project.workspace}|${path.resolve(project.root).toLowerCase()}`).digest('hex').slice(0, 12);
    this.localDir = path.join(dataDir, 'projects', key);
  }

  get server() { return { url: this.project.url, workspace: this.project.workspace, token: this.project.token }; }

  async start() {
    fs.mkdirSync(this.localDir, { recursive: true });
    this.conn = new Connection({ ...this.server, user: this.user });
    this.conn.on('status', (s, detail) => this.send('tc:status', { status: s, detail }));
    this.conn.on('fatal', (msg) => this.send('tc:toast', { kind: 'error', text: msg }));
    this.conn.on('presence', (users) => { this.presence = users; this.send('tc:presence', users); });
    this.conn.on('welcome', (m) => {
      this.state = m.snapshot;
      this.events = m.events.slice(-500);
      this.send('tc:snapshot', this.state);
      this.send('tc:events', this.events);
      this._autoRun();
    });
    this.conn.on('event', (e) => {
      this.events.push(e);
      if (this.events.length > 800) this.events.splice(0, this.events.length - 800);
      this.send('tc:event', e);
      this._refreshSoon();
      this._notifyFor(e);
    });

    this.sync = new SyncClient({ root: this.project.root, connection: this.conn, manifestPath: path.join(this.localDir, 'manifest.json'), preferRemoteOnFirstSync: this.project.role === 'member' });
    const syncInfo = (extra = {}) => this.send('tc:sync', { ...this.sync.stats, ready: this.sync.ready, conflicts: [...this.sync.conflicts.keys()], ...extra });
    for (const ev of ['pushed', 'pulled', 'merged', 'reconciled']) this.sync.on(ev, () => syncInfo());
    this.sync.on('reconciling', () => syncInfo({ reconciling: true }));
    this.sync.on('conflict', (c) => { syncInfo(); this.send('tc:toast', { kind: 'warn', text: `Edit conflict on ${c.path}. Both versions kept; resolve it in Context → Conflicts.` }); });
    this.sync.on('skipped', (s) => this.send('tc:toast', { kind: 'warn', text: `${s.path} not synced (${s.reason})` }));
    this.sync.on('error', (e) => this.send('tc:toast', { kind: 'error', text: `Sync: ${e.message}` }));
    await this.sync.start();

    this.agents = new AgentManager({
      conn: this.conn, server: this.server, user: this.user, root: this.project.root, dataDir: this.localDir,
      getSettings: this.getSettings, getState: () => this.state, scripts: this.scripts,
    });
    this.agents.on('log', (agentId, entry) => this.send('tc:agentLog', { agentId, entry }));
    this.agents.on('started', (info) => this.send('tc:agentStarted', info));
    this.agents.on('runtime', () => { this.send('tc:runtime', this.agents.runtime()); this._autoRun(); });
    this.agents.on('needsLogin', () => this.send('tc:needsLogin'));
    this.agents.on('finished', () => this._autoRun());
    this.conn.start();
  }

  async stop() {
    this.agents?.stopAll();
    this.agents?.dispose();
    await this.sync?.stop();
    this.conn?.close();
  }

  _refreshSoon() {
    clearTimeout(this._rt);
    this._rt = setTimeout(async () => {
      try {
        this.state = await this.conn.call('snapshot');
        this.send('tc:snapshot', this.state);
        this._autoRun();
      } catch { /* offline; will resync on reconnect */ }
    }, 120);
  }

  _notifyFor(e) {
    const mine = new Set(Object.keys(this.agents?.meta || {}));
    if (e.type === 'changes.review_requested') this.notify('Ready for review', e.summary);
    else if (e.type === 'conflict.detected' && ((e.data.agents || []).some((a) => mine.has(a)) || e.data.kind === 'sync' || e.data.kind === 'merge')) this.notify('Conflict detected', e.summary);
    else if (e.type === 'blocker.reported') this.notify('Agent blocked', e.summary);
    else if (e.type === 'chat.message' && e.actor.id !== this.user.id) this.notify(e.actor.name, e.data.text);
  }

  call(op, args) { return this.conn.call(op, args); }

  // ---------- scheduling ----------
  async _autoRun() {
    const s = this.getSettings();
    if (!s.autoRun || this.autoPaused || !this.state || !this.agents || this.conn.status !== 'online') return;
    const busy = new Set([...this.agents.running.values()].map((r) => r.taskId));
    let slots = (s.maxParallel || 3) - this.agents.running.size - this.starting.size;
    const ready = Object.values(this.state.tasks)
      .filter((t) => t.status === 'ready' && t.autoStart && t.runner === this.user.id && !busy.has(t.id) && !this.starting.has(t.id))
      .filter((t) => { const a = this.autoTried.get(t.id); return !a || (this.state.seq > a.seq && !(a.failed && t.updatedAt === a.updatedAt)); })
      .filter((t) => !this.agents.handedOffTasks().has(t.id))
      .sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt);
    for (const t of ready) {
      if (slots-- <= 0) break;
      const attempt = { seq: this.state.seq, updatedAt: t.updatedAt, failed: false };
      this.autoTried.set(t.id, attempt);
      this.startTask(t.id).catch((e) => {
        attempt.failed = true;
        if (e.code === 'claude_setup') {
          // Not this task's fault: it may start once Claude Code works. Pause everything and say so once.
          this.autoTried.delete(t.id);
          if (!this.autoPaused) this.send('tc:toast', { kind: 'error', text: `Agents paused. ${e.message}` });
          this.autoPaused = e.message;
        } else {
          this.send('tc:toast', { kind: 'error', text: `Could not start "${t.title}": ${e.message}` });
        }
      });
    }
  }

  // Called when Claude Code settings change: try auto-starting again.
  resumeAuto() {
    this.autoPaused = null;
    this.autoTried.clear();
    if (this.agents) this.agents._verifiedClaude = null;
    this._autoRun();
  }

  async startTask(taskId, opts = {}) {
    if (this.starting.has(taskId)) return null;
    this.starting.add(taskId);
    try {
      const r = await this.agents.startTask(taskId, opts);
      // Started by hand after a setup problem: auto-starting can carry on.
      if (opts.manual) { this.autoPaused = null; this.autoTried.delete(taskId); this._autoRun(); }
      return r;
    } finally { this.starting.delete(taskId); }
  }

  // ---------- review & integration ----------
  _task(taskId) {
    const t = this.state?.tasks?.[taskId];
    if (!t) throw new Error('Task not found');
    return t;
  }

  async _hasBranch(t) {
    if (!t.branch || t.branch === 'main' || !(await git.isRepo(this.project.root))) return false;
    return (await git.git(this.project.root, ['rev-parse', '--verify', `refs/heads/${t.branch}`], { allowFail: true })).code === 0;
  }

  async reviewDiff(taskId) {
    const t = this._task(taskId);
    if (t.mode === 'isolated' && t.branch && t.branch !== 'main') {
      if (!(await this._hasBranch(t))) return { kind: 'remote', message: `Branch ${t.branch} lives on ${t.runnerName || 'the computer that ran this task'}. Open the review there to merge it.` };
      const base = t.baseCommit || 'HEAD';
      const [diff, files, stats] = await Promise.all([git.diff(this.project.root, base, t.branch), git.changedFiles(this.project.root, base, t.branch), git.diffStat(this.project.root, base, t.branch)]);
      return { kind: 'git', diff: diff.length > 2_000_000 ? diff.slice(0, 2_000_000) + '\n… diff truncated …' : diff, files, stats };
    }
    const changes = await this.call('taskChanges', { taskId });
    const files = [];
    for (const c of changes.slice(0, 60)) {
      const get = async (v) => { if (!v) return ''; const f = await this.call('fileGet', { path: c.path, version: v }); return f.contentB64 ? Buffer.from(f.contentB64, 'base64') : Buffer.alloc(0); };
      const [before, after] = await Promise.all([get(c.beforeVersion), get(c.afterVersion)]);
      const binary = before.includes(0) || after.includes(0);
      files.push({ ...c, binary, before: binary ? '' : before.toString('utf8').slice(0, TEXT_LIMIT), after: binary ? '' : after.toString('utf8').slice(0, TEXT_LIMIT) });
    }
    return { kind: 'shared', files };
  }

  async runTests(taskId) {
    const t = taskId ? this._task(taskId) : null;
    const shared = (await this.call('snapshot').catch(() => this.state)).settings;
    const cmd = shared?.testCommand || this.getSettings().testCommand;
    if (!cmd) throw new Error('Set a test command in Settings first (e.g. "npm test")');
    const cwd = t?.worktree && fs.existsSync(t.worktree) ? t.worktree : this.project.root;
    this.send('tc:toast', { kind: 'info', text: `Running "${cmd}"…` });
    const r = await git.runCommand(cmd, cwd);
    await this.call('testCompleted', { taskId, passed: r.passed, output: r.output, command: cmd, durationMs: r.durationMs });
    return r;
  }

  async checkIntegration(taskId) {
    const t = this._task(taskId);
    const risks = [];
    let conflicts = [];
    if (t.mode === 'isolated' && await this._hasBranch(t)) {
      const root = this.project.root;
      const check = await git.mergeCheck(root, t.branch);
      conflicts = check.conflicts;
      const changed = (await git.changedFiles(root, t.baseCommit || 'HEAD', t.branch)).map((f) => f.path);
      const dirty = new Set(await git.dirtyFiles(root));
      const overlapDirty = changed.filter((f) => dirty.has(f));
      if (overlapDirty.length) risks.push({ kind: 'working-copy', message: `Uncommitted changes in the main working copy overlap this branch: ${overlapDirty.slice(0, 6).join(', ')}. Commit them (Checkpoint) before merging.` });
      risks.push(...git.breakingChanges(await git.diff(root, t.baseCommit || 'HEAD', t.branch)));
      for (const d of t.dependsOn.map((id) => this.state.tasks[id]).filter(Boolean)) {
        if (d.mode === 'isolated' && d.branch && d.branch !== 'main' && d.integration?.state !== 'merged') risks.push({ kind: 'dependency', message: `Built on top of "${d.title}", which isn't merged yet. Merging this also brings in that work. Review and merge it first.` });
      }
    } else if (t.mode !== 'isolated') {
      const changes = await this.call('taskChanges', { taskId });
      for (const c of changes) if (c.changedByOthersSince.length) risks.push({ kind: 'overlap', message: `${c.path} was also changed by ${[...new Set(c.changedByOthersSince)].join(', ')} after this task` });
    } else {
      throw new Error(`Branch ${t.branch} is not on this computer`);
    }
    return this.call('integrationChecked', { taskId, conflicts, risks });
  }

  async approve(taskId, { checkpoint } = {}) {
    const t = this._task(taskId);
    if (t.mode === 'isolated' && t.branch && t.branch !== 'main') {
      if (!(await this._hasBranch(t))) throw new Error(`Branch ${t.branch} is not on this computer`);
      const root = this.project.root;
      if (checkpoint) await git.checkpoint(root, 'TeamCode checkpoint: shared working copy before merge');
      const changed = (await git.changedFiles(root, t.baseCommit || 'HEAD', t.branch)).map((f) => f.path);
      const dirty = new Set(await git.dirtyFiles(root));
      const overlap = changed.filter((f) => dirty.has(f));
      if (overlap.length) return { ok: false, needsCheckpoint: true, files: overlap };
      const pre = await git.mergeCheck(root, t.branch);
      if (!pre.clean) { await this.call('integrationChecked', { taskId, conflicts: pre.conflicts, risks: [] }); return { ok: false, conflicts: pre.conflicts }; }
      await this.call('reviewDecision', { taskId, decision: 'approve' });
      const r = await git.merge(root, t.branch, `Merge "${t.title}" (${t.assigneeName || 'agent'}, TeamCode)`);
      if (!r.ok) { await this.call('integrationChecked', { taskId, conflicts: r.conflicts, risks: [] }); return { ok: false, conflicts: r.conflicts, error: r.error }; }
      await this.call('markMerged', { taskId, commit: r.commit, into: await git.currentBranch(root) });
      if (t.worktree) await git.removeWorktree(root, t.worktree, null).catch(() => {});
      return { ok: true, commit: r.commit };
    }
    // Shared-mode work is already in the working copy: approval records the decision and integration.
    await this.call('reviewDecision', { taskId, decision: 'approve' });
    await this.call('markMerged', { taskId, into: 'shared working copy' });
    return { ok: true };
  }

  async reject(taskId, { note, discard } = {}) {
    const t = this._task(taskId);
    await this.call('reviewDecision', { taskId, decision: 'reject', note });
    if (discard) {
      if (t.mode === 'isolated' && await this._hasBranch(t)) await git.removeWorktree(this.project.root, t.worktree, t.branch);
      else if (t.mode !== 'isolated') return this.revert(taskId);
    }
    return { ok: true };
  }

  async revert(taskId) {
    const t = this._task(taskId);
    if (t.mode === 'isolated' && t.integration?.commit) {
      const commit = await git.revertMerge(this.project.root, t.integration.commit);
      await this.call('markReverted', { taskId, commit });
      return { ok: true, commit, skipped: [] };
    }
    if (t.mode === 'isolated') throw new Error('Nothing to revert: this branch was never merged');
    const changes = await this.call('taskChanges', { taskId });
    const skipped = [];
    for (const c of changes) {
      if (c.changedByOthersSince.length) { skipped.push({ path: c.path, reason: `also changed by ${[...new Set(c.changedByOthersSince)].join(', ')}` }); continue; }
      if (c.beforeVersion) await this.call('fileRevert', { path: c.path, version: c.beforeVersion });
      else fs.rmSync(path.join(this.project.root, c.path), { force: true }); // file was created by the task; the watcher syncs the delete
    }
    await this.call('markReverted', { taskId });
    return { ok: true, skipped };
  }

  async checkpoint() {
    if (!(await git.isRepo(this.project.root))) throw new Error('This folder is not a git repository');
    return git.checkpoint(this.project.root, 'TeamCode checkpoint');
  }

  async gitInfo() {
    const root = this.project.root;
    if (!(await git.isRepo(root))) return { repo: false };
    const has = await git.hasCommits(root);
    return { repo: true, hasCommits: has, branch: has ? await git.currentBranch(root) : null, dirty: (await git.dirtyFiles(root)).length };
  }
}

module.exports = { ProjectSession };
