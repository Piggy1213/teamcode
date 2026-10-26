'use strict';
// WebSocket client for a TeamCode workspace. Reconnects with backoff and resumes from the last seen event seq,
// so events missed while offline are replayed by the server.
const { EventEmitter } = require('events');
const WebSocket = require('ws');

class Connection extends EventEmitter {
  constructor({ url, workspace, token, user }) {
    super();
    Object.assign(this, { url: url.replace(/\/+$/, ''), workspace, token, user });
    this.lastSeq = 0;
    this.status = 'offline';
    this.pending = new Map();
    this.queue = [];
    this.nextId = 1;
    this.backoff = 1000;
    this.closed = false;
  }

  get httpUrl() { return this.url; }

  start() {
    this.closed = false;
    this._connect();
    return this;
  }

  _setStatus(s, detail) {
    if (this.status === s) return;
    this.status = s;
    this.emit('status', s, detail);
  }

  _connect() {
    if (this.closed) return;
    this._setStatus('connecting');
    const ws = new WebSocket(this.url.replace(/^http/, 'ws') + '/ws', { maxPayload: 16 * 1024 * 1024, handshakeTimeout: 8000 });
    this.ws = ws;
    ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', workspace: this.workspace, token: this.token, user: this.user, since: this.lastSeq })));
    ws.on('message', (raw) => {
      let m;
      try { m = JSON.parse(raw.toString()); } catch { return; }
      switch (m.t) {
        case 'welcome':
          this.backoff = 1000;
          this.connId = m.connId;
          for (const e of m.events) this.lastSeq = Math.max(this.lastSeq, e.seq);
          this.lastSeq = Math.max(this.lastSeq, m.snapshot.seq);
          this._setStatus('online');
          this.emit('welcome', m);
          for (const q of this.queue.splice(0)) this._send(q);
          break;
        case 'event':
          this.lastSeq = Math.max(this.lastSeq, m.event.seq);
          this.emit('event', m.event);
          break;
        case 'file': this.emit('file', m); break;
        case 'presence': this.emit('presence', m.users); break;
        case 'result': {
          const p = this.pending.get(m.id);
          if (!p) break;
          this.pending.delete(m.id);
          clearTimeout(p.timer);
          if (m.ok) p.resolve(m.result);
          else { const err = new Error(m.error); err.code = m.code; p.reject(err); }
          break;
        }
        case 'error':
          this.fatal = m.error;
          this.emit('fatal', m.error, m.code);
          if (m.code === 'unauthorized' || m.code === 'not_found') this.closed = true;
          break;
        default: break;
      }
    });
    ws.on('close', () => {
      if (this.ws !== ws) return;
      this._setStatus('offline', this.fatal);
      if (this.closed) return;
      setTimeout(() => this._connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 1.7, 10000);
    });
    ws.on('error', () => { /* close handler schedules the reconnect */ });
  }

  _send(msg) {
    if (this.status === 'online' && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
    else this.queue.push(msg);
  }

  call(op, args = {}, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${op} timed out — is the team server reachable?`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this._send({ t: 'call', id, op, args });
    });
  }

  close() {
    this.closed = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('Disconnected')); }
    this.pending.clear();
    try { this.ws?.close(); } catch { /* already closed */ }
    this._setStatus('offline');
  }
}

module.exports = { Connection };
