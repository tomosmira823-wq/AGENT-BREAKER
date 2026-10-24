// Electron main process: hosts the engine and streams events to the lab UI.
import { app, BrowserWindow, ipcMain, protocol, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadEnv, loadModelsConfig, ROOT } from '../src/env.js';
import { loadAllScenarios } from '../src/scenarios.js';
import { Run, runMatrix } from '../src/runner.js';
import { markdownReport } from '../src/report.js';
import { providerAvailable, parseModelSpec } from '../src/providers/index.js';
import { mergeKeys, KEY_NAMES } from '../src/keys.js';
import { discoverAll, clearDiscoveryCache } from '../src/providers/discover.js';

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
      if (process.env.AB_SHOT) { await new Promise((res) => setTimeout(res, 3500)); fs.writeFileSync(process.env.AB_SHOT.replace(/\.png$/, '-0-dock.png'), (await win.webContents.capturePage()).toPNG()); }
      const timeout = new Promise((res) => setTimeout(() => res({ timedOut: true }), process.env.AB_BATCH ? 45000 : 15000));
      const probe = win.webContents.executeJavaScript(`(async () => {
        window.__abClicks = ${process.env.AB_CLICKS ? 'true' : 'false'};
        window.__abKeys = ${process.env.AB_KEYS ? 'true' : 'false'};
        window.__abBatch = ${process.env.AB_BATCH ? 'true' : 'false'};
        const r = { labType: typeof window.lab };
        await new Promise((res) => setTimeout(res, 2000));
        r.bays = window.__scene?.bays?.map((b) => b.id + '@' + b.group.position.x.toFixed(1) + ' plate:' + !!b.plate.parent);
        r.cam = window.__scene?.camera.position.toArray().map((v) => +v.toFixed(1));
        await document.fonts.ready; r.fontLoaded = document.fonts.check('12px "Recursive Variable"') && [...document.fonts].some((f) => f.family.includes('Recursive') && f.status === 'loaded');
        r.scenarioRows = document.querySelectorAll('#scenario-list .row').length;
        r.modelRows = document.querySelectorAll('#model-list .row').length;
        r.scenariosIpc = (await window.lab.scenarios()).length;
        r.modelsIpc = (await window.lab.models()).models.length;
        if (window.__abKeys) {
          document.querySelector('#open-env').click(); await new Promise((res) => setTimeout(res, 800));
          r.dialogOpened = !document.querySelector('#keys-modal').hidden;
          document.querySelector('#key-OPENAI_API_KEY').value = 'sk-test-FAKE-0000';
          document.querySelector('#keys-save').click(); await new Promise((res) => setTimeout(res, 1500));
          r.dialogClosed = document.querySelector('#keys-modal').hidden;
          r.availableAfterSave = (await window.lab.models()).models.filter((x) => x.available).map((x) => x.id);
        }
        if (window.__abClicks) { document.querySelector('#reload-models').click(); await new Promise((res) => setTimeout(res, 1500)); r.afterRefresh = (await window.lab.models()).models.length; }
        if (window.__abBatch) {
          // run two scenarios with a broken model and a working one, then read the UI back
          [...document.querySelectorAll('#scenario-list .row')].forEach((c, i) => { if ((i < 2) !== c.classList.contains('on')) c.click(); });
          [...document.querySelectorAll('#model-list .row')].forEach((c) => { const want = /broken|careful/i.test(c.textContent); if (want !== c.classList.contains('on')) c.click(); });
          const done = new Promise((res) => window.lab.onBatchDone(res));
          document.querySelector('#run-btn').click();
          const batch = await Promise.race([done, new Promise((res) => setTimeout(() => res({ timedOut: true }), 25000))]);
          r.batch = { timedOut: !!batch.timedOut, error: batch.error || null, results: (batch.results || []).map((x) => x.model + ':' + x.verdict) };
          r.statusAfter = document.querySelector('#status').textContent;
          r.badges = [...document.querySelectorAll('.console')].map((c) => c.querySelector('.name, .title, .head')?.textContent.trim() + '=' + c.querySelector('.badge').textContent);
          r.cells = [...document.querySelectorAll('td.cell')].map((c) => c.textContent.trim());
          r.scoreCards = [...document.querySelectorAll('.score')].map((c) => c.textContent.replace(/\s+/g, ' ').trim());
          // open the transcript for the broken model's console
          const brokenConsole = [...document.querySelectorAll('.console')].find((c) => /broken/i.test(c.textContent));
          brokenConsole?.querySelector('.open')?.click();
          await new Promise((res) => setTimeout(res, 300));
          r.drawer = { open: document.querySelector('#drawer').classList.contains('open'), title: document.querySelector('#drawer-title').textContent, sub: document.querySelector('#drawer-sub').textContent, body: document.querySelector('#drawer-body').innerText.replace(/\s+/g, ' ').slice(0, 600) };
          document.querySelector('#drawer-close').click();
          const okConsole = [...document.querySelectorAll('.console')].find((c) => /careful/i.test(c.textContent));
          okConsole?.querySelector('.open')?.click();
          await new Promise((res) => setTimeout(res, 300));
          r.drawerOk = { sub: document.querySelector('#drawer-sub').textContent, steps: document.querySelectorAll('#drawer-body .msg.assistant, #drawer-body .msg.tool').length, body: document.querySelector('#drawer-body').innerText.replace(/\s+/g, ' ').slice(0, 300) };
        }
        for (const u of ['renderer/app.js', 'vendor/three/addons/postprocessing/EffectComposer.js', 'vendor/three/addons/environments/RoomEnvironment.js']) {
          const res = await fetch('lab://app/' + u);
          r[u] = res.status;
        }
        return r;
      })()`).catch((e) => ({ hookError: String(e) }));
      const result = await Promise.race([probe, timeout]);
      result.envAfter = fs.existsSync(ENV_FILE()) ? fs.readFileSync(ENV_FILE(), 'utf8').replace(/=(.{4}).*/g, '=…$1') : null;
      if (process.env.AB_SHOT) {
        // reopen the broken model's transcript and photograph it
        await win.webContents.executeJavaScript(`document.querySelector('#tab-live')?.click(); document.querySelector('#drawer-close')?.click();`);
        await new Promise((res) => setTimeout(res, 600));
        fs.writeFileSync(process.env.AB_SHOT.replace(/\.png$/, '-1-readouts.png'), (await win.webContents.capturePage()).toPNG());
        await win.webContents.executeJavaScript(`(() => { const c = [...document.querySelectorAll('.console')].find((x) => /broken/i.test(x.textContent)); c?.querySelector('.open')?.click(); })()`);
        await new Promise((res) => setTimeout(res, 1200));
        fs.writeFileSync(process.env.AB_SHOT, (await win.webContents.capturePage()).toPNG());
      }
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

// Models the API said do not exist for this key, remembered for a day so the
// list can grey them out instead of letting them fail again.
const DEAD_FILE = () => path.join(DATA_DIR, 'unavailable-models.json');
const keyTag = (env, provider) => String(provider === 'anthropic' ? env.ANTHROPIC_API_KEY : provider === 'openai' ? env.OPENAI_API_KEY : env.GEMINI_API_KEY || env.GOOGLE_API_KEY || '').slice(-6);
function readDead() { try { return JSON.parse(fs.readFileSync(DEAD_FILE(), 'utf8')); } catch { return {}; } }
function rememberDead(modelId, reason, env) {
  const d = readDead();
  d[modelId] = { reason, at: Date.now(), key: keyTag(env, modelId.split(':')[0]) };
  try { fs.writeFileSync(DEAD_FILE(), JSON.stringify(d, null, 2)); } catch {}
}
function deadFor(env) {
  const d = readDead(), out = {};
  for (const [id, v] of Object.entries(d)) if (Date.now() - v.at < 24 * 3600e3 && v.key === keyTag(env, id.split(':')[0])) out[id] = v.reason;
  return out;
}

// Models = everything the current keys can reach (asked live, cached a few
// minutes) plus the curated models.json entries for providers with no key yet,
// greyed out so it is clear what adding a key unlocks.
ipcMain.handle('lab:models', async (ev, { refresh } = {}) => {
  const env = loadKeys();
  if (refresh) clearDiscoveryCache();
  const curated = loadModelsConfig();
  const found = await discoverAll(env);
  const haveKey = (p) => providerAvailable({ provider: p, model: 'x' }, env);
  const discoveredProviders = new Set(found.models.map((x) => x.provider));
  const models = [];
  const dead = refresh ? {} : deadFor(env);
  if (refresh) { try { fs.unlinkSync(DEAD_FILE()); } catch {} }
  for (const d of found.models) models.push({ ...d, available: !dead[d.id], source: 'discovered', note: dead[d.id] ? `Not available to this key: ${dead[d.id]}` : undefined });
  for (const c of curated) {
    if (c.provider === 'mock') { models.push({ ...c, available: true, source: 'curated' }); continue; }
    if (models.some((x) => x.id === c.id)) { Object.assign(models.find((x) => x.id === c.id), { label: c.label, featured: true }); continue; }
    // provider answered and this curated model was not in the answer: it would 404, leave it out
    if (discoveredProviders.has(c.provider)) continue;
    models.push({ ...c, available: haveKey(c.provider) && !found.errors[c.provider] ? true : false, source: 'curated', note: found.errors[c.provider] ? `could not list models: ${found.errors[c.provider]}` : undefined });
  }
  return { models, errors: found.errors };
});

ipcMain.handle('lab:run', async (ev, { scenarioIds, modelSpecs, maxSteps, repeat = 1 }) => {
  repeat = Math.min(10, Math.max(1, Number(repeat) || 1));
  const env = loadKeys();
  const all = loadAllScenarios();
  const scenarios = scenarioIds.map((id) => all.find((s) => s.id === id)).filter(Boolean);
  const models = modelSpecs.map(parseModelSpec);
  cancelled = false;
  const results = [];
  const send = (channel, payload) => win && !win.isDestroyed() && win.webContents.send(channel, payload);
  send('lab:batch-start', { scenarios: scenarios.map((s) => s.id), models: models.map((m) => m.id), repeat });
  let batchError = null;
  try {
    results.push(...await runMatrix({
      scenarios, models, maxSteps, env, repeat,
      onEvent: (e) => send('lab:event', e),
      shouldStop: () => cancelled,
      onGroupDone: (scenario, rep, r) => send('lab:scenario-done', { scenario: scenario.id, repeat: rep, results: r.map(slim) }),
      onDead: (modelId, reason) => { rememberDead(modelId, reason, env); send('lab:model-dead', { model: modelId, reason }); },
    }));
  } catch (e) {
    batchError = String(e?.stack || e?.message || e);
  }
  activeRuns = [];
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const title = `Agent Breaker · ${stamp}`;
  let file = null;
  if (results.length) {
    fs.mkdirSync(RUNS_DIR, { recursive: true });
    const payload = { title, createdAt: Date.now(), models, scenarios: scenarios.map((s) => s.id), repeat, results, error: batchError };
    fs.writeFileSync(path.join(RUNS_DIR, `${stamp}.json`), JSON.stringify(payload, null, 2));
    fs.writeFileSync(path.join(RUNS_DIR, `${stamp}.md`), markdownReport(results, { title }));
    fs.writeFileSync(path.join(RUNS_DIR, 'latest.json'), JSON.stringify(payload));
    file = `${stamp}.json`;
  }
  const done = { file, title, results: results.map(slim), error: batchError, cancelled };
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

// Keys entered in the lab dialog. The renderer only gets set/not-set, never the value back.
ipcMain.handle('lab:key-status', () => {
  const env = loadKeys();
  return KEY_NAMES.map((name) => ({ name, set: !!(env[name] || '').trim() }));
});

ipcMain.handle('lab:save-keys', (ev, keys) => {
  const file = ENV_FILE();
  try {
    const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    fs.writeFileSync(file, mergeKeys(current, keys || {}));
    for (const name of KEY_NAMES) { const v = String((keys || {})[name] ?? '').trim(); if (v) process.env[name] = v; }
    return { file };
  } catch (e) {
    return { error: e.message, file };
  }
});

ipcMain.handle('lab:report', (ev, file) => {
  const md = path.join(RUNS_DIR, path.basename(file).replace(/\.json$/, '.md'));
  return fs.existsSync(md) ? fs.readFileSync(md, 'utf8') : '';
});

// Drop the heavy fields so the renderer stays snappy.
function slim(r) {
  const { actions, events, transcript, filesAfter, ...rest } = r;
  return { ...rest, actionCount: actions?.length || 0 };
}
