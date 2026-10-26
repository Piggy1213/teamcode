'use strict';
// Git helpers for isolated agent worktrees, review diffs, conflict detection and controlled merging.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

function git(cwd, args, { input, allowFail = false, timeout = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn('git', args, { cwd, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    let out = '', err = '';
    const timer = setTimeout(() => p.kill(), timeout);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => { clearTimeout(timer); reject(new Error(e.code === 'ENOENT' ? 'Git is not installed or not on PATH' : e.message)); });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 && !allowFail) reject(Object.assign(new Error((err || out).trim() || `git ${args[0]} failed`), { code, stdout: out, stderr: err }));
      else resolve({ code, stdout: out, stderr: err });
    });
    if (input) p.stdin.end(input); else p.stdin.end();
  });
}

async function isRepo(root) {
  try { return (await git(root, ['rev-parse', '--is-inside-work-tree'])).stdout.trim() === 'true'; } catch { return false; }
}

async function hasCommits(root) {
  return (await git(root, ['rev-parse', '--verify', 'HEAD'], { allowFail: true })).code === 0;
}

async function head(root) { return (await git(root, ['rev-parse', 'HEAD'])).stdout.trim(); }
async function currentBranch(root) { return (await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim(); }

async function initRepo(root) {
  await git(root, ['init']);
  await git(root, ['add', '-A']);
  await git(root, ['-c', 'user.name=TeamCode', '-c', 'user.email=teamcode@local', 'commit', '-m', 'Initial commit (TeamCode)', '--allow-empty']);
}

async function createWorktree(root, dir, branch, base = 'HEAD') {
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  if (fs.existsSync(dir)) await removeWorktree(root, dir, null).catch(() => {});
  const exists = (await git(root, ['rev-parse', '--verify', `refs/heads/${branch}`], { allowFail: true })).code === 0;
  await git(root, exists ? ['worktree', 'add', dir, branch] : ['worktree', 'add', '-b', branch, dir, base]);
  return { dir, branch, baseCommit: (await git(root, ['rev-parse', base])).stdout.trim() };
}

async function removeWorktree(root, dir, branch) {
  await git(root, ['worktree', 'remove', '--force', dir], { allowFail: true });
  fs.rmSync(dir, { recursive: true, force: true });
  await git(root, ['worktree', 'prune'], { allowFail: true });
  if (branch) await git(root, ['branch', '-D', branch], { allowFail: true });
}

// Commit everything in a worktree, attributed to the agent. Returns the new head (or null if nothing changed).
async function commitAll(dir, message, author) {
  await git(dir, ['add', '-A']);
  const st = await git(dir, ['diff', '--cached', '--quiet'], { allowFail: true });
  if (st.code === 0) return null;
  await git(dir, ['-c', `user.name=${author.name}`, '-c', `user.email=${author.email}`, 'commit', '-m', message]);
  return head(dir);
}

async function changedFiles(root, base, ref) {
  const r = await git(root, ['diff', '--name-status', `${base}...${ref}`]);
  return r.stdout.trim().split('\n').filter(Boolean).map((l) => { const [status, ...p] = l.split('\t'); return { status: status[0], path: p[p.length - 1] }; });
}

async function diffStat(root, base, ref) {
  const r = await git(root, ['diff', '--shortstat', `${base}...${ref}`]);
  const m = r.stdout.match(/(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/);
  return m ? { files: +m[1], insertions: +(m[2] || 0), deletions: +(m[3] || 0) } : { files: 0, insertions: 0, deletions: 0 };
}

async function diff(root, base, ref) {
  return (await git(root, ['diff', '--no-color', `${base}...${ref}`])).stdout;
}

// Dry-run merge with `git merge-tree --write-tree` (git >= 2.38). Never touches the working tree.
async function mergeCheck(root, ref, into = 'HEAD') {
  const r = await git(root, ['merge-tree', '--write-tree', '--name-only', '--no-messages', into, ref], { allowFail: true });
  if (r.code === 0) return { clean: true, conflicts: [] };
  if (r.code === 1) return { clean: false, conflicts: r.stdout.trim().split('\n').slice(1).filter(Boolean) };
  throw new Error(r.stderr.trim() || 'merge-tree failed (git 2.38+ is required for conflict checks)');
}

async function dirtyFiles(root) {
  const r = await git(root, ['status', '--porcelain', '-z']);
  return r.stdout.split('\0').filter(Boolean).map((l) => l.slice(3));
}

async function merge(root, branch, message) {
  const r = await git(root, ['-c', 'user.name=TeamCode', '-c', 'user.email=teamcode@local', 'merge', '--no-ff', '-m', message, branch], { allowFail: true });
  if (r.code !== 0) {
    const conflicts = (await git(root, ['diff', '--name-only', '--diff-filter=U'], { allowFail: true })).stdout.trim().split('\n').filter(Boolean);
    await git(root, ['merge', '--abort'], { allowFail: true });
    return { ok: false, conflicts, error: (r.stderr || r.stdout).trim() };
  }
  return { ok: true, commit: await head(root) };
}

async function revertMerge(root, commit) {
  await git(root, ['-c', 'user.name=TeamCode', '-c', 'user.email=teamcode@local', 'revert', '-m', '1', '--no-edit', commit]);
  return head(root);
}

async function checkpoint(root, message) {
  await git(root, ['add', '-A']);
  const st = await git(root, ['diff', '--cached', '--quiet'], { allowFail: true });
  if (st.code === 0) return null;
  await git(root, ['-c', 'user.name=TeamCode', '-c', 'user.email=teamcode@local', 'commit', '-m', message]);
  return head(root);
}

// Heuristic API/schema break detection: removed or changed exported symbols, routes and schema statements.
function breakingChanges(diffText) {
  const risks = [];
  let file = null;
  const removed = new Map(), added = new Set();
  for (const line of diffText.split('\n')) {
    if (line.startsWith('+++ b/')) { file = line.slice(6); continue; }
    if (line.startsWith('---') || line.startsWith('+++')) continue;
    const sig = line.slice(1).match(/^\s*(export\s+(?:default\s+)?(?:async\s+)?(?:function|const|let|class|interface|type|enum)\s+(\w+)|def\s+(\w+)\s*\(|(?:public\s+)?func\s+(\w+)|(?:app|router)\.(?:get|post|put|patch|delete)\(\s*['"`]([^'"`]+))/);
    if (line.startsWith('-') && sig) removed.set(`${file}|${sig[2] || sig[3] || sig[4] || sig[5]}`, line.slice(1).trim());
    if (line.startsWith('+') && sig) added.add(`${file}|${sig[2] || sig[3] || sig[4] || sig[5]}|${line.slice(1).trim()}`);
    if (line.startsWith('+') && /\b(DROP\s+(TABLE|COLUMN)|ALTER\s+TABLE|RENAME\s+(COLUMN|TO))\b/i.test(line)) risks.push({ kind: 'schema', message: `${file}: ${line.slice(1).trim().slice(0, 120)}` });
  }
  for (const [key, old] of removed) {
    const [f, name] = key.split('|');
    const replacement = [...added].find((a) => a.startsWith(`${f}|${name}|`));
    if (!replacement) risks.push({ kind: 'api', message: `${f}: removed \`${name}\`` });
    else if (replacement.split('|').slice(2).join('|') !== old) risks.push({ kind: 'api', message: `${f}: signature of \`${name}\` changed` });
  }
  return risks;
}

function runCommand(cmd, cwd, timeout = 15 * 60 * 1000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const p = spawn(cmd, { cwd, shell: true, windowsHide: true, env: { ...process.env, CI: '1' } });
    let out = '';
    const add = (d) => { out += d; if (out.length > 200000) out = out.slice(-150000); };
    p.stdout.on('data', add);
    p.stderr.on('data', add);
    const timer = setTimeout(() => { add('\n[TeamCode] command timed out\n'); p.kill(); }, timeout);
    p.on('error', (e) => { clearTimeout(timer); resolve({ passed: false, output: String(e.message), durationMs: Date.now() - started }); });
    p.on('close', (code) => { clearTimeout(timer); resolve({ passed: code === 0, code, output: out, durationMs: Date.now() - started }); });
  });
}

module.exports = { git, isRepo, hasCommits, head, currentBranch, initRepo, createWorktree, removeWorktree, commitAll, changedFiles, diffStat, diff, mergeCheck, dirtyFiles, merge, revertMerge, checkpoint, breakingChanges, runCommand };
