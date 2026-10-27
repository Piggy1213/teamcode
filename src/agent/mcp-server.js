#!/usr/bin/env node
'use strict';
// TeamCode MCP server (stdio). Lets any MCP-capable AI agent join a TeamCode workspace and coordinate:
// discover agents, read targeted context, receive missed updates, reserve files, publish progress,
// decisions, blockers and interface contracts, and request coordination or review.
const { loadConfig, agentCall, post, register, relPath, fileHash, mcpIdentity, pruneProcs } = require('./api');

// A bad or missing config must not crash before the MCP handshake: report it from every tool instead.
let cfg = null, cfgError = null;
try { cfg = loadConfig(); } catch (e) { cfgError = e.message; }
let registered = null;
// The agent this Claude Code runs as: the one its hooks recorded (also after /clear, or when this server was
// restarted after one), else the one derived from its session id, which its hooks derive too.
let identity = null;
if (cfg?.perSession) pruneProcs(cfg);
function settleIdentity() {
  if (!cfg?.perSession) return;
  const id = mcpIdentity(cfg) || identity;
  if (!id) return;
  if (id.agentId !== cfg.agentId) registered = null; // registers again under the right id
  identity = id;
  Object.assign(cfg, id);
}

const S = (props, required = []) => ({ type: 'object', properties: props, required, additionalProperties: false });
const str = (description) => ({ type: 'string', description });
const strs = (description) => ({ type: 'array', items: { type: 'string' }, description });

const TOOLS = [
  {
    name: 'team_status',
    description: 'List the active AI agents (name, client, task, status, files being edited) and all tasks with their status and dependencies. Call this to discover who is working on what.',
    inputSchema: S({}),
    run: () => agentCall(cfg, 'teamStatus'),
  },
  {
    name: 'get_context',
    description: 'Get targeted shared context for your task: task spec, dependency status, agreed interface contracts, decisions, open blockers, notes, other agents\' reservations on your files and recent changes to them. Call before starting work and again when you get update notices. Optionally narrow with files or a topic.',
    inputSchema: S({ files: strs('Extra files you plan to touch (paths relative to the project root)'), topic: str('Optional keyword to filter decisions, contracts and notes'), task_id: str('Task to get context for (defaults to your own)') }),
    run: (a) => agentCall(cfg, 'getContext', { files: a.files, topic: a.topic, taskId: a.task_id }),
  },
  {
    name: 'get_updates',
    description: 'Fetch workspace events relevant to your work that you have not seen yet (file changes by others, contract updates, decisions, conflicts, dependency progress). Advances your read cursor. Set all=true to see every event, not only relevant ones.',
    inputSchema: S({ all: { type: 'boolean', description: 'Include events not related to your task or files' } }),
    run: (a) => agentCall(cfg, 'getUpdates', { all: !!a.all }),
    noDigest: true,
  },
  {
    name: 'get_agent',
    description: 'Read another agent\'s declared task, status, files they are editing, and recent progress updates.',
    inputSchema: S({ agent: str('Agent name or id') }, ['agent']),
    run: (a) => agentCall(cfg, 'getAgent', { agent: a.agent }),
  },
  {
    name: 'check_files',
    description: 'Before modifying files, check whether they changed since you last read them, who changed them last, and whether another agent is editing them.',
    inputSchema: S({ paths: strs('File paths relative to the project root') }, ['paths']),
    run: (a) => {
      const paths = (a.paths || []).map((p) => relPath(cfg, p) || p);
      const hashes = Object.fromEntries(paths.map((p) => [p, fileHash(cfg, p)]).filter(([, h]) => h));
      return agentCall(cfg, 'checkFiles', { paths, hashes });
    },
  },
  {
    name: 'announce_edit',
    description: 'Announce files you are about to change and why, so other agents are warned. Returns overlaps with other agents. Use exclusive=true only for short, risky rewrites where concurrent edits would break things.',
    inputSchema: S({ paths: strs('Files you will change'), intent: str('One line: what you will change'), exclusive: { type: 'boolean' } }, ['paths', 'intent']),
    run: (a) => agentCall(cfg, 'announceEdit', { paths: (a.paths || []).map((p) => relPath(cfg, p) || p), intent: a.intent, exclusive: !!a.exclusive }),
  },
  {
    name: 'release_files',
    description: 'Release your edit reservations once you are done with files (omit paths to release all).',
    inputSchema: S({ paths: strs('Files to release') }),
    run: (a) => agentCall(cfg, 'releaseFiles', { paths: a.paths && a.paths.map((p) => relPath(cfg, p) || p) }),
  },
  {
    name: 'publish_update',
    description: 'Share a concise update with the team. kind: progress (milestone reached), discovery (technical finding others should know), error (problem you hit), approach (you changed your plan).',
    inputSchema: S({ kind: { type: 'string', enum: ['progress', 'discovery', 'error', 'approach'] }, message: str('One or two sentences'), files: strs('Related files') }, ['kind', 'message']),
    run: (a) => agentCall(cfg, 'publishUpdate', { kind: a.kind, message: a.message, files: a.files }),
  },
  {
    name: 'record_decision',
    description: 'Record an architectural or technical decision so every agent follows it.',
    inputSchema: S({ title: str('Short name'), decision: str('What was decided'), rationale: str('Why'), files: strs('Affected files') }, ['title', 'decision']),
    run: (a) => agentCall(cfg, 'recordDecision', a),
  },
  {
    name: 'report_blocker',
    description: 'Report something blocking your task (e.g. a missing API from another task). Marks your task blocked until resolved.',
    inputSchema: S({ description: str('What is blocking you'), needs: str('What would unblock you'), blocking_task: str('Task id that must deliver something') }, ['description']),
    run: (a) => agentCall(cfg, 'reportBlocker', { description: a.description, needs: a.needs, blockingTask: a.blocking_task }),
  },
  {
    name: 'resolve_blocker',
    description: 'Mark a blocker as resolved.',
    inputSchema: S({ blocker_id: str('Blocker id'), resolution: str('How it was resolved') }, ['blocker_id']),
    run: (a) => agentCall(cfg, 'resolveBlocker', { blockerId: a.blocker_id, resolution: a.resolution }),
  },
  {
    name: 'publish_contract',
    description: 'Publish or update a shared interface contract (API signatures, types, schema, events) that dependent tasks build against. Publish as soon as the interface is agreed, before the implementation is finished.',
    inputSchema: S({ name: str('Contract name, e.g. "track-export API"'), content: str('The interface: types, function signatures, endpoints, schema'), description: str('One line summary') }, ['name', 'content']),
    run: (a) => agentCall(cfg, 'publishContract', a),
  },
  {
    name: 'get_contract',
    description: 'Get a shared interface contract by name, or list all contracts if name is omitted.',
    inputSchema: S({ name: str('Contract name') }),
    run: (a) => agentCall(cfg, 'getContract', { name: a.name }),
  },
  {
    name: 'find_overlaps',
    description: 'Find tasks and agents whose files or dependencies overlap with yours.',
    inputSchema: S({ task_id: str('Task id (defaults to yours)') }),
    run: (a) => agentCall(cfg, 'findOverlaps', { taskId: a.task_id }),
  },
  {
    name: 'request_coordination',
    description: 'Send a concise, task-focused coordination request to another agent (or all agents if "to" is omitted), e.g. to sequence edits to a shared file or agree an interface.',
    inputSchema: S({ to: str('Agent name or id'), subject: str('Short subject'), message: str('What you need'), files: strs('Related files') }, ['subject', 'message']),
    run: (a) => agentCall(cfg, 'requestCoordination', a),
  },
  {
    name: 'request_review',
    description: 'Ask for your changes to be reviewed and integrated. Completion is not the same as approval: a human or reviewer decides.',
    inputSchema: S({ summary: str('What changed and how it was verified') }, ['summary']),
    run: (a) => agentCall(cfg, 'requestReview', { summary: a.summary }),
  },
  {
    name: 'update_task_status',
    description: 'Update your task status: started, completed (with summary), failed (with reason), or blocked.',
    inputSchema: S({ status: { type: 'string', enum: ['started', 'completed', 'failed', 'blocked'] }, summary: str('Summary or reason'), task_id: str('Task id, if you were not started on a task (see team_status)') }, ['status']),
    run: async (a) => {
      if (a.status === 'completed') return agentCall(cfg, 'completeTask', { summary: a.summary, taskId: a.task_id });
      if (a.status === 'failed') return agentCall(cfg, 'failTask', { error: a.summary, taskId: a.task_id });
      if (a.status === 'blocked') return agentCall(cfg, 'reportBlocker', { description: a.summary || 'Blocked', taskId: a.task_id });
      // Claim a task on the board (assigns it to this session) when one is named.
      if (a.task_id) return agentCall(cfg, 'startTask', { taskId: a.task_id });
      return agentCall(cfg, 'setAgentStatus', { status: 'working', detail: a.summary || 'started' });
    },
  },
  {
    name: 'create_tasks',
    description: 'Add tasks to the shared TeamCode board. depends_on may reference other new tasks by title or zero-based index. Only split work that can genuinely proceed in parallel. Set start_on_my_computer to have the TeamCode app on this person\'s computer start a Claude Code agent for each task as soon as it is ready.',
    inputSchema: S({
      tasks: {
        type: 'array',
        items: S({ title: str('Title'), description: str('Spec, acceptance criteria, interfaces'), depends_on: { type: 'array', items: { type: ['string', 'integer'] } }, files: strs('Files it will likely touch'), mode: { type: 'string', enum: ['shared', 'isolated'] } }, ['title']),
      },
      start_on_my_computer: { type: 'boolean', description: 'Start an agent for each task automatically on this person\'s computer (needs the TeamCode app open)' },
    }, ['tasks']),
    run: (a) => {
      if (a.start_on_my_computer && !cfg.userId) throw new Error('This connection is not linked to a TeamCode user. Add it from the TeamCode app (Settings, Claude Code) to start tasks on your computer.');
      const runOn = a.start_on_my_computer ? { runner: cfg.userId, runnerName: cfg.userName || cfg.name, autoStart: true } : {};
      return agentCall(cfg, 'createTasks', { tasks: (a.tasks || []).map((t) => ({ ...t, dependsOn: t.depends_on, ...runOn })) });
    },
  },
  {
    name: 'start_task',
    description: 'Have the TeamCode app on this person\'s computer start a Claude Code agent for a task (now if it is ready, otherwise as soon as its dependencies are done). Restarts failed or finished tasks.',
    inputSchema: S({ task_id: str('Task id from team_status') }, ['task_id']),
    run: async (a) => {
      if (!cfg.userId) throw new Error('This connection is not linked to a TeamCode user. Add it from the TeamCode app (Settings, Claude Code) to start tasks on your computer.');
      const snap = await agentCall(cfg, 'snapshot', {});
      const current = snap.tasks?.[a.task_id];
      if (!current) throw new Error(`No task ${a.task_id}. Use team_status to see task ids.`);
      // Same rule as the server: a task is taken only while a live agent is on it.
      const owner = current.assignee && snap.agents?.[current.assignee];
      const busy = ['running', 'blocked'].includes(current.status) && owner && ['starting', 'working', 'idle', 'waiting', 'blocked', 'stale'].includes(owner.status) && owner.task?.id === current.id;
      if (busy) return `"${current.title}" is ${current.status} with ${current.assigneeName || 'another agent'}. It can be started here once that agent stops.`;
      // One step: reopened and handed to this person's computer together, so no other computer can start it
      // in between. If another agent grabbed it meanwhile this fails and nothing has been changed.
      const runner = { runner: cfg.userId, runnerName: cfg.userName || cfg.name, autoStart: true };
      let t = await agentCall(cfg, 'reopenTask', { taskId: a.task_id, ...runner });
      if (t.runner !== cfg.userId || !t.autoStart) t = await agentCall(cfg, 'updateTask', { taskId: a.task_id, ...runner }); // older server
      return `"${t.title}" will start on ${cfg.userName ? `${cfg.userName}'s` : 'your'} computer ${t.status === 'ready' ? 'in a moment' : 'when its dependencies are done'}. The TeamCode app needs to be open.`;
    },
  },
  {
    name: 'record_file_read',
    description: 'For MCP clients without TeamCode hooks: record that you read files, so later version checks can tell you if they changed.',
    inputSchema: S({ paths: strs('Files you read') }, ['paths']),
    run: async (a) => {
      for (const p of a.paths || []) { const r = relPath(cfg, p) || p; await agentCall(cfg, 'agentRead', { path: r, hash: fileHash(cfg, r) }); }
      return { recorded: a.paths.length };
    },
  },
  {
    name: 'record_file_change',
    description: 'For MCP clients without TeamCode hooks: publish that you changed a file so other agents are notified.',
    inputSchema: S({ path: str('File you changed'), summary: str('What changed') }, ['path']),
    run: (a) => { const r = relPath(cfg, a.path) || a.path; const hash = fileHash(cfg, r); return agentCall(cfg, 'fileEdited', { path: r, hash, deleted: hash === null, summary: a.summary }); },
  },
];

const INSTRUCTIONS = `TeamCode connects you with other AI agents working on the same project at the same time.
Workflow: (1) call get_context before starting; (2) before changing files another agent may touch, call check_files or announce_edit; (3) publish_update at milestones and for discoveries; record_decision for architectural choices; (4) publish_contract as soon as an interface others depend on is defined; (5) report_blocker instead of guessing about another task's API; (6) when done, update_task_status completed and request_review. Team updates relevant to you are appended to tool results. Act on them. Keep messages short and task-focused.`;

function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return send({ jsonrpc: '2.0', id, result: { protocolVersion: params?.protocolVersion || '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'teamcode', version: '1.0.0' }, instructions: INSTRUCTIONS } });
  }
  if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
  if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) } });
  if (method === 'tools/call') {
    const tool = TOOLS.find((t) => t.name === params?.name);
    if (!tool) return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Unknown tool ${params?.name}` }], isError: true } });
    // A connection file is re-read on every call: the app rewrites it when the project's address changes.
    if (cfgError || cfg?.external) {
      try {
        const next = loadConfig();
        if (cfg && next.url !== cfg.url) registered = null;
        cfg = identity ? Object.assign(next, identity) : next; cfgError = null;
      } catch (e) { cfgError = e.message; }
    }
    if (cfgError) return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `TeamCode isn't connected: ${cfgError}` }], isError: true } });
    try {
      settleIdentity();
      if (!registered) registered = await register(cfg);
      const result = await tool.run(params.arguments || {});
      let text = typeof result === 'string' ? result : JSON.stringify(result, null, 1);
      if (!tool.noDigest) {
        const d = await agentCall(cfg, 'pullDigest', {}).catch(() => null);
        if (d?.text) text += `\n\n${d.text}`;
      }
      return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } });
    } catch (e) {
      return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `TeamCode error: ${e.message}` }], isError: true } });
    }
  }
  if (id !== undefined && id !== null) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    handle(msg).catch(() => {});
  }
});
// Claude Code is quitting, or restarting this server (it closes stdin, then may signal). A task this connection
// was on goes back to the queue now rather than after the 10-minute timeout; if this same Claude Code comes back
// (a restarted server is the same agent), it carries on with it.
let ending = false;
function end() {
  if (ending) return;
  ending = true;
  if (!cfg || cfg.taskId || !registered) return process.exit(0);
  settleIdentity();
  post(cfg, 'releaseTask', { agentId: cfg.agentId, resumable: true }, 2000).catch(() => {}).finally(() => process.exit(0));
}
process.stdin.on('end', end);
process.on('SIGINT', end);
process.on('SIGTERM', end);

// A connection added from the app registers on its first tool call or heartbeat (by then its hooks have recorded
// which agent this Claude Code is, and a quick probe such as `claude mcp list` never shows up as an agent).
// Anything else registers now. The heartbeat lets the workspace tell live agents from stale ones.
if (cfg && !cfg.perSession) register(cfg).then((r) => { registered = r; }).catch(() => {});
setInterval(() => {
  if (!cfg) return;
  settleIdentity();
  agentCall(cfg, 'heartbeat', {}).then(() => { registered ||= true; }).catch(() => {});
}, 30000).unref();
