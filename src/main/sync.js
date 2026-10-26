'use strict';
// Two-way, real-time file sync between a local folder and a TeamCode workspace.
// Every write carries the version it was based on; the server merges or records a conflict instead of overwriting.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const chokidar = require('chokidar');
const ignore = require('ignore');

const ALWAYS_IGNORE = ['.git/', 'node_modules/', '.teamcode/', '.DS_Store', 'Thumbs.db', '*.swp', '*~', '.~lock.*', 'dist/', 'build/', 'out/', '.next/', '__pycache__/', '.venv/', 'venv/'];
const MAX_BYTES = 5 * 1024 * 1024;

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const rel = (root, abs) => path.relative(root, abs).split(path.sep).join('/');

class SyncClient extends EventEmitter {
  constructor({ root, connection, manifestPath, preferRemoteOnFirstSync = false }) {
    super();
    this.root = path.resolve(root);
    this.conn = connection;
    this.manifestPath = manifestPath;
    this.preferRemote = preferRemoteOnFirstSync;
    this.manifest = {};
    this.conflicts = new Map(); // path -> hash we submitted
    this.locks = new Map();
    this.timers = new Map();
    this.stats = { up: 0, down: 0, merged: 0, conflicts: 0 };
    this.ready = false;
    try { this.manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { this.manifest = {}; }
    this._loadIgnore();
    this._onWelcome = (m) => this.reconcile(m.fileIndex).catch((e) => this.emit('error', e));
    this._onFile = (m) => this._serial(m.path, () => this._applyRemote(m)).catch((e) => this.emit('error', e));
    this._onEvent = (e) => {
      if (e.type === 'conflict.resolved') for (const p of e.files) if (this.conflicts.has(p)) this._serial(p, () => this._pullLatest(p)).catch(() => {});
    };
  }

  _loadIgnore() {
    this.ig = ignore().add(ALWAYS_IGNORE);
    try { this.ig.add(fs.readFileSync(path.join(this.root, '.gitignore'), 'utf8')); } catch { /* no .gitignore */ }
  }

  ignored(relPath) {
    if (!relPath || relPath.startsWith('..')) return true;
    try { return this.ig.ignores(relPath); } catch { return true; }
  }

  start() {
    this.conn.on('welcome', this._onWelcome);
    this.conn.on('file', this._onFile);
    this.conn.on('event', this._onEvent);
    this.watcher = chokidar.watch(this.root, {
      ignoreInitial: true,
      ignored: (p) => { const r = rel(this.root, p); return r !== '' && (this.ignored(r) || this.ignored(r + '/')); },
      awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 40 },
    });
    const onChange = (abs) => {
      const r = rel(this.root, abs);
      if (r === '.gitignore') this._loadIgnore();
      if (this.ignored(r)) return;
      clearTimeout(this.timers.get(r));
      this.timers.set(r, setTimeout(() => { this.timers.delete(r); this._serial(r, () => this._pushLocal(r)).catch((e) => this.emit('error', e)); }, 60));
    };
    this.watcher.on('add', onChange).on('change', onChange).on('unlink', onChange);
    return new Promise((r) => this.watcher.on('ready', r));
  }

  async stop() {
    this.conn.off('welcome', this._onWelcome);
    this.conn.off('file', this._onFile);
    this.conn.off('event', this._onEvent);
    for (const t of this.timers.values()) clearTimeout(t);
    await this.watcher?.close();
    this._saveManifest(true);
  }

  // Serialize all work on a given path so remote and local updates never interleave.
  _serial(p, fn) {
    const prev = this.locks.get(p) || Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    this.locks.set(p, next);
    next.finally(() => { if (this.locks.get(p) === next) this.locks.delete(p); }).catch(() => {});
    return next;
  }

  async idle() {
    while (this.timers.size || this.locks.size) {
      await Promise.allSettled([...this.locks.values()]);
      await new Promise((r) => setTimeout(r, 80));
    }
  }

  _saveManifest(now) {
    if (!this.manifestPath) return;
    const write = () => { try { fs.mkdirSync(path.dirname(this.manifestPath), { recursive: true }); fs.writeFileSync(this.manifestPath, JSON.stringify(this.manifest)); } catch { /* best effort */ } };
    if (now) { clearTimeout(this._mt); return write(); }
    clearTimeout(this._mt);
    this._mt = setTimeout(write, 500);
  }

  _abs(p) {
    const abs = path.resolve(this.root, p);
    if (!abs.startsWith(this.root + path.sep)) throw new Error(`Refusing path outside project: ${p}`);
    return abs;
  }

  async _readLocal(p) {
    try {
      const st = await fsp.stat(this._abs(p));
      if (!st.isFile()) return null;
      if (st.size > MAX_BYTES) return { tooBig: true };
      const buf = await fsp.readFile(this._abs(p));
      return { buf, hash: sha(buf) };
    } catch { return null; }
  }

  async _write(p, buf) {
    const abs = this._abs(p);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, buf);
  }

  async _unlink(p) {
    try { await fsp.unlink(this._abs(p)); } catch { /* already gone */ }
  }

  async _pushLocal(p) {
    if (this.ignored(p)) return;
    const local = await this._readLocal(p);
    if (local?.tooBig) return this.emit('skipped', { path: p, reason: 'larger than 5 MB' });
    const m = this.manifest[p];
    if (!local && (!m || m.deleted)) return;
    if (local && m && m.hash === local.hash) return; // echo of our own write, or no change
    if (this.conflicts.has(p) && this.conflicts.get(p) === (local?.hash || null)) return;
    const res = await this.conn.call('filePut', { path: p, baseVersion: m?.version || 0, contentB64: local ? local.buf.toString('base64') : null, deleted: !local });
    if (res.ok) {
      this.conflicts.delete(p);
      this.stats.up++;
      if (res.merged) {
        const merged = Buffer.from(res.contentB64, 'base64');
        this.manifest[p] = { version: res.version, hash: sha(merged) };
        await this._write(p, merged);
        this.stats.merged++;
        this.emit('merged', { path: p, version: res.version });
      } else {
        this.manifest[p] = { version: res.version, hash: local ? local.hash : null, deleted: !local };
      }
      this._saveManifest();
      this.emit('pushed', { path: p, version: res.version });
    } else if (res.conflict) {
      this.conflicts.set(p, local ? local.hash : null);
      this.stats.conflicts++;
      this.emit('conflict', { path: p, conflictId: res.conflict });
    }
  }

  async _applyRemote({ path: p, version, hash, deleted, contentB64 }) {
    if (this.ignored(p)) return;
    const m = this.manifest[p];
    if (m && m.version >= version) return;
    const local = await this._readLocal(p);
    const localHash = local?.hash || null;
    if (localHash === (deleted ? null : hash)) {
      this.manifest[p] = { version, hash: deleted ? null : hash, deleted: !!deleted };
      this._saveManifest();
      return;
    }
    const dirty = m ? localHash !== (m.deleted ? null : m.hash) : !!local;
    const submittedInConflict = this.conflicts.has(p) && this.conflicts.get(p) === localHash;
    if (dirty && !submittedInConflict) {
      // Unsent local edit: push it against our old base so the server merges it instead of us clobbering it.
      return this._pushLocal(p);
    }
    this.conflicts.delete(p);
    this.manifest[p] = { version, hash: deleted ? null : hash, deleted: !!deleted };
    if (deleted) await this._unlink(p);
    else await this._write(p, Buffer.from(contentB64, 'base64'));
    this.stats.down++;
    this._saveManifest();
    this.emit('pulled', { path: p, version });
  }

  async _pullLatest(p) {
    const f = await this.conn.call('fileGet', { path: p });
    await this._applyRemote({ path: p, version: f.version, hash: f.hash, deleted: f.deleted, contentB64: f.contentB64 });
  }

  async _scanLocal() {
    const out = new Map();
    const walk = async (dir) => {
      let entries;
      try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const abs = path.join(dir, e.name);
        const r = rel(this.root, abs);
        if (e.isDirectory()) { if (!this.ignored(r + '/')) await walk(abs); }
        else if (e.isFile() && !this.ignored(r)) out.set(r, abs);
      }
    };
    await walk(this.root);
    return out;
  }

  // Bring local folder and server into agreement after (re)connecting.
  async reconcile(index) {
    this.emit('reconciling');
    const localFiles = await this._scanLocal();
    const paths = new Set([...Object.keys(index).filter((p) => !this.ignored(p)), ...localFiles.keys()]);
    const jobs = [...paths].map((p) => () => this._serial(p, async () => {
      const s = index[p];
      const m = this.manifest[p];
      const local = localFiles.has(p) ? await this._readLocal(p) : null;
      if (local?.tooBig) return;
      const L = local?.hash || null;
      const S = s && !s.deleted ? s.hash : null;
      if (L === S) {
        if (s) this.manifest[p] = { version: s.version, hash: S, deleted: !!s.deleted };
        return;
      }
      const localUnchanged = m ? L === (m.deleted ? null : m.hash) : false;
      if (s && localUnchanged && (m?.version || 0) <= s.version) {
        // Only the server moved: download (or delete) it.
        if (s.deleted) { await this._unlink(p); this.manifest[p] = { version: s.version, hash: null, deleted: true }; this.stats.down++; return; }
        return this._pullLatest(p);
      }
      if (s && !L && !m) return this._pullLatest(p); // new file from the team
      if (S && L && !m && this.preferRemote) {
        // Joining a team with an existing local copy: take the team's version, keep ours as a backup.
        const backup = path.join(this.root, '.teamcode', 'backup', this.backupStamp ||= new Date().toISOString().replace(/[:.]/g, '-'), p);
        await fsp.mkdir(path.dirname(backup), { recursive: true });
        await fsp.copyFile(this._abs(p), backup);
        this.emit('backedUp', { path: p, backup });
        return this._pullLatest(p);
      }
      if (!s && !L) return;
      // Local changed (or first sync of an existing local file): upload against our last known base.
      return this._pushLocal(p);
    }));
    let i = 0;
    await Promise.all(Array.from({ length: 8 }, async () => { while (i < jobs.length) await jobs[i++]().catch((e) => this.emit('error', e)); }));
    this._saveManifest(true);
    this.ready = true;
    this.emit('reconciled', { files: paths.size });
  }
}

module.exports = { SyncClient, sha, ALWAYS_IGNORE };
