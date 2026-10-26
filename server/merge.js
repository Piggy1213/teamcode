'use strict';
// Three-way text merge using `git merge-file`. Returns { clean, content } or null if git is unavailable.
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

let gitAvailable = null;
function hasGit() {
  if (gitAvailable === null) {
    try { gitAvailable = spawnSync('git', ['--version'], { windowsHide: true }).status === 0; } catch { gitAvailable = false; }
  }
  return gitAvailable;
}

function merge3(base, ours, theirs, labels = {}) {
  if (!hasGit()) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-merge-'));
  try {
    const f = (n, c) => { const p = path.join(dir, n); fs.writeFileSync(p, c); return p; };
    const pOurs = f('ours', ours), pBase = f('base', base), pTheirs = f('theirs', theirs);
    const r = spawnSync('git', ['merge-file', '-p',
      '-L', labels.ours || 'current', '-L', labels.base || 'base', '-L', labels.theirs || 'incoming',
      pOurs, pBase, pTheirs], { windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    if (r.status < 0 || r.status === null || r.error) return null;
    return { clean: r.status === 0, conflicts: r.status, content: r.stdout.toString('utf8') };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { merge3, hasGit };
