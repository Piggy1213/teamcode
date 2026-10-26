'use strict';
// TeamCode account in the desktop app. Sign-in happens in the browser (device-code flow): the app asks the
// website for a short code, opens the approval page, and polls until the person approves it there.
// The app never sees the password. The session token is encrypted with the OS keychain when available.
const { safeStorage, shell } = require('electron');

class Account {
  constructor({ siteUrl, config, saveConfig, onState }) {
    this.siteUrl = String(siteUrl || '').replace(/\/+$/, '');
    this.config = config;
    this.saveConfig = saveConfig;
    this.onState = onState || (() => {});
    this.pending = null;
  }

  get state() {
    const a = this.config.account;
    return {
      available: !!this.siteUrl,
      siteUrl: this.siteUrl,
      user: a?.user || null,
      pending: this.pending ? { userCode: this.pending.userCode, url: this.pending.url } : null,
    };
  }

  emit() { this.onState(this.state); }

  token() {
    const a = this.config.account;
    if (!a) return null;
    try { return a.enc ? safeStorage.decryptString(Buffer.from(a.token, 'base64')) : a.token; } catch { return null; }
  }

  save(token, user) {
    const enc = safeStorage.isEncryptionAvailable();
    this.config.account = { token: enc ? safeStorage.encryptString(token).toString('base64') : token, enc, user };
    if (user?.name) this.config.user.name = user.name;
    this.saveConfig();
  }

  clear() {
    delete this.config.account;
    this.saveConfig();
  }

  async api(path, { method = 'GET', body, auth } = {}) {
    if (!this.siteUrl) throw new Error('No TeamCode website is configured for this build.');
    const headers = { 'user-agent': 'TeamCode-Desktop', ...(body ? { 'content-type': 'application/json' } : {}) };
    if (auth) headers.authorization = `Bearer ${auth}`;
    const r = await fetch(`${this.siteUrl}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
    let data = {};
    try { data = await r.json(); } catch { /* empty */ }
    if (!r.ok) { const e = new Error(data.error || `TeamCode website returned ${r.status}`); e.status = r.status; throw e; }
    return data;
  }

  // Confirms the stored session still works; a revoked or expired one signs the app out.
  async refresh() {
    const t = this.token();
    if (!t || !this.siteUrl) return this.state;
    try {
      const { user } = await this.api('/api/me', { auth: t });
      this.save(t, user);
    } catch (e) {
      if (e.status === 401) this.clear();
    }
    this.emit();
    return this.state;
  }

  async login() {
    this.cancel();
    const s = await this.api('/api/app-login/start', { method: 'POST', body: {} });
    const url = `${this.siteUrl}/app-login?code=${encodeURIComponent(s.userCode)}`;
    const pending = { userCode: s.userCode, url, deviceCode: s.deviceCode, until: Date.now() + s.expiresIn * 1000 };
    this.pending = pending;
    shell.openExternal(url);
    this.emit();
    const poll = async () => {
      if (this.pending !== pending) return;
      if (Date.now() > pending.until) { this.pending = null; this.emit(); return; }
      try {
        const r = await this.api('/api/app-login/poll', { method: 'POST', body: { deviceCode: pending.deviceCode } });
        if (this.pending !== pending) return;
        if (r.status === 'approved') { this.pending = null; this.save(r.token, r.user); this.emit(); return; }
        if (r.status === 'expired') { this.pending = null; this.emit(); return; }
      } catch { /* network blip: keep polling */ }
      pending.timer = setTimeout(poll, (s.interval || 3) * 1000);
    };
    pending.timer = setTimeout(poll, (s.interval || 3) * 1000);
    return this.state;
  }

  cancel() {
    if (this.pending?.timer) clearTimeout(this.pending.timer);
    this.pending = null;
    this.emit();
    return this.state;
  }

  // What the website offers (accounts, cloud hosting). Cached briefly; null when the site can't be reached.
  async siteConfig() {
    if (!this.siteUrl) return null;
    if (this._cfg && Date.now() - this._cfg.at < 60000) return this._cfg.value;
    const value = await this.api('/api/config').catch(() => null);
    this._cfg = { at: Date.now(), value };
    return value;
  }

  _authed() {
    const t = this.token();
    if (!t || !this.config.account?.user) throw new Error('Sign in to TeamCode first (Settings, Account).');
    return t;
  }

  createWorkspace(name) { return this.api('/api/workspaces', { method: 'POST', body: { name }, auth: this._authed() }); }

  async listWorkspaces() { return (await this.api('/api/workspaces', { auth: this._authed() })).workspaces; }

  async logout() {
    const t = this.token();
    this.clear();
    this.emit();
    if (t) await this.api('/api/logout', { method: 'POST', body: {}, auth: t }).catch(() => {});
    return this.state;
  }
}

module.exports = { Account };
