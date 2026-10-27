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

// Identifies this process when it is an agent of its own (an MCP client that isn't Claude Code).
const PROCESS_KEY = crypto.randomBytes(8).toString('hex');

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
  // Each Claude Code session joins as an agent of its own, so two sessions in one folder never share a task or
  // each other's edits. Its id comes from the session id Claude Code gives both its MCP server and its hooks
  // (after /clear the hooks find the MCP server's id instead; see processIdentity). An MCP client that isn't
  // Claude Code has no hooks, so each of its processes is an agent. Claude Code too old to give a session id: one
  // agent per folder, as before. Agents TeamCode launched keep their own id.
  const eligible = !insideAgent && !env.TEAMCODE_TASK_ID && (!!file || !env.TEAMCODE_AGENT_ID);
  const sid = eligible && /^[A-Za-z0-9-]{8,100}$/.test(String(env.CLAUDE_CODE_SESSION_ID || '')) ? String(env.CLAUDE_CODE_SESSION_ID) : '';
  const perSession = !!sid || (eligible && !env.CLAUDECODE);
  const baseAgentId = agentId;
  if (perSession) {
    const key = sid || PROCESS_KEY;
    agentId = `${agentId}_${crypto.createHash('sha1').update(key).digest('hex').slice(0, 10)}`;
    name = `${name} (${key.slice(0, 4)})`;
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

// /clear and an in-app /resume give a Claude Code process a new session id but keep its MCP server running. So
// the MCP server records the agent it runs as under its parent's pid (the Claude Code process), and hooks, which
// get that pid as CLAUDE_PID, use it. A file left by an earlier process with the same pid is ignored unless the
// hook's session is one the file knows, or the hook marks the switch (SessionStart after clear/resume).
function processFile(cfg, pid) {
  return cfg.sessionsDir && /^\d+$/.test(String(pid || '')) ? path.join(cfg.sessionsDir, `${pid}.json`) : null;
}

function recordProcessIdentity(cfg, pid) {
  const f = processFile(cfg, pid);
  if (!f || !cfg.sid) return null;
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
    fs.writeFileSync(f, JSON.stringify({ agentId: cfg.agentId, name: cfg.name, sids: [cfg.sid], mcp: process.pid }), { mode: 0o600 });
    return f;
  } catch { return null; }
}

function processIdentity(cfg, env, input = {}) {
  const f = processFile(cfg, env.CLAUDE_PID);
  if (!f || !cfg.sid) return cfg;
  let m;
  try { m = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return cfg; }
  if (typeof m?.agentId !== 'string' || !m.agentId.startsWith(`${cfg.baseAgentId}_`) || !Array.isArray(m.sids)) return cfg;
  if (!m.sids.includes(cfg.sid)) {
    const switched = input.hook_event_name === 'SessionStart' && ['clear', 'resume', 'compact'].includes(input.source);
    if (!switched) return cfg;
    m.sids = [...m.sids, cfg.sid].slice(-20);
    try { fs.writeFileSync(f, JSON.stringify(m), { mode: 0o600 }); } catch { /* still use it for this call */ }
  }
  cfg.agentId = m.agentId;
  if (typeof m.name === 'string') cfg.name = m.name;
  return cfg;
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

module.exports = { loadConfig, post, agentCall, register, relPath, fileHash, recordProcessIdentity, processIdentity };
