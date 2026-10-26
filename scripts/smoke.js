#!/usr/bin/env node
'use strict';
// Launches the real app against a throwaway profile, drives every view with demo data and saves screenshots.
//   npm run smoke            -> screenshots in ./smoke-shots
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const electron = require('electron');

const out = path.resolve(process.argv[2] || 'smoke-shots');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-smoke-'));
fs.rmSync(out, { recursive: true, force: true });
spawnSync(electron, [path.join(__dirname, '..')], { stdio: 'inherit', env: { ...process.env, TEAMCODE_SCREENSHOT: out, TEAMCODE_USERDATA: userData }, timeout: 120000 });
const result = JSON.parse(fs.readFileSync(path.join(out, 'result.json'), 'utf8'));
console.log(result.ok && !result.errors.length ? `UI smoke test passed. Screenshots in ${out}` : `UI smoke test FAILED: ${result.error || result.errors.join('\n')}`);
process.exit(result.ok && !result.errors.length ? 0 : 1);
