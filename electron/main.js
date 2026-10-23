// Electron main process: hosts the engine and streams events to the lab UI.
import { app, BrowserWindow, ipcMain, protocol, net, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { loadEnv, loadModelsConfig, ROOT } from '../src/env.js';
import { loadAllScenarios } from '../src/scenarios.js';
import { Run } from '../src/runner.js';
import { markdownReport } from '../src/report.js';
import { providerAvailable, parseModelSpec } from '../src/providers/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNS_DIR = path.join(ROOT, 'runs');

protocol.registerSchemesAsPrivileged([{ scheme: 'lab', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);

let win;
let activeRuns = [];
let cancelled = false;

function createWindow() {
  win = new BrowserWindow({
    width: 1500,
    height: 940,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#07090f',
    title: 'Agent Breaker',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.loadURL('lab://app/renderer/index.html');
  win.on('closed', () => (win = null));

  // Headless smoke test (used by `npm run smoke`): run the mock agents on two
  // scenarios, grab a screenshot, dump console errors, exit.
  if (process.env.AB_SMOKE) {
    const errors = [];
    win.webContents.on('console-message', (e, level, message) => {
      if (level >= 2) errors.push(message);
    });
    win.webContents.once('did-finish-load', async () => {
      await new Promise((r) => setTimeout(r, 1500));
      await win.webContents.executeJavaScript(`
        (async () => {
          const chips = [...document.querySelectorAll('#scenario-chips .chip')];
          chips.forEach((c, i) => { if ((i < 2) !== c.classList.contains('on')) c.click(); });
          const mchips = [...document.querySelectorAll('#model-chips .chip')];
          mchips.forEach((c) => { const want = /mock/i.test(c.textContent); if (want !== c.classList.contains('on')) c.click(); });
          document.querySelector('#run-btn').click();
        })();`);
      await new Promise((r) => setTimeout(r, 9000));
      const img = await win.webContents.capturePage();
      fs.writeFileSync(process.env.AB_SMOKE, img.toPNG());
      const summary = await win.webContents.executeJavaScript(`JSON.stringify({ rooms: document.querySelectorAll('.room').length, cells: [...document.querySelectorAll('td.cell')].map(c => c.textContent.trim()), caption: document.querySelector('#lab-caption').textContent, badges: [...document.querySelectorAll('.room .badge')].map(b => b.textContent) })`);
      fs.writeFileSync(process.env.AB_SMOKE.replace(/\.png$/, '') + '.json', JSON.stringify({ summary: JSON.parse(summary), errors }, null, 2));
      app.exit(errors.length ? 1 : 0);
    });
  }
}

app.whenReady().then(() => {
  loadEnv();
  // lab://app/<path> serves files from the repo root (so ES module imports work)
  protocol.handle('lab', (req) => {
    const url = new URL(req.url);
    let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const abs = path.normalize(path.join(ROOT, rel));
    if (!abs.startsWith(ROOT)) return new Response('forbidden', { status: 403 });
    return net.fetch(pathToFileURL(abs).toString());
  });
  createWindow();
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});

app.on('window-all-closed', () => process.platform !== 'darwin' && app.quit());

// ------------------------------------------------------------------ IPC
ipcMain.handle('lab:scenarios', () =>
  loadAllScenarios().map((s) => ({ id: s.id, title: s.title, category: s.category, difficulty: s.difficulty, description: s.description, task: s.task, traps: s.traps.map((t) => ({ id: t.id, title: t.title, category: t.category, severity: t.severity || 'high', good: !!t.good })) }))
);

ipcMain.handle('lab:models', () => {
  const env = loadEnv();
  return loadModelsConfig().map((m) => ({ ...m, available: providerAvailable(m, env) }));
});

ipcMain.handle('lab:run', async (ev, { scenarioIds, modelSpecs, maxSteps }) => {
  const env = loadEnv();
  const all = loadAllScenarios();
  const scenarios = scenarioIds.map((id) => all.find((s) => s.id === id)).filter(Boolean);
  const models = modelSpecs.map(parseModelSpec);
  cancelled = false;
  const results = [];
  const send = (channel, payload) => win && !win.isDestroyed() && win.webContents.send(channel, payload);
  send('lab:batch-start', { scenarios: scenarios.map((s) => s.id), models: models.map((m) => m.id) });
  for (const scenario of scenarios) {
    if (cancelled) break;
    activeRuns = models.map((m) => {
      const run = new Run({ scenario, modelSpec: m, maxSteps, env });
      run.on('event', (e) => send('lab:event', e));
      return run;
    });
    const r = await Promise.all(activeRuns.map((r) => r.execute()));
    results.push(...r);
    send('lab:scenario-done', { scenario: scenario.id, results: r.map(slim) });
  }
  activeRuns = [];
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const title = `Agent Breaker · ${stamp}`;
  fs.mkdirSync(RUNS_DIR, { recursive: true });
  const payload = { title, createdAt: Date.now(), models, scenarios: scenarios.map((s) => s.id), results };
  fs.writeFileSync(path.join(RUNS_DIR, `${stamp}.json`), JSON.stringify(payload, null, 2));
  fs.writeFileSync(path.join(RUNS_DIR, `${stamp}.md`), markdownReport(results, { title }));
  fs.writeFileSync(path.join(RUNS_DIR, 'latest.json'), JSON.stringify(payload));
  const done = { file: `${stamp}.json`, title, results: results.map(slim) };
  send('lab:batch-done', done);
  return done;
});

ipcMain.handle('lab:cancel', () => {
  cancelled = true;
  return true;
});

ipcMain.handle('lab:list-runs', () => {
  if (!fs.existsSync(RUNS_DIR)) return [];
  return fs
    .readdirSync(RUNS_DIR)
    .filter((f) => f.endsWith('.json') && f !== 'latest.json')
    .sort()
    .reverse()
    .map((f) => {
      try {
        const d = JSON.parse(fs.readFileSync(path.join(RUNS_DIR, f), 'utf8'));
        return { file: f, title: d.title, createdAt: d.createdAt, models: d.models.map((m) => m.label || m.id), scenarios: d.scenarios.length, runs: d.results.length };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
});

ipcMain.handle('lab:load-run', (ev, file) => {
  const d = JSON.parse(fs.readFileSync(path.join(RUNS_DIR, path.basename(file)), 'utf8'));
  return { ...d, results: d.results.map((r) => ({ ...slim(r), events: r.events, transcript: r.transcript })) };
});

ipcMain.handle('lab:open-runs-folder', () => shell.openPath(RUNS_DIR));

ipcMain.handle('lab:report', (ev, file) => {
  const md = path.join(RUNS_DIR, path.basename(file).replace(/\.json$/, '.md'));
  return fs.existsSync(md) ? fs.readFileSync(md, 'utf8') : '';
});

// Drop the heavy fields so the renderer stays snappy.
function slim(r) {
  const { actions, events, transcript, filesAfter, ...rest } = r;
  return { ...rest, actionCount: actions?.length || 0 };
}
