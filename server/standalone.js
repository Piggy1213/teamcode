#!/usr/bin/env node
'use strict';
// Run a TeamCode coordination server without the desktop app (e.g. on Railway or a VPS so remote teammates can join).
// Every option can also come from env: PORT, TEAMCODE_DATA, TEAMCODE_WORKSPACE, TEAMCODE_NAME, TEAMCODE_TOKEN, TEAMCODE_PUBLIC_URL.
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
  const id = args.workspace || process.env.TEAMCODE_WORKSPACE || 'team-' + crypto.randomBytes(3).toString('hex');
  const w = server.coordinator.ensureWorkspace(id, { name: args.name || process.env.TEAMCODE_NAME || id, token: args.token || process.env.TEAMCODE_TOKEN });
  await server.listen(port, args.host || '0.0.0.0');
  const url = args['public-url'] || process.env.TEAMCODE_PUBLIC_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : `http://localhost:${port}`);
  console.log(`TeamCode server listening on port ${port}`);
  console.log(`Workspace: ${w.state.meta.name} (${id})`);
  console.log(`Invite code (paste into TeamCode → Join a team):\n\n${encodeInvite({ url, workspace: id, token: w.token, name: w.state.meta.name })}\n`);
  const stop = async () => { await server.close(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
})().catch((e) => { console.error(e); process.exit(1); });
