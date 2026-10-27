#!/usr/bin/env node
'use strict';
// Claude Code hook handler. This is the delivery mechanism that keeps each agent in sync with the team
// without relying on the agent to poll:
//   SessionStart / UserPromptSubmit  -> inject a targeted briefing + missed updates
//   PreToolUse  (Edit/Write/...)     -> version check + overlap check; deny with an explanation if unsafe
//   PostToolUse (Read)               -> record which version of a file the agent saw
//   PostToolUse (Edit/Write/...)     -> publish file.changed; inject relevant team updates
//   Stop                             -> don't let the agent finish while urgent team updates are unread
// Any failure exits 0 silently so the agent is never blocked by TeamCode being unavailable.
const { loadConfig, agentCall, post, relPath, fileHash } = require('./api');

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', () => resolve(data));
    setTimeout(() => resolve(data), 3000);
  });
}

function out(obj) {
  process.stdout.write(JSON.stringify(obj));
}

async function main() {
  const input = JSON.parse((await readStdin()) || '{}');
  const cfg = loadConfig();
  // Personal hooks (from "Add to Claude Code") inside an agent TeamCode launched: its own hooks already run.
  if (cfg.insideAgent) return;
  // Fall back to Claude Code's cwd only when no project root was configured (env or connection file).
  if (!process.env.TEAMCODE_ROOT && !cfg.external && input.cwd) cfg.root = input.cwd;
  const event = input.hook_event_name;
  const tool = input.tool_name;
  const file = input.tool_input?.file_path || input.tool_input?.notebook_path;

  // The Claude Code session closed (or was cleared). Its agent is done; a task it was still on goes back to the
  // queue. Only for per-session agents: an older Claude Code shares one agent between sessions.
  if (event === 'SessionEnd') {
    if (cfg.perSession) await post(cfg, 'agentExited', { agentId: cfg.agentId, outcome: 'done', detail: 'Claude Code session ended' }, 3000).catch(() => {});
    return;
  }

  if (event === 'PreToolUse' && EDIT_TOOLS.has(tool)) {
    const rel = relPath(cfg, file);
    if (!rel) return;
    const diskHash = fileHash(cfg, rel);
    const r = await agentCall(cfg, 'preEdit', { path: rel, diskHash, exists: diskHash !== null }, 4000);
    if (r.decision === 'deny') {
      out({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: r.reason } });
    }
    return;
  }

  if (event === 'PostToolUse') {
    const rel = relPath(cfg, file);
    if (tool === 'Read' && rel) await agentCall(cfg, 'agentRead', { path: rel, hash: fileHash(cfg, rel) }, 4000);
    if (EDIT_TOOLS.has(tool) && rel) {
      const hash = fileHash(cfg, rel);
      await agentCall(cfg, 'fileEdited', { path: rel, hash, deleted: hash === null }, 4000);
    }
    const d = await agentCall(cfg, 'pullDigest', {}, 4000);
    if (d.text) out({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: d.text } });
    return;
  }

  if (event === 'SessionStart' || event === 'UserPromptSubmit') {
    const parts = [];
    if (event === 'SessionStart') {
      const ctx = await agentCall(cfg, 'getContext', {}, 5000);
      parts.push(`You are "${cfg.name}", one of several AI agents working on this project at the same time through TeamCode. Use the teamcode MCP tools to stay coordinated (get_context, check_files, announce_edit, publish_update, publish_contract, request_coordination).`);
      if (ctx.activeAgents?.length) parts.push('Other active agents:\n' + ctx.activeAgents.map((a) => `- ${a.name}: ${a.task || 'no task'} (${a.status})${a.editing.length ? ` editing ${a.editing.slice(0, 5).join(', ')}` : ''}`).join('\n'));
      if (ctx.decisions?.length) parts.push('Team decisions:\n' + ctx.decisions.map((d) => `- ${d.title}: ${d.decision}`).join('\n'));
      if (ctx.contracts?.length) parts.push('Published interface contracts (fetch with get_contract): ' + ctx.contracts.map((c) => `${c.name} v${c.version}`).join(', '));
    }
    const d = await agentCall(cfg, 'pullDigest', { force: true }, 4000);
    if (d.text) parts.push(d.text);
    if (parts.length) out({ hookSpecificOutput: { hookEventName: event, additionalContext: parts.join('\n\n') } });
    return;
  }

  if (event === 'Stop' && !input.stop_hook_active) {
    const d = await agentCall(cfg, 'pullDigest', {}, 4000);
    if (d.text && /conflict\.detected|contract\.updated|coordination\.requested|file\.changed/.test(d.text)) {
      out({ decision: 'block', reason: `Before finishing, account for these team updates (verify your work is still correct against them, then finish):\n${d.text}` });
    }
  }
}

// Exit only after stdout has flushed (pipes are asynchronous on macOS).
main().catch(() => { /* never block the agent on coordination failures */ }).finally(() => process.stdout.write('', () => process.exit(0)));
