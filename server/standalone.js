#!/usr/bin/env node
'use strict';
// Run a TeamCode coordination server without the desktop app (e.g. on a VPS so remote teammates can join).
//   node server/standalone.js --port 4477 --data ./teamcode-data --workspace my-team --name "My Team" --public-url http://my-server:4477
const path = require('path');
const crypto = require('crypto');
const { TeamServer } = require('./server');
const { encodeInvite } = require('./invite');

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]);
  return acc;
}, []));

(async () => {
  const port = Number(args.port || process.env.PORT || 4477);
  const server = new TeamServer({ dataDir: path.resolve(args.data || process.env.TEAMCODE_DATA || './teamcode-data') });
  const id = args.workspace || 'team-' + crypto.randomBytes(3).toString('hex');
  const w = server.coordinator.ensureWorkspace(id, { name: args.name || id, token: args.token || process.env.TEAMCODE_TOKEN });
  await server.listen(port, args.host || '0.0.0.0');
  const url = args['public-url'] || `http://localhost:${port}`;
  console.log(`TeamCode server listening on port ${port}`);
  console.log(`Workspace: ${w.state.meta.name} (${id})`);
  console.log(`Invite code (paste into TeamCode → Join a team):\n\n${encodeInvite({ url, workspace: id, token: w.token, name: w.state.meta.name })}\n`);
  const stop = async () => { await server.close(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
})().catch((e) => { console.error(e); process.exit(1); });
