'use strict';
// Locate the Claude Code CLI on Mac and Windows and build a spawn command for it.
const { execFile, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const isWin = process.platform === 'win32';
const exists = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

// A path TeamCode can actually execute: a file (not a folder or .app bundle), executable, and built for
// this OS. Claude desktop also keeps a Linux build for its VM next to the Mac one; that can't run here.
function isRunnable(p) {
  if (!p || !exists(p)) return false;
  if (isWin) return /\.(exe|cmd|bat)$/i.test(p);
  try { fs.accessSync(p, fs.constants.X_OK); } catch { return false; }
  try {
    const fd = fs.openSync(p, 'r');
    const head = Buffer.alloc(4);
    fs.readSync(fd, head, 0, 4, 0);
    fs.closeSync(fd);
    if (head.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) && process.platform !== 'linux') return false; // ELF
  } catch { return false; }
  return true;
}

// Claude Code's executable is called "claude". The Claude desktop app's own binary is "Claude", and on a
// case-insensitive Mac disk ".../Claude.app/Contents/MacOS/claude" opens it, so compare the real name.
function isDesktopApp(p) {
  try {
    const real = fs.realpathSync.native(p);
    return /\.app\/Contents\/MacOS\/Claude$/.test(real) || /[\\/]Claude\.exe$/.test(real) && !/claude-code/i.test(real);
  } catch { return false; }
}

// Turns what someone picked in a file dialog into the Claude Code executable, or explains why it isn't one.
function resolveClaudePath(picked) {
  if (!picked) return { error: 'No file chosen.' };
  let stat;
  try { stat = fs.statSync(picked); } catch { return { error: `${picked} doesn't exist.` }; }
  if (stat.isDirectory() && /\.app$/i.test(picked)) {
    const macos = path.join(picked, 'Contents', 'MacOS');
    let names = [];
    try { names = fs.readdirSync(macos); } catch { /* not a normal bundle */ }
    if (names.includes('claude')) picked = path.join(macos, 'claude');
    else if (names.includes('Claude')) return { error: 'That\'s the Claude desktop app. TeamCode needs Claude Code, the command-line tool. Use Detect, or install it with: curl -fsSL https://claude.ai/install.sh | bash', desktop: true };
    else return { error: `${path.basename(picked)} doesn't contain Claude Code.` };
  } else if (stat.isDirectory()) {
    return { error: 'That\'s a folder. Choose the claude program itself.' };
  }
  if (isDesktopApp(picked)) return { error: 'That\'s the Claude desktop app, not Claude Code. Use Detect, or install Claude Code with: curl -fsSL https://claude.ai/install.sh | bash', desktop: true };
  if (!isRunnable(picked)) return { error: `${picked} can't be run on this computer.` };
  return { path: picked };
}

function versionKey(p) {
  const m = p.match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? m.slice(1).map(Number).reduce((a, n) => a * 10000 + n, 0) : 0;
}

// Claude desktop ships its own copy of Claude Code; find the newest one that runs on this OS.
// Mac layout today: ~/Library/Application Support/Claude/claude-code/<version>/<build>/claude.app/Contents/MacOS/claude
// (older builds put the binary straight under claude-code/<version>/). claude-code-vm holds a Linux build: skip it.
function bundledCandidates() {
  const out = [];
  const scan = (dir, depth, match) => {
    if (depth < 0) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) scan(p, depth - 1, match);
      else if (match(p, e.name)) out.push(p);
    }
  };
  if (isWin) {
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    for (const base of [path.join(local, 'Claude-Data'), path.join(local, 'AnthropicClaude'), path.join(process.env.APPDATA || '', 'Claude')]) {
      scan(base, 6, (p, name) => name.toLowerCase() === 'claude.exe' && /[\\/]claude-code[\\/]/i.test(p) && !/claude-code-vm/i.test(p));
    }
  } else {
    const sup = path.join(os.homedir(), 'Library', 'Application Support');
    for (const d of ['Claude', 'Claude-Data', 'Claude Code']) scan(path.join(sup, d, 'claude-code'), 5, (p, name) => name === 'claude');
  }
  return out.filter(isRunnable).sort((a, b) => versionKey(b) - versionKey(a));
}

function pathCandidates() {
  const out = [];
  try {
    const r = isWin
      ? spawnSync('where', ['claude'], { encoding: 'utf8', windowsHide: true })
      : spawnSync(process.env.SHELL || '/bin/zsh', ['-lc', 'command -v claude'], { encoding: 'utf8', timeout: 5000 });
    out.push(...String(r.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
  } catch { /* no shell */ }
  const home = os.homedir();
  if (isWin) {
    out.push(path.join(home, '.local', 'bin', 'claude.exe'), path.join(process.env.APPDATA || '', 'npm', 'claude.cmd'));
  } else {
    out.push(path.join(home, '.local', 'bin', 'claude'), path.join(home, '.claude', 'local', 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude');
  }
  return out;
}

function findClaude(preferred) {
  const list = [preferred, ...pathCandidates(), ...bundledCandidates()].filter(Boolean);
  // `where` lists both `claude` (a sh script) and `claude.cmd` on Windows; prefer real executables.
  const ok = list.filter((p) => isRunnable(p) && !isDesktopApp(p));
  ok.sort((a, b) => (a === preferred ? -1 : b === preferred ? 1 : 0) || (isWin ? Number(/\.exe$/i.test(b)) - Number(/\.exe$/i.test(a)) : 0));
  return ok[0] || null;
}

// npm installs on Windows expose a .cmd shim; resolve it to something we can spawn without a shell.
function spawnSpec(cliPath, nodePath) {
  if (isWin && /\.(cmd|bat)$/i.test(cliPath)) {
    const pkg = path.join(path.dirname(cliPath), 'node_modules', '@anthropic-ai', 'claude-code');
    for (const exe of [path.join(pkg, 'bin', 'claude.exe'), path.join(pkg, 'claude.exe')]) if (exists(exe)) return { command: exe, prefix: [] };
    const js = path.join(pkg, 'cli.js');
    if (exists(js) && nodePath) return { command: nodePath, prefix: [js] };
    return { command: cliPath, prefix: [], shell: true };
  }
  return { command: cliPath, prefix: [] };
}

// When a shell is unavoidable (.cmd shims), quote arguments ourselves; Node does not.
function shellQuote(args) {
  return args.map((a) => (/[\s"&|<>^]/.test(a) ? `"${String(a).replace(/"/g, '""')}"` : a));
}

function claudeVersion(cliPath) {
  return new Promise((resolve) => {
    const spec = spawnSpec(cliPath, findNode());
    execFile(spec.command, [...spec.prefix, '--version'], { timeout: 15000, windowsHide: true, shell: !!spec.shell }, (err, stdout) => {
      resolve(err ? null : String(stdout).trim().split('\n')[0]);
    });
  });
}

let nodeCache;
function findNode() {
  if (nodeCache !== undefined) return nodeCache;
  try {
    const r = isWin
      ? spawnSync('where', ['node'], { encoding: 'utf8', windowsHide: true })
      : spawnSync(process.env.SHELL || '/bin/zsh', ['-lc', 'command -v node'], { encoding: 'utf8', timeout: 5000 });
    nodeCache = String(r.stdout || '').split(/\r?\n/).map((s) => s.trim()).find((p) => p && exists(p)) || null;
  } catch { nodeCache = null; }
  return nodeCache;
}

// Opens a terminal window running Claude Code so the user can sign in once.
function loginScript(cliPath, dir) {
  fs.mkdirSync(dir, { recursive: true });
  if (isWin) {
    const f = path.join(dir, 'claude-login.cmd');
    fs.writeFileSync(f, `@echo off\r\ntitle Claude Code sign-in\r\necho Signing in to Claude Code - finish the steps in your browser.\r\n"${cliPath}" auth login\r\necho.\r\necho Done. You can close this window and return to TeamCode.\r\npause\r\n`);
    return f;
  }
  const f = path.join(dir, 'claude-login.command');
  fs.writeFileSync(f, `#!/bin/sh\necho "Signing in to Claude Code - finish the steps in your browser."\n"${cliPath}" auth login\necho "Done. You can close this window and return to TeamCode."\n`);
  fs.chmodSync(f, 0o755);
  return f;
}

// `claude auth status` prints JSON; null when the CLI is too old to support it.
function claudeAuthStatus(cliPath) {
  return new Promise((resolve) => {
    const spec = spawnSpec(cliPath, findNode());
    execFile(spec.command, [...spec.prefix, 'auth', 'status'], { timeout: 20000, windowsHide: true, shell: !!spec.shell }, (err, stdout) => {
      try { resolve(JSON.parse(String(stdout))); } catch { resolve(null); }
    });
  });
}

module.exports = { findClaude, claudeVersion, claudeAuthStatus, spawnSpec, shellQuote, findNode, loginScript, isRunnable, isDesktopApp, resolveClaudePath };
