'use strict';
// Locate the Claude Code CLI on Mac and Windows and build a spawn command for it.
const { execFile, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const isWin = process.platform === 'win32';
const exists = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

function versionKey(p) {
  const m = p.match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? m.slice(1).map(Number).reduce((a, n) => a * 10000 + n, 0) : 0;
}

// Claude desktop ships its own copy of Claude Code; find the newest one.
function bundledCandidates() {
  const out = [];
  const scan = (dir, depth, match) => {
    if (depth < 0) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) scan(p, depth - 1, match);
      else if (match(p)) out.push(p);
    }
  };
  if (isWin) {
    const base = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Claude-Data');
    scan(base, 4, (p) => /[\\/]claude-code[\\/].*claude\.exe$/i.test(p));
    const base2 = path.join(process.env.APPDATA || '', 'Claude', 'claude-code');
    scan(base2, 3, (p) => /claude\.exe$/i.test(p));
  } else {
    const sup = path.join(os.homedir(), 'Library', 'Application Support');
    for (const d of ['Claude', 'Claude-Data', 'Claude Code']) scan(path.join(sup, d), 4, (p) => /\/claude-code\/.*\/claude$/.test(p));
  }
  return out.sort((a, b) => versionKey(b) - versionKey(a));
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
  const ok = list.filter((p) => exists(p) && (!isWin || /\.(exe|cmd|bat)$/i.test(p)));
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

module.exports = { findClaude, claudeVersion, claudeAuthStatus, spawnSpec, shellQuote, findNode, loginScript };
