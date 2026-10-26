'use strict';
/* TeamCode renderer — plain JS, no build step. State lives in S; render() redraws from it. */
window.__errors = [];
window.addEventListener('error', (e) => window.__errors.push(String(e.message)));
window.addEventListener('unhandledrejection', (e) => window.__errors.push(String(e.reason?.message || e.reason)));

const api = (ch, args) => window.tc.invoke(ch, args);
const call = (op, args) => api('ws:call', { op, args });
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isMac = window.tc.platform === 'darwin';
const MOD = isMac ? '⌘' : 'Ctrl';

const S = {
  init: null, project: null, view: 'agents', state: null, events: [], presence: [], runtime: {}, status: 'offline', sync: null,
  logs: {}, drawer: null, review: { sel: null, tab: 'tasks', data: {}, busy: null }, taskMode: 'board', showClosed: false,
  activity: { filter: 'all', q: '' }, ctxTab: 'contracts', gitInfo: null, needsLogin: false,
};

// ---------- helpers ----------
const hue = (s) => [...String(s)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
const avatar = (name, cls = '') => `<span class="avatar ${cls}" style="background:hsl(${hue(name)} 62% 52%)">${esc(String(name || '?').trim()[0]?.toUpperCase() || '?')}</span>`;
function ago(ts) {
  if (!ts) return '';
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(ts).toLocaleDateString();
}
const clock = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const tasks = () => Object.values(S.state?.tasks || {});
const agents = () => Object.values(S.state?.agents || {});
const ACTIVE = new Set(['starting', 'working', 'idle', 'waiting', 'blocked']);
const me = () => S.init?.user || {};

function toast(text, kind = 'info', ms = 4200) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = text;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), ms);
}

async function run(fn, okMsg) {
  try {
    const r = await fn();
    if (okMsg) toast(okMsg, 'ok');
    return r;
  } catch (e) {
    toast(e.message || String(e), 'error', 7000);
    return undefined;
  }
}

const STATUS = {
  working: ['green pulse', 'Working'], starting: ['blue pulse', 'Starting'], idle: ['', 'Idle'], waiting: ['amber', 'Waiting'],
  blocked: ['red', 'Blocked'], stale: ['amber', 'No heartbeat'], offline: ['', 'Offline'], done: ['violet', 'Done'], error: ['red', 'Error'], stopped: ['', 'Stopped'],
};
const statusPill = (s) => { const [c, l] = STATUS[s] || ['', s]; return `<span class="pill ${c}">${esc(l)}</span>`; };
const TSTATUS = {
  waiting: ['amber', 'Waiting on deps'], ready: ['blue', 'Ready'], running: ['green pulse', 'Running'], blocked: ['red', 'Blocked'],
  done: ['violet', 'Completed'], failed: ['red', 'Failed'], cancelled: ['', 'Cancelled'],
};
const taskPill = (s) => { const [c, l] = TSTATUS[s] || ['', s]; return `<span class="pill ${c}">${esc(l)}</span>`; };

function evKind(t) {
  if (t.startsWith('chat')) return ['chat', '💬'];
  if (t.startsWith('conflict')) return ['conflict', t === 'conflict.resolved' ? '✅' : '⚠️'];
  if (t.startsWith('task')) return ['task', { 'task.completed': '🏁', 'task.failed': '❌', 'task.started': '▶️', 'task.ready': '🟢', 'task.blocked': '⛔' }[t] || '📋'];
  if (t.startsWith('file')) return ['file', t === 'file.changed' ? '✏️' : t === 'file.edit_started' ? '🔒' : t === 'file.edit_completed' ? '🔓' : '📄'];
  if (t.startsWith('changes')) return ['task', { 'changes.merged': '🔀', 'changes.approved': '👍', 'changes.rejected': '👎', 'changes.reverted': '↩️' }[t] || '👀'];
  if (t.startsWith('agent')) return ['agent', t === 'agent.error' ? '🐞' : t === 'agent.joined' ? '🤖' : '📣'];
  return ['', { 'decision.recorded': '🧭', 'contract.updated': '📐', 'blocker.reported': '🚧', 'blocker.resolved': '🛠️', 'note.added': '💡', 'test.completed': '🧪', 'branch.created': '🌿', 'coordination.requested': '🤝', 'integration.checked': '🔍', 'user.joined': '👋', 'user.left': '👋' }[t] || '•'];
}

function eventRow(e, { compact } = {}) {
  const [cls, ico] = evKind(e.type);
  const delivered = e.deliveredTo?.length ? ` · delivered to ${esc(e.deliveredTo.join(', '))}` : '';
  const task = e.task && S.state?.tasks[e.task];
  return `<div class="ev ${cls}" title="${esc(e.type)} · #${e.seq}">
    <div class="ico">${ico}</div>
    <div><div>${esc(e.summary)}</div>${compact ? '' : `<div class="meta">${esc(e.actor.name)} · ${esc(e.type)}${task ? ` · ${esc(task.title)}` : ''}${e.branch && e.branch !== 'main' ? ` · ${esc(e.branch)}` : ''}${delivered}</div>`}</div>
    <div class="time" title="${new Date(e.ts).toLocaleString()}">${clock(e.ts)}</div>
  </div>`;
}

// ---------- rendering ----------
let raf = null;
function render() {
  if (raf) return;
  raf = requestAnimationFrame(() => { raf = null; renderNow(); });
}

function renderNow() {
  // Preserve focus/caret of the active input across re-renders.
  const a = document.activeElement;
  const keep = a && a.id && ['INPUT', 'TEXTAREA', 'SELECT'].includes(a.tagName) && $('#app').contains(a) ? { id: a.id, v: a.value, s: a.selectionStart, e: a.selectionEnd } : null;
  const scrollers = [...document.querySelectorAll('#app [data-scroll]')].map((el) => [el.dataset.scroll, el.scrollTop]);
  const app = $('#app');
  document.body.classList.toggle('mac', isMac);
  if (!S.init) app.innerHTML = `<div class="empty" style="height:100%;justify-content:center"><span class="spinner"></span></div>`;
  else if (!S.project) app.innerHTML = welcome();
  else app.innerHTML = shell();
  for (const [k, top] of scrollers) { const el = document.querySelector(`#app [data-scroll="${k}"]`); if (el) el.scrollTop = top; }
  if (keep) {
    const el = document.getElementById(keep.id);
    if (el) { el.value = keep.v; el.focus(); try { el.setSelectionRange(keep.s, keep.e); } catch { /* not a text input */ } }
  }
  renderDrawer();
}

function claudeBanner() {
  const c = S.init.claude;
  if (S.needsLogin) return `<div class="banner warn"><span>🔑</span><div class="spacer"><b>Claude Code needs you to sign in.</b> <span class="muted">Agents can't run until you do. It only takes a moment.</span></div><button class="btn primary sm" data-act="login">Sign in to Claude Code</button></div>`;
  if (!c.path) return `<div class="banner warn"><span>⚠️</span><div class="spacer"><b>Claude Code not found.</b> <span class="muted">Install it (npm i -g @anthropic-ai/claude-code) or point TeamCode at it.</span></div><button class="btn sm" data-act="detect-claude">Detect again</button><button class="btn sm" data-act="browse-claude">Locate…</button></div>`;
  return `<div class="banner ok"><span>✅</span><div class="spacer"><b>Claude Code ready</b> <span class="muted">${esc(c.version || '')} · ${esc(c.path)}</span></div><button class="btn sm ghost" data-act="login">Sign in / switch account</button></div>`;
}

function welcome() {
  const u = me();
  const recent = S.init.projects;
  return `<div class="welcome"><div class="welcome-inner">
    <div class="brand"><div class="logo">TC</div><div><h1>TeamCode</h1><div class="muted">Your team and its AI agents, working on one codebase at the same time.</div></div></div>
    ${!u.name ? `<div class="panel panel-body col"><h3>👋 What should your team call you?</h3><div class="row"><input id="w-name" placeholder="Your name" maxlength="40"><button class="btn primary" data-act="save-name">Continue</button></div></div>` : ''}
    ${claudeBanner()}
    <div class="cards3">
      <button class="big-card" data-act="open-folder"><div class="emoji">📂</div><h3>Open a project</h3><div class="muted small">Pick a local folder or repository. You host the workspace and can invite your team.</div></button>
      <button class="big-card" data-act="join-modal"><div class="emoji">🤝</div><h3>Join your team</h3><div class="muted small">Paste the invite code a teammate shared. Files sync to a folder you choose.</div></button>
      <button class="big-card" data-act="clone-modal"><div class="emoji">⬇️</div><h3>Clone from Git</h3><div class="muted small">Clone a GitHub/GitLab repository and open it as a TeamCode project.</div></button>
    </div>
    ${recent.length ? `<div class="col"><h4>Recent projects</h4><div class="recent">${recent.map((p) => `
      <div class="recent-item" data-act="open-recent" data-root="${esc(p.root)}" data-ws="${esc(p.workspace)}">
        ${avatar(p.name)}<div class="spacer"><b>${esc(p.name)}</b><div class="muted small">${esc(p.root)}</div></div>
        <span class="pill nodot ${p.role === 'host' ? 'violet' : 'blue'}">${p.role === 'host' ? 'Host' : 'Member'}</span>
        <span class="faint small">${ago(p.lastOpened)}</span>
      </div>`).join('')}</div></div>` : ''}
    <div class="muted small">Tip: everyone on the team runs TeamCode with their own Claude Code. The host's computer runs the shared workspace — or run <code>npm run server</code> on an always-on machine.</div>
  </div></div>`;
}

const VIEWS = [
  ['agents', '🤖', 'Agents'], ['tasks', '📋', 'Tasks'], ['activity', '⚡', 'Activity'], ['review', '👀', 'Review'],
  ['context', '🧭', 'Context'], ['files', '🗂️', 'Files'], ['settings', '⚙️', 'Settings'],
];

function counts() {
  const t = tasks();
  const st = S.state;
  return {
    agents: agents().filter((a) => ACTIVE.has(a.status)).length,
    tasks: t.filter((x) => ['ready', 'running', 'blocked'].includes(x.status)).length,
    review: t.filter((x) => x.review?.state === 'pending').length,
    context: Object.values(st?.conflicts || {}).filter((c) => c.status === 'open').length + Object.values(st?.blockers || {}).filter((b) => b.status === 'open').length,
  };
}

function shell() {
  const c = counts();
  const p = S.project;
  const conn = { online: ['green', 'Live'], connecting: ['amber pulse', 'Connecting'], offline: ['red', 'Offline'] }[S.status] || ['', S.status];
  const people = S.presence.length ? S.presence : [{ id: me().id, name: me().name }];
  const sync = S.sync;
  return `<div class="shell">
    <aside class="sidebar">
      <div class="side-head">
        <div class="row"><div class="logo" style="width:30px;height:30px;font-size:12px;border-radius:9px">TC</div><div class="spacer ellipsis proj" title="${esc(p.root)}">${esc(p.name)}</div></div>
        <div class="row"><span class="pill ${conn[0]}">${conn[1]}</span><span class="pill nodot ${p.role === 'host' ? 'violet' : 'blue'}">${p.role === 'host' ? (p.shared ? 'Hosting · shared' : 'Hosting') : 'Joined'}</span></div>
      </div>
      <nav class="nav">${VIEWS.map(([k, ico, label], i) => {
        const n = c[k];
        return `<button class="${S.view === k ? 'on' : ''}" data-act="view" data-view="${k}" title="${label} (${MOD}+${i + 1})"><span class="ico">${ico}</span>${label}${n ? `<span class="count ${k === 'context' || k === 'review' ? 'alert' : ''}">${n}</span>` : ''}</button>`;
      }).join('')}</nav>
      <div class="spacer"></div>
      <div class="side-section">
        <div class="row"><h4>Team online</h4><span class="spacer"></span><button class="icon-btn" data-act="invite" title="Invite teammates">＋</button></div>
        <div class="people">${people.map((u) => `<div class="person">${avatar(u.name, 'sm round')}<span class="ellipsis">${esc(u.name)}${u.id === me().id ? ' <span class="faint">(you)</span>' : ''}</span><span class="dot"></span></div>`).join('')}</div>
      </div>
      <div class="side-section small muted">
        ${sync ? `<div class="row">${sync.ready ? '🔄 Synced' : '<span class="spinner" style="width:12px;height:12px"></span> Syncing…'}<span class="spacer"></span><span title="uploaded / downloaded">↑${sync.up} ↓${sync.down}</span></div>${sync.conflicts?.length ? `<div style="color:var(--red)">⚠️ ${sync.conflicts.length} file conflict(s)</div>` : ''}` : ''}
        <div class="row"><button class="btn sm ghost" data-act="close-project">← All projects</button></div>
      </div>
    </aside>
    <section class="main">
      <div class="topbar">
        <h2>${esc(VIEWS.find((v) => v[0] === S.view)[2])}</h2>
        <span class="spacer"></span>
        <button class="btn" data-act="invite">👥 Invite</button>
        <button class="btn" data-act="plan-modal" title="Let Claude split a feature into parallel tasks">✨ Plan a feature</button>
        <button class="btn primary" data-act="task-modal" title="${MOD}+N">＋ New task</button>
      </div>
      ${S.needsLogin || !S.init.claude.path ? `<div style="padding:12px 20px 0">${claudeBanner()}</div>` : ''}
      ${S.state ? VIEW_RENDER[S.view]() : `<div class="view"><div class="empty"><span class="spinner"></span><div>${S.status === 'offline' ? 'Reconnecting to the team workspace…' : 'Connecting to the team workspace…'}</div></div></div>`}
    </section>
  </div>`;
}

// ---------- Agents (Multi-Agent panel) ----------
function agentCard(a) {
  const rt = S.runtime[a.id];
  const t = a.task && S.state.tasks[a.task.id];
  const owner = S.state.users[a.userId]?.name;
  const conflicts = Object.values(S.state.conflicts).filter((c) => c.status !== 'resolved' && c.agents?.includes(a.id));
  const waiting = t ? t.dependsOn.map((d) => S.state.tasks[d]).filter((d) => d && d.status !== 'done') : [];
  const errors = a.updates.filter((u) => u.kind === 'error').slice(-2);
  const updates = a.updates.filter((u) => u.kind !== 'error').slice(-3).reverse();
  const cls = a.status === 'stale' ? 'stale' : a.status;
  return `<div class="agent-card ${cls}">
    <div class="row">${avatar(a.name)}<div class="spacer" style="min-width:0"><div class="row"><b>${esc(a.name)}</b>${statusPill(a.status)}</div>
      <div class="tiny muted ellipsis">${esc(a.client)}${owner ? ` · ${esc(owner)}'s computer` : ''} · ${a.mode === 'isolated' ? `🌿 ${esc(a.branch)}` : 'shared copy'}</div></div>
      ${rt?.costUsd ? `<span class="tiny faint" title="Claude usage cost">$${rt.costUsd.toFixed(2)}</span>` : ''}
    </div>
    <div>${t ? `<div class="task-line ellipsis" title="${esc(t.title)}">📋 ${esc(t.title)}</div><div class="row tiny" style="margin-top:3px">${taskPill(t.status)}${t.review?.state === 'pending' ? '<span class="pill blue">Awaiting review</span>' : ''}${t.integration?.state === 'merged' ? '<span class="pill green">Merged</span>' : ''}</div>` : '<span class="muted">No task assigned</span>'}</div>
    ${a.detail && !['working'].includes(a.status) ? `<div class="tiny muted">${esc(a.detail)}</div>` : ''}
    ${a.editing.length ? `<div><div class="tiny muted" style="margin-bottom:4px">Editing now</div><div class="files">${a.editing.slice(0, 8).map((f) => `<span class="chip ${f.mode === 'exclusive' ? 'warn' : ''}" title="${esc(f.intent || f.path)}">${f.mode === 'exclusive' ? '🔒 ' : ''}${esc(f.path)}</span>`).join('')}${a.editing.length > 8 ? `<span class="chip">+${a.editing.length - 8}</span>` : ''}</div></div>` : ''}
    ${!a.editing.length && a.edited.length ? `<div><div class="tiny muted" style="margin-bottom:4px">Changed</div><div class="files">${a.edited.slice(-6).map((f) => `<span class="chip">${esc(f)}</span>`).join('')}</div></div>` : ''}
    ${updates.length ? `<div class="updates">${updates.map((u) => `<div class="u"><span>${u.kind === 'discovery' ? '💡' : u.kind === 'approach' ? '🔀' : '📣'}</span><span><b>${esc(u.message)}</b> <span class="faint">${ago(u.at)}</span></span></div>`).join('')}</div>` : ''}
    ${errors.map((u) => `<div class="errbox">🐞 ${esc(u.message)}</div>`).join('')}
    ${conflicts.map((c) => `<div class="warnbox">⚠️ ${esc(c.message)}</div>`).join('')}
    ${waiting.length ? `<div class="warnbox">⏳ Waiting on: ${waiting.map((d) => esc(d.title)).join(', ')}</div>` : ''}
    <div class="row tiny faint">${a.pendingEvents ? `<span title="Relevant team updates not yet delivered to this agent">📬 ${a.pendingEvents} pending update(s)</span>` : '<span title="All relevant updates delivered">📭 Up to date</span>'}<span class="spacer"></span><span>seen ${ago(a.lastSeen)}</span></div>
    <div class="row">
      ${rt ? `<button class="btn sm" data-act="agent-log" data-id="${a.id}">📜 Live log</button>` : `<button class="btn sm" data-act="agent-detail" data-id="${a.id}">Details</button>`}
      ${rt ? `<button class="btn sm" data-act="agent-msg" data-id="${a.id}">💬 Message</button>` : ''}
      <span class="spacer"></span>
      ${rt?.running ? `<button class="btn sm danger" data-act="agent-stop" data-id="${a.id}">■ Stop</button>` : ''}
    </div>
  </div>`;
}

function viewAgents() {
  const all = agents().sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
  const live = all.filter((a) => ACTIVE.has(a.status) || a.status === 'stale');
  const finished = all.filter((a) => !live.includes(a)).slice(0, 12);
  const t = tasks();
  const stat = (n, l) => `<div class="stat"><div class="n">${n}</div><div class="l">${l}</div></div>`;
  const recent = S.events.filter((e) => !['user.joined', 'user.left'].includes(e.type)).slice(-60).reverse();
  return `<div class="view split">
    <div data-scroll="agents">
      <div class="stats">
        ${stat(live.filter((a) => a.status === 'working').length, 'agents working')}
        ${stat(t.filter((x) => x.status === 'ready').length, 'tasks ready to start')}
        ${stat(t.filter((x) => x.status === 'waiting').length, 'waiting on dependencies')}
        ${stat(t.filter((x) => x.status === 'blocked').length + live.filter((a) => a.status === 'blocked').length, 'blocked')}
        ${stat(t.filter((x) => x.review?.state === 'pending').length, 'awaiting review')}
      </div>
      ${live.length ? `<div class="agent-grid">${live.map(agentCard).join('')}</div>` : `<div class="panel empty"><div class="emoji">🤖</div><h3>No agents running</h3><div>Create tasks and start them — each task gets its own Claude Code agent. Agents see each other's work in real time.</div><div class="row"><button class="btn primary" data-act="task-modal">＋ New task</button><button class="btn" data-act="plan-modal">✨ Plan a feature</button></div></div>`}
      ${finished.length ? `<details style="margin-top:18px"><summary class="muted">Finished agents (${finished.length})</summary><div class="agent-grid" style="margin-top:12px">${finished.map(agentCard).join('')}</div></details>` : ''}
    </div>
    <div class="panel" style="display:flex;flex-direction:column">
      <div class="panel-head"><h3>Live activity</h3><span class="spacer"></span><button class="btn sm ghost" data-act="view" data-view="activity">All →</button></div>
      <div class="panel-body timeline compact" style="overflow:auto;flex:1" data-scroll="mini">${recent.map((e) => eventRow(e, { compact: true })).join('') || '<div class="muted small">Nothing yet.</div>'}</div>
    </div>
  </div>`;
}

// ---------- Tasks ----------
function runningAgentFor(taskId) {
  return Object.entries(S.runtime).find(([, r]) => r.taskId === taskId && r.running)?.[0];
}

function taskCard(t) {
  const deps = t.dependsOn.map((d) => S.state.tasks[d]).filter(Boolean);
  const agentId = runningAgentFor(t.id);
  const mine = !t.runner || t.runner === me().id;
  return `<div class="task-card" data-act="task-detail" data-id="${t.id}">
    <div class="row"><span class="prio p${t.priority}">P${t.priority}</span><span class="title spacer">${esc(t.title)}</span></div>
    <div class="row wrap tiny">${taskPill(t.status)}<span class="pill nodot">${t.mode === 'isolated' ? '🌿 isolated' : '📁 shared'}</span>${t.autoStart ? '<span class="pill nodot" title="Starts automatically when ready">⚡ auto</span>' : ''}</div>
    ${deps.length ? `<div class="deps">${deps.map((d) => `<span>${d.status === 'done' ? '✅' : '⏳'} ${esc(d.title)}</span>`).join('')}</div>` : ''}
    ${t.parallelNotes?.length ? `<div class="warnbox tiny">Shares files with ${t.parallelNotes.map((p) => `"${esc(p.title)}"`).join(', ')} — avoid running together</div>` : ''}
    <div class="row tiny muted">${[t.assigneeName && `🤖 ${esc(t.assigneeName)}`, t.runnerName && `💻 ${esc(t.runnerName)}`].filter(Boolean).join(' · ')}</div>
    <div class="actions">
      ${['ready', 'waiting', 'failed'].includes(t.status) && mine && !agentId ? `<button class="btn sm primary" data-act="task-start" data-id="${t.id}">▶ ${t.status === 'waiting' ? 'Start anyway' : t.status === 'failed' ? 'Retry' : 'Start'}</button>` : ''}
      ${agentId ? `<button class="btn sm" data-act="agent-log" data-id="${agentId}">📜 Log</button><button class="btn sm danger" data-act="agent-stop" data-id="${agentId}">■ Stop</button>` : ''}
      ${t.review?.state === 'pending' ? `<button class="btn sm primary" data-act="review-open" data-id="${t.id}">👀 Review</button>` : ''}
      <span class="spacer"></span>
      <button class="icon-btn" data-act="task-prio" data-id="${t.id}" data-d="-1" title="Higher priority">▲</button>
      <button class="icon-btn" data-act="task-prio" data-id="${t.id}" data-d="1" title="Lower priority">▼</button>
      <button class="icon-btn" data-act="task-modal" data-id="${t.id}" title="Edit">✎</button>
    </div>
  </div>`;
}

function waves(list) {
  const depth = {};
  const d = (t, seen = new Set()) => {
    if (depth[t.id] != null) return depth[t.id];
    if (seen.has(t.id)) return 0;
    seen.add(t.id);
    const deps = t.dependsOn.map((x) => S.state.tasks[x]).filter((x) => x && list.includes(x));
    return (depth[t.id] = deps.length ? 1 + Math.max(...deps.map((x) => d(x, seen))) : 0);
  };
  list.forEach((t) => d(t));
  const out = [];
  for (const t of list) (out[depth[t.id]] ||= []).push(t);
  return out.filter(Boolean);
}

function viewTasks() {
  const all = tasks().filter((t) => S.showClosed || t.status !== 'cancelled').sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt);
  if (!all.length) return `<div class="view"><div class="panel empty"><div class="emoji">📋</div><h3>No tasks yet</h3><div>Add tasks yourself, or describe a feature and let Claude split it into parallel subtasks with dependencies.</div><div class="row"><button class="btn primary" data-act="task-modal">＋ New task</button><button class="btn" data-act="plan-modal">✨ Plan a feature</button></div></div></div>`;
  const ready = all.filter((t) => t.status === 'ready');
  const waiting = all.filter((t) => t.status === 'waiting');
  const running = all.filter((t) => t.status === 'running');
  const conflictsInReady = ready.filter((t) => t.parallelNotes?.some((p) => ready.some((r) => r.id === p.task) || running.some((r) => r.id === p.task)));
  const integrated = (t) => t.status === 'done' && (t.integration?.state === 'merged' || ['approved'].includes(t.review?.state) || (t.review?.state === 'none' && t.integration?.state !== 'conflicts'));
  const cols = [
    ['⏳ Waiting on dependencies', waiting],
    ['🟢 Ready', ready],
    ['▶️ Running', running],
    ['⛔ Blocked / failed', all.filter((t) => ['blocked', 'failed'].includes(t.status))],
    ['👀 Completed — needs review', all.filter((t) => t.status === 'done' && !integrated(t))],
    ['✅ Integrated', all.filter(integrated)],
  ];
  if (S.showClosed) cols.push(['🗑️ Cancelled', all.filter((t) => t.status === 'cancelled')]);
  const body = S.taskMode === 'board'
    ? `<div class="board">${cols.map(([title, list]) => `<div class="column"><div class="column-head">${title}<span class="n">${list.length}</span></div>${list.map(taskCard).join('')}</div>`).join('')}</div>`
    : `<div class="waves">${waves(all.filter((t) => t.status !== 'cancelled')).map((w, i) => `<div class="wave"><div class="wave-head">Wave ${i + 1} · ${i === 0 ? 'no open dependencies' : `after wave ${i}`} · ${w.length} task(s) in parallel</div>${w.map(taskCard).join('')}</div>`).join('')}</div>`;
  return `<div class="view" data-scroll="tasks">
    <div class="row wrap" style="margin-bottom:14px">
      <div class="seg"><button class="${S.taskMode === 'board' ? 'on' : ''}" data-act="task-mode" data-mode="board">Board</button><button class="${S.taskMode === 'waves' ? 'on' : ''}" data-act="task-mode" data-mode="waves">Parallel plan</button></div>
      <span class="muted small">${ready.length} can start now · ${running.length} running · ${waiting.length} waiting on dependencies</span>
      <span class="spacer"></span>
      ${ready.filter((t) => !t.runner || t.runner === me().id).length > 1 ? `<button class="btn sm" data-act="start-all-ready">▶ Start all ready (${ready.filter((t) => !t.runner || t.runner === me().id).length})</button>` : ''}
      <label class="check small"><input type="checkbox" data-act="toggle-closed" ${S.showClosed ? 'checked' : ''}> Show cancelled</label>
    </div>
    ${conflictsInReady.length ? `<div class="banner warn" style="margin-bottom:14px">⚠️ ${conflictsInReady.map((t) => `"${esc(t.title)}"`).join(', ')} expect to touch the same files as other ready/running tasks. Consider running them one after another or adding a dependency.</div>` : ''}
    ${body}
  </div>`;
}

// ---------- Activity ----------
const FILTERS = [['all', 'All'], ['task', 'Tasks'], ['agent', 'Agents'], ['file', 'Files'], ['conflict', 'Conflicts'], ['decision', 'Decisions & contracts'], ['chat', 'Team chat']];
function matchFilter(e, f) {
  if (f === 'all') return true;
  if (f === 'decision') return /^(decision|contract|blocker|note|coordination)/.test(e.type);
  if (f === 'task') return /^(task|changes|test|integration|branch)/.test(e.type);
  return e.type.startsWith(f);
}
function viewActivity() {
  const q = S.activity.q.toLowerCase();
  const list = S.events.filter((e) => matchFilter(e, S.activity.filter) && (!q || (e.summary + e.actor.name + e.type).toLowerCase().includes(q))).slice(-400).reverse();
  return `<div class="view" style="display:flex;flex-direction:column;gap:12px">
    <div class="row wrap"><div class="seg">${FILTERS.map(([k, l]) => `<button class="${S.activity.filter === k ? 'on' : ''}" data-act="act-filter" data-f="${k}">${l}</button>`).join('')}</div><span class="spacer"></span><input id="act-q" placeholder="Search activity…" style="max-width:240px" value="${esc(S.activity.q)}"><button class="btn sm" data-act="load-delivery" title="Show which agents each event was delivered to">📬 Delivery info</button></div>
    <div class="panel" style="flex:1;display:flex;flex-direction:column;min-height:0">
      <div class="panel-body timeline" style="overflow:auto;flex:1" data-scroll="activity">${list.map((e) => eventRow(e)).join('') || '<div class="empty">No matching activity.</div>'}</div>
      <div class="chatbar"><input id="chat-input" placeholder="Message your team… (Enter to send)"><button class="btn primary" data-act="chat-send">Send</button></div>
    </div>
  </div>`;
}

// ---------- Review ----------
function gate(k, v, cls) { return `<div class="gate ${cls}"><span class="k">${k}</span><span class="v">${v}</span></div>`; }

function reviewDetail(t) {
  const d = S.review.data[t.id];
  const busy = S.review.busy;
  const tests = { passed: ['✓ Passed', 'ok'], failed: ['✗ Failed', 'bad'], none: ['Not run', 'wait'] }[t.tests?.state || 'none'];
  const integ = { clean: ['✓ Clean', 'ok'], conflicts: [`✗ ${t.integration.conflicts.length} conflict(s)`, 'bad'], merged: ['✓ Merged', 'ok'], reverted: ['↩ Reverted', 'wait'], none: ['Not checked', 'wait'] }[t.integration?.state || 'none'];
  const appr = { pending: ['Pending', 'wait'], approved: ['✓ Approved', 'ok'], rejected: ['✗ Rejected', 'bad'], reverted: ['↩ Reverted', 'wait'], none: ['Not requested', 'wait'] }[t.review?.state || 'none'];
  const merged = t.integration?.state === 'merged';
  const isolated = t.mode === 'isolated' && t.branch && t.branch !== 'main';
  let diffHtml = '<div class="empty"><span class="spinner"></span></div>';
  if (d?.error) diffHtml = `<div class="errbox">${esc(d.error)}</div>`;
  else if (d?.kind === 'remote') diffHtml = `<div class="banner">${esc(d.message)}</div>`;
  else if (d?.kind === 'git') {
    const files = TCDiff.parseGitDiff(d.diff);
    diffHtml = files.length ? files.map((f) => diffFile(f.path, f.hunks, `+${f.adds} −${f.dels}`, f.binary)).join('') : '<div class="muted">No changes on this branch.</div>';
  } else if (d?.kind === 'shared') {
    diffHtml = d.files.length ? d.files.map((f) => {
      const hunks = f.binary ? [] : TCDiff.lineDiff(f.before, f.after);
      const note = f.changedByOthersSince?.length ? ` · also changed by ${[...new Set(f.changedByOthersSince)].join(', ')}` : '';
      return diffFile(f.path, hunks, `${f.beforeVersion ? `v${f.beforeVersion}` : 'new'} → v${f.afterVersion} · ${f.lastBy}${note}`, f.binary);
    }).join('') : '<div class="muted">No file changes recorded for this task.</div>';
  }
  return `<div class="col" style="gap:14px">
    <div class="row"><div class="spacer"><h2>${esc(t.title)}</h2><div class="muted small">${t.assigneeName ? `by ${esc(t.assigneeName)} · ` : ''}${isolated ? `🌿 ${esc(t.branch)}` : '📁 shared working copy'}${t.review?.stats ? ` · ${t.review.stats.files} files, +${t.review.stats.insertions} −${t.review.stats.deletions}` : ''}</div></div></div>
    <div class="gates">${gate('Task', t.status === 'done' ? '✓ Completed' : esc(TSTATUS[t.status]?.[1] || t.status), t.status === 'done' ? 'ok' : t.status === 'failed' ? 'bad' : 'wait')}${gate('Tests', tests[0], tests[1])}${gate('Integration', integ[0], integ[1])}${gate('Approval', appr[0], appr[1])}</div>
    ${t.review?.summary || t.summary ? `<div class="panel panel-body small">${esc(t.review?.summary || t.summary)}</div>` : ''}
    <div class="row wrap">
      <button class="btn" data-act="rv-test" data-id="${t.id}" ${busy ? 'disabled' : ''}>${busy === 'test' ? '<span class="spinner"></span>' : '🧪'} Run tests</button>
      <button class="btn" data-act="rv-check" data-id="${t.id}" ${busy || merged ? 'disabled' : ''}>${busy === 'check' ? '<span class="spinner"></span>' : '🔍'} Check integration</button>
      ${!merged ? `<button class="btn primary" data-act="rv-approve" data-id="${t.id}" ${busy ? 'disabled' : ''}>${busy === 'approve' ? '<span class="spinner"></span>' : '✔'} ${isolated ? 'Approve & merge' : 'Approve'}</button>` : ''}
      ${!merged && t.review?.state !== 'rejected' ? `<button class="btn danger" data-act="rv-reject" data-id="${t.id}" ${busy ? 'disabled' : ''}>Reject…</button>` : ''}
      ${t.integration?.state === 'conflicts' && isolated ? `<button class="btn" data-act="rv-agent-fix" data-id="${t.id}">🤖 Ask agent to resolve conflicts</button>` : ''}
      ${merged ? `<button class="btn danger" data-act="rv-revert" data-id="${t.id}">↩ Revert</button>` : ''}
      <span class="spacer"></span><button class="btn sm ghost" data-act="rv-refresh" data-id="${t.id}">↻ Refresh diff</button>
    </div>
    ${t.integration?.conflicts?.length ? `<div class="errbox">Merge conflicts in: ${t.integration.conflicts.map(esc).join(', ')}</div>` : ''}
    ${t.integration?.risks?.length ? `<div class="col">${t.integration.risks.map((r) => `<div class="warnbox">⚠️ <b>${esc(r.kind)}</b> — ${esc(r.message)}</div>`).join('')}</div>` : ''}
    ${t.tests?.output ? `<details><summary class="muted small">Test output (${esc(t.tests.command || '')}, ${Math.round((t.tests.durationMs || 0) / 1000)}s)</summary><pre class="out">${esc(t.tests.output)}</pre></details>` : ''}
    <div>${diffHtml}</div>
  </div>`;
}

function diffFile(p, hunks, meta, binary) {
  const body = binary ? '<div class="muted small" style="padding:10px 12px">Binary file</div>'
    : hunks === null ? '<div class="muted small" style="padding:10px 12px">File too large to diff here.</div>'
    : hunks.map((h) => `<div class="h">${esc(h.header)}</div>${h.lines.map((l) => `<div class="l ${l.t === '+' ? 'add' : l.t === '-' ? 'del' : 'ctx'}">${esc(l.s)}</div>`).join('')}`).join('');
  return `<details class="diff-file" open><summary class="diff-file-head"><span class="spacer ellipsis">${esc(p)}</span><span class="faint">${esc(meta)}</span></summary><div class="diff">${body}</div></details>`;
}

function viewReview() {
  const list = tasks().filter((t) => t.review?.state !== 'none' || t.status === 'done').sort((a, b) => (a.review?.state === 'pending' ? -1 : 0) - (b.review?.state === 'pending' ? -1 : 0) || (b.completedAt || 0) - (a.completedAt || 0));
  const sel = S.review.sel && S.state.tasks[S.review.sel] ? S.state.tasks[S.review.sel] : list[0];
  if (sel && !S.review.data[sel.id] && S.review.tab === 'tasks') loadDiff(sel.id);
  const tabs = `<div class="tabs" style="margin:0 0 0;padding:0 10px"><button class="${S.review.tab === 'tasks' ? 'on' : ''}" data-act="rv-tab" data-tab="tasks">By task</button><button class="${S.review.tab === 'all' ? 'on' : ''}" data-act="rv-tab" data-tab="all">All changes</button></div>`;
  if (S.review.tab === 'all') {
    const rows = [...(S.state.recentFiles || []).map((f) => ({ path: f.path, by: f.by?.name, kind: f.by?.kind, at: f.at, where: `main v${f.version}`, deleted: f.deleted })),
      ...(S.state.branchChanges || []).map((c) => ({ path: c.path, by: c.by?.name, kind: c.by?.kind, at: c.at, where: c.branch, task: c.task }))].sort((a, b) => b.at - a.at).slice(0, 300);
    const byWho = {};
    for (const r of rows) byWho[r.by] = (byWho[r.by] || 0) + 1;
    return `<div class="view"><div class="panel">${tabs}<div class="panel-body">
      <div class="row wrap" style="margin-bottom:12px">${Object.entries(byWho).map(([n, c]) => `<span class="pill nodot">${avatar(n, 'sm round')} ${esc(n)} · ${c}</span>`).join('')}</div>
      <table class="t"><tr><th>File</th><th>Changed by</th><th>Where</th><th>When</th></tr>${rows.map((r) => `<tr><td class="mono">${esc(r.path)}${r.deleted ? ' <span class="pill red nodot">deleted</span>' : ''}</td><td>${r.kind === 'agent' ? '🤖' : '🧑'} ${esc(r.by)}</td><td>${esc(r.where)}${r.task && S.state.tasks[r.task] ? ` · ${esc(S.state.tasks[r.task].title)}` : ''}</td><td class="faint">${ago(r.at)}</td></tr>`).join('')}</table>
      ${rows.length ? '' : '<div class="empty">No changes yet.</div>'}
    </div></div></div>`;
  }
  return `<div class="view"><div class="review">
    <div class="panel">${tabs}${list.map((t) => `<div class="list-item ${sel?.id === t.id ? 'on' : ''}" data-act="rv-select" data-id="${t.id}">
      <b class="ellipsis">${esc(t.title)}</b>
      <div class="row wrap tiny">${t.review?.state === 'pending' ? '<span class="pill blue">Needs review</span>' : t.review?.state === 'approved' ? '<span class="pill green">Approved</span>' : t.review?.state === 'rejected' ? '<span class="pill red">Rejected</span>' : '<span class="pill">No review</span>'}${t.integration?.state === 'merged' ? '<span class="pill green">Merged</span>' : t.integration?.state === 'conflicts' ? '<span class="pill red">Conflicts</span>' : ''}${t.tests?.state === 'failed' ? '<span class="pill red">Tests failing</span>' : t.tests?.state === 'passed' ? '<span class="pill green">Tests pass</span>' : ''}</div>
      <div class="tiny muted">${esc(t.assigneeName || '')} ${t.completedAt ? '· ' + ago(t.completedAt) : ''}</div>
    </div>`).join('') || '<div class="empty small">Completed tasks show up here for review.</div>'}</div>
    <div class="panel panel-body" data-scroll="review">${sel ? reviewDetail(sel) : '<div class="empty"><div class="emoji">👀</div>Nothing to review yet.</div>'}</div>
  </div></div>`;
}

async function loadDiff(taskId, force) {
  if (!force && S.review.data[taskId]) return;
  S.review.data[taskId] = { loading: true };
  try { S.review.data[taskId] = await api('review:diff', { taskId }); } catch (e) { S.review.data[taskId] = { error: e.message }; }
  render();
}

// ---------- Context ----------
function viewContext() {
  const st = S.state;
  const tabs = [['contracts', `📐 Contracts (${Object.keys(st.contracts).length})`], ['decisions', `🧭 Decisions (${st.decisions.length})`], ['blockers', `🚧 Blockers (${Object.values(st.blockers).filter((b) => b.status === 'open').length})`], ['conflicts', `⚠️ Conflicts (${Object.values(st.conflicts).filter((c) => c.status === 'open').length})`], ['notes', `💡 Notes (${st.notes.length})`], ['coordination', `🤝 Requests (${st.coordination.length})`]];
  let body = '';
  const by = (o) => `<span class="faint tiny">${esc(o.by?.name || o.by || '')} · ${ago(o.at)}</span>`;
  if (S.ctxTab === 'contracts') {
    const list = Object.values(st.contracts).sort((a, b) => b.at - a.at);
    body = `<div class="row" style="margin-bottom:12px"><span class="muted small spacer">Shared interface contracts that dependent tasks build against. Agents publish them with publish_contract; you can too.</span><button class="btn primary sm" data-act="contract-modal">＋ Publish contract</button></div>
      ${list.map((c) => `<div class="panel panel-body col" style="margin-bottom:10px"><div class="row"><b>${esc(c.name)}</b><span class="pill violet nodot">v${c.version}</span><span class="spacer"></span>${by(c)}<button class="btn sm" data-act="contract-modal" data-name="${esc(c.name)}">Edit</button></div>${c.description ? `<div class="muted small">${esc(c.description)}</div>` : ''}${c.taskId && st.tasks[c.taskId] ? `<div class="tiny muted">From task: ${esc(st.tasks[c.taskId].title)}</div>` : ''}<pre class="out">${esc(c.content)}</pre></div>`).join('') || '<div class="empty">No contracts yet.</div>'}`;
  } else if (S.ctxTab === 'decisions') {
    body = `<div class="row" style="margin-bottom:12px"><span class="muted small spacer">Architectural decisions every agent is told to follow.</span><button class="btn primary sm" data-act="decision-modal">＋ Record decision</button></div>
      ${st.decisions.slice().reverse().map((d) => `<div class="panel panel-body col" style="margin-bottom:10px"><div class="row"><b>${esc(d.title)}</b><span class="spacer"></span>${by(d)}</div><div>${esc(d.decision)}</div>${d.rationale ? `<div class="muted small">Why: ${esc(d.rationale)}</div>` : ''}</div>`).join('') || '<div class="empty">No decisions recorded.</div>'}`;
  } else if (S.ctxTab === 'blockers') {
    const list = Object.values(st.blockers).sort((a, b) => (a.status === 'open' ? -1 : 1) - (b.status === 'open' ? -1 : 1) || b.at - a.at);
    body = list.map((b) => `<div class="panel panel-body col" style="margin-bottom:10px"><div class="row">${b.status === 'open' ? '<span class="pill red">Open</span>' : '<span class="pill green">Resolved</span>'}<b class="spacer">${esc(b.description)}</b>${by(b)}</div>${b.needs ? `<div class="small">Needs: ${esc(b.needs)}</div>` : ''}${b.taskId && st.tasks[b.taskId] ? `<div class="tiny muted">Task: ${esc(st.tasks[b.taskId].title)}</div>` : ''}${b.resolution ? `<div class="okbox">${esc(b.resolution)}</div>` : ''}${b.status === 'open' ? `<div><button class="btn sm" data-act="blocker-resolve" data-id="${b.id}">Mark resolved…</button></div>` : ''}</div>`).join('') || '<div class="empty">No blockers. 🎉</div>';
  } else if (S.ctxTab === 'conflicts') {
    const list = Object.values(st.conflicts).sort((a, b) => (a.status === 'open' ? -1 : 1) - (b.status === 'open' ? -1 : 1) || b.at - a.at).slice(0, 80);
    const kinds = { sync: 'Simultaneous edit', overlap: 'Agents editing same file', integration_risk: 'Same file on different branches', merge: 'Merge conflict' };
    body = list.map((c) => `<div class="panel panel-body col" style="margin-bottom:10px"><div class="row">${c.status === 'open' ? '<span class="pill red">Open</span>' : c.status === 'watch' ? '<span class="pill amber">Watch</span>' : '<span class="pill green">Resolved</span>'}<b>${esc(kinds[c.kind] || c.kind)}</b><span class="chip">${esc(c.path || '')}</span><span class="spacer"></span><span class="faint tiny">${ago(c.at)}</span></div><div class="small">${esc(c.message)}</div>
      ${c.status !== 'resolved' ? `<div class="row">${c.kind === 'sync' ? `<button class="btn sm primary" data-act="conflict-resolve" data-id="${c.id}">Resolve…</button>` : c.kind === 'merge' ? `<button class="btn sm" data-act="review-open" data-id="${c.taskId}">Open in Review</button>` : ''}<button class="btn sm ghost" data-act="conflict-ack" data-id="${c.id}">Acknowledge</button></div>` : c.resolution ? `<div class="tiny muted">Resolution: ${esc(c.resolution)}</div>` : ''}</div>`).join('') || '<div class="empty">No conflicts. Changes from everyone are merging cleanly.</div>';
  } else if (S.ctxTab === 'notes') {
    body = st.notes.slice().reverse().map((n) => `<div class="panel panel-body row" style="margin-bottom:8px;align-items:flex-start"><span>${n.kind === 'error' ? '🐞' : '💡'}</span><div class="spacer"><div>${esc(n.message)}</div>${n.files?.length ? `<div class="files" style="margin-top:4px">${n.files.map((f) => `<span class="chip">${esc(f)}</span>`).join('')}</div>` : ''}</div>${by(n)}</div>`).join('') || '<div class="empty">Agents share discoveries here with publish_update.</div>';
  } else {
    body = st.coordination.slice().reverse().map((r) => `<div class="panel panel-body col" style="margin-bottom:8px"><div class="row"><b>${esc(r.from.name)} → ${esc(r.toName || 'all agents')}</b><span class="spacer"></span><span class="faint tiny">${ago(r.at)}</span></div><div><b>${esc(r.subject)}</b> — ${esc(r.message)}</div>${r.files?.length ? `<div class="files">${r.files.map((f) => `<span class="chip">${esc(f)}</span>`).join('')}</div>` : ''}</div>`).join('') || '<div class="empty">Agents use request_coordination to agree on shared files and interfaces.</div>';
  }
  return `<div class="view" data-scroll="context"><div class="tabs">${tabs.map(([k, l]) => `<button class="${S.ctxTab === k ? 'on' : ''}" data-act="ctx-tab" data-tab="${k}">${l}</button>`).join('')}</div>${body}</div>`;
}

// ---------- Files ----------
function viewFiles() {
  const st = S.state;
  const sync = S.sync || {};
  const res = Object.entries(st.reservations || {});
  return `<div class="view" data-scroll="files">
    <div class="stats">
      <div class="stat"><div class="n">${st.fileCount}</div><div class="l">files in workspace</div></div>
      <div class="stat"><div class="n">${sync.up || 0}</div><div class="l">uploaded this session</div></div>
      <div class="stat"><div class="n">${sync.down || 0}</div><div class="l">received from team</div></div>
      <div class="stat"><div class="n">${sync.merged || 0}</div><div class="l">auto-merged edits</div></div>
      <div class="stat"><div class="n">${sync.conflicts?.length || 0}</div><div class="l">unresolved file conflicts</div></div>
    </div>
    <div class="grid2">
      <div class="panel"><div class="panel-head"><h3>🔒 Being edited right now</h3></div><div class="panel-body">${res.length ? `<table class="t"><tr><th>File</th><th>Agent</th><th>Intent</th></tr>${res.map(([p, rs]) => rs.map((r) => `<tr><td class="mono">${esc(p)}</td><td>${esc(r.agentName)} ${r.mode === 'exclusive' ? '<span class="pill amber nodot">exclusive</span>' : ''}${r.branch && r.branch !== 'main' ? `<div class="tiny faint">🌿 ${esc(r.branch)}</div>` : ''}</td><td class="small muted">${esc(r.intent || r.taskTitle || '')}</td></tr>`).join('')).join('')}</table>` : '<div class="muted small">No files reserved. Agents reserve files automatically when they edit, or explicitly with announce_edit.</div>'}</div></div>
      <div class="panel"><div class="panel-head"><h3>🌿 Changes on agent branches</h3></div><div class="panel-body">${(st.branchChanges || []).length ? `<table class="t"><tr><th>File</th><th>By</th><th>Branch</th></tr>${st.branchChanges.slice().reverse().slice(0, 40).map((c) => `<tr><td class="mono">${esc(c.path)}</td><td>${esc(c.by?.name)}</td><td class="small">${esc(c.branch)}</td></tr>`).join('')}</table>` : '<div class="muted small">Isolated tasks work on their own branches; their edits show here until merged.</div>'}</div></div>
    </div>
    <div class="panel" style="margin-top:16px"><div class="panel-head"><h3>🕘 Recently changed in the shared working copy</h3></div><div class="panel-body">
      ${(st.recentFiles || []).length ? `<table class="t"><tr><th>File</th><th>Version</th><th>Last changed by</th><th>When</th><th></th></tr>${st.recentFiles.slice(0, 80).map((f) => `<tr><td class="mono">${esc(f.path)}${f.deleted ? ' <span class="pill red nodot">deleted</span>' : ''}</td><td>v${f.version}</td><td>${f.by?.kind === 'agent' ? '🤖' : '🧑'} ${esc(f.by?.name)}</td><td class="faint">${ago(f.at)}</td><td><button class="btn sm ghost" data-act="file-history" data-path="${esc(f.path)}">History</button></td></tr>`).join('')}</table>` : '<div class="muted small">Edits from anyone on the team appear here instantly.</div>'}
    </div></div>
  </div>`;
}

// ---------- Settings ----------
function viewSettings() {
  const s = S.init.settings;
  const c = S.init.claude;
  const g = S.gitInfo;
  if (!g) api('project:gitInfo').then((x) => { S.gitInfo = x; render(); }).catch(() => { S.gitInfo = { repo: false, error: true }; });
  return `<div class="view" data-scroll="settings"><div style="max-width:760px">
    <div class="section"><h3>You</h3><div class="row"><input id="set-name" value="${esc(me().name)}" placeholder="Your name"><button class="btn" data-act="set-name">Save</button></div></div>
    <div class="section"><h3>Claude Code</h3>
      <div class="banner ${c.path ? 'ok' : 'warn'}"><div class="spacer"><b>${c.path ? esc(c.version || 'Found') : 'Not found'}</b><div class="small muted mono">${esc(c.path || 'Install with: npm i -g @anthropic-ai/claude-code')}</div></div></div>
      <div class="row"><button class="btn" data-act="detect-claude">Detect</button><button class="btn" data-act="browse-claude">Locate…</button><button class="btn" data-act="login">Sign in to Claude Code</button></div>
    </div>
    <div class="section"><h3>Agents</h3>
      <label class="field">Permissions<select id="set-perm">
        <option value="acceptEdits" ${s.permissionMode === 'acceptEdits' ? 'selected' : ''}>Edit files automatically; other commands need allow-listing (recommended)</option>
        <option value="bypassPermissions" ${s.permissionMode === 'bypassPermissions' ? 'selected' : ''}>Full auto — agents may also run commands (fastest, trust your agents)</option>
        <option value="default" ${s.permissionMode === 'default' ? 'selected' : ''}>Cautious — only read and TeamCode tools without approval</option>
      </select></label>
      <div class="grid2"><label class="field">Model <span class="hint">Leave empty for your Claude Code default</span><input id="set-model" value="${esc(s.model)}" placeholder="e.g. opus or sonnet"></label>
      <label class="field">Max agents in parallel on this computer<input id="set-max" type="number" min="1" max="10" value="${s.maxParallel}"></label></div>
      <label class="check"><input type="checkbox" id="set-auto" ${s.autoRun ? 'checked' : ''}> Automatically start tasks marked ⚡ auto when their dependencies are done</label>
      <div><button class="btn primary" data-act="save-settings">Save agent settings</button></div>
    </div>
    <div class="section"><h3>Workspace</h3>
      <label class="field">Test command <span class="hint">Shared with the whole team — used by “Run tests” in Review</span><div class="row"><input id="set-test" value="${esc(S.state.settings.testCommand || '')}" placeholder="npm test"><button class="btn" data-act="save-test">Save</button></div></label>
      <label class="field">Public server URL <span class="hint">Optional: if you expose your TeamCode port to the internet (router port-forward, tunnel), invites will use it</span><div class="row"><input id="set-public" value="${esc(s.publicUrl)}" placeholder="https://my-tunnel.example.com"><button class="btn" data-act="save-public">Save</button></div></label>
    </div>
    <div class="section"><h3>Connect another AI agent</h3><div class="muted small">Any MCP client (Claude Code in a terminal, Claude desktop, IDEs) can join this workspace with the TeamCode MCP server and hooks.</div><div><button class="btn" data-act="external-agent">Show connection settings</button></div></div>
    <div class="section"><h3>Git</h3>${!g ? '<span class="spinner"></span>' : g.repo ? `<div class="small">Branch <b>${esc(g.branch || '(no commits)')}</b> · ${g.dirty} uncommitted file(s)</div><div class="row"><button class="btn" data-act="checkpoint">Commit working copy (checkpoint)</button></div>` : `<div class="small muted">This folder isn't a git repository. Isolated agent branches and merge review need git.</div><div><button class="btn" data-act="init-git">Initialize git repository</button></div>`}</div>
    <div class="section"><h3>Keyboard shortcuts</h3><div class="small muted"><span class="kbd">${MOD}+N</span> new task · <span class="kbd">${MOD}+P</span> plan a feature · <span class="kbd">${MOD}+1…7</span> switch views · <span class="kbd">Esc</span> close dialogs</div></div>
  </div></div>`;
}

const VIEW_RENDER = { agents: viewAgents, tasks: viewTasks, activity: viewActivity, review: viewReview, context: viewContext, files: viewFiles, settings: viewSettings };

// ---------- drawer ----------
function renderDrawer() {
  const root = $('#drawer-root');
  const d = S.drawer;
  if (!d || !S.state) { root.innerHTML = ''; return; }
  let html = '';
  if (d.kind === 'agent') {
    const a = S.state.agents[d.id];
    const rt = S.runtime[d.id];
    const log = S.logs[d.id] || [];
    html = `<div class="drawer"><div class="modal-head">${avatar(a?.name || '?')}<div class="spacer"><b>${esc(a?.name || 'Agent')}</b><div class="tiny muted">${esc(a?.task?.title || '')}</div></div>${a ? statusPill(a.status) : ''}${rt?.running ? `<button class="btn sm danger" data-act="agent-stop" data-id="${d.id}">■ Stop</button>` : ''}<button class="icon-btn" data-act="drawer-close">✕</button></div>
      <div class="drawer-body" id="log-scroll"><div class="log">${log.map((e) => `<div class="e ${e.kind}">${esc(e.text)}</div>`).join('') || '<div class="muted small">No output yet.</div>'}</div></div>
      ${rt ? `<div class="chatbar"><input id="agent-msg-input" placeholder="${rt.running ? 'Send a message to this agent (queued after its current step)…' : 'Ask a follow-up — resumes the same session…'}"><button class="btn primary" data-act="agent-send" data-id="${d.id}">Send</button></div>` : ''}</div>`;
  } else if (d.kind === 'task') {
    const t = S.state.tasks[d.id];
    if (!t) { S.drawer = null; root.innerHTML = ''; return; }
    const evs = S.events.filter((e) => e.task === t.id).slice(-60).reverse();
    const deps = t.dependsOn.map((x) => S.state.tasks[x]).filter(Boolean);
    const dependents = tasks().filter((o) => o.dependsOn.includes(t.id));
    html = `<div class="drawer"><div class="modal-head"><span class="prio p${t.priority}">P${t.priority}</span><b class="spacer">${esc(t.title)}</b>${taskPill(t.status)}<button class="icon-btn" data-act="drawer-close">✕</button></div>
      <div class="drawer-body col" style="gap:14px">
        <div style="white-space:pre-wrap">${esc(t.description) || '<span class="muted">No description.</span>'}</div>
        <div class="row wrap small">${t.mode === 'isolated' ? `🌿 Isolated${t.branch && t.branch !== 'main' ? ` on <code>${esc(t.branch)}</code>` : ''}` : '📁 Shared working copy'} · Runs on ${esc(t.runnerName || 'any computer')} ${t.assigneeName ? `· Agent ${esc(t.assigneeName)}` : ''}</div>
        ${t.files.length ? `<div><h4>Expected files</h4><div class="files" style="margin-top:6px">${t.files.map((f) => `<span class="chip">${esc(f)}</span>`).join('')}</div></div>` : ''}
        ${deps.length ? `<div><h4>Depends on</h4>${deps.map((x) => `<div class="small">${x.status === 'done' ? '✅' : '⏳'} ${esc(x.title)} — ${esc(TSTATUS[x.status]?.[1] || x.status)}</div>`).join('')}</div>` : ''}
        ${dependents.length ? `<div><h4>Unblocks</h4>${dependents.map((x) => `<div class="small">→ ${esc(x.title)}</div>`).join('')}</div>` : ''}
        ${t.parallelNotes?.length ? `<div class="warnbox">${t.parallelNotes.map((p) => `Shares ${p.files.map(esc).join(', ')} with "${esc(p.title)}"`).join('<br>')}</div>` : ''}
        ${t.summary ? `<div><h4>Summary</h4><div class="small">${esc(t.summary)}</div></div>` : ''}
        ${t.error ? `<div class="errbox">${esc(t.error)}</div>` : ''}
        <div class="row wrap">
          ${['ready', 'waiting', 'failed'].includes(t.status) && !runningAgentFor(t.id) ? `<button class="btn primary" data-act="task-start" data-id="${t.id}">▶ Start agent</button>` : ''}
          <button class="btn" data-act="task-modal" data-id="${t.id}">✎ Edit</button>
          ${t.status === 'done' ? `<button class="btn" data-act="review-open" data-id="${t.id}">👀 Review</button><button class="btn" data-act="task-reopen" data-id="${t.id}">Reopen</button>` : ''}
          ${!['running', 'cancelled'].includes(t.status) ? `<button class="btn danger" data-act="task-cancel" data-id="${t.id}">Cancel task</button>` : ''}
          ${t.status === 'cancelled' ? `<button class="btn danger" data-act="task-delete" data-id="${t.id}">Delete</button>` : ''}
        </div>
        <div><h4>History</h4><div class="timeline compact" style="margin-top:6px">${evs.map((e) => eventRow(e, { compact: true })).join('') || '<div class="muted small">No activity yet.</div>'}</div></div>
      </div></div>`;
  }
  const scroller = $('#log-scroll');
  const atBottom = !scroller || scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 30;
  const msg = $('#agent-msg-input');
  const keep = msg && document.activeElement === msg ? msg.value : null;
  root.innerHTML = html;
  const ns = $('#log-scroll');
  if (ns && atBottom) ns.scrollTop = ns.scrollHeight;
  if (keep !== null) { const m = $('#agent-msg-input'); m.value = keep; m.focus(); }
}

// ---------- modals ----------
function modal(html, { wide } = {}) {
  $('#modal-root').innerHTML = `<div class="overlay" data-act="modal-bg"><div class="modal ${wide ? 'wide' : ''}">${html}</div></div>`;
  const f = $('#modal-root [autofocus]');
  if (f) f.focus();
}
const closeModal = () => { $('#modal-root').innerHTML = ''; };
const mhead = (title) => `<div class="modal-head"><h2 class="spacer">${title}</h2><button class="icon-btn" data-act="modal-close">✕</button></div>`;

function runnerOptions(selected) {
  const users = { [me().id]: `${me().name || 'Me'} (this computer)` };
  for (const u of S.presence) if (!users[u.id]) users[u.id] = u.name;
  for (const u of Object.values(S.state.users)) if (!users[u.id]) users[u.id] = u.name;
  return `<option value="">Anyone (start manually)</option>` + Object.entries(users).map(([id, n]) => `<option value="${esc(id)}" ${selected === id ? 'selected' : ''}>${esc(n)}</option>`).join('');
}

function taskModal(id) {
  const t = id ? S.state.tasks[id] : null;
  const others = tasks().filter((o) => o.id !== id && o.status !== 'cancelled');
  modal(`${mhead(t ? 'Edit task' : 'New task')}
    <div class="modal-body">
      <label class="field">Title<input id="tm-title" autofocus value="${esc(t?.title || '')}" placeholder="e.g. Build the track export API"></label>
      <label class="field">Description <span class="hint">Spec, acceptance criteria, interfaces it provides or uses. This is what the agent reads.</span><textarea id="tm-desc" rows="6">${esc(t?.description || '')}</textarea></label>
      <div class="grid2">
        <label class="field">How should the agent work?<select id="tm-mode"><option value="isolated" ${t?.mode !== 'shared' ? 'selected' : ''}>🌿 Isolated branch — review & merge after (safest)</option><option value="shared" ${t?.mode === 'shared' ? 'selected' : ''}>📁 Shared working copy — changes go live instantly</option></select></label>
        <label class="field">Priority<select id="tm-prio">${[0, 1, 2, 3].map((p) => `<option value="${p}" ${(t?.priority ?? 2) === p ? 'selected' : ''}>P${p}${p === 0 ? ' — urgent' : p === 3 ? ' — low' : ''}</option>`).join('')}</select></label>
      </div>
      ${others.length ? `<label class="field">Depends on <span class="hint">The task waits until these are completed. Leave empty if it can run in parallel.</span><div class="col" style="max-height:150px;overflow:auto;border:1px solid var(--border);border-radius:8px;padding:8px">${others.map((o) => `<label class="check small"><input type="checkbox" class="tm-dep" value="${o.id}" ${t?.dependsOn.includes(o.id) ? 'checked' : ''}> ${esc(o.title)} <span class="faint">(${esc(TSTATUS[o.status]?.[1] || o.status)})</span></label>`).join('')}</div></label>` : ''}
      <label class="field">Files it will likely touch <span class="hint">Optional, comma-separated. Used to warn about tasks that shouldn't run in parallel.</span><input id="tm-files" value="${esc((t?.files || []).join(', '))}" placeholder="src/editor/Track.ts, src/api/export.ts"></label>
      <div class="grid2">
        <label class="field">Run on<select id="tm-runner">${runnerOptions(t ? t.runner : me().id)}</select></label>
        <label class="check" style="align-self:end;padding-bottom:8px"><input type="checkbox" id="tm-auto" ${t ? (t.autoStart ? 'checked' : '') : 'checked'}> ⚡ Start automatically when ready</label>
      </div>
    </div>
    <div class="modal-foot">${t ? '' : '<span class="muted small spacer">Tip: describe a whole feature with ✨ Plan a feature to get a parallel task breakdown.</span>'}<button class="btn" data-act="modal-close">Cancel</button><button class="btn primary" data-act="task-save" data-id="${id || ''}">${t ? 'Save' : 'Create task'}</button></div>`);
}

function planModal() {
  modal(`${mhead('✨ Plan a feature')}
    <div class="modal-body">
      <div class="muted small">Describe what you want built. Claude reads the repository and proposes subtasks with dependencies — independent tasks run in parallel, dependent ones wait for the interfaces they need.</div>
      <textarea id="plan-text" rows="6" autofocus placeholder="e.g. Add a track editor: users can draw tracks on a canvas, save them, and export to JSON and SVG. Include tests."></textarea>
      <div id="plan-result"></div>
    </div>
    <div class="modal-foot"><button class="btn" data-act="modal-close">Cancel</button><button class="btn primary" id="plan-go" data-act="plan-go">Propose tasks</button></div>`, { wide: true });
}

let planDraft = null;
function renderPlan() {
  const el = $('#plan-result');
  if (!el || !planDraft) return;
  const p = planDraft;
  el.innerHTML = `<div class="col">
    ${p.summary ? `<div class="okbox">${esc(p.summary)}</div>` : ''}
    ${p.tasks.map((t, i) => `<div class="panel panel-body col" style="gap:6px">
      <div class="row"><label class="check"><input type="checkbox" class="pl-on" data-i="${i}" ${t.on !== false ? 'checked' : ''}></label><span class="pill nodot">#${i + 1}</span><input class="pl-title" data-i="${i}" value="${esc(t.title)}"><select class="pl-mode" data-i="${i}" style="width:150px"><option value="isolated" ${t.mode !== 'shared' ? 'selected' : ''}>🌿 isolated</option><option value="shared" ${t.mode === 'shared' ? 'selected' : ''}>📁 shared</option></select></div>
      <textarea class="pl-desc" data-i="${i}" rows="3">${esc(t.description || '')}</textarea>
      <div class="row wrap tiny muted">${(t.depends_on || []).length ? `Waits for: ${(t.depends_on || []).map((d) => `#${Number(d) + 1} ${esc(p.tasks[d]?.title || '')}`).join(', ')}` : '🟢 Can start immediately'}${t.contract ? ` · Contract: <b>${esc(t.contract)}</b>` : ''}${(t.files || []).length ? ` · ${t.files.slice(0, 4).map((f) => `<span class="chip">${esc(f)}</span>`).join(' ')}` : ''}</div>
    </div>`).join('')}
    ${p.risks?.length ? `<div class="warnbox">${p.risks.map(esc).join('<br>')}</div>` : ''}
    <label class="check"><input type="checkbox" id="plan-auto" checked> ⚡ Start agents automatically as tasks become ready</label>
  </div>`;
  const go = $('#plan-go');
  go.textContent = 'Create these tasks';
  go.dataset.act = 'plan-create';
  go.disabled = false;
}

function inviteModal(info) {
  modal(`${mhead('👥 Invite your team')}
    <div class="modal-body">
      ${info.hosted && !info.shared ? `<div class="banner"><div class="spacer"><b>Share this workspace on your network</b><div class="small muted">TeamCode will accept connections from teammates (protected by a secret token). Your OS may ask to allow network access.</div></div><button class="btn primary" data-act="invite-share">Share</button></div>` : ''}
      ${info.codes.map((c) => `<div class="col"><b class="small">${esc(c.label)}</b><div class="row"><input readonly value="${esc(c.code)}" class="mono"><button class="btn" data-act="copy" data-text="${esc(c.code)}">Copy</button></div></div>`).join('')}
      <div class="muted small">Teammates open TeamCode → <b>Join your team</b>, paste the code and choose a folder. Files sync both ways in real time and their Claude Code agents join the same coordination workspace.${info.hosted ? ' Keep TeamCode open on this computer while your team works — or run the standalone server (npm run server) on an always-on machine.' : ''}</div>
      ${info.hosted ? '<div class="muted small">Teammates outside your network? Set a Public server URL in Settings (port-forward or a tunnel such as cloudflared to port ' + esc(info.port) + ').</div>' : ''}
    </div>
    <div class="modal-foot"><button class="btn" data-act="modal-close">Done</button></div>`);
}

// ---------- actions ----------
const A = {};
A.view = (d) => { S.view = d.view; render(); };
A['save-name'] = async () => { const n = $('#w-name').value.trim(); if (!n) return; S.init.user = await api('app:setUser', { name: n }); render(); };
A['set-name'] = async () => { S.init.user = await run(() => api('app:setUser', { name: $('#set-name').value }), 'Saved') || S.init.user; render(); };
A['detect-claude'] = async () => { const r = await run(() => api('app:detectClaude')); if (r) { S.init.claude = r; S.init.settings.claudePath = r.path; toast(r.path ? `Found ${r.version || 'Claude Code'}` : 'Claude Code not found', r.path ? 'ok' : 'warn'); render(); } };
A['browse-claude'] = async () => { const r = await run(() => api('app:browseClaude')); if (r) { S.init.claude = r; render(); } };
A.login = async () => { await run(() => api('app:loginClaude')); S.needsLogin = false; toast('Finish signing in in the terminal window, then start your tasks.', 'info', 8000); render(); };

async function openProject(p) {
  if (!me().name) return toast('Enter your name first', 'warn');
  const r = await run(() => api(p.invite ? 'project:join' : 'project:open', p));
  if (!r) return;
  S.project = r;
  S.view = 'agents';
  S.review = { sel: null, tab: 'tasks', data: {}, busy: null };
  S.gitInfo = null;
  render();
}
A['open-folder'] = async () => { const root = await api('app:pickFolder', {}); if (root) openProject({ root }); };
A['open-recent'] = async (d) => {
  if (!me().name) return toast('Enter your name first', 'warn');
  const r = await run(() => api('project:reopen', { root: d.root, workspace: d.ws }));
  if (!r) return;
  S.project = r;
  S.view = 'agents';
  S.review = { sel: null, tab: 'tasks', data: {}, busy: null };
  S.gitInfo = null;
  render();
};
A['join-modal'] = () => modal(`${mhead('🤝 Join your team')}
  <div class="modal-body">
    <label class="field">Invite code<textarea id="join-code" rows="3" autofocus placeholder="tc1.…" class="mono"></textarea></label>
    <label class="field">Folder for the project files <span class="hint">An empty folder, or your existing clone of the repo (your local copies are backed up if they differ)</span><div class="row"><input id="join-folder" readonly placeholder="Choose a folder…"><button class="btn" data-act="join-pick">Browse…</button></div></label>
  </div>
  <div class="modal-foot"><button class="btn" data-act="modal-close">Cancel</button><button class="btn primary" data-act="join-go">Join</button></div>`);
A['join-pick'] = async () => { const f = await api('app:pickFolder', { title: 'Folder for the shared project' }); if (f) $('#join-folder').value = f; };
A['join-go'] = async (d, el) => {
  const invite = $('#join-code').value.trim(), root = $('#join-folder').value;
  if (!invite || !root) return toast('Paste the invite code and choose a folder', 'warn');
  el.disabled = true; el.innerHTML = '<span class="spinner"></span> Connecting…';
  if (!me().name) { el.disabled = false; el.textContent = 'Join'; return toast('Enter your name first', 'warn'); }
  const r = await run(() => api('project:join', { invite, root }));
  if (!r) { el.disabled = false; el.textContent = 'Join'; return; }
  closeModal(); S.project = r; S.view = 'agents'; render();
};
A['clone-modal'] = () => modal(`${mhead('⬇️ Clone from Git')}
  <div class="modal-body">
    <label class="field">Repository URL<input id="clone-url" autofocus placeholder="https://github.com/you/your-repo.git"></label>
    <label class="field">Clone into<div class="row"><input id="clone-parent" readonly placeholder="Choose a parent folder…"><button class="btn" data-act="clone-pick">Browse…</button></div></label>
  </div>
  <div class="modal-foot"><button class="btn" data-act="modal-close">Cancel</button><button class="btn primary" data-act="clone-go">Clone & open</button></div>`);
A['clone-pick'] = async () => { const f = await api('app:pickFolder', { title: 'Where to clone' }); if (f) $('#clone-parent').value = f; };
A['clone-go'] = async (d, el) => {
  const url = $('#clone-url').value.trim(), parent = $('#clone-parent').value;
  if (!url || !parent) return toast('Enter the URL and choose a folder', 'warn');
  el.disabled = true; el.innerHTML = '<span class="spinner"></span> Cloning…';
  const root = await run(() => api('project:clone', { url, parent }));
  if (!root) { el.disabled = false; el.textContent = 'Clone & open'; return; }
  closeModal(); openProject({ root });
};
A['close-project'] = async () => { await api('project:close'); S.project = null; S.state = null; S.events = []; S.drawer = null; S.init = await api('app:init'); render(); };

A.invite = async () => { const info = await run(() => api('project:invite', { share: false })); if (info) inviteModal(info); };
A['invite-share'] = async (d, el) => { el.disabled = true; el.innerHTML = '<span class="spinner"></span>'; const info = await run(() => api('project:invite', { share: true })); if (info) { S.project.shared = true; inviteModal(info); render(); } };
A.copy = async (d) => { await api('app:copy', { text: d.text }); toast('Copied to clipboard', 'ok'); };

A['task-modal'] = (d) => taskModal(d.id);
A['task-save'] = async (d) => {
  const body = {
    title: $('#tm-title').value.trim(), description: $('#tm-desc').value, mode: $('#tm-mode').value, priority: +$('#tm-prio').value,
    dependsOn: [...document.querySelectorAll('.tm-dep:checked')].map((x) => x.value),
    files: $('#tm-files').value.split(',').map((s) => s.trim()).filter(Boolean),
    runner: $('#tm-runner').value || null, autoStart: $('#tm-auto').checked,
  };
  body.runnerName = body.runner ? $('#tm-runner').selectedOptions[0].textContent.replace(' (this computer)', '') : null;
  if (!body.title) return toast('Give the task a title', 'warn');
  const r = await run(() => (d.id ? call('updateTask', { taskId: d.id, ...body }) : call('createTask', body)), d.id ? 'Task updated' : 'Task created');
  if (r) closeModal();
};
A['task-detail'] = (d, el, e) => { if (e.target.closest('button')) return; S.drawer = { kind: 'task', id: d.id }; renderDrawer(); };
A['task-start'] = async (d) => {
  const t = S.state.tasks[d.id];
  if (t.status === 'waiting' && !confirm('This task is still waiting on dependencies. Start it anyway?')) return;
  if (t.status === 'waiting') await run(() => call('updateTask', { taskId: d.id, dependsOn: [] }));
  const r = await run(() => api('agent:start', { taskId: d.id }));
  if (r) { toast(`${r.name} is on it`, 'ok'); S.drawer = { kind: 'agent', id: r.agentId }; S.logs[r.agentId] = await api('agent:log', { agentId: r.agentId }); render(); }
};
A['start-all-ready'] = async () => {
  for (const t of tasks().filter((x) => x.status === 'ready' && (!x.runner || x.runner === me().id))) await run(() => api('agent:start', { taskId: t.id }));
};
A['task-prio'] = (d) => { const t = S.state.tasks[d.id]; run(() => call('updateTask', { taskId: d.id, priority: Math.max(0, Math.min(3, t.priority + Number(d.d))) })); };
A['task-cancel'] = (d) => { if (confirm('Cancel this task?')) run(() => call('cancelTask', { taskId: d.id }), 'Task cancelled'); };
A['task-delete'] = (d) => { if (confirm('Delete this task permanently?')) { run(() => call('deleteTask', { taskId: d.id })); S.drawer = null; } };
A['task-reopen'] = (d) => run(() => call('reopenTask', { taskId: d.id }), 'Task reopened');
A['task-mode'] = (d) => { S.taskMode = d.mode; render(); };
A['toggle-closed'] = () => { S.showClosed = !S.showClosed; render(); };

A['plan-modal'] = () => { planDraft = null; planModal(); };
A['plan-go'] = async (d, el) => {
  const text = $('#plan-text').value.trim();
  if (!text) return toast('Describe the feature first', 'warn');
  el.disabled = true; el.innerHTML = '<span class="spinner"></span> Claude is reading the repo and planning…';
  const r = await run(() => api('agent:plan', { text }));
  if (!r) { el.disabled = false; el.textContent = 'Propose tasks'; return; }
  planDraft = r;
  renderPlan();
};
A['plan-create'] = async (d, el) => {
  const p = planDraft;
  document.querySelectorAll('.pl-title').forEach((x) => { p.tasks[x.dataset.i].title = x.value; });
  document.querySelectorAll('.pl-desc').forEach((x) => { p.tasks[x.dataset.i].description = x.value; });
  document.querySelectorAll('.pl-mode').forEach((x) => { p.tasks[x.dataset.i].mode = x.value; });
  document.querySelectorAll('.pl-on').forEach((x) => { p.tasks[x.dataset.i].on = x.checked; });
  const keep = p.tasks.map((t, i) => [t, i]).filter(([t]) => t.on !== false);
  const remap = Object.fromEntries(keep.map(([, i], j) => [i, j]));
  const auto = $('#plan-auto').checked;
  const list = keep.map(([t]) => ({
    title: t.title, description: t.description + (t.contract ? `\n\nInterface contract: "${t.contract}" (publish or consume it via the teamcode contract tools).` : ''),
    dependsOn: (t.depends_on || []).map((x) => remap[x]).filter((x) => x !== undefined), files: t.files || [], mode: t.mode === 'shared' ? 'shared' : 'isolated',
    runner: me().id, runnerName: me().name, autoStart: auto,
  }));
  el.disabled = true;
  const r = await run(() => call('createTasks', { tasks: list }), `${list.length} tasks created`);
  if (r) { closeModal(); S.view = 'tasks'; S.taskMode = 'waves'; render(); }
  else el.disabled = false;
};

A['agent-log'] = async (d) => { S.drawer = { kind: 'agent', id: d.id }; S.logs[d.id] = await api('agent:log', { agentId: d.id }); renderDrawer(); };
A['agent-detail'] = (d) => {
  const a = S.state.agents[d.id];
  if (a?.task) { S.drawer = { kind: 'task', id: a.task.id }; renderDrawer(); } else toast(`${a?.name} runs on another computer`, 'info');
};
A['agent-msg'] = (d) => A['agent-log'](d).then(() => $('#agent-msg-input')?.focus());
A['agent-stop'] = (d) => { if (confirm('Stop this agent? Its task returns to the queue.')) run(() => api('agent:stop', { agentId: d.id }), 'Stopping agent'); };
A['agent-send'] = async (d) => {
  const inp = $('#agent-msg-input');
  const text = inp.value.trim();
  if (!text) return;
  inp.value = '';
  await run(() => api('agent:message', { agentId: d.id, text }));
};
A['drawer-close'] = () => { S.drawer = null; renderDrawer(); };

A['act-filter'] = (d) => { S.activity.filter = d.f; render(); };
A['chat-send'] = async () => {
  const inp = $('#chat-input');
  const text = inp.value.trim();
  if (!text) return;
  inp.value = '';
  await run(() => call('chat', { text }));
};
A['load-delivery'] = async () => {
  const evs = await run(() => call('events', { since: 0, limit: 400 }));
  if (evs) { const map = Object.fromEntries(evs.map((e) => [e.seq, e.deliveredTo])); S.events = S.events.map((e) => ({ ...e, deliveredTo: map[e.seq] || e.deliveredTo })); render(); }
};

A['review-open'] = (d) => { S.view = 'review'; S.review.tab = 'tasks'; S.review.sel = d.id; S.drawer = null; loadDiff(d.id, true); render(); };
A['rv-tab'] = (d) => { S.review.tab = d.tab; render(); };
A['rv-select'] = (d) => { S.review.sel = d.id; render(); };
A['rv-refresh'] = (d) => loadDiff(d.id, true);
async function reviewBusy(kind, fn) { S.review.busy = kind; render(); try { return await fn(); } finally { S.review.busy = null; render(); } }
A['rv-test'] = (d) => reviewBusy('test', () => run(() => api('review:test', { taskId: d.id })).then((r) => r && toast(r.passed ? 'Tests passed' : 'Tests failed', r.passed ? 'ok' : 'error')));
A['rv-check'] = (d) => reviewBusy('check', () => run(() => api('review:check', { taskId: d.id })).then((r) => r && toast(r.state === 'clean' ? `Merges cleanly${r.risks.length ? ` · ${r.risks.length} risk(s) to look at` : ''}` : `${r.conflicts.length} conflict(s) with main`, r.state === 'clean' ? 'ok' : 'warn')));
A['rv-approve'] = (d) => reviewBusy('approve', async () => {
  let r = await run(() => api('review:approve', { taskId: d.id }));
  if (r?.needsCheckpoint) {
    if (!confirm(`The shared working copy has uncommitted changes in files this branch also changes:\n\n${r.files.join('\n')}\n\nCommit the working copy as a checkpoint first, then merge?`)) return;
    r = await run(() => api('review:approve', { taskId: d.id, checkpoint: true }));
  }
  if (!r) return;
  if (r.ok) { toast('Approved and integrated ✓', 'ok'); loadDiff(d.id, true); } else if (r.conflicts) toast(`Merge has conflicts in ${r.conflicts.length} file(s) — nothing was changed. Ask the agent to resolve them.`, 'warn', 8000);
});
A['rv-reject'] = async (d) => {
  const t = S.state.tasks[d.id];
  modal(`${mhead('Reject changes')}<div class="modal-body"><label class="field">What should change? <span class="hint">Shared with the team; you can send it to the agent as a follow-up</span><textarea id="rj-note" autofocus rows="3"></textarea></label>
    <label class="check"><input type="checkbox" id="rj-discard"> ${t.mode === 'isolated' ? 'Discard the branch and worktree' : 'Revert this task\'s file changes (skips files others changed since)'}</label></div>
    <div class="modal-foot"><button class="btn" data-act="modal-close">Cancel</button><button class="btn danger" data-act="rv-reject-go" data-id="${d.id}">Reject</button></div>`);
};
A['rv-reject-go'] = async (d) => {
  const note = $('#rj-note').value, discard = $('#rj-discard').checked;
  const r = await run(() => api('review:reject', { taskId: d.id, note, discard }), 'Changes rejected');
  if (r) { closeModal(); if (r.skipped?.length) toast(`Kept ${r.skipped.length} file(s) that others changed since`, 'warn', 8000); loadDiff(d.id, true); }
};
A['rv-revert'] = async (d) => {
  if (!confirm('Revert this task\'s changes? A revert is recorded; nothing is deleted from history.')) return;
  const r = await run(() => api('review:revert', { taskId: d.id }), 'Changes reverted');
  if (r?.skipped?.length) toast(`Skipped ${r.skipped.length} file(s) changed by others since: ${r.skipped.map((s) => s.path).join(', ')}`, 'warn', 9000);
};
A['rv-agent-fix'] = (d) => run(() => api('agent:resolveConflicts', { taskId: d.id }), 'Agent is resolving the conflicts');

A['ctx-tab'] = (d) => { S.ctxTab = d.tab; render(); };
A['contract-modal'] = (d) => {
  const c = d.name ? S.state.contracts[d.name] : null;
  modal(`${mhead(c ? `Update contract “${esc(c.name)}”` : 'Publish an interface contract')}<div class="modal-body">
    <label class="field">Name<input id="ct-name" ${c ? 'readonly' : 'autofocus'} value="${esc(c?.name || '')}" placeholder="track-export API"></label>
    <label class="field">Summary<input id="ct-desc" value="${esc(c?.description || '')}"></label>
    <label class="field">Interface <span class="hint">Types, signatures, endpoints, schema — what dependent tasks build against</span><textarea id="ct-content" rows="12" class="mono" ${c ? 'autofocus' : ''}>${esc(c?.content || '')}</textarea></label></div>
    <div class="modal-foot"><button class="btn" data-act="modal-close">Cancel</button><button class="btn primary" data-act="contract-save">Publish</button></div>`, { wide: true });
};
A['contract-save'] = async () => {
  const r = await run(() => call('publishContract', { name: $('#ct-name').value.trim(), description: $('#ct-desc').value, content: $('#ct-content').value }), 'Contract published — dependent agents are notified');
  if (r) closeModal();
};
A['decision-modal'] = () => modal(`${mhead('Record a decision')}<div class="modal-body">
  <label class="field">Title<input id="dc-title" autofocus placeholder="State management"></label>
  <label class="field">Decision<textarea id="dc-dec" rows="3" placeholder="Use a single Zustand store per feature; no Redux."></textarea></label>
  <label class="field">Why<textarea id="dc-why" rows="2"></textarea></label></div>
  <div class="modal-foot"><button class="btn" data-act="modal-close">Cancel</button><button class="btn primary" data-act="decision-save">Record</button></div>`);
A['decision-save'] = async () => {
  const r = await run(() => call('recordDecision', { title: $('#dc-title').value.trim(), decision: $('#dc-dec').value.trim(), rationale: $('#dc-why').value }), 'Decision recorded — all agents will follow it');
  if (r) closeModal();
};
A['blocker-resolve'] = (d) => { const resolution = prompt('How was it resolved?') ?? null; if (resolution !== null) run(() => call('resolveBlocker', { blockerId: d.id, resolution }), 'Blocker resolved'); };
A['conflict-ack'] = (d) => run(() => call('resolveConflictRecord', { conflictId: d.id, resolution: 'acknowledged' }));
A['conflict-resolve'] = async (d) => {
  const c = await run(() => call('conflictData', { conflictId: d.id }));
  if (!c) return;
  const dec = (b) => (b ? new TextDecoder().decode(Uint8Array.from(atob(b), (x) => x.charCodeAt(0))) : '');
  const cur = dec(c.currentB64), inc = dec(c.incomingB64);
  const hunks = TCDiff.lineDiff(cur, inc);
  modal(`${mhead(`Resolve edit conflict — ${esc(c.path)}`)}<div class="modal-body">
    <div class="small">${esc(c.message)}</div>
    <div class="small muted">Diff from the saved version (v${c.currentVersion} by ${esc(c.currentBy)}) to the conflicting edit by ${esc(c.incomingBy?.name)}:</div>
    ${diffFile(c.path, hunks, '', false)}
    <label class="field">Or write the merged result<textarea id="cf-merged" rows="10" class="mono">${esc(`<<<<<<< ${c.currentBy} (saved)\n${cur}\n=======\n${inc}\n>>>>>>> ${c.incomingBy?.name}\n`)}</textarea></label></div>
    <div class="modal-foot"><button class="btn" data-act="cf-go" data-id="${c.id}" data-r="current">Keep saved version</button><button class="btn" data-act="cf-go" data-id="${c.id}" data-r="incoming">Use ${esc(c.incomingBy?.name)}'s version</button><button class="btn primary" data-act="cf-go" data-id="${c.id}" data-r="content">Save merged result</button></div>`, { wide: true });
};
A['cf-go'] = async (d) => {
  const args = { conflictId: d.id, resolution: d.r };
  if (d.r === 'content') {
    const text = $('#cf-merged').value;
    if (/^(<<<<<<<|=======|>>>>>>>)/m.test(text) && !confirm('The merged text still contains conflict markers. Save anyway?')) return;
    args.contentB64 = btoa(String.fromCharCode(...new TextEncoder().encode(text)));
  }
  const r = await run(() => call('resolveConflict', args), 'Conflict resolved');
  if (r) closeModal();
};
A['file-history'] = async (d) => {
  const h = await run(() => call('fileHistory', { path: d.path }));
  if (!h) return;
  modal(`${mhead(`History — ${esc(d.path)}`)}<div class="modal-body"><table class="t"><tr><th>Version</th><th>By</th><th>When</th><th></th></tr>${h.map((v, i) => `<tr><td>v${v.version}${v.deleted ? ' (deleted)' : ''}</td><td>${esc(v.by?.name)}</td><td class="faint">${new Date(v.at).toLocaleString()}</td><td>${i ? `<button class="btn sm" data-act="file-restore" data-path="${esc(d.path)}" data-v="${v.version}">Restore</button>` : '<span class="pill green nodot">current</span>'}</td></tr>`).join('')}</table></div>`);
};
A['file-restore'] = async (d) => { if (confirm(`Restore ${d.path} to v${d.v} for the whole team?`)) { const r = await run(() => call('fileRevert', { path: d.path, version: Number(d.v) }), 'Restored'); if (r) closeModal(); } };

A['save-settings'] = async () => {
  const s = await run(() => api('app:saveSettings', { permissionMode: $('#set-perm').value, model: $('#set-model').value.trim(), maxParallel: Number($('#set-max').value), autoRun: $('#set-auto').checked }), 'Settings saved');
  if (s) { S.init.settings = s; render(); }
};
A['save-test'] = () => run(() => call('updateSettings', { settings: { testCommand: $('#set-test').value.trim() } }), 'Test command saved for the team');
A['save-public'] = async () => { const s = await run(() => api('app:saveSettings', { publicUrl: $('#set-public').value.trim() }), 'Saved'); if (s) S.init.settings = s; };
A['external-agent'] = async () => {
  const c = await run(() => api('project:externalAgentConfig'));
  if (!c) return;
  modal(`${mhead('Connect another AI agent')}<div class="modal-body">
    <div class="small">1. Add the TeamCode MCP server to the agent's MCP config (for Claude Code: <code>.mcp.json</code> in the project, or <code>claude mcp add-json teamcode '…'</code>):</div>
    <pre class="out">${esc(c.mcp)}</pre><div><button class="btn sm" data-act="copy" data-text="${esc(c.mcp)}">Copy MCP config</button></div>
    <div class="small">2. For Claude Code, also add these hooks to <code>.claude/settings.local.json</code> so edits are version-checked and team updates are delivered automatically:</div>
    <pre class="out">${esc(c.hooks)}</pre><div><button class="btn sm" data-act="copy" data-text="${esc(c.hooks)}">Copy hooks</button></div>
    <div class="small muted">Agents without hooks can still coordinate with the record_file_read / record_file_change and get_updates tools.</div></div>`, { wide: true });
};
A['init-git'] = async () => { const g = await run(() => api('project:initGit'), 'Git repository initialized'); if (g) { S.gitInfo = g; render(); } };
A.checkpoint = async () => { const r = await run(() => api('project:checkpoint')); toast(r ? `Committed ${String(r).slice(0, 8)}` : 'Nothing to commit', 'ok'); S.gitInfo = null; render(); };

A['modal-close'] = closeModal;
A['modal-bg'] = (d, el, e) => { if (e.target === el) closeModal(); };

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const fn = A[el.dataset.act];
  if (fn && !(el.tagName === 'INPUT' && el.type === 'checkbox' && el.dataset.act !== 'toggle-closed')) fn(el.dataset, el, e);
});
document.addEventListener('input', (e) => {
  if (e.target.id === 'act-q') { S.activity.q = e.target.value; render(); }
});
document.addEventListener('keydown', (e) => {
  const mod = isMac ? e.metaKey : e.ctrlKey;
  if (e.key === 'Escape') { if ($('#modal-root').innerHTML) closeModal(); else if (S.drawer) { S.drawer = null; renderDrawer(); } }
  if (e.key === 'Enter' && !e.shiftKey) {
    if (e.target.id === 'chat-input') { e.preventDefault(); A['chat-send'](); }
    if (e.target.id === 'agent-msg-input') { e.preventDefault(); A['agent-send']({ id: S.drawer.id }); }
    if (e.target.id === 'w-name') A['save-name']();
  }
  if (!S.project || !mod) return;
  if (e.key.toLowerCase() === 'n') { e.preventDefault(); taskModal(); }
  if (e.key.toLowerCase() === 'p') { e.preventDefault(); A['plan-modal'](); }
  const i = Number(e.key);
  if (i >= 1 && i <= VIEWS.length) { e.preventDefault(); S.view = VIEWS[i - 1][0]; render(); }
});

// ---------- live updates from main ----------
window.tc.on('tc:snapshot', (s) => { S.state = s; render(); });
window.tc.on('tc:events', (evs) => { S.events = evs; render(); });
window.tc.on('tc:event', (e) => {
  S.events.push(e);
  if (S.events.length > 1000) S.events.splice(0, S.events.length - 1000);
  if (['changes.merged', 'changes.reverted', 'changes.review_requested'].includes(e.type) && e.task) delete S.review.data[e.task];
  render();
});
window.tc.on('tc:status', (s) => { S.status = s.status; render(); });
window.tc.on('tc:presence', (p) => { S.presence = p; render(); });
window.tc.on('tc:sync', (s) => { S.sync = s; render(); });
window.tc.on('tc:runtime', (r) => { S.runtime = r; render(); });
window.tc.on('tc:toast', (t) => toast(t.text, t.kind));
window.tc.on('tc:needsLogin', () => { S.needsLogin = true; render(); });
window.tc.on('tc:agentLog', ({ agentId, entry }) => {
  (S.logs[agentId] ||= []).push(entry);
  if (S.drawer?.kind === 'agent' && S.drawer.id === agentId) renderDrawer();
});

// Refresh relative timestamps.
setInterval(() => { if (S.project && !$('#modal-root').innerHTML) render(); }, 30000);

(async () => {
  S.init = await api('app:init');
  if (S.init.current) {
    S.project = S.init.current;
    const st = await api('ws:state');
    Object.assign(S, { state: st.state, events: st.events, presence: st.presence, runtime: st.runtime, status: st.status, sync: st.sync });
  }
  render();
})();
