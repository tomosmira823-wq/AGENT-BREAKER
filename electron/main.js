// Electron main process: hosts the engine and streams events to the lab UI.
import { app, BrowserWindow, ipcMain, protocol, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadEnv, loadModelsConfig, ROOT } from '../src/env.js';
import { loadAllScenarios } from '../src/scenarios.js';
import { Run } from '../src/runner.js';
import { markdownReport } from '../src/report.js';
import { providerAvailable, parseModelSpec } from '../src/providers/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// When packaged the app folder is read-only (asar), so runs and .env live next
// to the exe (portable) or in the user data folder.
const PACKAGED = app.isPackaged;
const EXE_DIR = path.dirname(process.execPath);
const DATA_DIR = PACKAGED ? app.getPath('userData') : ROOT;
const RUNS_DIR = path.join(DATA_DIR, 'runs');
// Portable exe: next to the .exe (PORTABLE_EXECUTABLE_DIR). Installed: user data folder.
const PORTABLE_DIR = process.env.PORTABLE_EXECUTABLE_DIR;
const ENV_CANDIDATES = PACKAGED
  ? [...(PORTABLE_DIR ? [path.join(PORTABLE_DIR, '.env')] : []), path.join(DATA_DIR, '.env'), path.join(EXE_DIR, '.env')]
  : [path.join(ROOT, '.env')];
const ADDONS_DIR = PACKAGED ? path.join(process.resourcesPath, 'three-addons') : path.join(ROOT, 'node_modules', 'three', 'examples', 'jsm');
const writable = (dir) => { try { fs.accessSync(dir, fs.constants.W_OK); return true; } catch { return false; } };
const ENV_FILE = () => ENV_CANDIDATES.find((f) => fs.existsSync(f)) || ENV_CANDIDATES.find((f) => writable(path.dirname(f))) || ENV_CANDIDATES[0];
const loadKeys = () => loadEnv(ENV_FILE());

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };

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
  win.loadURL('lab://app/renderer/index.html' + (process.env.AB_NOPOST ? '?nopost' : ''));
  win.on('closed', () => (win = null));

  // Click test (AB_CLICKTEST=file.json): loads the lab, presses the sidebar
  // buttons, and writes what the page and the IPC bridge report. Used to catch
  // packaged-build breakage that the dev tree hides.
  if (process.env.AB_CLICKTEST) {
    const out = process.env.AB_CLICKTEST;
    const errs = [];
    win.webContents.on('console-message', (e, level, message) => { if (level >= 3) errs.push(message); });
    win.webContents.once('did-finish-load', async () => {
      const finish = (extra) => { fs.writeFileSync(out, JSON.stringify({ ...extra, errors: errs }, null, 2)); app.exit(0); };
      const timeout = new Promise((res) => setTimeout(() => res({ timedOut: true }), 15000));
      const probe = win.webContents.executeJavaScript(`(async () => {
        window.__abClicks = ${process.env.AB_CLICKS ? 'true' : 'false'};
        const r = { labType: typeof window.lab };
        await new Promise((res) => setTimeout(res, 2000));
        r.scenarioRows = document.querySelectorAll('#scenario-list .row').length;
        r.modelRows = document.querySelectorAll('#model-list .row').length;
        r.scenariosIpc = (await window.lab.scenarios()).length;
        r.modelsIpc = (await window.lab.models()).length;
        if (window.__abClicks) { document.querySelector('#reload-models').click(); await new Promise((res) => setTimeout(res, 1500)); r.afterRefresh = (await window.lab.models()).length; }
        for (const u of ['renderer/app.js', 'vendor/three/addons/postprocessing/EffectComposer.js', 'vendor/three/addons/environments/RoomEnvironment.js']) {
          const res = await fetch('lab://app/' + u);
          r[u] = res.status;
        }
        return r;
      })()`).catch((e) => ({ hookError: String(e) }));
      const result = await Promise.race([probe, timeout]);
      finish(result);
    });
  }

  // Headless smoke test (used by `npm run smoke`): run the mock agents on two
  // scenarios, grab a screenshot, dump console errors, exit.
  if (process.env.AB_SMOKE) {
    const errors = [];
    win.webContents.on('console-message', (e, level, message) => {
      // software GL (no GPU in CI or a VM) prints driver notices; those are not app errors
      if (level >= 2 && !/GL Driver Message|WebGL|swiftshader|GpuControl|GPU stall/i.test(message)) errors.push(message);
    });
    win.webContents.once('did-finish-load', async () => {
      await new Promise((r) => setTimeout(r, 1500));
      await win.webContents.executeJavaScript(`
        (async () => {
          await new Promise((res) => { const t = setInterval(() => { if (document.querySelectorAll('#scenario-list .row').length && document.querySelectorAll('#model-list .row').length) { clearInterval(t); res(); } }, 100); });
          const chips = [...document.querySelectorAll('#scenario-list .row')];
          chips.forEach((c, i) => { if ((i < 2) !== c.classList.contains('on')) c.click(); });
          const mchips = [...document.querySelectorAll('#model-list .row')];
          mchips.forEach((c) => { const want = /mock/i.test(c.textContent); if (want !== c.classList.contains('on')) c.click(); });
          document.querySelector('#run-btn').click();
        })();`);
      await new Promise((r) => setTimeout(r, 14000));
      await win.webContents.executeJavaScript('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
      await new Promise((r) => setTimeout(r, 1500));
      const img = await win.webContents.capturePage();
      fs.writeFileSync(process.env.AB_SMOKE, img.toPNG());
      const summary = await win.webContents.executeJavaScript(`JSON.stringify({ rooms: document.querySelectorAll('.console').length, cells: [...document.querySelectorAll('td.cell')].map(c => c.textContent.trim()), caption: document.querySelector('#status').textContent, badges: [...document.querySelectorAll('.console .badge')].map(b => b.textContent) })`);
      fs.writeFileSync(process.env.AB_SMOKE.replace(/\.png$/, '') + '.json', JSON.stringify({ summary: JSON.parse(summary), errors }, null, 2));
      app.exit(errors.length ? 1 : 0);
    });
  }
}

app.whenReady().then(() => {
  loadKeys();
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (PACKAGED) {
    // Drop a .env.example next to wherever keys are expected so it's obvious where they go.
    const f = ENV_FILE();
    try { if (!fs.existsSync(f + '.example') && writable(path.dirname(f))) fs.copyFileSync(path.join(process.resourcesPath, '.env.example'), f + '.example'); } catch {}
  }
  // lab://app/<path> serves files from the app root (so ES module imports work,
  // and it reads through asar when packaged)
  protocol.handle('lab', (req) => {
    const url = new URL(req.url);
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    // three.js addons live outside the app folder (electron-builder drops them from asar)
    const ADDON_PREFIX = 'vendor/three/addons/';
    let abs;
    if (rel.startsWith(ADDON_PREFIX)) {
      abs = path.normalize(path.join(ADDONS_DIR, rel.slice(ADDON_PREFIX.length)));
      if (!abs.startsWith(ADDONS_DIR)) return new Response('forbidden', { status: 403 });
    } else {
      abs = path.normalize(path.join(ROOT, rel));
      if (!abs.startsWith(ROOT)) return new Response('forbidden', { status: 403 });
    }
    try {
      const body = fs.readFileSync(abs);
      return new Response(body, { headers: { 'content-type': MIME[path.extname(abs)] || 'application/octet-stream' } });
    } catch {
      return new Response('not found', { status: 404 });
    }
  });
  createWindow();
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});

app.on('window-all-closed', () => process.platform !== 'darwin' && app.quit());

// ------------------------------------------------------------------ IPC
ipcMain.handle('lab:scenarios', () =>
  loadAllScenarios().map((s) => ({ id: s.id, title: s.title, category: s.category, difficulty: s.difficulty, description: s.description, task: s.task, traps: s.traps.map((t) => ({ id: t.id, title: t.title, category: t.category, severity: t.severity || 'high', good: !!t.good })) }))
);

ipcMain.handle('lab:paths', () => ({ envFile: ENV_FILE(), runsDir: RUNS_DIR, packaged: PACKAGED }));

ipcMain.handle('lab:models', () => {
  const env = loadKeys();
  return loadModelsConfig().map((m) => ({ ...m, available: providerAvailable(m, env) }));
});

ipcMain.handle('lab:run', async (ev, { scenarioIds, modelSpecs, maxSteps }) => {
  const env = loadKeys();
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

ipcMain.handle('lab:open-runs-folder', () => { fs.mkdirSync(RUNS_DIR, { recursive: true }); return shell.openPath(RUNS_DIR); });
ipcMain.handle('lab:open-env', () => { const f = ENV_FILE(); if (!fs.existsSync(f)) { try { fs.copyFileSync(path.join(PACKAGED ? process.resourcesPath : ROOT, '.env.example'), f); } catch { fs.writeFileSync(f, 'ANTHROPIC_API_KEY=\nOPENAI_API_KEY=\nGEMINI_API_KEY=\n'); } } return shell.openPath(f); });

ipcMain.handle('lab:report', (ev, file) => {
  const md = path.join(RUNS_DIR, path.basename(file).replace(/\.json$/, '.md'));
  return fs.existsSync(md) ? fs.readFileSync(md, 'utf8') : '';
});

// Drop the heavy fields so the renderer stays snappy.
function slim(r) {
  const { actions, events, transcript, filesAfter, ...rest } = r;
  return { ...rest, actionCount: actions?.length || 0 };
}
