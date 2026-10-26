'use strict';
// Visual smoke test: TEAMCODE_SCREENSHOT=<dir> TEAMCODE_USERDATA=<tmp> electron .
// Opens a demo project, fills it with a realistic multi-agent scenario and captures every view as PNG.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app } = require('electron');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run(win, { handlers, getSession, config }) {
  const out = process.env.TEAMCODE_SCREENSHOT;
  fs.mkdirSync(out, { recursive: true });
  const shot = async (name) => { await sleep(500); fs.writeFileSync(path.join(out, `${name}.png`), (await win.webContents.capturePage()).toPNG()); };
  const js = (code) => win.webContents.executeJavaScript(code);
  try {
    await new Promise((r) => win.webContents.once('did-finish-load', r));
    config.user.name = 'Lachie';
    await sleep(600);
    await js('S.init.user.name = "Lachie"; S.init.projects = []; renderNow();');
    await shot('01-welcome');

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-demo-'));
    fs.mkdirSync(path.join(root, 'src', 'model'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'model', 'track.ts'), 'export interface Track { id: string; points: [number, number][] }\n');
    fs.writeFileSync(path.join(root, 'package.json'), '{ "name": "track-studio" }\n');
    await handlers['project:open']({ root });
    const s = getSession();
    const me = config.user;
    const call = (op, args) => s.call(op, args);
    const base = { runner: me.id, runnerName: me.name, autoStart: false };
    const model = await call('createTask', { ...base, title: 'Track data model & storage', description: 'Define Track, Segment and persistence API.', mode: 'isolated', files: ['src/model/track.ts', 'src/model/store.ts'], priority: 1 });
    const editor = await call('createTask', { ...base, title: 'Track editor canvas UI', description: 'Draw and edit tracks on a canvas.', mode: 'isolated', dependsOn: [model.id], files: ['src/editor/Canvas.tsx', 'src/model/track.ts'] });
    const exp = await call('createTask', { ...base, title: 'Export tracks to JSON / SVG', description: 'Implement exportTrack().', mode: 'isolated', dependsOn: [model.id], files: ['src/export/index.ts'] });
    await call('createTask', { ...base, title: 'Tests & docs for editor + export', mode: 'shared', dependsOn: [editor.id, exp.id] });
    const polish = await call('createTask', { ...base, title: 'Settings page polish', mode: 'shared', priority: 3 });
    await call('createTask', { ...base, title: 'Keyboard shortcuts for the editor', mode: 'shared', files: ['src/editor/Canvas.tsx'] });

    const agent = async (id, name, taskId, branch) => { await call('registerAgent', { agentId: id, name, client: 'Claude Code', taskId, userId: me.id, mode: 'isolated', branch }); await call('startTask', { taskId, agentId: id, branch }); };
    await agent('agt_demo_nova', 'Nova', model.id, 'teamcode/track-model');
    await call('fileEdited', { agentId: 'agt_demo_nova', path: 'src/model/track.ts', hash: 'h1' });
    await call('publishContract', { agentId: 'agt_demo_nova', name: 'track-model', description: 'Track types + store API', content: 'export interface Track { id: string; name: string; segments: Segment[] }\nexport interface Segment { from: Point; to: Point; kind: "line" | "curve" }\nexport function saveTrack(t: Track): Promise<void>\nexport function loadTrack(id: string): Promise<Track>' });
    await call('publishUpdate', { agentId: 'agt_demo_nova', kind: 'discovery', message: 'IndexedDB wrapper already exists in src/lib/db.ts — reuse it.' });
    await call('recordDecision', { agentId: 'agt_demo_nova', title: 'Coordinates', decision: 'All track coordinates are stored in metres, converted to pixels only in the editor.', rationale: 'Keeps export resolution-independent' });
    await call('completeTask', { agentId: 'agt_demo_nova', summary: 'Track model, Segment type and IndexedDB store implemented with tests.' });
    await call('requestReview', { agentId: 'agt_demo_nova', taskId: model.id, files: ['src/model/track.ts', 'src/model/store.ts'], stats: { files: 2, insertions: 148, deletions: 6 } });
    await call('agentExited', { agentId: 'agt_demo_nova', outcome: 'done' });

    await agent('agt_demo_atlas', 'Atlas', editor.id, 'teamcode/track-editor');
    await call('announceEdit', { agentId: 'agt_demo_atlas', paths: ['src/editor/Canvas.tsx', 'src/editor/tools.ts'], intent: 'Canvas with pan/zoom and segment tools' });
    await call('publishUpdate', { agentId: 'agt_demo_atlas', kind: 'progress', message: 'Canvas renders tracks from the store; working on drag handles.' });
    await agent('agt_demo_pixel', 'Pixel', exp.id, 'teamcode/export');
    await call('announceEdit', { agentId: 'agt_demo_pixel', paths: ['src/export/index.ts', 'src/export/svg.ts'], intent: 'JSON + SVG exporters' });
    await call('preEdit', { agentId: 'agt_demo_atlas', path: 'src/model/track.ts', exists: true, diskHash: 'h1' });
    await call('preEdit', { agentId: 'agt_demo_pixel', path: 'src/model/track.ts', exists: true, diskHash: 'h1' });
    await call('publishUpdate', { agentId: 'agt_demo_pixel', kind: 'progress', message: 'JSON export done, SVG path generation next.' });
    await call('requestCoordination', { agentId: 'agt_demo_pixel', to: 'Atlas', subject: 'Curve segments', message: 'Are curves quadratic or cubic? I need it for SVG paths.', files: ['src/model/track.ts'] });

    await call('registerAgent', { agentId: 'agt_demo_echo', name: 'Echo', client: 'Claude Code', taskId: polish.id, userId: me.id, mode: 'shared', branch: 'main' });
    await call('startTask', { taskId: polish.id, agentId: 'agt_demo_echo' });
    await call('reportBlocker', { agentId: 'agt_demo_echo', description: 'Design tokens for dark mode are missing', needs: 'Decision on colour palette' });
    await call('chat', { text: 'Atlas and Pixel are both on the track model — I asked them to agree on curve types first.' });
    await sleep(800);

    win.webContents.reload();
    await new Promise((r) => win.webContents.once('did-finish-load', r));
    await sleep(1200);
    for (const [i, v] of ['agents', 'tasks', 'activity', 'review', 'context', 'files', 'settings'].entries()) {
      await js(`S.view = ${JSON.stringify(v)}; renderNow();`);
      await shot(`${String(i + 2).padStart(2, '0')}-${v}`);
    }
    await js('S.view = "tasks"; S.taskMode = "waves"; renderNow();');
    await shot('09-tasks-waves');
    await js('S.view = "context"; S.ctxTab = "conflicts"; renderNow();');
    await shot('10-conflicts');
    await js(`S.view = "agents"; renderNow(); S.drawer = { kind: "task", id: ${JSON.stringify(editor.id)} }; renderDrawer();`);
    await shot('11-task-drawer');
    await js('S.drawer = null; renderDrawer(); taskModal();');
    await shot('12-new-task');
    await js('closeModal(); A.invite();');
    await shot('13-invite');
    const errors = await js('window.__errors || []');
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ ok: true, errors }, null, 1));
  } catch (e) {
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ ok: false, error: e.stack }, null, 1));
  }
  app.quit();
}

module.exports = { run };
