'use strict';
// Shared helpers for agent-side processes (MCP server and Claude Code hooks).
// Configuration comes from environment variables so any MCP client can be pointed at a workspace:
//   TEAMCODE_INVITE (or TEAMCODE_URL + TEAMCODE_WORKSPACE + TEAMCODE_TOKEN), TEAMCODE_AGENT_ID, TEAMCODE_AGENT_NAME,
//   TEAMCODE_ROOT, TEAMCODE_BRANCH, TEAMCODE_TASK_ID, TEAMCODE_CLIENT, TEAMCODE_USER_ID, TEAMCODE_USER_NAME, TEAMCODE_MODE
// or from `--config <file>`: a JSON file of those same keys that the TeamCode app writes and keeps current
// (used by "Add to Claude Code", so the workspace token never sits in Claude Code's own settings).
const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { decodeInvite } = require('../../server/invite');

// True when this process runs inside an agent the TeamCode app launched (it sets these on the agent).
const isAgentEnv = (env) => !!(env.TEAMCODE_AGENT_ID && env.TEAMCODE_URL && env.TEAMCODE_WORKSPACE && env.TEAMCODE_TOKEN);

function loadConfig(env = process.env, argv = process.argv) {
  const i = argv.indexOf('--config');
  const file = i >= 0 ? argv[i + 1] : null;
  // A personal "Add to Claude Code" entry can also load inside an agent TeamCode launched. That agent's own
  // identity wins, so it never shows up twice.
  const insideAgent = !!file && isAgentEnv(env);
  if (file && !insideAgent) {
    let fromFile;
    try { fromFile = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new Error(`Can't read the TeamCode connection file ${file} (${e.code || e.message}). Open the project in the TeamCode app, then try again.`); }
    env = { ...env, ...fromFile };
  }
  let base = {};
  if (env.TEAMCODE_INVITE) base = decodeInvite(env.TEAMCODE_INVITE);
  const url = (env.TEAMCODE_URL || base.url || '').replace(/\/+$/, '');
  const workspace = env.TEAMCODE_WORKSPACE || base.workspace;
  const token = env.TEAMCODE_TOKEN || base.token;
  if (!url || !workspace || !token) throw new Error('TeamCode is not configured: set TEAMCODE_INVITE (or TEAMCODE_URL, TEAMCODE_WORKSPACE and TEAMCODE_TOKEN).');
  const root = path.resolve(env.TEAMCODE_ROOT || process.cwd());
  let name = env.TEAMCODE_AGENT_NAME || `${os.userInfo().username}'s ${env.TEAMCODE_CLIENT || 'AI agent'}`;
  // External agents get a stable id derived from workspace + name + folder, so reconnecting resumes their event cursor.
  let agentId = env.TEAMCODE_AGENT_ID || 'agt_ext_' + crypto.createHash('sha1').update(`${workspace}|${name}|${root.toLowerCase()}`).digest('hex').slice(0, 12);
  // Each Claude Code process joins as an agent of its own, so two windows in one folder never share a task or
  // each other's edits. Its id comes from the session id Claude Code gives both its MCP server and its hooks
  // (kept across /clear and /resume; see hookIdentity). Claude Code too old to give a session id keeps one agent
  // per folder. Agents TeamCode launched keep their own id.
  const eligible = !insideAgent && !env.TEAMCODE_TASK_ID && (!!file || !env.TEAMCODE_AGENT_ID);
  const sid = eligible && /^[A-Za-z0-9-]{8,100}$/.test(String(env.CLAUDE_CODE_SESSION_ID || '')) ? String(env.CLAUDE_CODE_SESSION_ID) : '';
  // Another MCP client (no CLAUDECODE): one agent per client process, so two of its windows stay apart and a
  // restart of the server by the same client keeps its agent.
  const key = sid || (eligible && !env.CLAUDECODE ? `client:${process.ppid}` : '');
  const perSession = !!key;
  const baseAgentId = agentId;
  if (perSession) {
    const h = crypto.createHash('sha1').update(key).digest('hex');
    agentId = `${agentId}_${h.slice(0, 10)}`;
    name = `${name} (${(sid || h).slice(0, 4)})`;
  }
  return {
    url, workspace, token, root, name, agentId, perSession, baseAgentId, sid,
    sessionsDir: file ? path.join(path.dirname(file), 'sessions') : null,
    branch: env.TEAMCODE_BRANCH || 'main', taskId: env.TEAMCODE_TASK_ID || null,
    client: env.TEAMCODE_CLIENT || 'Claude Code', userId: env.TEAMCODE_USER_ID || null, userName: env.TEAMCODE_USER_NAME || null,
    mode: env.TEAMCODE_MODE || 'shared', external: !!file && !insideAgent, insideAgent,
  };
}

function post(cfg, op, args, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const u = new URL(`${cfg.url}/api/${cfg.workspace}/${op}`);
    const body = Buffer.from(JSON.stringify(args || {}));
    const req = (u.protocol === 'https:' ? https : http).request(u, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': body.length, authorization: `Bearer ${cfg.token}` },
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          const j = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (j.ok) resolve(j.result);
          else { const e = new Error(j.error); e.code = j.code; reject(e); }
        } catch (e) { reject(new Error(`Bad response from TeamCode server (${res.statusCode})`)); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('TeamCode server timed out')));
    req.on('error', reject);
    req.end(body);
  });
}

// Calls an agent operation, registering the agent first if the server doesn't know it yet.
async function agentCall(cfg, op, args = {}, timeoutMs) {
  try {
    return await post(cfg, op, { agentId: cfg.agentId, ...args }, timeoutMs);
  } catch (e) {
    if (e.code !== 'unknown_agent') throw e;
    await register(cfg);
    return post(cfg, op, { agentId: cfg.agentId, ...args }, timeoutMs);
  }
}

function register(cfg) {
  return post(cfg, 'registerAgent', {
    agentId: cfg.agentId, name: cfg.name, client: cfg.client, taskId: cfg.taskId, userId: cfg.userId,
    mode: cfg.mode, branch: cfg.branch, cwd: cfg.root, ...(cfg.perSession ? { perSession: true, baseId: cfg.baseAgentId } : {}),
  });
}

// Which agent a Claude Code process runs as. One record per Claude Code process, named by its pid, lists every
// session id that process has had (a new one with each /clear or in-app /resume, while its MCP server keeps
// running). Hooks get the pid as CLAUDE_PID and create the record on the process's first hook; the MCP server
// finds it among its ancestor processes (there may be a node shim in between). A process started with
// claude --resume or --continue has its own pid, so it never takes over another window's agent.
const procFile = (cfg, pid) => (cfg.sessionsDir && /^\d+$/.test(String(pid || '')) ? path.join(cfg.sessionsDir, `proc-${pid}.json`) : null);

function readProc(cfg, pid) {
  const f = procFile(cfg, pid);
  if (!f) return null;
  try {
    const r = JSON.parse(fs.readFileSync(f, 'utf8'));
    return typeof r?.agentId === 'string' && r.agentId.startsWith(`${cfg.baseAgentId}_`) && Array.isArray(r.sids) ? r : null;
  } catch { return null; }
}

function writeProc(cfg, pid, r) {
  const f = procFile(cfg, pid);
  if (!f) return;
  try {
    fs.mkdirSync(cfg.sessionsDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(f, JSON.stringify(r), { mode: 0o600 }); // also keeps a live record from looking abandoned
  } catch { /* identity still holds for this call */ }
}

const alive = (pid) => { try { process.kill(Number(pid), 0); return true; } catch (e) { return e.code === 'EPERM'; } };

// Hooks. switching: this is SessionStart after /clear or /resume. Returns whether the conversation changed
// inside the same Claude Code (the caller then lets go of the previous conversation's task).
function hookIdentity(cfg, pid, switching) {
  if (!cfg.perSession || !cfg.sid || !procFile(cfg, pid)) return false;
  let r = readProc(cfg, pid), switched = false;
  if (r && !r.sids.includes(cfg.sid)) {
    if (switching && r.ending && Date.now() - r.ending < 120000) { r.sids = [...r.sids, cfg.sid].slice(-20); switched = true; }
    else r = null; // left by an earlier process that had this pid
  }
  if (!r) {
    // Normally the id the MCP server derives from the same session id. If another live window already is that
    // agent (this process resumed its conversation), this one gets an id of its own.
    let agentId = cfg.agentId;
    const taken = fs.existsSync(cfg.sessionsDir) && fs.readdirSync(cfg.sessionsDir).some((n) => {
      const m = /^proc-(\d+)\.json$/.exec(n);
      return m && m[1] !== String(pid) && readProc(cfg, m[1])?.agentId === agentId && alive(m[1]);
    });
    if (taken) agentId = `${cfg.baseAgentId}_${crypto.createHash('sha1').update(`${cfg.sid}:${pid}`).digest('hex').slice(0, 10)}`;
    r = { pid: Number(pid), agentId, name: cfg.name, sids: [cfg.sid] };
  }
  delete r.ending;
  writeProc(cfg, pid, r);
  cfg.agentId = r.agentId;
  if (typeof r.name === 'string') cfg.name = r.name;
  return switched;
}

// SessionEnd for /clear or /resume: the same Claude Code goes on with another conversation.
function markSwitching(cfg, pid) {
  const r = readProc(cfg, pid);
  if (r) { r.ending = Date.now(); writeProc(cfg, pid, r); }
}

function forgetProc(cfg, pid) {
  const f = procFile(cfg, pid);
  if (f) try { fs.rmSync(f, { force: true }); } catch { /* gone */ }
}

// The MCP server's ancestors, nearest first (Claude Code is normally the parent; a node shim may sit between).
let ancestorCache = null;
function ancestors() {
  if (ancestorCache) return ancestorCache;
  const chain = [process.ppid];
  if (process.platform !== 'win32') {
    try {
      const { execFileSync } = require('child_process');
      const parent = new Map(execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8', timeout: 3000 }).trim().split('\n')
        .map((l) => l.trim().split(/\s+/).map(Number)).filter((x) => x.length === 2));
      for (let i = 0; i < 4; i++) { const up = parent.get(chain[chain.length - 1]); if (!up || up <= 1) break; chain.push(up); }
    } catch { /* ps unavailable: parent only */ }
  }
  return (ancestorCache = chain);
}

// The MCP server: the record of the Claude Code process it belongs to, if its hooks have written one.
function mcpIdentity(cfg) {
  if (!cfg.perSession || !cfg.sid || !cfg.sessionsDir) return null;
  for (const pid of ancestors()) {
    const r = readProc(cfg, pid);
    if (r && r.sids.includes(cfg.sid)) {
      try { const now = new Date(); fs.utimesSync(procFile(cfg, pid), now, now); } catch { /* best effort */ }
      return { agentId: r.agentId, name: r.name };
    }
  }
  return null;
}

// Records of Claude Code processes that are gone (crashed without SessionEnd) are cleared after a week.
function pruneProcs(cfg) {
  if (!cfg.sessionsDir) return;
  try {
    for (const n of fs.readdirSync(cfg.sessionsDir)) {
      const f = path.join(cfg.sessionsDir, n);
      const m = /^proc-(\d+)\.json$/.exec(n);
      if (Date.now() - fs.statSync(f).mtimeMs > 7 * 24 * 3600 * 1000 && !(m && alive(m[1]))) fs.rmSync(f, { force: true });
    }
  } catch { /* no folder yet */ }
}

// Resolves symlinks in the longest existing prefix of `p`, so a file that doesn't exist yet still matches.
function realish(p) {
  let head = p, tail = '';
  for (;;) {
    try { return path.join(fs.realpathSync.native(head), tail); } catch { /* keep walking up */ }
    const up = path.dirname(head);
    if (up === head) return p;
    tail = path.join(path.basename(head), tail);
    head = up;
  }
}

function relPath(cfg, file) {
  if (!file) return null;
  const abs = path.resolve(cfg.root, file);
  let r = path.relative(cfg.root, abs);
  // The project root and the file may be spelled through different symlinks (macOS /var -> /private/var).
  if (!r || r.startsWith('..') || path.isAbsolute(r)) r = path.relative(realish(cfg.root), realish(abs));
  if (!r || r.startsWith('..') || path.isAbsolute(r)) return null;
  return r.split(path.sep).join('/');
}

function fileHash(cfg, rel) {
  try {
    const buf = fs.readFileSync(path.join(cfg.root, rel));
    return crypto.createHash('sha256').update(buf).digest('hex');
  } catch { return null; }
}

module.exports = { loadConfig, post, agentCall, register, relPath, fileHash, hookIdentity, markSwitching, forgetProc, mcpIdentity, pruneProcs };
