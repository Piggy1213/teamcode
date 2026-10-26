#!/usr/bin/env node
'use strict';
// Live end-to-end run with the real Claude Code CLI (no UI needed):
//   node scripts/live-test.js <project-folder> "<feature request>"
// Hosts a workspace, asks Claude to plan the feature, runs the tasks as parallel agents,
// then reviews, tests and merges each one. Prints an invite code so you can watch from the app.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { TeamServer } = require('../server/server');
const { encodeInvite } = require('../server/invite');
const { ProjectSession } = require('../src/main/session');
const { findClaude } = require('../src/main/claude-cli');

const [root, feature] = process.argv.slice(2);
if (!root || !feature) { console.error('Usage: node scripts/live-test.js <project-folder> "<feature request>"'); process.exit(1); }
const PORT = Number(process.env.TEAMCODE_LIVE_PORT || 4488);
const MAX_MINUTES = Number(process.env.TEAMCODE_LIVE_MINUTES || 25);
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s]`, ...a);

(async () => {
  const claudePath = process.env.CLAUDE_PATH || findClaude(null);
  if (!claudePath) throw new Error('Claude Code CLI not found');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-live-'));
  const server = new TeamServer({ dataDir: path.join(dataDir, 'server') });
  await server.listen(PORT, '0.0.0.0');
  const ws = server.coordinator.ensureWorkspace('live-demo', { name: path.basename(root) });
  log(`Workspace server on :${PORT}. Watch live in TeamCode → Join your team with this invite code:\n\n${encodeInvite({ url: `http://127.0.0.1:${PORT}`, workspace: 'live-demo', token: ws.token, name: path.basename(root) })}\n`);

  const user = { id: 'usr_live_host', name: 'Lachie' };
  const settings = { claudePath, autoRun: true, maxParallel: 2, permissionMode: process.env.TEAMCODE_PERMISSION || 'acceptEdits', model: process.env.TEAMCODE_MODEL || '' };
  const session = new ProjectSession({
    project: { root: path.resolve(root), name: path.basename(root), role: 'host', url: `http://127.0.0.1:${PORT}`, workspace: 'live-demo', token: ws.token },
    user, getSettings: () => settings, send: () => {}, dataDir, notify: () => {},
    scripts: { hook: path.join(__dirname, '..', 'src', 'agent', 'hook.js'), mcp: path.join(__dirname, '..', 'src', 'agent', 'mcp-server.js') },
  });
  await session.start();
  while (!session.state) await new Promise((r) => setTimeout(r, 100));
  ws.on('event', (e) => { if (!['agent.status_changed', 'file.edit_completed'].includes(e.type) || e.data?.to === 'blocked') log(`📣 ${e.type.padEnd(26)} ${e.summary}`); });
  session.agents.on('log', (id, entry) => {
    const name = session.agents.meta[id]?.name || id;
    if (['tool', 'team', 'error', 'result', 'system'].includes(entry.kind)) log(`   ${name.padEnd(6)} ${entry.kind === 'team' ? '🤝 ' : ''}${entry.text.replace(/\s+/g, ' ').slice(0, 220)}`);
  });

  log(`Planning: "${feature}"`);
  const plan = await session.agents.planFeature(feature);
  log(`Plan: ${plan.summary || ''}`);
  plan.tasks.forEach((t, i) => log(`  #${i + 1} ${t.title} [${t.mode}] deps=${JSON.stringify(t.depends_on || [])} files=${(t.files || []).join(', ')}`));
  (plan.risks || []).forEach((r) => log(`  risk: ${r}`));
  const created = await session.call('createTasks', {
    tasks: plan.tasks.map((t) => ({
      title: t.title, description: t.description + (t.contract ? `\n\nInterface contract: "${t.contract}" (publish or consume it via the teamcode contract tools).` : ''),
      dependsOn: t.depends_on || [], files: t.files || [], mode: 'isolated', runner: user.id, runnerName: user.name, autoStart: true,
    })),
  });
  log(`Created ${created.length} tasks; ${created.filter((t) => ws.state.tasks[t.id].status === 'ready').length} can start immediately (max 2 agents in parallel).`);

  // Wait until every task is done or failed.
  const deadline = t0 + MAX_MINUTES * 60000;
  let peak = 0;
  while (Date.now() < deadline) {
    peak = Math.max(peak, session.agents.running.size);
    const ts = created.map((t) => ws.state.tasks[t.id]);
    if (ts.every((t) => ['done', 'failed', 'cancelled'].includes(t.status)) && session.agents.running.size === 0) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (Date.now() >= deadline) { log('⏰ Time limit reached; stopping agents'); session.agents.stopAll(); await new Promise((r) => setTimeout(r, 3000)); }

  // Review & integrate each completed task in dependency order.
  await session.call('updateSettings', { settings: { testCommand: 'npm test' } });
  await new Promise((r) => setTimeout(r, 500));
  const report = [];
  for (const c of created) {
    const t = ws.state.tasks[c.id];
    const row = { task: t.title, agent: t.assigneeName, status: t.status, files: t.review?.files || [] };
    if (t.status === 'done' && t.review?.state === 'pending') {
      const check = await session.checkIntegration(t.id);
      row.integration = check.state; row.risks = check.risks.map((r) => r.message);
      const tests = await session.runTests(t.id);
      row.testsOnBranch = tests.passed ? 'passed' : 'FAILED';
      const merged = await session.approve(t.id, { checkpoint: true });
      row.merged = merged.ok ? merged.commit?.slice(0, 8) || 'yes' : `no (${merged.conflicts ? 'conflicts: ' + merged.conflicts.join(', ') : merged.error || 'needs checkpoint'})`;
    }
    report.push(row);
  }
  const finalTests = await session.runTests(null);
  const agents = Object.values(ws.state.agents);
  const coord = ws.events.filter((e) => ['conflict.detected', 'contract.updated', 'decision.recorded', 'coordination.requested', 'note.added', 'blocker.reported'].includes(e.type));
  const delivered = [...ws.delivered.values()].reduce((n, s) => n + s.size, 0);
  console.log('\n================ LIVE TEST REPORT ================');
  console.log(`Duration: ${((Date.now() - t0) / 60000).toFixed(1)} min · peak parallel agents: ${peak} · events: ${ws.state.seq} · event deliveries to agents: ${delivered}`);
  console.log(`Agents: ${agents.map((a) => `${a.name} (${a.status}, edited ${Object.keys(a.edited).length} files, cost $${(session.agents.meta[a.id]?.costUsd || 0).toFixed(2)})`).join('; ')}`);
  for (const r of report) console.log(JSON.stringify(r));
  console.log(`Coordination events: ${coord.map((e) => `${e.type}: ${e.summary}`).join('\n  ') || 'none'}`);
  console.log(`Final tests on merged main: ${finalTests.passed ? 'PASSED' : 'FAILED'}\n${finalTests.output.split('\n').filter((l) => /^ℹ (tests|pass|fail)/.test(l)).join('\n')}`);
  console.log('==================================================');
  await session.stop();
  await server.close();
  process.exit(0);
})().catch((e) => { console.error('LIVE TEST ERROR:', e); process.exit(1); });
