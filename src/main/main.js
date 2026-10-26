'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, Notification, nativeTheme } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { TeamServer } = require('../../server/server');
const { encodeInvite, decodeInvite } = require('../../server/invite');
const { ProjectSession } = require('./session');
const { findClaude, claudeVersion, loginScript, findNode } = require('./claude-cli');
const git = require('./git');

const DEFAULT_PORT = 4477;
if (process.env.TEAMCODE_USERDATA) app.setPath('userData', process.env.TEAMCODE_USERDATA);
const userData = app.getPath('userData');
const configFile = path.join(userData, 'config.json');
// Agent-side scripts are run by an external node/Electron process, so they must live outside app.asar.
const unpacked = (p) => p.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
const scripts = { hook: unpacked(path.join(__dirname, '..', 'agent', 'hook.js')), mcp: unpacked(path.join(__dirname, '..', 'agent', 'mcp-server.js')) };

let win = null;
let session = null;
let teamServer = null;
let serverPort = null;
let serverHost = null;

// ---------- config ----------
const defaults = () => ({
  user: { id: 'usr_' + crypto.randomBytes(6).toString('hex'), name: '' },
  settings: { claudePath: '', permissionMode: 'acceptEdits', model: '', maxParallel: 3, autoRun: true, testCommand: '', publicUrl: '', port: DEFAULT_PORT },
  projects: [],
});
let config = defaults();
try { const saved = JSON.parse(fs.readFileSync(configFile, 'utf8')); config = { ...config, ...saved, settings: { ...config.settings, ...saved.settings } }; } catch { /* first run */ }
const saveConfig = () => { fs.mkdirSync(userData, { recursive: true }); fs.writeFileSync(configFile, JSON.stringify(config, null, 1)); };
const getSettings = () => config.settings;

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function notify(title, body) {
  if (win && win.isFocused()) return;
  if (Notification.isSupported()) new Notification({ title: `TeamCode — ${title}`, body: String(body || '').slice(0, 200) }).show();
}

// ---------- embedded team server ----------
async function ensureServer(host) {
  if (teamServer && (serverHost === host || serverHost === '0.0.0.0')) return serverPort;
  if (teamServer) await teamServer.close();
  teamServer = new TeamServer({ dataDir: path.join(userData, 'server') });
  try {
    serverPort = await teamServer.listen(config.settings.port || DEFAULT_PORT, host);
  } catch (e) {
    if (e.code !== 'EADDRINUSE') throw e;
    teamServer = new TeamServer({ dataDir: path.join(userData, 'server') });
    serverPort = await teamServer.listen(0, host);
  }
  serverHost = host;
  return serverPort;
}

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  const priv = (ip) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
  return out.sort((a, b) => Number(priv(b)) - Number(priv(a)));
}

function ping(url) {
  return new Promise((resolve) => {
    const req = (url.startsWith('https') ? https : http).get(`${url}/health`, { timeout: 5000 }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => { try { resolve(JSON.parse(d).app === 'teamcode'); } catch { resolve(false); } });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
  });
}

// ---------- projects ----------
function projectView(p) {
  return p && { root: p.root, name: p.name, role: p.role, workspace: p.workspace, url: p.url, lastOpened: p.lastOpened, shared: !!p.shared };
}

async function openSession(project) {
  if (session) { await session.stop(); session = null; }
  if (project.role === 'host') {
    await ensureServer(project.shared ? '0.0.0.0' : '127.0.0.1');
    teamServer.coordinator.ensureWorkspace(project.workspace, { name: project.name, token: project.token });
    project.url = `http://127.0.0.1:${serverPort}`;
  }
  project.lastOpened = Date.now();
  config.projects = [project, ...config.projects.filter((p) => !(p.root === project.root && p.workspace === project.workspace))].slice(0, 20);
  saveConfig();
  session = new ProjectSession({ project, user: config.user, getSettings, send, dataDir: userData, scripts, notify });
  await session.start();
  win?.setTitle(`${project.name} — TeamCode`);
  return projectView(project);
}

function requireSession() {
  if (!session) throw new Error('No project is open');
  return session;
}

// ---------- IPC ----------
const handlers = {
  'app:init': async () => {
    if (!config.settings.claudePath || !fs.existsSync(config.settings.claudePath)) {
      config.settings.claudePath = findClaude(null) || '';
      saveConfig();
    }
    return {
      user: config.user, settings: config.settings, platform: process.platform, version: app.getVersion(),
      projects: config.projects.filter((p) => fs.existsSync(p.root)).map(projectView),
      claude: { path: config.settings.claudePath, version: config.settings.claudePath ? await claudeVersion(config.settings.claudePath) : null },
      nodeFound: !!findNode(),
      current: session ? projectView(session.project) : null,
    };
  },
  'app:setUser': ({ name }) => { config.user.name = String(name || '').trim().slice(0, 40) || 'Developer'; saveConfig(); return config.user; },
  'app:saveSettings': (s) => {
    const allowed = ['claudePath', 'permissionMode', 'model', 'maxParallel', 'autoRun', 'testCommand', 'publicUrl'];
    for (const k of allowed) if (k in s) config.settings[k] = s[k];
    config.settings.maxParallel = Math.max(1, Math.min(10, Number(config.settings.maxParallel) || 3));
    saveConfig();
    if (session && 'autoRun' in s) session._autoRun();
    return config.settings;
  },
  'app:detectClaude': async () => {
    const p = findClaude(null);
    if (p) { config.settings.claudePath = p; saveConfig(); }
    return { path: p, version: p ? await claudeVersion(p) : null };
  },
  'app:browseClaude': async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Locate the Claude Code CLI', properties: ['openFile'] });
    if (r.canceled) return null;
    config.settings.claudePath = r.filePaths[0];
    saveConfig();
    return { path: r.filePaths[0], version: await claudeVersion(r.filePaths[0]) };
  },
  'app:loginClaude': async () => {
    if (!config.settings.claudePath) throw new Error('Claude Code was not found');
    const f = loginScript(config.settings.claudePath, path.join(userData, 'scripts'));
    const err = await shell.openPath(f);
    if (err) throw new Error(err);
    return true;
  },
  'app:pickFolder': async ({ title } = {}) => {
    const r = await dialog.showOpenDialog(win, { title: title || 'Choose a project folder', properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  },
  'app:copy': ({ text }) => { clipboard.writeText(String(text)); return true; },
  'app:openPath': ({ target }) => shell.openPath(target),
  'app:openExternal': ({ url }) => (/^https?:\/\//.test(url) ? shell.openExternal(url) : null),

  'project:open': async ({ root }) => {
    root = path.resolve(root);
    if (!fs.existsSync(root)) throw new Error('Folder does not exist');
    const existing = config.projects.find((p) => p.root === root && p.role === 'host') || config.projects.find((p) => p.root === root);
    const name = path.basename(root);
    const project = existing || {
      root, name, role: 'host', shared: false,
      workspace: `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'project'}-${crypto.randomBytes(3).toString('hex')}`,
      token: crypto.randomBytes(16).toString('hex'),
    };
    return openSession(project);
  },
  'project:join': async ({ invite, root }) => {
    const inv = decodeInvite(invite);
    root = path.resolve(root);
    fs.mkdirSync(root, { recursive: true });
    if (!(await ping(inv.url))) throw new Error(`Can't reach the team server at ${inv.url}. Make sure your teammate has TeamCode open and you are on the same network (or use their public URL).`);
    return openSession({ root, name: inv.name, role: 'member', url: inv.url, workspace: inv.workspace, token: inv.token });
  },
  'project:reopen': async ({ root, workspace }) => {
    const p = config.projects.find((x) => x.root === root && x.workspace === workspace);
    if (!p) throw new Error('Project not found');
    if (!fs.existsSync(p.root)) throw new Error(`Folder ${p.root} no longer exists`);
    if (p.role === 'member' && !(await ping(p.url))) throw new Error(`Can't reach the team server at ${p.url}. Ask the host to open TeamCode.`);
    return openSession(p);
  },
  'project:clone': async ({ url, parent }) => {
    const name = path.basename(String(url).replace(/\.git$/, '').replace(/[\\/]+$/, '')) || 'repo';
    const dest = path.join(parent, name);
    if (fs.existsSync(dest) && fs.readdirSync(dest).length) throw new Error(`${dest} already exists and is not empty`);
    await git.git(parent, ['clone', url, dest], { timeout: 10 * 60 * 1000 });
    return dest;
  },
  'project:close': async () => { if (session) await session.stop(); session = null; win?.setTitle('TeamCode'); return true; },
  'project:invite': async ({ share }) => {
    const s = requireSession();
    const p = s.project;
    if (p.role !== 'host') return { codes: [{ label: 'Team server', code: encodeInvite({ url: p.url, workspace: p.workspace, token: p.token, name: p.name }) }], hosted: false };
    if (share && !p.shared) {
      p.shared = true;
      saveConfig();
      await openSession(p); // restart the embedded server listening on the network
    }
    const codes = [];
    if (config.settings.publicUrl) codes.push({ label: `Public URL (${config.settings.publicUrl})`, code: encodeInvite({ url: config.settings.publicUrl.replace(/\/+$/, ''), workspace: p.workspace, token: p.token, name: p.name }) });
    if (p.shared) for (const ip of lanAddresses()) codes.push({ label: `Local network (${ip})`, code: encodeInvite({ url: `http://${ip}:${serverPort}`, workspace: p.workspace, token: p.token, name: p.name }) });
    return { codes, hosted: true, shared: !!p.shared, port: serverPort };
  },
  'project:externalAgentConfig': () => {
    const s = requireSession();
    const p = s.project;
    const node = findNode();
    const inviteUrl = p.role === 'host' ? `http://127.0.0.1:${serverPort}` : p.url;
    const env = { TEAMCODE_INVITE: encodeInvite({ url: inviteUrl, workspace: p.workspace, token: p.token, name: p.name }), TEAMCODE_ROOT: p.root, TEAMCODE_AGENT_NAME: `${config.user.name || 'My'} external agent` };
    const mcp = { mcpServers: { teamcode: { command: node || process.execPath, args: [scripts.mcp], env: { ...env, ...(node ? {} : { ELECTRON_RUN_AS_NODE: '1' }) } } } };
    const hookCmd = `"${node || process.execPath}" "${scripts.hook}"`;
    const hooks = { hooks: { PreToolUse: [{ matcher: 'Edit|Write|MultiEdit|NotebookEdit', hooks: [{ type: 'command', command: hookCmd }] }], PostToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command: hookCmd }] }], SessionStart: [{ hooks: [{ type: 'command', command: hookCmd }] }], UserPromptSubmit: [{ hooks: [{ type: 'command', command: hookCmd }] }] } };
    return { mcp: JSON.stringify(mcp, null, 2), hooks: JSON.stringify(hooks, null, 2), env };
  },
  'project:gitInfo': () => requireSession().gitInfo(),
  'project:initGit': async () => { await git.initRepo(requireSession().project.root); return requireSession().gitInfo(); },
  'project:checkpoint': () => requireSession().checkpoint(),

  'ws:call': ({ op, args }) => requireSession().call(op, args || {}),
  'ws:state': () => ({ state: session?.state || null, events: session?.events || [], presence: session?.presence || [], runtime: session?.agents?.runtime() || {}, status: session?.conn?.status || 'offline', sync: session?.sync ? { ...session.sync.stats, ready: session.sync.ready, conflicts: [...session.sync.conflicts.keys()] } : null }),

  'agent:start': ({ taskId }) => requireSession().startTask(taskId),
  'agent:stop': ({ agentId }) => requireSession().agents.stop(agentId),
  'agent:message': ({ agentId, text }) => requireSession().agents.message(agentId, text),
  'agent:log': ({ agentId }) => requireSession().agents.getLog(agentId),
  'agent:plan': ({ text }) => requireSession().agents.planFeature(text),
  'agent:resolveConflicts': ({ taskId }) => requireSession().agents.resolveConflictsWithAgent(taskId),

  'review:diff': ({ taskId }) => requireSession().reviewDiff(taskId),
  'review:test': ({ taskId }) => requireSession().runTests(taskId),
  'review:check': ({ taskId }) => requireSession().checkIntegration(taskId),
  'review:approve': ({ taskId, checkpoint }) => requireSession().approve(taskId, { checkpoint }),
  'review:reject': ({ taskId, note, discard }) => requireSession().reject(taskId, { note, discard }),
  'review:revert': ({ taskId }) => requireSession().revert(taskId),
};

for (const [channel, fn] of Object.entries(handlers)) {
  ipcMain.handle(channel, async (_e, args) => {
    try { return { ok: true, result: await fn(args || {}) }; } catch (e) { return { ok: false, error: e.message }; }
  });
}

// ---------- window ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1360, height: 860, minWidth: 980, minHeight: 640, title: 'TeamCode',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0f1115' : '#f6f7f9',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.on('closed', () => { win = null; });
  if (process.env.TEAMCODE_SCREENSHOT) require('./smoke').run(win, { handlers, getSession: () => session, openSession, config });
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (!win) createWindow(); });
app.on('before-quit', async (e) => {
  if (app._tcQuitting) return;
  app._tcQuitting = true;
  e.preventDefault();
  try { if (session) await session.stop(); if (teamServer) await teamServer.close(); } catch { /* quitting anyway */ }
  app.quit();
});
