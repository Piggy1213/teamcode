'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, Notification, nativeTheme } = require('electron');
const fs = require('fs');
const { execFile } = require('child_process');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { TeamServer } = require('../../server/server');
const { encodeInvite, decodeInvite } = require('../../server/invite');
const { ProjectSession } = require('./session');
const { findClaude, claudeVersion, claudeAuthStatus, loginScript, findNode, isRunnable, isDesktopApp, resolveClaudePath, spawnSpec } = require('./claude-cli');
const git = require('./git');
const { Updater } = require('./updater');
const { Account } = require('./account');
const pkg = require('../../package.json');

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
let updater = null;
let account = null;

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
  if (Notification.isSupported()) new Notification({ title: `TeamCode: ${title}`, body: String(body || '').slice(0, 200) }).show();
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
  return p && { root: p.root, name: p.name, role: p.role, workspace: p.workspace, url: p.url, lastOpened: p.lastOpened, shared: !!p.shared, cloud: !!p.cloud, claudeLinked: !!p.claudeLinked };
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
  const link = claudeCodeLink(session); // the local server's port can change between runs; keep Claude Code's connection current
  // If TeamCode or node moved since "Add to Claude Code", point Claude Code at the new paths.
  if (project.claudeLinked && (project.claudeLinkedServer !== JSON.stringify(link.server) || project.claudeLinkedHooks !== HOOK_EVENTS.join(','))) linkClaudeCode(session).catch(() => {});
  win?.setTitle(`${project.name} | TeamCode`);
  return projectView(project);
}

function requireSession() {
  if (!session) throw new Error('No project is open');
  return session;
}

async function claudeInfo(p) {
  if (!p) return { path: null, version: null, loggedIn: null };
  const [version, auth] = await Promise.all([claudeVersion(p), claudeAuthStatus(p)]);
  return { path: p, version, works: !!version, loggedIn: auth ? !!auth.loggedIn : null, account: auth?.email || null };
}

// Claude Code settings changed: let the open project try starting agents again.
function claudeChanged() { session?.resumeAuto(); }

// ---------- Claude Code integration ("Add to Claude Code") ----------
// Claude Code gets an MCP entry and hooks that read their connection from a private file TeamCode keeps
// current, so the workspace token never lands in the project folder or in Claude Code's own config.
const HOOK_EVENTS = ['PreToolUse', 'PostToolUse', 'SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd'];

function claudeCodeLink(s) {
  const p = s.project;
  const node = findNode();
  const runtime = node || process.execPath;
  const file = path.join(s.localDir, 'claude-code.json');
  fs.mkdirSync(s.localDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    TEAMCODE_URL: p.role === 'host' ? `http://127.0.0.1:${serverPort}` : p.url, TEAMCODE_WORKSPACE: p.workspace, TEAMCODE_TOKEN: p.token,
    TEAMCODE_ROOT: p.root, TEAMCODE_CLIENT: 'Claude Code', TEAMCODE_USER_ID: config.user.id, TEAMCODE_USER_NAME: config.user.name || '',
    TEAMCODE_AGENT_NAME: `${config.user.name || 'My'}'s Claude Code`,
    TEAMCODE_AGENT_ID: 'agt_cc_' + crypto.createHash('sha1').update(`${config.user.id}|${p.workspace}|${p.root.toLowerCase()}`).digest('hex').slice(0, 10),
  }, null, 1), { mode: 0o600 });
  // Electron only behaves like node with ELECTRON_RUN_AS_NODE; Claude Code runs hook commands in a POSIX shell.
  const server = { type: 'stdio', command: runtime, args: [scripts.mcp, '--config', file], ...(node ? {} : { env: { ELECTRON_RUN_AS_NODE: '1' } }) };
  const hookCmd = `${node ? '' : 'ELECTRON_RUN_AS_NODE=1 '}"${runtime}" "${scripts.hook}" --config "${file}"`;
  return { file, server, hookCmd };
}

// Adds or removes TeamCode's hooks in <root>/.claude/settings.local.json, keeping everything else in it.
function writeClaudeHooks(root, hookCmd) {
  const f = path.join(root, '.claude', 'settings.local.json');
  let j = {};
  try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) {
    if (e.code !== 'ENOENT') throw new Error(`.claude/settings.local.json in this project isn't valid JSON. Fix or delete it, then try again.`);
  }
  const ours = (h) => /[\\/]agent[\\/]hook\.js" --config /.test(h?.command || '');
  j.hooks = j.hooks && typeof j.hooks === 'object' ? j.hooks : {};
  for (const ev of HOOK_EVENTS) {
    const groups = (j.hooks[ev] || []).map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !ours(h)) })).filter((g) => g.hooks.length);
    if (hookCmd) groups.push({ ...(ev === 'PreToolUse' ? { matcher: 'Edit|Write|MultiEdit|NotebookEdit' } : ev === 'PostToolUse' ? { matcher: '.*' } : {}), hooks: [{ type: 'command', command: hookCmd, timeout: 10 }] });
    if (groups.length) j.hooks[ev] = groups; else delete j.hooks[ev];
  }
  if (!Object.keys(j.hooks).length) delete j.hooks;
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(j, null, 2) + '\n');
}

// Keeps a TeamCode-created .claude/settings.local.json out of git (Claude Code does the same for its own).
// Best effort: skipped when .git is a file (a linked worktree or submodule keeps its info/ elsewhere).
function gitExclude(root, rel) {
  const f = path.join(root, '.git', 'info', 'exclude');
  try { if (!fs.statSync(path.join(root, '.git')).isDirectory()) return; } catch { return; }
  let cur = '';
  try { cur = fs.readFileSync(f, 'utf8'); } catch { /* no exclude file yet */ }
  if (cur.split(/\r?\n/).includes(rel)) return;
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.appendFileSync(f, `${cur && !cur.endsWith('\n') ? '\n' : ''}${rel}\n`);
}

async function linkClaudeCode(s) {
  const link = claudeCodeLink(s);
  await claudeCli(['mcp', 'remove', 'teamcode', '--scope', 'local'], s.project.root).catch(() => {});
  await claudeCli(['mcp', 'add-json', 'teamcode', JSON.stringify(link.server), '--scope', 'local'], s.project.root);
  writeClaudeHooks(s.project.root, link.hookCmd);
  s.project.claudeLinked = true;
  s.project.claudeLinkedServer = JSON.stringify(link.server);
  s.project.claudeLinkedHooks = HOOK_EVENTS.join(',');
  saveConfig();
  try { gitExclude(s.project.root, '.claude/settings.local.json'); } catch { /* optional */ }
}

// Runs the Claude Code CLI (e.g. `claude mcp add-json ...`) in the project folder.
async function claudeCli(args, cwd) {
  const cli = config.settings.claudePath;
  const setup = (msg) => Object.assign(new Error(msg), { setup: true });
  if (!cli || !isRunnable(cli) || isDesktopApp(cli)) throw setup('Claude Code isn\'t set up. Open Settings, Claude Code, and press Detect.');
  const spec = spawnSpec(cli, findNode());
  if (spec.shell) throw setup('This Claude Code install needs a shell. Use Set up by hand and run the command in a terminal.');
  return new Promise((resolve, reject) => {
    execFile(spec.command, [...spec.prefix, ...args], { cwd, timeout: 30000, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr || stdout || err.message).trim().split('\n').slice(-3).join(' ')));
      else resolve(String(stdout));
    });
  });
}

// ---------- IPC ----------
const handlers = {
  'app:init': async () => {
    // Repair a missing or unusable path (for example the Claude desktop app picked by mistake).
    const cp = config.settings.claudePath;
    if (!cp || !isRunnable(cp) || isDesktopApp(cp)) {
      config.settings.claudePath = findClaude(null) || '';
      saveConfig();
    }
    return {
      user: config.user, settings: config.settings, platform: process.platform, version: app.getVersion(),
      projects: config.projects.filter((p) => fs.existsSync(p.root)).map(projectView),
      claude: await claudeInfo(config.settings.claudePath),
      nodeFound: !!findNode(),
      current: session ? projectView(session.project) : null,
      update: updater.state,
      account: account.state,
    };
  },
  'app:setUser': ({ name }) => { config.user.name = String(name || '').trim().slice(0, 40) || 'Developer'; saveConfig(); return config.user; },
  'app:saveSettings': (s) => {
    const allowed = ['claudePath', 'permissionMode', 'model', 'maxParallel', 'autoRun', 'testCommand', 'publicUrl'];
    for (const k of allowed) if (k in s) config.settings[k] = s[k];
    config.settings.maxParallel = Math.max(1, Math.min(10, Number(config.settings.maxParallel) || 3));
    saveConfig();
    if (session && 'autoRun' in s) session._autoRun();
    if ('claudePath' in s) claudeChanged();
    return config.settings;
  },
  'app:detectClaude': async () => {
    const p = findClaude(null);
    if (p) { config.settings.claudePath = p; saveConfig(); claudeChanged(); }
    return claudeInfo(p);
  },
  'app:claudeStatus': () => claudeInfo(config.settings.claudePath),
  'app:browseClaude': async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Locate the Claude Code CLI (the "claude" program)', properties: ['openFile'] });
    if (r.canceled) return null;
    const picked = resolveClaudePath(r.filePaths[0]);
    if (picked.error) throw new Error(picked.error);
    const version = await claudeVersion(picked.path);
    if (!version || !/claude code|^\d+\.\d+\.\d+/i.test(version)) throw new Error(`${picked.path} didn't respond like Claude Code.`);
    config.settings.claudePath = picked.path;
    saveConfig();
    claudeChanged();
    return claudeInfo(picked.path);
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
  'cloud:status': async () => {
    const cfg = await account.siteConfig();
    const signedIn = !!account.state.user;
    if (!account.siteUrl) return { available: false, signedIn, reason: 'This build of TeamCode has no website configured.' };
    if (!cfg) return { available: false, signedIn, reason: 'Can\'t reach the TeamCode website right now.' };
    if (!cfg.cloud) return { available: false, signedIn, reason: 'Cloud hosting isn\'t switched on for this TeamCode website yet.' };
    return { available: true, signedIn, reason: signedIn ? null : 'Sign in to host projects on TeamCode cloud.' };
  },
  'cloud:list': async () => {
    if (!account.state.user) return [];
    const list = await account.listWorkspaces();
    return list.map((w) => {
      const p = config.projects.find((x) => x.workspace === w.workspace && fs.existsSync(x.root));
      return { ...w, token: undefined, open: p ? p.root : null };
    });
  },
  // Host a folder on TeamCode cloud: create the workspace on the website, then connect as its first member.
  // An empty cloud workspace takes the folder's files on first sync.
  'project:openCloud': async ({ root }) => {
    root = path.resolve(root);
    if (!fs.existsSync(root)) throw new Error('Folder does not exist');
    const w = await account.createWorkspace(path.basename(root));
    return openSession({ root, name: w.name, role: 'member', cloud: true, owner: true, url: w.url, workspace: w.workspace, token: w.token });
  },
  // Open one of your cloud projects on this computer (for example a second laptop).
  'project:joinCloud': async ({ workspace, root }) => {
    const w = (await account.listWorkspaces()).find((x) => x.workspace === workspace);
    if (!w) throw new Error('That cloud project wasn\'t found on your account.');
    root = path.resolve(root);
    fs.mkdirSync(root, { recursive: true });
    return openSession({ root, name: w.name, role: 'member', cloud: true, owner: true, url: w.url, workspace: w.workspace, token: w.token });
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
    if (p.role === 'member' && !(await ping(p.url))) throw new Error(p.cloud ? `Can't reach TeamCode cloud at ${p.url}. Check your internet connection.` : `Can't reach the team server at ${p.url}. Ask the host to open TeamCode.`);
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
    const link = claudeCodeLink(s);
    const hooks = { hooks: Object.fromEntries(HOOK_EVENTS.map((ev) => [ev, [{ ...(ev === 'PreToolUse' ? { matcher: 'Edit|Write|MultiEdit|NotebookEdit' } : ev === 'PostToolUse' ? { matcher: '.*' } : {}), hooks: [{ type: 'command', command: link.hookCmd, timeout: 10 }] }]])) };
    return {
      linked: !!s.project.claudeLinked, root: s.project.root, local: s.project.role === 'host',
      // No embedded JSON, so the same command works in cmd, PowerShell and POSIX shells.
      command: `claude mcp add --scope local teamcode${link.server.env ? ' -e ELECTRON_RUN_AS_NODE=1' : ''} -- ${[link.server.command, ...link.server.args].map((a) => `"${a}"`).join(' ')}`,
      server: JSON.stringify(link.server, null, 2), hooks: JSON.stringify(hooks, null, 2),
    };
  },
  'claude:link': async () => { await linkClaudeCode(requireSession()); return true; },
  'claude:unlink': async () => {
    const s = requireSession();
    // "Not found" is fine (already removed); a Claude Code that can't run is not: say so instead of pretending.
    await claudeCli(['mcp', 'remove', 'teamcode', '--scope', 'local'], s.project.root).catch((e) => { if (e.setup) throw e; });
    writeClaudeHooks(s.project.root, null);
    s.project.claudeLinked = false;
    delete s.project.claudeLinkedServer;
    delete s.project.claudeLinkedHooks;
    saveConfig();
    return true;
  },
  'project:gitInfo': () => requireSession().gitInfo(),
  'project:initGit': async () => { await git.initRepo(requireSession().project.root); return requireSession().gitInfo(); },
  'project:checkpoint': () => requireSession().checkpoint(),

  'ws:call': ({ op, args }) => requireSession().call(op, args || {}),
  'ws:state': () => ({ state: session?.state || null, events: session?.events || [], presence: session?.presence || [], runtime: session?.agents?.runtime() || {}, status: session?.conn?.status || 'offline', sync: session?.sync ? { ...session.sync.stats, ready: session.sync.ready, conflicts: [...session.sync.conflicts.keys()] } : null }),

  'agent:start': ({ taskId }) => requireSession().startTask(taskId, { manual: true }),
  'agent:openInClaudeCode': ({ agentId }) => requireSession().agents.openInClaudeCode(agentId, async (f) => {
    const err = await shell.openPath(f);
    if (err) throw new Error(`Couldn't open a terminal: ${err}`);
  }),
  'agent:finishHandoff': ({ agentId }) => requireSession().agents.finishHandoff(agentId),
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

  'account:login': () => account.login(),
  'account:cancel': () => account.cancel(),
  'account:logout': () => account.logout(),
  'account:refresh': () => account.refresh(),

  'update:check': () => updater.check(),
  'update:install': async () => { if (await updater.install({ relaunch: true })) app.quit(); return updater.state; },
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
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#121211' : '#fbfbfa',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.on('closed', () => { win = null; });
  if (process.env.TEAMCODE_SCREENSHOT) require('./smoke').run(win, { handlers, getSession: () => session, openSession, config });
}

// The TeamCode website serves updates and accounts. TEAMCODE_SITE_URL points a development build at a
// local website and turns the updater on there (it downloads but never installs over the dev Electron).
const siteUrl = process.env.TEAMCODE_SITE_URL || pkg.teamcode?.siteUrl || '';
updater = new Updater({
  feedUrl: siteUrl,
  currentVersion: process.env.TEAMCODE_FAKE_VERSION || app.getVersion(),
  dir: path.join(userData, 'updates'),
  enabled: app.isPackaged || !!process.env.TEAMCODE_SITE_URL,
  canInstall: app.isPackaged,
  onState: (state) => send('tc:update', state),
});

account = new Account({ siteUrl, config, saveConfig, onState: (state) => send('tc:account', state) });

app.whenReady().then(() => { createWindow(); updater.start(); account.refresh(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (!win) createWindow(); });
app.on('before-quit', async (e) => {
  if (app._tcQuitting) return;
  app._tcQuitting = true;
  e.preventDefault();
  try { if (session) await session.stop(); if (teamServer) await teamServer.close(); } catch { /* quitting anyway */ }
  // A downloaded update installs as the app quits.
  try { if (updater.state.status === 'ready') await updater.install({ relaunch: false }); } catch { /* keep the download for next time */ }
  app.quit();
});
