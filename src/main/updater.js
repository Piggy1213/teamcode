'use strict';
// Self-updater. Asks the TeamCode website (website/server.js) for the latest release, downloads this
// platform's installer in the background, verifies it, and installs it on restart or quit.
// The website proxies the GitHub release, so the repo can stay private and no token ships in the app.
//   Windows: runs the NSIS installer silently (--updated /S), which replaces the installed app.
//   macOS:   mounts the .dmg and swaps the .app bundle in place. Squirrel.Mac would need an Apple Developer ID.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { spawn } = require('child_process');

const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;
const FIRST_CHECK_MS = 15 * 1000;

function platformKey() {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64';
  return null;
}

// 1.2.10 > 1.2.9; ignores a leading "v" and any pre-release suffix.
function newer(a, b) {
  const p = (v) => String(v).replace(/^v/, '').split('-')[0].split('.').map((n) => Number(n) || 0);
  const [x, y] = [p(a), p(b)];
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
}

function get(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.get(url, { headers: { 'user-agent': 'TeamCode-Updater' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(get(new URL(res.headers.location, url).toString(), redirects - 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`Update server returned ${res.statusCode}`)); }
      resolve(res);
    });
    req.setTimeout(30000, () => req.destroy(new Error('Update server timed out')));
    req.on('error', reject);
  });
}

async function getJson(url) {
  const res = await get(url);
  let body = '';
  for await (const chunk of res) body += chunk;
  return JSON.parse(body);
}

class Updater {
  constructor({ feedUrl, currentVersion, dir, enabled, canInstall, onState }) {
    this.feedUrl = String(feedUrl || '').replace(/\/+$/, '');
    this.currentVersion = currentVersion;
    this.dir = dir;
    this.canInstall = !!canInstall;
    this.key = platformKey();
    this.onState = onState || (() => {});
    this.file = null;
    this.timer = null;
    const why = !enabled ? 'Updates are off in development builds.' : !this.feedUrl ? 'No update server is configured for this build.' : !this.key ? 'Automatic updates are not available on this platform.' : null;
    this.state = { status: why ? 'disabled' : 'idle', current: currentVersion, version: null, progress: 0, error: why, checkedAt: null, notes: '' };
  }

  set(patch) {
    this.state = { ...this.state, ...patch };
    this.onState(this.state);
  }

  start() {
    if (this.state.status === 'disabled') return;
    setTimeout(() => this.check().catch(() => {}), FIRST_CHECK_MS);
    this.timer = setInterval(() => this.check().catch(() => {}), CHECK_EVERY_MS);
  }

  async check() {
    if (this.state.status === 'disabled') return this.state;
    if (['downloading', 'ready', 'installing'].includes(this.state.status)) return this.state;
    this.set({ status: 'checking', error: null });
    try {
      const info = await getJson(`${this.feedUrl}/api/release`);
      const asset = info.platforms?.[this.key];
      if (!info.version || !newer(info.version, this.currentVersion) || !asset) {
        this.set({ status: 'current', checkedAt: Date.now() });
        return this.state;
      }
      this.set({ status: 'available', version: info.version.replace(/^v/, ''), notes: info.notes || '', checkedAt: Date.now() });
      await this.download(asset);
    } catch (e) {
      this.set({ status: 'error', error: e.message, checkedAt: Date.now() });
    }
    return this.state;
  }

  async download(asset) {
    fs.mkdirSync(this.dir, { recursive: true });
    const ext = path.extname(asset.file) || (this.key === 'windows' ? '.exe' : '.dmg');
    const dest = path.join(this.dir, `TeamCode-${this.state.version}-${this.key}${ext}`);
    // Clear out older downloads.
    for (const f of fs.readdirSync(this.dir)) if (f !== path.basename(dest)) fs.rmSync(path.join(this.dir, f), { force: true, recursive: true });
    if (fs.existsSync(dest) && (!asset.size || fs.statSync(dest).size === asset.size) && (await this.verify(dest, asset))) {
      this.file = dest;
      return this.set({ status: 'ready', progress: 1 });
    }
    this.set({ status: 'downloading', progress: 0 });
    const res = await get(`${this.feedUrl}/download/${this.key}`);
    const total = Number(res.headers['content-length']) || asset.size || 0;
    const part = `${dest}.part`;
    let got = 0;
    let lastEmit = 0;
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(part);
      res.on('data', (c) => {
        got += c.length;
        if (total && Date.now() - lastEmit > 250) { lastEmit = Date.now(); this.set({ progress: got / total }); }
      });
      res.on('error', reject);
      out.on('error', reject);
      out.on('finish', resolve);
      res.pipe(out);
    });
    if (asset.size && fs.statSync(part).size !== asset.size) { fs.rmSync(part, { force: true }); throw new Error('Downloaded update is incomplete'); }
    if (!(await this.verify(part, asset))) { fs.rmSync(part, { force: true }); throw new Error('Downloaded update failed its checksum'); }
    fs.renameSync(part, dest);
    this.file = dest;
    this.set({ status: 'ready', progress: 1 });
  }

  async verify(file, asset) {
    const m = /^sha256:([0-9a-f]{64})$/i.exec(asset.digest || '');
    if (!m) return true; // older releases carry no digest; size was already checked
    const hash = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
    return hash.digest('hex') === m[1].toLowerCase();
  }

  // Starts the installer in a detached process. The caller quits the app straight after.
  async install({ relaunch }) {
    if (this.state.status !== 'ready' || !this.file) return false;
    // In development the running "app" is Electron inside node_modules; never overwrite it.
    if (!this.canInstall) throw new Error('Updates only install in the packaged app.');
    if (this.key === 'windows') {
      spawn(this.file, ['--updated', '/S', ...(relaunch ? ['--force-run'] : [])], { detached: true, stdio: 'ignore' }).unref();
    } else {
      const bundle = path.resolve(process.execPath, '..', '..', '..');
      if (!bundle.endsWith('.app') || /\/AppTranslocation\/|^\/Volumes\//.test(bundle)) {
        throw new Error('Move TeamCode to your Applications folder to install updates.');
      }
      try { fs.accessSync(path.dirname(bundle), fs.constants.W_OK); } catch { throw new Error(`TeamCode can't write to ${path.dirname(bundle)}. Install this update by opening the downloaded file.`); }
      const script = path.join(os.tmpdir(), `teamcode-update-${process.pid}.sh`);
      fs.writeFileSync(script, `#!/bin/sh
while kill -0 "$TC_PID" 2>/dev/null; do sleep 0.3; done
MNT=$(mktemp -d /tmp/teamcode-update.XXXXXX)
hdiutil attach -nobrowse -noautoopen -quiet -mountpoint "$MNT" "$TC_DMG" || exit 1
SRC=$(ls -d "$MNT"/*.app | head -n 1)
if [ -n "$SRC" ] && ditto "$SRC" "$TC_APP.updating"; then
  rm -rf "$TC_APP" && mv "$TC_APP.updating" "$TC_APP"
  xattr -cr "$TC_APP" 2>/dev/null
fi
rm -rf "$TC_APP.updating"
hdiutil detach -quiet "$MNT"
rmdir "$MNT" 2>/dev/null
[ "$TC_RELAUNCH" = 1 ] && open "$TC_APP"
rm -f "$0"
`, { mode: 0o755 });
      spawn('/bin/sh', [script], { detached: true, stdio: 'ignore', env: { ...process.env, TC_PID: String(process.pid), TC_DMG: this.file, TC_APP: bundle, TC_RELAUNCH: relaunch ? '1' : '0' } }).unref();
    }
    this.set({ status: 'installing' });
    return true;
  }
}

module.exports = { Updater, newer, platformKey };
