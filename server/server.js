'use strict';
// HTTP + WebSocket front-end for the Coordinator.
//   HTTP  POST /api/<workspace>/<op>   (Authorization: Bearer <token>)  : used by MCP servers and hooks
//   WS    /ws                           : used by desktop clients for live events and file sync
// It runs its own http.Server (desktop app, standalone server), or with { ownServer: false } it is mounted
// inside another server (the TeamCode website) that passes requests in with the mount prefix removed.
const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { Coordinator, CoordError } = require('./coordinator');

const MAX_BODY = 12 * 1024 * 1024;

function safeEqual(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

class TeamServer {
  constructor({ dataDir, coordinator, ownServer = true, limits } = {}) {
    this.coordinator = coordinator || new Coordinator({ dataDir, limits });
    this.clients = new Set();
    this.subscribed = new Set();
    // Largest message: a 5 MB file, base64-encoded (about 6.7 MB), plus its JSON envelope.
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
    if (ownServer) {
      this.http = http.createServer((req, res) => this.handleRequest(req, res));
      this.http.on('upgrade', (req, sock, head) => this.handleUpgrade(req, sock, head));
    }
    this._ping = setInterval(() => {
      for (const c of this.clients) {
        if (!c.alive) { c.ws.terminate(); continue; }
        c.alive = false;
        try { c.ws.ping(); } catch { /* socket already gone */ }
      }
    }, 25000);
    this._ping.unref?.();
  }

  listen(port = 4477, host = '0.0.0.0') {
    return new Promise((resolve, reject) => {
      this.http.once('error', reject);
      this.http.listen(port, host, () => { this.http.off('error', reject); resolve(this.http.address().port); });
    });
  }

  close() {
    clearInterval(this._ping);
    for (const c of this.clients) c.ws.terminate();
    this.coordinator.close();
    if (!this.http) return Promise.resolve();
    return new Promise((r) => { this.http.close(() => r()); this.http.closeAllConnections?.(); });
  }

  // `url` is the request path relative to where this server is mounted (defaults to req.url).
  handleUpgrade(req, sock, head, url = req.url) {
    if (!url.startsWith('/ws')) return sock.destroy();
    this.wss.handleUpgrade(req, sock, head, (ws) => this._onSocket(ws));
  }

  // Deletes a workspace and disconnects everyone in it.
  removeWorkspace(id) {
    for (const c of this.clients) if (c.workspace?.id === id) c.ws.terminate();
    this.subscribed.delete(id);
    this.coordinator.removeWorkspace(id);
  }

  _workspace(id, token) {
    const w = this.coordinator.get(id);
    if (!w) throw new CoordError('Workspace not found', 'not_found');
    if (!safeEqual(token, w.token)) throw new CoordError('Invalid workspace token', 'unauthorized');
    this._subscribe(w);
    return w;
  }

  _subscribe(w) {
    if (this.subscribed.has(w.id)) return;
    this.subscribed.add(w.id);
    w.on('event', (e) => this._broadcast(w.id, { t: 'event', event: e }));
    w.on('file', (f) => this._broadcast(w.id, { t: 'file', ...f }, f.origin));
  }

  _broadcast(wsId, msg, exceptConnId) {
    const data = JSON.stringify(msg);
    for (const c of this.clients) {
      if (c.workspace?.id === wsId && c.id !== exceptConnId && c.ws.readyState === 1) c.ws.send(data);
    }
  }

  handleRequest(req, res, url = req.url) {
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.method === 'GET' && (url === '/' || url === '/health')) return send(200, { ok: true, app: 'teamcode' });
    const m = url.match(/^\/api\/([\w-]+)\/(\w+)$/);
    if (req.method !== 'POST' || !m) return send(404, { ok: false, error: 'Not found' });
    // Check the workspace and token before reading any body, so strangers can't make the server buffer data.
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    let w;
    try { w = this._workspace(m[1], token); } catch (err) {
      send(err.code === 'unauthorized' ? 401 : 404, { ok: false, error: err.message, code: err.code });
      return req.resume();
    }
    if (Number(req.headers['content-length']) > MAX_BODY) { send(413, { ok: false, error: 'Request too large', code: 'too_large' }); return req.resume(); }
    let size = 0, tooBig = false;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY && !tooBig) { tooBig = true; send(413, { ok: false, error: 'Request too large', code: 'too_large' }); req.destroy(); }
      else if (!tooBig) chunks.push(c);
    });
    req.on('end', () => {
      if (tooBig) return;
      try {
        const args = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
        const result = w.call(m[2], args, { user: args.user });
        send(200, { ok: true, result });
      } catch (err) {
        const code = err.code === 'unauthorized' ? 401 : err.code === 'not_found' ? 404 : err instanceof CoordError ? 400 : 500;
        send(code, { ok: false, error: err.message, code: err.code || 'error' });
      }
    });
  }

  _onSocket(ws) {
    const c = { id: crypto.randomBytes(6).toString('hex'), ws, alive: true, workspace: null, user: null };
    this.clients.add(c);
    // A connection must say hello (workspace + token) promptly, or it's dropped.
    c.helloTimer = setTimeout(() => { if (!c.workspace) ws.terminate(); }, 10000);
    ws.on('pong', () => { c.alive = true; });
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.t === 'hello') return this._hello(c, msg);
      if (msg.t === 'call') {
        if (!c.workspace) return ws.send(JSON.stringify({ t: 'result', id: msg.id, ok: false, error: 'Not joined' }));
        try {
          const args = { ...(msg.args || {}) };
          if (msg.op === 'filePut') args.origin = c.id;
          const result = c.workspace.call(msg.op, args, { user: c.user });
          ws.send(JSON.stringify({ t: 'result', id: msg.id, ok: true, result }));
        } catch (err) {
          ws.send(JSON.stringify({ t: 'result', id: msg.id, ok: false, error: err.message, code: err.code }));
        }
      }
    });
    ws.on('close', () => {
      clearTimeout(c.helloTimer);
      this.clients.delete(c);
      if (c.workspace && c.user && ![...this.clients].some((o) => o.workspace === c.workspace && o.user?.id === c.user.id)) {
        try { c.workspace.call('userLeft', { user: c.user }); } catch { /* workspace closed */ }
        this._presence(c.workspace);
      }
    });
  }

  _hello(c, msg) {
    try {
      const w = this._workspace(msg.workspace, msg.token);
      if (!msg.user?.id) throw new CoordError('user is required');
      if (/^(__proto__|constructor|prototype)$/.test(String(msg.user.id))) throw new CoordError('Invalid user');
      c.user = { id: String(msg.user.id).slice(0, 80), name: String(msg.user.name || 'Teammate').slice(0, 60) };
      // Joining first: if the project refuses this person, no snapshot is sent for nothing.
      w.call('userJoined', { user: c.user });
      c.workspace = w;
      clearTimeout(c.helloTimer);
      const since = Number(msg.since) || 0;
      const missed = since ? w.eventsSince(since, 5000) : w.events.slice(-300);
      c.ws.send(JSON.stringify({ t: 'welcome', connId: c.id, snapshot: w.call('snapshot'), events: missed, fileIndex: w.call('fileIndex') }));
      this._presence(w);
    } catch (err) {
      c.ws.send(JSON.stringify({ t: 'error', error: err.message, code: err.code }));
      c.ws.close();
    }
  }

  _presence(w) {
    const online = [...this.clients].filter((c) => c.workspace === w && c.user).map((c) => c.user);
    const uniq = Object.values(Object.fromEntries(online.map((u) => [u.id, u])));
    this._broadcast(w.id, { t: 'presence', users: uniq });
  }
}

module.exports = { TeamServer };
