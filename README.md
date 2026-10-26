# TeamCode

**Your dev team and all of its AI agents, working on one codebase at the same time.**

TeamCode is a desktop app for Mac and Windows that runs on top of your own Claude Code. You open a local folder or repository, invite your teammates, and everyone works in it at once. Each person's Claude Code agents see the rest of the team's changes in real time, coordinate through a shared workspace, and hand their work back for review and a safe merge.

- **Real-time sync.** Files sync both ways between everyone's folders as they're saved. Concurrent edits to the same file are 3-way merged. When an edit really conflicts, both versions are kept and nothing is silently overwritten.
- **Multi-agent coordination.** Every agent knows which tasks, files, interfaces and decisions the other agents are working on, without you relaying messages between them.
- **Parallel tasks.** You can describe a feature and Claude breaks it into subtasks with dependencies. Independent tasks start at the same time, and dependent ones wait for the interfaces they need.
- **Safe integration.** Isolated agents work on their own git worktree and branch. Before anything lands in the main working copy you get per-task diffs, test runs, conflict and API-break detection, and an approve, reject or revert step.

---

## Quick start

```bash
npm install
npm start
```

Requirements:

- **Node 18+**
- **git 2.38+**
- **Claude Code**

You can install Claude Code with `npm i -g @anthropic-ai/claude-code`. TeamCode also finds the copy that ships with the Claude desktop app. If Claude Code isn't signed in yet, click **Sign in to Claude Code** in the app.

1. **Open a project**: pick a folder or repo, or clone one from Git.
2. **Invite your team**: click **👥 Invite**, then **Share**, and send the `tc1.…` invite code to your teammates.
3. **Teammates join**: in TeamCode they click **Join your team**, paste the code and pick a folder. The files sync down and stay in sync from then on.
4. **Create tasks**: use **＋ New task**, or **✨ Plan a feature** to have Claude split a feature into parallel tasks. Tasks marked ⚡ auto start an agent as soon as their dependencies are done.
5. **Watch and steer**: the **Agents** panel shows every agent's task, status, the files it's editing, its progress, discoveries, conflicts and blockers. Open an agent's live log to message it.
6. **Review and merge**: the **Review** panel shows each task's diff and four separate gates (Completed → Tests → Integration → Approval). From there you can approve and merge, reject, or revert.

Shortcuts: `Ctrl/⌘+N` creates a new task, `Ctrl/⌘+P` plans a feature, `Ctrl/⌘+1…7` switches views, and `Esc` closes dialogs.

### Teams on different networks

The host's TeamCode runs the shared workspace server on port **4477**. Teammates can reach it in three ways:

- **Same network:** use the invite code as-is.
- **Over the internet:** expose the port with a tunnel or a port-forward, for example `cloudflared tunnel --url http://localhost:4477`. Then set **Settings → Public server URL** so that invites use that address.
- **Always-on server:** run the workspace without the desktop app, for example on a VPS:

  ```bash
  npm run server -- --port 4477 --data ./teamcode-data --workspace my-team --name "My Team" --public-url https://teamcode.example.com
  ```

  This prints an invite code that everyone, including you, joins with.

### Build installers

```bash
npm run dist:win   # Windows NSIS installer  -> dist/
npm run dist:mac   # macOS dmg + zip (run on a Mac; sign/notarize for distribution)
```

On Windows, if the build fails with "Cannot create symbolic link", turn on Developer Mode (Settings → System → For developers) or run the build from an elevated terminal once.

---

## How the multi-agent system works

```
 ┌──────────── Desktop app (each teammate) ────────────┐        ┌──────── Workspace server ────────┐
 │ UI ── IPC ── ProjectSession                          │  WS    │ Coordinator (per workspace)      │
 │               ├─ SyncClient  (chokidar ⇄ file sync)  │◀──────▶│  • live state: agents, tasks,    │
 │               ├─ AgentManager → claude -p (per task) │        │    files+versions, reservations, │
 │               │     ├─ teamcode MCP server  ──HTTP──┐│        │    contracts, decisions,         │
 │               │     └─ Claude Code hooks    ──HTTP──┤│──────▶ │    blockers, reviews, conflicts  │
 │               └─ git worktrees / review / merge     ││  HTTP  │  • append-only event log (seq)   │
 └──────────────────────────────────────────────────────┘        │  • 3-way merge, persistence      │
                                                                  └──────────────────────────────────┘
```

### Shared live context (`server/coordinator.js`)

The server keeps one central state for each workspace. That state holds:

- tasks and their dependencies
- agent identities, statuses and heartbeats
- which files each agent has read, reserved or edited
- file versions and history
- branches and worktrees
- interface contracts
- architectural decisions, notes and discoveries
- blockers
- coordination requests
- pending reviews
- conflicts and integration risks

Agents don't load the whole thing. `get_context` returns only what's relevant to the agent's own task: its dependencies and dependents, the contracts its dependencies publish, team decisions, reservations on its files, recent changes to those files, open conflicts and any stale contracts.

### Events and delivery

Every change becomes a structured event. Each event records:

- `seq` and `id`
- `type`
- `ts` (timestamp)
- `workspace`
- `actor`, with its `kind` (user, agent or system), `id` and `name`
- `task`
- `files`
- `branch`
- `version`
- `data`
- a human-readable `summary`

The event types are:

`task.created`, `task.assigned`, `task.ready`, `task.started`, `task.blocked`, `task.completed`, `task.failed`, `agent.joined`, `agent.status_changed`, `agent.progress`, `agent.error`, `agent.approach_changed`, `file.edit_started`, `file.changed`, `file.edit_completed`, `branch.created`, `changes.review_requested`, `changes.approved`, `changes.rejected`, `changes.merged`, `changes.reverted`, `conflict.detected`, `conflict.resolved`, `test.completed`, `integration.checked`, `decision.recorded`, `contract.updated`, `blocker.reported`, `blocker.resolved`, `note.added`, `coordination.requested`, `chat.message`.

The log is persisted, so it survives server restarts:

- **Desktop clients** reconnect with their last `seq` and the server replays everything they missed.
- **Agents** have a server-side cursor. Being connected isn't treated as being informed: updates are actually *delivered* in four ways:
  1. **Claude Code hooks** (`src/agent/hook.js`) inject a de-duplicated digest of the relevant new events into the agent's context after its tool calls (`PostToolUse`), on new prompts, and at session start. Urgent events go out right away; the rest are batched about every 45 s.
  2. **MCP tool results** carry the same digest, so agents on clients without hooks still get it.
  3. **`get_updates`** lets the agent fetch what it missed explicitly, for example after reconnecting.
  4. **The `Stop` hook** won't let an agent finish while urgent updates (conflicts, contract changes, coordination requests, changes to its files) are still unread.

  The server records which agents each event was delivered to, and the Activity view shows this.

What counts as "relevant" to an agent:

- its own task, plus the tasks it depends on and the tasks that depend on it
- files it has read, reserved or edited, and the files its task expects to touch
- decisions, contracts and blockers
- conflicts it is part of
- coordination requests addressed to it

### MCP tools (`src/agent/mcp-server.js`)

| Tool | What it does |
| --- | --- |
| `team_status`, `get_agent` | Find active agents, their declared tasks and statuses, and the files they're editing |
| `get_context` | Targeted shared context for your task |
| `get_updates` | Relevant events you haven't seen yet (advances your cursor) |
| `check_files` | Has this file changed since I read it? Who changed it? Is anyone editing it right now? |
| `announce_edit` / `release_files` | Announce a planned change, either shared or exclusive. Returns any overlaps. |
| `publish_update` | Report progress, discoveries, errors or a change of approach |
| `record_decision` | Record an architectural decision that all agents follow |
| `report_blocker` / `resolve_blocker` | Raise or clear a blocker |
| `publish_contract` / `get_contract` | Shared interface contracts for dependent tasks (versioned) |
| `find_overlaps` | Tasks or agents that touch your files or are in your dependency chain |
| `request_coordination`, `request_review` | Structured, task-focused requests to another agent or for review |
| `update_task_status`, `create_tasks` | Task lifecycle, and the orchestrator's task breakdown |
| `record_file_read` / `record_file_change` | Version tracking for MCP clients that don't have hooks |

Any MCP client can join a workspace: open **Settings → Connect another AI agent** for the configuration.

### Preventing conflicting changes

TeamCode uses several layers so that no single file lock blocks parallel work:

1. **Isolated worktrees.** A task in `isolated` mode runs in its own git worktree on the branch `teamcode/<task>`. Nothing reaches the main copy until it's reviewed.
2. **Version checks.** The `PreToolUse` hook compares the file on disk with the version the agent last read. If someone changed it in between, the edit is refused, along with who changed it and why, and the agent re-reads and re-applies its change.
3. **Soft reservations.** Agents reserve files automatically when they edit them, or explicitly with `announce_edit`. When two agents edit the same file in the shared copy, the second one gets a one-time warning describing the other agent's task and intent. A `conflict.detected (overlap)` event goes to both, and the edit is allowed when retried. `exclusive` reservations can still be used for short, risky rewrites. When the same file changes on different branches, both agents get an `integration_risk` event.
4. **Sync without overwrites.** Every write carries the version it was based on. A write based on an old version is 3-way merged (`git merge-file`). If the merge isn't clean, a conflict record keeps both versions, and the Context → Conflicts view lets you keep one, take the other, or save a hand-merged result.
5. **Contracts.** Dependent tasks build against versioned contracts. If a contract changes while a dependent task is running, that task is notified, and its integration check flags the drift.

### Integration and review

When an agent finishes, its task is marked **Completed**. That is a separate state from **Tests**, **Integration** (clean / conflicts / merged) and **Approval** (pending / approved / rejected / reverted).

The Review view gives you:

- **Diffs:** per task from git, plus a version-based diff for shared-mode tasks.
- **Consolidated changes:** an attributed list of every change, from every agent and person.
- **Tests:** run the workspace's test command inside the task's worktree.
- **Integration checks:**
  - merge-conflict check (`git merge-tree`, which doesn't touch the working copy)
  - API/schema break detection (removed or changed exports, routes, `DROP`/`ALTER`)
  - contract drift
  - overlap with other unmerged tasks
  - uncommitted shared changes that would collide
- **Approve & merge:** a `--no-ff` merge commit that names the task and agent. A merge that conflicts is aborted with nothing changed, and an agent can be asked to resolve it.
- **Reject:** optionally discards the branch. **Revert:** undoes the merge with `git revert -m 1`. For shared tasks, revert restores the files to their pre-task versions but skips any file someone else has changed since.

---

## Tests

```bash
npm test         # acceptance tests (real server, sync, MCP server, hooks, git, agent runner)
npm run smoke    # launches the app, drives every view with demo data, saves screenshots
```

The acceptance suite covers the scenarios from the spec:

1. Two agents edit separate files at the same time and both changes are kept.
2. An agent discovers another agent's change before it modifies the file, and stale edits are refused.
3. Two agents modify the same file: the overlap is detected, non-conflicting edits are merged automatically, and real conflicts keep both versions.
4. An API contract reaches dependent agents, the dependent task is unblocked, and contract drift is flagged.
5. A disconnected agent (and a restarted server) recovers the events it missed, and nothing is delivered twice.
6. The desktop state shows the active agents, their tasks, the files they're editing, and their progress.
7. Changes made through MCP and through the desktop app land in the same workspace, with correct attribution and no duplicate events.
8. Isolated branches are reviewed and merged, a conflicting merge is blocked without losing anything, and revert works.

The suite also runs the agent runner end to end, using a stand-in CLI that executes the real hooks and the MCP config.

## Project layout

```
server/        coordination server (coordinator, HTTP/WS server, merge, invites, standalone CLI)
src/agent/     processes started per agent: MCP server, Claude Code hooks, shared API client
src/main/      Electron main process: app/IPC, project session, sync, agents, git, CLI discovery
src/renderer/  UI (plain HTML/CSS/JS, no build step)
test/          acceptance tests + fake Claude CLI fixture
scripts/       smoke test, icon generator
```

## Security notes

- Each workspace is protected by a random 128-bit token carried in its invite code. Share invite codes only with your team.
- The host's server only listens on the network after you click **Share**. Before that it is bound to `127.0.0.1`.
- For teams that connect over the internet, put the server behind HTTPS, for example with a tunnel or a reverse proxy.
- By default agents use Claude Code's `acceptEdits` permission mode. "Full auto" (`bypassPermissions`) lets agents run commands without asking. Only turn it on for projects you trust.
