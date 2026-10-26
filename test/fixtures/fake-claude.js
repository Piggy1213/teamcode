#!/usr/bin/env node
'use strict';
// Stand-in for the Claude Code CLI used by the tests. It speaks the same stream-json protocol and
// exercises the real wiring TeamCode sets up: it runs the configured hooks around a file write and
// calls the teamcode MCP server from --mcp-config. Behaviour is driven by FAKE_CLAUDE_FILE / FAKE_CLAUDE_TEXT.
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
if (args.includes('--version')) { console.log('9.9.9 (Fake Claude Code)'); process.exit(0); }

const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const settings = JSON.parse(fs.readFileSync(opt('--settings'), 'utf8'));
const mcpConfig = JSON.parse(fs.readFileSync(opt('--mcp-config'), 'utf8'));
const sessionId = opt('--resume') || 'fake-session-' + process.pid;

function runHooks(event, toolName, payload) {
  const results = [];
  for (const group of settings.hooks[event] || []) {
    if (group.matcher && !new RegExp(`^(${group.matcher})$`).test(toolName || '')) continue;
    for (const h of group.hooks) {
      const stdout = execSync(h.command, { input: JSON.stringify({ hook_event_name: event, tool_name: toolName, session_id: sessionId, cwd: process.cwd(), ...payload }), encoding: 'utf8' });
      if (stdout.trim()) results.push(JSON.parse(stdout));
    }
  }
  return results;
}

function mcpCall(tool, toolArgs) {
  return new Promise((resolve, reject) => {
    const s = mcpConfig.mcpServers.teamcode;
    const p = spawn(s.command, s.args, { env: { ...process.env, ...s.env }, stdio: ['pipe', 'pipe', 'inherit'] });
    let buf = '';
    p.stdout.on('data', (d) => {
      buf += d;
      for (const line of buf.split('\n')) {
        if (!line.trim()) continue;
        try { const m = JSON.parse(line); if (m.id === 2) { p.kill(); resolve(m.result); } } catch { /* partial line */ }
      }
    });
    p.on('error', reject);
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake', version: '1' } } }) + '\n');
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: tool, arguments: toolArgs } }) + '\n');
  });
}

let buf = '';
let handled = false;
process.stdin.on('data', async (d) => {
  buf += d;
  if (handled || !buf.includes('\n')) return;
  handled = true;
  const first = JSON.parse(buf.slice(0, buf.indexOf('\n')));
  const prompt = first.message.content[0].text;
  out({ type: 'system', subtype: 'init', session_id: sessionId, model: 'fake-model', cwd: process.cwd(), mcp_servers: [{ name: 'teamcode', status: 'connected' }] });
  const file = path.join(process.cwd(), process.env.FAKE_CLAUDE_FILE || 'agent-output.txt');
  const input = { file_path: file, content: process.env.FAKE_CLAUDE_TEXT || 'hello from fake agent\n' };
  out({ type: 'assistant', message: { content: [{ type: 'text', text: `Working on it (prompt had ${prompt.length} chars)` }, { type: 'tool_use', id: 't1', name: 'Write', input }] } });
  const pre = runHooks('PreToolUse', 'Write', { tool_input: input });
  const denied = pre.find((r) => r.hookSpecificOutput?.permissionDecision === 'deny');
  if (denied) {
    out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: denied.hookSpecificOutput.permissionDecisionReason }] } });
  } else {
    fs.writeFileSync(file, input.content);
    const post = runHooks('PostToolUse', 'Write', { tool_input: input, tool_response: { success: true } });
    const ctx = post.map((r) => r.hookSpecificOutput?.additionalContext).filter(Boolean).join('\n');
    out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' + (ctx ? `\n${ctx}` : '') }] } });
  }
  const r = await mcpCall('publish_update', { kind: 'progress', message: `Wrote ${path.basename(file)}` });
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'mcp__teamcode__publish_update', input: {} }] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: denied ? 'Could not write file' : `Done: wrote ${path.basename(file)}`, session_id: sessionId, total_cost_usd: 0.01, mcpOk: !r.isError });
});
process.stdin.on('end', () => process.exit(0));
