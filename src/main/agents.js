'use strict';
// Runs Claude Code agents for tasks. Each agent gets:
//   - the teamcode MCP server (coordination tools)
//   - hooks that version-check edits, publish file changes and inject relevant team updates
//   - a targeted briefing built from the shared workspace context
//   - optionally its own git worktree + branch (isolated mode) for safe parallel work
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const git = require('./git');
const { spawnSpec, shellQuote, findNode, isRunnable, isDesktopApp, claudeVersion } = require('./claude-cli');

const NAMES = ['Nova', 'Atlas', 'Pixel', 'Echo', 'Orbit', 'Sage', 'Blaze', 'Quill', 'Rune', 'Flux', 'Iris', 'Kite', 'Lumen', 'Mako', 'Halo', 'Cosmo', 'Dash', 'Juno', 'Vega', 'Zephyr'];
const EDIT_TOOLS = 'Edit|Write|MultiEdit|NotebookEdit';
// Allowed for agents in every permission mode (Windows agents run commands through the PowerShell tool).
const SAFE_COMMANDS = ['npm test', 'npm run test', 'node --test', 'git status', 'git diff', 'git log', 'git show'];
const isWin = process.platform === 'win32';

const clip = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'task';
const q = (p) => `"${p}"`;

class AgentManager extends EventEmitter {
  constructor({ conn, server, user, root, dataDir, getSettings, getState, scripts }) {
    super();
    Object.assign(this, { conn, server, user, root, dataDir, getSettings, getState, scripts });
    this.running = new Map();
    this.logs = new Map();
    this.metaFile = path.join(dataDir, 'agents.json');
    try { this.meta = JSON.parse(fs.readFileSync(this.metaFile, 'utf8')); } catch { this.meta = {}; }
    this.handoffBeats = new Map();
    for (const m of Object.values(this.meta)) if (m.handedOff) this._keepAlive(m.agentId);
  }

  // While an agent continues in Claude Code, this app keeps it marked alive so the server never treats
  // it as gone and hands its task to a new agent (which would replace its worktree).
  _keepAlive(agentId) {
    if (this.handoffBeats.has(agentId)) return;
    const beat = () => this.conn.call('heartbeat', { agentId }).catch(() => {});
    beat();
    this.handoffBeats.set(agentId, setInterval(beat, 20000));
  }

  _stopKeepAlive(agentId) {
    clearInterval(this.handoffBeats.get(agentId));
    this.handoffBeats.delete(agentId);
  }

  handedOffTasks() { return new Set(Object.values(this.meta).filter((m) => m.handedOff).map((m) => m.taskId)); }

  // Closing or switching projects: stop keep-alive timers (the next open resumes them from meta).
  dispose() {
    for (const id of [...this.handoffBeats.keys()]) this._stopKeepAlive(id);
  }

  _saveMeta() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.writeFileSync(this.metaFile, JSON.stringify(this.meta, null, 1));
  }

  runtime() {
    return Object.fromEntries(Object.entries(this.meta).map(([id, m]) => [id, { ...m, running: this.running.has(id), pendingTurns: this.running.get(id)?.pendingTurns || 0 }]));
  }

  log(agentId, kind, text) {
    const list = this.logs.get(agentId) || [];
    const entry = { ts: Date.now(), kind, text: clip(text, 6000) };
    list.push(entry);
    if (list.length > 1500) list.splice(0, list.length - 1500);
    this.logs.set(agentId, list);
    this.emit('log', agentId, entry);
  }

  getLog(agentId) { return this.logs.get(agentId) || []; }

  _pickName() {
    // Agents started in the same tick aren't in the snapshot yet, so also count names handed out locally.
    this.namesTaken ||= new Set();
    const used = new Set([...Object.values(this.getState()?.agents || {}).map((a) => a.name.split(' ')[0]), ...this.namesTaken]);
    const name = NAMES.find((n) => !used.has(n)) || `Agent-${crypto.randomBytes(2).toString('hex')}`;
    this.namesTaken.add(name);
    return name;
  }

  // Confirms Claude Code can actually run before any task or agent state changes, so a broken setup
  // fails once with a clear message instead of starting (and failing) agent after agent.
  async checkClaude() {
    const p = this.getSettings().claudePath;
    const fix = 'Open Settings, Claude Code, and press Detect.';
    if (!p) throw setupError(`Claude Code wasn't found on this computer. Install it (curl -fsSL https://claude.ai/install.sh | bash), then ${fix}`);
    if (isDesktopApp(p)) throw setupError(`TeamCode is pointed at the Claude desktop app, not Claude Code. ${fix}`);
    if (!isRunnable(p)) throw setupError(`TeamCode can't run Claude Code at ${p}. ${fix}`);
    if (this._verifiedClaude !== p) {
      if (!(await claudeVersion(p))) throw setupError(`Claude Code at ${p} didn't respond. ${fix}`);
      this._verifiedClaude = p;
    }
  }

  // manual: started by a person (Start / Retry), which may restart a failed or finished task.
  async startTask(taskId, { manual = false } = {}) {
    if (this.handedOffTasks().has(taskId)) throw new Error('This task is being worked on in Claude Code. Send it for review first.');
    await this.checkClaude();
    const task = this.getState()?.tasks?.[taskId];
    if (!task) throw new Error('Task not found');
    if ([...this.running.values()].some((r) => r.taskId === taskId && !r.exited)) throw new Error('An agent is already running this task');

    const agentId = 'agt_' + crypto.randomBytes(5).toString('hex');
    const name = this._pickName();
    let mode = task.mode;
    let cwd = this.root, branch = 'main', worktree = null, baseCommit = null;
    if (mode === 'isolated') {
      if (await git.isRepo(this.root) && await git.hasCommits(this.root)) {
        branch = `teamcode/${slug(task.title)}-${taskId.slice(-4)}`;
        worktree = path.join(this.dataDir, 'worktrees', `${slug(task.title)}-${taskId.slice(-6)}`);
        const wt = await git.createWorktree(this.root, worktree, branch);
        cwd = worktree; baseCommit = wt.baseCommit;
        // Dependencies that finished on their own branches but aren't merged yet: build on top of their work.
        const merged = await this._mergeDependencyBranches(agentId, task, worktree);
        if (merged) baseCommit = await git.head(worktree);
      } else {
        mode = 'shared';
        this.log(agentId, 'system', 'Isolated mode needs a git repository with at least one commit, so this agent runs in the shared working copy instead.');
      }
    }

    await this.conn.call('registerAgent', { agentId, name, client: 'Claude Code', taskId, userId: this.user.id, mode, branch, cwd });
    try {
      await this.conn.call('startTask', { taskId, agentId, branch, worktree, baseCommit, force: manual && ['failed', 'done', 'cancelled'].includes(task.status) });
    } catch (e) {
      await this.conn.call('agentExited', { agentId, outcome: 'stopped' }).catch(() => {});
      throw e;
    }
    if (worktree) await this.conn.call('branchCreated', { taskId, branch, worktree, baseCommit });
    this.meta[agentId] = { agentId, name, taskId, mode, branch, worktree, baseCommit, cwd, sessionId: null, startedAt: Date.now() };
    this._saveMeta();

    const ctx = await this.conn.call('getContext', { agentId });
    this.log(agentId, 'system', `${name} starting "${task.title}" (${mode === 'isolated' ? `isolated worktree on ${branch}` : 'shared working copy'})`);
    this._spawn(agentId, this._briefing(name, task, ctx, mode, branch));
    this.emit('started', { agentId, name, taskId });
    return { agentId, name };
  }

  async _mergeDependencyBranches(agentId, task, worktree) {
    let merged = 0;
    for (const id of task.dependsOn || []) {
      const dep = this.getState()?.tasks?.[id];
      if (!dep || dep.mode !== 'isolated' || !dep.branch || dep.branch === 'main' || dep.integration?.state === 'merged') continue;
      const exists = (await git.git(this.root, ['rev-parse', '--verify', `refs/heads/${dep.branch}`], { allowFail: true })).code === 0;
      if (!exists) { this.log(agentId, 'system', `Dependency "${dep.title}" is on ${dep.branch}, which isn't on this computer. Its code won't be in this worktree until it's merged.`); continue; }
      const r = await git.merge(worktree, dep.branch, `Build on "${dep.title}" (TeamCode dependency)`);
      if (r.ok) { merged++; this.log(agentId, 'system', `Included unmerged dependency "${dep.title}" from ${dep.branch}`); }
      else this.log(agentId, 'error', `Could not combine dependency "${dep.title}" (${r.conflicts.join(', ') || r.error}). Starting without it.`);
    }
    return merged;
  }

  _briefing(name, task, ctx, mode, branch) {
    const lines = [];
    lines.push(`You are ${name}, an AI developer agent. Several AI agents and humans are working on this project at the same time through TeamCode; behave like a member of one team.`);
    lines.push(`\n## Your task: ${task.title}\n${task.description || '(no further description)'}`);
    if (task.files?.length) lines.push(`Expected files: ${task.files.join(', ')}`);
    lines.push(mode === 'isolated'
      ? `You are working in your own git worktree on branch "${branch}". Your changes are reviewed and merged after you finish; do not commit; TeamCode commits for you.`
      : 'You are working in the shared working copy: other agents and teammates edit this same folder live. Keep edits focused on your task.');
    if (ctx.dependencies?.length) lines.push('\n## Tasks you depend on\n' + ctx.dependencies.map((d) => `- ${d.title} [${d.status}]${d.summary ? `: ${clip(d.summary, 300)}` : ''}`).join('\n'));
    if (ctx.dependents?.length) lines.push('\n## Tasks that depend on you (publish contracts for them early)\n' + ctx.dependents.map((d) => `- ${d.title} [${d.status}]`).join('\n'));
    if (ctx.activeAgents?.length) lines.push('\n## Other agents working right now\n' + ctx.activeAgents.map((a) => `- ${a.name}: ${a.task || 'no task'} (${a.status}${a.branch && a.branch !== 'main' ? `, branch ${a.branch}` : ''})${a.editing.length ? `, editing ${a.editing.slice(0, 6).join(', ')}` : ''}`).join('\n'));
    const contracts = (ctx.contracts || []).filter((c) => c.content);
    if (contracts.length) lines.push('\n## Agreed interface contracts\n' + contracts.map((c) => `### ${c.name} v${c.version}\n${clip(c.content, 3000)}`).join('\n'));
    const others = (ctx.contracts || []).filter((c) => !c.content);
    if (others.length) lines.push(`Other contracts available via get_contract: ${others.map((c) => `${c.name} v${c.version}`).join(', ')}`);
    if (ctx.decisions?.length) lines.push('\n## Team decisions (follow these)\n' + ctx.decisions.map((d) => `- ${d.title}: ${d.decision}`).join('\n'));
    if (ctx.openBlockers?.length) lines.push('\n## Open blockers\n' + ctx.openBlockers.map((b) => `- ${b.description}${b.task ? ` (task ${b.task})` : ''}`).join('\n'));
    if (task.parallelNotes?.length) lines.push('\n## Parallel-work warnings\n' + task.parallelNotes.map((p) => `- Task "${p.title}" also expects to touch ${p.files.join(', ')}. Coordinate before large edits there.`).join('\n'));
    if (ctx.notes?.length) lines.push('\n## Recent discoveries\n' + ctx.notes.slice(-6).map((n) => `- ${n.by}: ${clip(n.message, 200)}`).join('\n'));
    lines.push(`\n## How to collaborate
- TeamCode hooks tell you automatically when teammates change files you have read, and will stop an edit if a file changed since you read it. When that happens, re-read the file and re-apply your change on top. Never overwrite others' work.
- Use the teamcode MCP tools: announce_edit before big edits to shared files; publish_contract as soon as you define an interface another task depends on; record_decision for architectural choices; report_blocker instead of guessing another task's API; publish_update (kind "progress") at real milestones only. Keep messages short.
- Stay within your task's scope and do not refactor code owned by other tasks.
- When finished: run the relevant tests if the project has them, call update_task_status with status "completed" and a 1-3 sentence summary, then stop.`);
    return lines.join('\n');
  }

  _files(agentId, m) {
    const dir = path.join(this.dataDir, 'agents', agentId);
    fs.mkdirSync(dir, { recursive: true });
    const node = findNode();
    const runtime = node || process.execPath;
    const env = {
      TEAMCODE_URL: this.server.url, TEAMCODE_WORKSPACE: this.server.workspace, TEAMCODE_TOKEN: this.server.token,
      TEAMCODE_AGENT_ID: agentId, TEAMCODE_AGENT_NAME: m.name, TEAMCODE_ROOT: m.cwd, TEAMCODE_BRANCH: m.branch,
      TEAMCODE_TASK_ID: m.taskId, TEAMCODE_CLIENT: 'Claude Code', TEAMCODE_USER_ID: this.user.id, TEAMCODE_MODE: m.mode,
    };
    const mcpFile = path.join(dir, 'mcp.json');
    fs.writeFileSync(mcpFile, JSON.stringify({ mcpServers: { teamcode: { type: 'stdio', command: runtime, args: [this.scripts.mcp], env: { ...env, ...(node ? {} : { ELECTRON_RUN_AS_NODE: '1' }) } } } }, null, 1));
    const hook = (extra = '') => [{ type: 'command', command: `${q(runtime)} ${q(this.scripts.hook)}${extra}`, timeout: 10 }];
    const settingsFile = path.join(dir, 'settings.json');
    fs.writeFileSync(settingsFile, JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: EDIT_TOOLS, hooks: hook() }],
        PostToolUse: [{ matcher: '.*', hooks: hook() }],
        UserPromptSubmit: [{ hooks: hook() }],
        Stop: [{ hooks: hook() }],
      },
    }, null, 1));
    return { mcpFile, settingsFile, env: { ...env, ...(node ? {} : { ELECTRON_RUN_AS_NODE: '1' }) } };
  }

  _spawn(agentId, prompt, resumeSessionId) {
    const m = this.meta[agentId];
    const settings = this.getSettings();
    const { mcpFile, settingsFile, env } = this._files(agentId, m);
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--mcp-config', mcpFile, '--settings', settingsFile,
      '--permission-mode', settings.permissionMode || 'acceptEdits',
      // Read-only git and the project's test commands are safe to allow in every permission mode.
      '--allowedTools', 'mcp__teamcode', ...SAFE_COMMANDS.flatMap((c) => [`Bash(${c}:*)`, `PowerShell(${c}:*)`])];
    if (settings.model) args.push('--model', settings.model);
    if (resumeSessionId) args.push('--resume', resumeSessionId);
    const spec = spawnSpec(settings.claudePath, findNode());
    const child = spawnCli(spec, args, {
      cwd: m.cwd, env: { ...process.env, ...env }, windowsHide: true, shell: !!spec.shell, detached: !isWin,
    });
    const run = { child, taskId: m.taskId, pendingTurns: 0, stopping: false, handoff: false, exited: false, lastResult: null, notLoggedIn: false, spawnError: null };
    run.done = new Promise((resolve) => { run.markDone = resolve; });
    this.running.set(agentId, run);
    this.emit('runtime');
    run.heartbeat = setInterval(() => this.conn.call('heartbeat', { agentId }).catch(() => {}), 20000);

    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) this._onLine(agentId, run, line);
      }
    });
    let errBuf = '';
    child.stderr.on('data', (d) => { errBuf += d; if (errBuf.length > 20000) errBuf = errBuf.slice(-10000); });
    // A process that dies at once closes its stdin; without a listener that EPIPE would crash the app.
    child.stdin.on('error', () => {});
    child.on('error', (e) => { run.spawnError = launchError(e, spec.command); });
    child.on('close', (code) => {
      run.exited = true;
      this._onExit(agentId, run, code, errBuf).catch((e) => this.log(agentId, 'error', e.message)).finally(() => run.markDone());
    });
    this._send(agentId, prompt);
  }

  _send(agentId, text) {
    const run = this.running.get(agentId);
    if (!run || run.exited || !run.child.stdin.writable) return false;
    run.pendingTurns++;
    run.child.stdin.write(JSON.stringify({ type: 'user', session_id: '', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n');
    return true;
  }

  _onLine(agentId, run, line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return this.log(agentId, 'text', line); }
    const m = this.meta[agentId];
    if (msg.type === 'system' && msg.subtype === 'init') {
      m.sessionId = msg.session_id; m.model = msg.model; this._saveMeta();
      this.emit('runtime'); // the renderer offers Open in Claude Code once there is a session
      const tc = (msg.mcp_servers || []).find((s) => s.name === 'teamcode');
      this.log(agentId, 'system', `Session started (${msg.model || 'Claude'})${tc ? `, teamcode MCP ${tc.status}` : ''}`);
      return;
    }
    if (msg.type === 'assistant') {
      for (const c of msg.message?.content || []) {
        if (c.type === 'text' && c.text.trim()) {
          this.log(agentId, 'text', c.text);
          if (/not logged in|please run \/login|invalid api key/i.test(c.text)) run.notLoggedIn = true;
        } else if (c.type === 'tool_use') this.log(agentId, 'tool', describeTool(c.name, c.input));
      }
      return;
    }
    if (msg.type === 'user') {
      for (const c of msg.message?.content || []) {
        if (c.type === 'tool_result' && c.is_error) {
          const text = Array.isArray(c.content) ? c.content.map((x) => x.text || '').join(' ') : String(c.content || '');
          this.log(agentId, /TeamCode/.test(text) ? 'team' : 'error', clip(text, 800));
        }
      }
      return;
    }
    if (msg.type === 'result') {
      run.lastResult = msg;
      run.pendingTurns = Math.max(0, run.pendingTurns - 1);
      if (msg.is_error || msg.subtype !== 'success') this.log(agentId, 'error', `Turn ended: ${msg.subtype}${msg.result ? `: ${clip(msg.result, 300)}` : ''}`);
      else this.log(agentId, 'result', msg.result || 'Done');
      if (msg.total_cost_usd) { m.costUsd = (m.costUsd || 0) + msg.total_cost_usd; this._saveMeta(); }
      if (run.pendingTurns === 0) run.child.stdin.end();
    }
  }

  // Reports the outcome to the team server BEFORE the run is dropped from `running`: the scheduler runs
  // on 'runtime', and if it ran first it could see the task as still ready and start it again.
  async _onExit(agentId, run, code, errText) {
    clearInterval(run.heartbeat);
    const m = this.meta[agentId];
    // Read the task from the server: the local snapshot can still show it as "ready" when an agent
    // finishes quickly, which would skip completing it.
    const fresh = await this.conn.call('snapshot').catch(() => null);
    const task = fresh?.tasks?.[m.taskId] || this.getState()?.tasks?.[m.taskId];
    // Another live agent may have taken the task over (e.g. after this computer slept): then this agent
    // only reports itself as gone and leaves the task alone.
    const mine = !task?.assignee || task.assignee === agentId;
    try {
      if (run.handoff) {
        this.log(agentId, 'system', 'Continuing in Claude Code. Its work comes back here when you press Send for review.');
        return;
      }
      if (run.stopping) {
        this.log(agentId, 'system', 'Stopped by user');
        await this.conn.call('agentExited', { agentId, outcome: 'stopped' }).catch(() => {});
        // Back to the queue, but not straight back into an agent: wait for someone to start it again.
        if (mine && task && ['running', 'blocked'].includes(task.status)) {
          await this.conn.call('updateTask', { taskId: m.taskId, autoStart: false }).catch(() => {});
          await this.conn.call('reopenTask', { taskId: m.taskId, agentId }).catch(() => {});
        }
        return;
      }
      const res = run.lastResult;
      if (run.notLoggedIn || /not logged in|\/login/i.test(errText)) {
        this.emit('needsLogin');
        this.log(agentId, 'error', 'Claude Code is not signed in. Use Settings, Sign in to Claude Code, then restart the task.');
      }
      if (!mine) {
        this.log(agentId, 'system', `${task.assigneeName || 'Another agent'} has this task now, so this agent's result wasn't recorded on it.`);
        await this.conn.call('agentExited', { agentId, outcome: 'stopped' }).catch(() => {});
      } else if (res && !res.is_error && res.subtype === 'success' && !run.notLoggedIn) {
        const summary = clip(res.result || 'Completed', 1200);
        if (task && ['running', 'blocked'].includes(task.status)) await this.conn.call('completeTask', { agentId, taskId: m.taskId, summary });
        await this._requestReview(agentId, m, task, summary);
        await this.conn.call('agentExited', { agentId, outcome: 'done' });
        this.log(agentId, 'system', 'Finished. Changes sent for review.');
      } else {
        const error = run.spawnError || res?.result || clip(errText.trim(), 500) || `Claude Code stopped unexpectedly (exit code ${code})`;
        this.log(agentId, 'error', error);
        if (run.spawnError) this._verifiedClaude = null;
        await this.conn.call('failTask', { agentId, taskId: m.taskId, error: clip(error, 500) }).catch(() => {});
        await this.conn.call('agentExited', { agentId, outcome: 'error', detail: clip(error, 200) }).catch(() => {});
      }
    } finally {
      // A follow-up may already have resumed this agent under the same id; don't drop that new run.
      if (this.running.get(agentId) === run) this.running.delete(agentId);
      this.emit('runtime');
      this.emit('finished', agentId);
    }
  }

  async _requestReview(agentId, m, task, summary) {
    if (m.worktree) {
      const head = await git.commitAll(m.worktree, `${task?.title || 'TeamCode task'}\n\n${summary}\n\nTeamCode task ${m.taskId} by agent ${m.name}`, { name: `${m.name} (TeamCode agent)`, email: 'agent@teamcode.local' });
      if (!head && !(await git.changedFiles(this.root, m.baseCommit, m.branch)).length) return this.log(agentId, 'system', 'No file changes to review');
      const files = (await git.changedFiles(this.root, m.baseCommit, m.branch)).map((f) => f.path);
      const stats = await git.diffStat(this.root, m.baseCommit, m.branch);
      await this.conn.call('requestReview', { agentId, taskId: m.taskId, summary, files, headCommit: head, stats });
    } else {
      // The agent's last writes may still be on their way through file sync; give them a moment.
      let changes = [];
      for (let i = 0; i < 8; i++) {
        changes = await this.conn.call('taskChanges', { taskId: m.taskId });
        if (changes.length) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      if (!changes.length) return this.log(agentId, 'system', 'No file changes to review');
      await this.conn.call('requestReview', { agentId, taskId: m.taskId, summary });
    }
  }

  async message(agentId, text) {
    if (this.meta[agentId]?.handedOff) throw new Error('This agent is continuing in Claude Code. Message it there.');
    if (this.meta[agentId] && this.handedOffTasks().has(this.meta[agentId].taskId)) throw new Error('Another agent is continuing this task in Claude Code.');
    let live = this.running.get(agentId);
    if (live?.exited) { await live.done; live = this.running.get(agentId); }
    if (live && !live.exited) {
      this.log(agentId, 'user', text);
      this._send(agentId, text);
      return { queued: true };
    }
    const m = this.meta[agentId];
    if (!m) throw new Error('This agent was not started on this computer');
    if (!m.sessionId) throw new Error('This agent has no session to continue');
    if (!fs.existsSync(m.cwd)) throw new Error('This agent\'s folder no longer exists (its work was merged or removed). Start a new agent from the task instead.');
    if ([...this.running.entries()].some(([id, r]) => id !== agentId && r.taskId === m.taskId && !r.exited)) throw new Error('Another agent is running this task now.');
    const task = (await this.conn.call('snapshot').catch(() => null))?.tasks?.[m.taskId] || this.getState()?.tasks?.[m.taskId];
    if (task?.status === 'done' && task.integration?.state === 'merged') throw new Error('This task was merged. Reopen it from the board to keep working on it.');
    await this.conn.call('registerAgent', { agentId, name: m.name, client: 'Claude Code', taskId: m.taskId, userId: this.user.id, mode: m.mode, branch: m.branch, cwd: m.cwd });
    if (task && task.status !== 'running') await this.conn.call('startTask', { taskId: m.taskId, agentId, branch: m.branch, worktree: m.worktree, baseCommit: m.baseCommit, force: true });
    this.log(agentId, 'user', text);
    this._spawn(agentId, text, m.sessionId);
    return { resumed: true };
  }

  stop(agentId) {
    const run = this.running.get(agentId);
    if (!run || run.exited) return false;
    run.stopping = true;
    killTree(run.child);
    return true;
  }

  stopAll() { for (const id of this.running.keys()) this.stop(id); }

  // Hands an agent's conversation to an interactive Claude Code window (Terminal on Mac, a console on
  // Windows). The background run stops, the same session resumes with the same team tools and hooks, and
  // the task stays with this agent (kept alive, never auto-restarted) until the person presses Send for review.
  // `open` launches the script; the handoff only counts once it succeeds.
  async openInClaudeCode(agentId, open) {
    const m = this.meta[agentId];
    if (!m) throw new Error('This agent was not started on this computer');
    if (m.handedOff) throw new Error('This agent is already continuing in Claude Code');
    if (this.handedOffTasks().has(m.taskId)) throw new Error('Another agent is already continuing this task in Claude Code.');
    if ([...this.running.entries()].some(([id, r]) => id !== agentId && r.taskId === m.taskId && !r.exited)) throw new Error('Another agent is running this task. Stop it first.');
    if (!isWin && process.platform !== 'darwin') throw new Error('Open in Claude Code works on Mac and Windows');
    await this.checkClaude();
    if (!m.sessionId) throw new Error('This agent has no conversation yet. Wait until it has started, then try again.');
    if (!fs.existsSync(m.cwd)) throw new Error(`This agent's folder no longer exists (${m.cwd}).`);
    const freshTask = async () => (await this.conn.call('snapshot').catch(() => null))?.tasks?.[m.taskId] || this.getState()?.tasks?.[m.taskId];
    let task = await freshTask();
    if (task && ['done', 'cancelled'].includes(task.status)) throw new Error('This task is already finished.');

    const run = this.running.get(agentId);
    if (run?.exited) await run.done;
    else if (run) {
      run.handoff = true;
      killTree(run.child);
      await Promise.race([run.done, new Promise((r) => setTimeout(r, 10000))]);
    }
    // The run may have just finished, failed or been stopped: decide from the task as it is now.
    task = await freshTask();
    if (task && ['done', 'cancelled'].includes(task.status)) throw new Error('This task finished before it could be handed over.');
    const theirs = task?.assignee && task.assignee !== agentId && this.getState()?.agents?.[task.assignee];
    if (theirs && ['starting', 'working', 'idle', 'waiting', 'blocked'].includes(theirs.status)) throw new Error(`${theirs.name} is working on this task now.`);
    // A failed or stopped agent takes its task back first, the same way a follow-up message does.
    if (!task || !['running', 'blocked'].includes(task.status)) {
      await this.conn.call('registerAgent', { agentId, name: m.name, client: 'Claude Code', taskId: m.taskId, userId: this.user.id, mode: m.mode, branch: m.branch, cwd: m.cwd });
      await this.conn.call('startTask', { taskId: m.taskId, agentId, branch: m.branch, worktree: m.worktree, baseCommit: m.baseCommit, force: true });
    }
    const settings = this.getSettings();
    const { mcpFile, settingsFile, env } = this._files(agentId, m);
    const args = ['--resume', m.sessionId, '--mcp-config', mcpFile, '--settings', settingsFile, '--permission-mode', settings.permissionMode || 'acceptEdits'];
    if (settings.model) args.push('--model', settings.model);
    const spec = spawnSpec(settings.claudePath, findNode());
    const file = terminalScript(path.join(this.dataDir, 'scripts'), agentId, m.cwd, env, [spec.command, ...spec.prefix, ...args]);
    try {
      await open(file);
    } catch (e) {
      fs.rmSync(file, { force: true });
      // Couldn't open a window: release the task like a Stop would.
      await this.conn.call('agentExited', { agentId, outcome: 'stopped' }).catch(() => {});
      await this.conn.call('updateTask', { taskId: m.taskId, autoStart: false }).catch(() => {});
      await this.conn.call('reopenTask', { taskId: m.taskId, agentId }).catch(() => {});
      this.emit('runtime');
      throw e;
    }
    m.handedOff = true;
    this._saveMeta();
    await this.conn.call('updateTask', { taskId: m.taskId, autoStart: false }).catch(() => {});
    this._keepAlive(agentId);
    this.log(agentId, 'system', 'Opened in Claude Code');
    this.emit('runtime');
    return true;
  }

  // The person is done with a handed-off agent: record completion and send its changes for review.
  async finishHandoff(agentId) {
    const m = this.meta[agentId];
    if (!m?.handedOff) throw new Error('This agent is not in Claude Code');
    // If any step fails, the handoff stays in place so Send for review can simply be pressed again.
    try {
      const task = (await this.conn.call('snapshot').catch(() => null))?.tasks?.[m.taskId] || this.getState()?.tasks?.[m.taskId];
      const summary = clip(task?.summary || 'Finished in Claude Code', 1200);
      if (task && !['done', 'cancelled'].includes(task.status)) await this.conn.call('completeTask', { agentId, taskId: m.taskId, summary });
      await this._requestReview(agentId, m, task, summary);
      await this.conn.call('agentExited', { agentId, outcome: 'done' }).catch(() => {});
      m.handedOff = false;
      m.finishedAt = Date.now();
      this._saveMeta();
      this._stopKeepAlive(agentId);
      this.log(agentId, 'system', 'Finished in Claude Code. Changes sent for review.');
    } finally {
      this.emit('runtime');
    }
    return true;
  }

  // Orchestrator: ask Claude (read-only) to propose a dependency-aware task breakdown.
  planFeature(request) {
    const settings = this.getSettings();
    if (!settings.claudePath) return Promise.reject(new Error('Claude Code was not found. Set its location in Settings.'));
    const state = this.getState();
    const existing = Object.values(state?.tasks || {}).filter((t) => !['cancelled'].includes(t.status)).map((t) => `- ${t.title} [${t.status}]`).join('\n') || '(none)';
    const prompt = `You are the orchestrator for a team of AI coding agents that work in parallel on this repository. Break the feature request below into well-defined subtasks for separate agents.

Feature request:
${request}

Tasks already on the board:
${existing}

Briefly explore the repository (Read, Grep, Glob) so the plan refers to real files and structure.

Rules:
- Only split work into parallel tasks when they touch mostly different files. Work that depends heavily on the same files or on an undecided architectural choice must be one task, or sequenced with depends_on.
- Each task needs a clear spec with acceptance criteria, and names the interface contract it provides or consumes so dependents can build against it early.
- depends_on lists zero-based indexes into your tasks array. Tests/docs depend on what they verify unless they can be written against a published contract.
- Prefer 2-5 tasks. mode "isolated" (own git branch, merged after review) for substantial work; "shared" for small edits.

Respond with ONLY a JSON object, no prose:
{"summary":"...","tasks":[{"title":"...","description":"...","depends_on":[],"files":["..."],"mode":"isolated","contract":""}],"risks":["..."]}`;
    return new Promise((resolve, reject) => {
      const spec = spawnSpec(settings.claudePath, findNode());
      const args = ['-p', '--output-format', 'json', '--allowedTools', 'Read', 'Grep', 'Glob', '--max-turns', '25'];
      if (settings.model) args.push('--model', settings.model);
      const child = spawnCli(spec, args, { cwd: this.root, windowsHide: true, shell: !!spec.shell });
      let out = '', err = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err += d; });
      child.on('error', reject);
      child.on('close', () => {
        try {
          const r = JSON.parse(out);
          if (/not logged in|\/login/i.test(r.result || '')) { this.emit('needsLogin'); throw new Error('Claude Code is not signed in'); }
          const text = String(r.result || '');
          const json = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
          if (!Array.isArray(json.tasks)) throw new Error('No tasks in plan');
          resolve(json);
        } catch (e) {
          reject(new Error(`Planning failed: ${e.message}${err ? `: ${clip(err, 300)}` : ''}`));
        }
      });
      child.stdin.end(prompt);
    });
  }

  // Start a follow-up agent in the task's worktree to merge main and resolve conflicts.
  async resolveConflictsWithAgent(taskId) {
    const entry = Object.values(this.meta).filter((m) => m.taskId === taskId && m.worktree).pop();
    if (!entry) throw new Error('No worktree for this task on this computer');
    const instructions = `Integration check found merge conflicts between your branch "${entry.branch}" and the main working copy. In your worktree, run \`git merge ${await git.currentBranch(this.root)}\` (the main branch), resolve every conflict so both your work and the other changes are preserved, make sure it builds/tests pass, and commit the merge. Then call update_task_status completed with a short summary.`;
    return this.message(entry.agentId, instructions);
  }
}

function describeTool(name, input = {}) {
  const short = (p) => String(p || '').replace(/\\/g, '/').split('/').slice(-3).join('/');
  switch (name) {
    case 'Read': return `📖 Read ${short(input.file_path)}`;
    case 'Edit': case 'MultiEdit': return `✏️ Edit ${short(input.file_path)}`;
    case 'Write': return `📝 Write ${short(input.file_path)}`;
    case 'Bash': case 'PowerShell': return `$ ${clip(input.command, 200)}`;
    case 'Grep': return `🔎 Grep "${clip(input.pattern, 80)}"`;
    case 'Glob': return `🔎 Glob ${clip(input.pattern, 80)}`;
    case 'TodoWrite': return `☑️ Updated plan (${(input.todos || []).length} items)`;
    case 'WebFetch': case 'WebSearch': return `🌐 ${name} ${clip(input.url || input.query, 100)}`;
    default:
      if (name.startsWith('mcp__teamcode__')) return `🤝 ${name.slice(15)} ${clip(JSON.stringify(input), 160)}`;
      return `🔧 ${name}`;
  }
}

// Spawns the CLI; a .cmd shim needs a shell, so pass one pre-quoted command line instead of an args array.
function spawnCli(spec, args, opts) {
  if (!spec.shell) return spawn(spec.command, [...spec.prefix, ...args], opts);
  return spawn([`"${spec.command}"`, ...shellQuote([...spec.prefix, ...args])].join(' '), [], opts);
}

function setupError(message) {
  const e = new Error(message);
  e.code = 'claude_setup';
  return e;
}

// Node reports a failed launch as an errno (EACCES = permission denied, ENOENT = missing). Say what it means.
function launchError(e, command) {
  if (e.code === 'EACCES') return `Couldn't start Claude Code: ${command} isn't a program this computer can run. Open Settings, Claude Code, and press Detect.`;
  if (e.code === 'ENOENT') return `Couldn't start Claude Code: ${command} doesn't exist anymore. Open Settings, Claude Code, and press Detect.`;
  return `Couldn't start Claude Code: ${e.message}`;
}

// Writes a one-shot script that opens a terminal in `cwd` with the TeamCode env and runs `cmd`.
// The script deletes itself when it starts, because it carries the workspace token.
function terminalScript(dir, agentId, cwd, env, cmd) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (isWin) {
    const f = path.join(dir, `claude-${agentId}.cmd`);
    const sets = Object.entries(env).map(([k, v]) => `set "${k}=${String(v).replace(/"/g, '')}"`).join('\r\n');
    // chcp 65001: read the rest of this UTF-8 file correctly (folder names with non-ASCII characters).
    // `call` returns here after a .cmd shim, so the script can still delete itself.
    const run = `${/\.(cmd|bat)$/i.test(cmd[0]) ? 'call ' : ''}${[`"${cmd[0]}"`, ...shellQuote(cmd.slice(1))].join(' ')}`;
    fs.writeFileSync(f, `@echo off\r\nchcp 65001>nul\r\ntitle TeamCode agent\r\n${sets}\r\ncd /d "${cwd}" || exit /b 1\r\n${run}\r\n(goto) 2>nul & del "%~f0"\r\n`, { mode: 0o600 });
    return f;
  }
  const sq = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;
  const f = path.join(dir, `claude-${agentId}.command`);
  const exports = Object.entries(env).map(([k, v]) => `export ${k}=${sq(v)}`).join('\n');
  fs.writeFileSync(f, `#!/bin/sh\nrm -f "$0"\n${exports}\ncd ${sq(cwd)} || exit 1\nexec ${cmd.map(sq).join(' ')}\n`, { mode: 0o700 });
  return f;
}

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (isWin) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
  else { try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); } }
}

module.exports = { AgentManager, describeTool };
