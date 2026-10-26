'use strict';
// Landing page: sticky-nav border, signed-in state, and download buttons filled from /api/release.
const nav = document.getElementById('nav');
fetch('/api/me', { credentials: 'same-origin' }).then((r) => (r.ok ? r.json() : null)).then((d) => {
  if (!d) return;
  const a = document.getElementById('nav-signin');
  a.textContent = d.user.name;
  a.href = '/account';
}).catch(() => {});
addEventListener('scroll', () => nav.classList.toggle('scrolled', scrollY > 8), { passive: true });
(async () => {
  const ua = navigator.userAgent;
  const isMac = /Mac/i.test(navigator.platform) || /Mac OS X/.test(ua);
  let arm = true;
  try { if (navigator.userAgentData?.getHighEntropyValues) arm = (await navigator.userAgentData.getHighEntropyValues(['architecture'])).architecture === 'arm'; } catch {}
  const mine = isMac ? (arm ? 'mac-arm64' : 'mac-x64') : /Win/i.test(ua) ? 'windows' : null;
  let info = null;
  try { info = await (await fetch('/api/release')).json(); } catch {}
  const ver = document.getElementById('dl-version');
  if (!info || !info.version) {
    ver.textContent = 'The first release is on its way. Check back soon.';
    document.querySelectorAll('.dl .go').forEach((g) => { g.textContent = 'Soon'; });
    return;
  }
  const v = info.version.replace(/^v/, '');
  const date = info.publishedAt ? new Date(info.publishedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }) : '';
  ver.textContent = `Version ${v}${date ? `, released ${date}` : ''}. Free, and runs on your own Claude Code.`;
  document.getElementById('foot-version').textContent = `v${v}`;
  for (const [k, p] of Object.entries(info.platforms)) {
    const a = document.querySelector(`[data-dl="${k}"]`);
    const f = document.querySelector(`[data-file="${k}"]`);
    if (!a) continue;
    if (p) { a.classList.remove('disabled'); f.textContent = `${p.file}, ${p.sizeMb} MB`; }
    else a.querySelector('.go').textContent = 'Coming soon';
  }
  if (mine && info.platforms[mine]) {
    const hero = document.getElementById('hero-dl');
    hero.href = `/download/${mine}`;
    hero.querySelector('span').textContent = `Download for ${info.platforms[mine].label}`;
    document.getElementById('hero-meta').innerHTML = `Version ${v}, free. <a href="#download">Other platforms</a>`;
  }
})();
