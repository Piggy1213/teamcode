'use strict';
// Account pages: sign up, sign in, account settings, and approving a desktop app sign-in.
// All text from the server is inserted with textContent, never as HTML.
(() => {
  const $ = (s) => document.querySelector(s);
  const page = document.body.dataset.page;
  const params = new URLSearchParams(location.search);
  // Only same-site paths are allowed as a post-login destination.
  const next = (() => { const n = params.get('next') || ''; return /^\/(?!\/)[\w\-./?=&%]*$/.test(n) ? n : '/account'; })();

  async function api(path, body) {
    const r = await fetch(path, body === undefined ? { credentials: 'same-origin' } : {
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    let data = {};
    try { data = await r.json(); } catch { /* empty body */ }
    if (!r.ok) { const e = new Error(data.error || `Request failed (${r.status})`); e.status = r.status; throw e; }
    return data;
  }

  function show(msg, kind = 'err') {
    const el = $('#msg');
    if (!el) return;
    el.textContent = msg;
    el.className = `msg ${kind} show`;
  }
  const hide = () => { const el = $('#msg'); if (el) el.className = 'msg'; };
  const busy = (form, on) => form.querySelectorAll('button, input').forEach((x) => { x.disabled = on; });

  async function navAccount() {
    const nav = $('#nav-account');
    if (!nav) return null;
    try {
      const { user } = await api('/api/me');
      nav.replaceChildren();
      const dl = Object.assign(document.createElement('a'), { href: '/#download', textContent: 'Download' });
      const acct = Object.assign(document.createElement('a'), { href: '/account', textContent: user.name });
      nav.append(dl, acct);
      return user;
    } catch { return null; }
  }

  async function needsAccounts() {
    try { const c = await api('/api/config'); if (!c.accounts) { show('Accounts aren\'t available yet. Check back soon.'); return false; } } catch { /* fall through */ }
    return true;
  }

  if (page === 'signup' || page === 'login') {
    if (params.get('next')) $('#alt-link').href += `?next=${encodeURIComponent(next)}`;
    navAccount().then((u) => { if (u) location.replace(next); });
    needsAccounts();
    $('#form').addEventListener('submit', async (e) => {
      e.preventDefault();
      hide();
      const f = e.target;
      const data = Object.fromEntries(new FormData(f));
      if (page === 'signup' && !f.agree.checked) return show('Please agree to the Terms to create an account.');
      delete data.agree;
      busy(f, true);
      try {
        await api(page === 'signup' ? '/api/signup' : '/api/login', data);
        location.replace(next);
      } catch (err) { show(err.message); busy(f, false); }
    });
  }

  if (page === 'app-login') {
    const code = (params.get('code') || '').toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 9);
    $('#user-code').textContent = code || 'XXXX-XXXX';
    (async () => {
      if (!code) return show('This link is missing its code. Start again from the TeamCode app.');
      const user = await navAccount();
      if (!user) return location.replace(`/login?next=${encodeURIComponent(`/app-login?code=${code}`)}`);
      $('#who').textContent = `Signing in as ${user.name} (${user.email}).`;
      const btn = $('#approve');
      btn.disabled = false;
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          await api('/api/app-login/approve', { userCode: code });
          show('Done. Go back to the TeamCode app; it finishes signing in on its own.', 'ok');
          btn.textContent = 'Approved';
        } catch (err) { show(err.message); btn.disabled = false; }
      });
    })();
  }

  if (page === 'account') {
    (async () => {
      const user = await navAccount();
      if (!user) return location.replace('/login?next=/account');
      $('#hello').textContent = `Hi, ${user.name.split(' ')[0]}.`;
      $('#profile-name').textContent = user.name;
      $('#profile-email').textContent = user.email;
      try {
        const { sessions } = await api('/api/account/sessions');
        const list = $('#sessions');
        for (const s of sessions) {
          const li = document.createElement('li');
          const left = document.createElement('span');
          left.textContent = `${s.kind === 'app' ? 'Desktop app' : 'Browser'}${s.current ? ' (this one)' : ''}`;
          const right = document.createElement('span');
          right.className = 'meta';
          right.textContent = `last used ${new Date(s.lastSeenAt).toLocaleDateString()}`;
          li.title = s.userAgent || '';
          li.append(left, right);
          list.append(li);
        }
      } catch { /* list is optional */ }
    })();

    $('#pw-form').addEventListener('submit', async (e) => {
      e.preventDefault(); hide();
      const f = e.target;
      busy(f, true);
      try { await api('/api/account/password', Object.fromEntries(new FormData(f))); f.reset(); show('Password changed. Your other browsers and apps were signed out.', 'ok'); }
      catch (err) { show(err.message); }
      busy(f, false);
    });
    $('#signout').addEventListener('click', async () => { await api('/api/logout', {}).catch(() => {}); location.replace('/'); });
    $('#signout-all').addEventListener('click', async () => {
      if (!confirm('Sign out of every browser and app, including this one?')) return;
      await api('/api/account/signout-all', {}).catch(() => {}); location.replace('/login');
    });
    $('#del-form').addEventListener('submit', async (e) => {
      e.preventDefault(); hide();
      if (!confirm('Delete your TeamCode account? This can\'t be undone.')) return;
      const f = e.target;
      busy(f, true);
      try { await api('/api/account/delete', Object.fromEntries(new FormData(f))); location.replace('/'); }
      catch (err) { show(err.message); busy(f, false); }
    });
  }
})();
