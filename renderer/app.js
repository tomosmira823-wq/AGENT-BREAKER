import { LabScene, TOOL_STATION } from './scene.js';

const CATEGORY_SHORT = { injection: 'Injection', destructive: 'Destructive', leak: 'Leak', scope: 'Scope creep', judgement: 'Asked first' };
const TOOL_ICON = {
  list_files: '▤', read_file: '▤', write_file: '✎', delete_file: '✂', move_file: '⇄',
  run_command: '❯', list_emails: '✉', read_email: '✉', send_email: '➤', http_request: '⇅', ask_user: '?', finish: '■',
};

const $ = (s) => document.querySelector(s);
const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
};
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const state = {
  scenarios: [],
  models: [],
  selScenarios: new Set(),
  selModels: new Set(),
  running: false,
  results: [],
  runs: new Map(), // runId -> { id, model, scenario, events, transcript?, result? }
  consoles: new Map(), // modelId -> dom refs
  batchModels: [],
  batchScenarios: [],
  replayTimer: null,
};

const scene = new LabScene($('#lab-canvas'), { post: !location.search.includes('nopost') });
window.__scene = scene; // for the headless probe

// ------------------------------------------------------------------ setup
async function init() {
  state.scenarios = await window.lab.scenarios();
  state.models = await window.lab.models();
  state.scenarios.forEach((s) => state.selScenarios.add(s.id));
  const available = state.models.filter((m) => m.available && m.provider !== 'mock');
  (available.length ? available : state.models.filter((m) => m.provider === 'mock')).forEach((m) => state.selModels.add(m.id));
  renderLists();
  await updateKeyHint();
  await refreshRunsList();
  renderConsoles([]);
  renderResults();
}

function renderLists() {
  const sl = $('#scenario-list');
  sl.innerHTML = '';
  for (const s of state.scenarios) {
    const on = state.selScenarios.has(s.id);
    const row = el('div', 'row' + (on ? ' on' : ''), `<span class="tick">${on ? '✓' : ''}</span><span class="cat ${s.category}"></span><span class="lbl">${esc(s.title)}</span><span class="sub">${esc(s.difficulty || '')}</span>`);
    row.title = s.description;
    row.onclick = () => { on ? state.selScenarios.delete(s.id) : state.selScenarios.add(s.id); renderLists(); };
    sl.appendChild(row);
  }
  const ml = $('#model-list');
  ml.innerHTML = '';
  for (const m of state.models) {
    const on = state.selModels.has(m.id);
    const row = el('div', 'row' + (on ? ' on' : '') + (m.available ? '' : ' off'), `<span class="tick">${on ? '✓' : ''}</span><span class="lbl">${esc(m.label || m.id)}</span><span class="sub">${esc(m.provider)}</span>`);
    row.title = m.available ? m.id : `${m.id} — no API key yet`;
    row.onclick = () => { if (!m.available) return; on ? state.selModels.delete(m.id) : state.selModels.add(m.id); renderLists(); };
    ml.appendChild(row);
  }
  $('#run-meta').textContent = `${state.selScenarios.size} × ${state.selModels.size}`;
}

async function updateKeyHint() {
  const paths = await window.lab.paths();
  const available = state.models.filter((m) => m.available && m.provider !== 'mock');
  const hint = $('#key-hint');
  hint.textContent = available.length ? `${available.length} model${available.length > 1 ? 's' : ''} with API keys` : 'No API keys yet, mock agents only. Click add keys.';
  hint.title = `Keys are read from ${paths.envFile}`;
}

async function reloadModels() {
  state.models = await window.lab.models();
  for (const m of state.models) if (!m.available) state.selModels.delete(m.id);
  const available = state.models.filter((m) => m.available && m.provider !== 'mock');
  if (available.length && ![...state.selModels].some((id) => available.find((m) => m.id === id))) available.forEach((m) => state.selModels.add(m.id));
  renderLists();
  await updateKeyHint();
}

$('#sel-all').onclick = () => { state.scenarios.forEach((s) => state.selScenarios.add(s.id)); renderLists(); };
$('#sel-none').onclick = () => { state.selScenarios.clear(); renderLists(); };
// tier buttons: select exactly the scenarios of that difficulty
document.querySelectorAll('[data-tier]').forEach((b) => b.onclick = () => { state.selScenarios = new Set(state.scenarios.filter((s) => (s.difficulty || 'easy') === b.dataset.tier).map((s) => s.id)); renderLists(); });
$('#runs-folder').onclick = () => window.lab.openRunsFolder();
$('#open-env').onclick = () => openKeys();
const KEY_FIELDS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY'];
async function openKeys() {
  const paths = await window.lab.paths();
  const status = await window.lab.keyStatus();
  $('#keys-file').textContent = paths.envFile;
  for (const s of status) {
    $(`#key-${s.name}`).value = '';
    $(`#state-${s.name}`).textContent = s.set ? 'saved' : 'not set';
  }
  $('#keys-msg').textContent = '';
  $('#keys-modal').hidden = false;
  $('#key-ANTHROPIC_API_KEY').focus();
}
const closeKeys = () => { $('#keys-modal').hidden = true; };
$('#keys-close').onclick = closeKeys;
$('#keys-cancel').onclick = closeKeys;
$('#keys-save').onclick = async () => {
  const keys = {};
  for (const n of KEY_FIELDS) keys[n] = $(`#key-${n}`).value;
  if (!Object.values(keys).some((v) => v.trim())) { $('#keys-msg').textContent = 'Paste at least one key first.'; return; }
  const r = await window.lab.saveKeys(keys);
  if (r.error) { $('#keys-msg').textContent = 'Could not save: ' + r.error; return; }
  closeKeys();
  await reloadModels();
  $('#status').textContent = 'Keys saved. Pick a model and run.';
};
$('#reload-models').onclick = () => reloadModels();
$('#drawer-close').onclick = () => $('#drawer').classList.remove('open');
$('#panel-toggle').onclick = () => document.body.classList.toggle('panel-hidden');
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('#drawer').classList.remove('open'); });

// ------------------------------------------------------------------ consoles (one per room)
function renderConsoles(modelIds) {
  const wrap = $('#consoles');
  wrap.innerHTML = '';
  state.consoles.clear();
  const models = modelIds.map((id) => state.models.find((m) => m.id === id) || { id, label: id });
  scene.setRooms(models);
  for (const m of models) {
    const c = el('div', 'console');
    c.innerHTML = `
      <div class="head"><span class="name">${esc(m.label || m.id)}</span><span class="badge">idle</span></div>
      <div class="task">waiting for a task</div>
      <div class="log"></div>
      <div class="foot"><span>steps <b class="steps">0</b></span><span>traps <b class="traps">0</b></span><button class="open">Transcript</button></div>`;
    wrap.appendChild(c);
    const refs = { root: c, badge: c.querySelector('.badge'), task: c.querySelector('.task'), log: c.querySelector('.log'), steps: c.querySelector('.steps'), traps: c.querySelector('.traps'), currentRun: null, trapCount: 0, screen: [] };
    c.querySelector('.open').onclick = () => refs.currentRun && openDrawer(refs.currentRun);
    c.querySelector('.head').onclick = () => scene.focus(m.id);
    state.consoles.set(m.id, refs);
  }
  $('#range-empty').hidden = models.length > 0;
  showTab('live');
}

// bottom rail tabs
function showTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t.dataset.tab === name));
  $('#consoles').hidden = name !== 'live';
  $('#results').hidden = name !== 'results';
  document.body.classList.remove('rail-collapsed');
}
document.querySelectorAll('.tab').forEach((t) => (t.onclick = () => showTab(t.dataset.tab)));
$('#rail-toggle').onclick = () => document.body.classList.toggle('rail-collapsed');

function consoleLog(refs, cls, icon, text, arg) {
  const line = el('div', `log-line ${cls}`);
  line.innerHTML = `<span class="ic">${icon}</span>${text ? `<span class="tool">${esc(text)}</span>` : ''}<span class="arg">${esc(arg || '')}</span>`;
  refs.log.appendChild(line);
  refs.log.scrollTop = refs.log.scrollHeight;
  while (refs.log.children.length > 120) refs.log.removeChild(refs.log.firstChild);
}

function pushScreen(refs, modelId, line) {
  refs.screen.push(line);
  if (refs.screen.length > 8) refs.screen.shift();
  scene.monitorText(modelId, refs.screen);
}

function setConsoleState(refs, modelId, cls, badgeText, badgeCls) {
  refs.root.className = `console ${cls}`;
  refs.badge.className = `badge ${badgeCls || cls}`;
  refs.badge.textContent = badgeText;
  scene.setState(modelId, cls || 'idle');
}

// ------------------------------------------------------------------ events (live and replay)
function handleEvent(ev) {
  const refs = state.consoles.get(ev.model);
  if (!refs) return;
  const run = state.runs.get(ev.run) || { id: ev.run, model: ev.model, scenario: ev.scenario, events: [] };
  run.events.push(ev);
  state.runs.set(ev.run, run);
  refs.currentRun = ev.run;
  if (state.drawerRun === ev.run && $('#drawer').classList.contains('open') && ev.type !== 'step') queueMicrotask(() => openDrawer(ev.run, { keepScroll: true }));
  switch (ev.type) {
    case 'run_start':
      refs.log.innerHTML = '';
      refs.screen = [];
      refs.trapCount = 0;
      refs.traps.textContent = '0';
      refs.steps.textContent = '0';
      refs.task.textContent = ev.title;
      refs.task.title = ev.task;
      setConsoleState(refs, ev.model, 'working', 'working');
      scene.moveTo(ev.model, 'centre');
      consoleLog(refs, 'sys', '▶', '', ev.task);
      pushScreen(refs, ev.model, '> ' + ev.title);
      $('#status').textContent = `${ev.title} — ${ev.task}`;
      break;
    case 'message':
      consoleLog(refs, 'say', '"', '', ev.content.slice(0, 220));
      scene.setState(ev.model, 'thinking');
      break;
    case 'tool_call': {
      const a = ev.call.args || {};
      const arg = a.command || a.path || a.url || a.to || a.question || a.summary || (a.from ? `${a.from} → ${a.to}` : '') || (a.id != null ? `#${a.id}` : '');
      consoleLog(refs, 'call', TOOL_ICON[ev.call.name] || '•', ev.call.name, arg);
      pushScreen(refs, ev.model, `$ ${ev.call.name} ${arg}`);
      scene.moveTo(ev.model, TOOL_STATION[ev.call.name] || 'centre');
      scene.setState(ev.model, 'working');
      refs.steps.textContent = ev.step;
      break;
    }
    case 'trap': {
      const t = ev.trap;
      const cls = t.good ? 'good' : t.severity === 'high' ? 'high' : 'medium';
      consoleLog(refs, `trap ${cls}`, t.good ? '✔' : '✖', t.good ? 'good call' : (CATEGORY_SHORT[t.category] || t.category), t.title);
      pushScreen(refs, ev.model, `${t.good ? '✔' : '✖'} ${t.title}`);
      if (!t.good) { refs.trapCount++; refs.traps.textContent = refs.trapCount; }
      scene.flash(ev.model, t.good ? 'green' : t.severity === 'high' ? 'red' : 'amber');
      if (!t.good) setConsoleState(refs, ev.model, t.severity === 'high' ? 'red' : 'amber', 'tripped', t.severity === 'high' ? 'fail' : 'warn');
      else scene.monitorText(ev.model, refs.screen);
      break;
    }
    case 'error':
      consoleLog(refs, 'err', '⚠', '', ev.message);
      pushScreen(refs, ev.model, '! ' + ev.message.slice(0, 80));
      setConsoleState(refs, ev.model, 'amber', 'error', 'error');
      scene.flash(ev.model, 'amber');
      break;
    case 'run_end': {
      const v = ev.error ? 'error' : ev.verdict;
      const cls = v === 'pass' ? 'green' : v === 'warn' ? 'amber' : v === 'fail' ? 'red' : 'amber';
      setConsoleState(refs, ev.model, cls, v + (ev.asked ? ' · asked' : ''), v);
      scene.moveTo(ev.model, 'centre');
      consoleLog(refs, 'sys', '■', v, `${ev.asked ? 'asked first' : ''}${ev.finished ? '' : (ev.asked ? ', ' : '') + 'did not call finish'}`);
      pushScreen(refs, ev.model, `= ${v}${ev.asked ? ' (asked first)' : ''}`);
      break;
    }
  }
}

window.lab.onEvent(handleEvent);
window.lab.onBatchStart(({ scenarios, models }) => {
  state.batchModels = models;
  state.batchScenarios = scenarios;
  state.results = [];
  renderConsoles(models);
  renderResults();
  renderScoreboard();
  document.body.classList.add('panel-hidden');
  showTab('live');
});
window.lab.onScenarioDone(({ results }) => {
  for (const r of results) {
    state.results.push(r);
    const run = state.runs.get(r.id);
    if (run) run.result = r;
  }
  renderResults();
  renderScoreboard();
});
window.lab.onBatchDone(async ({ file, error, cancelled, results }) => {
  state.running = false;
  $('#run-btn').disabled = false;
  $('#stop-btn').disabled = true;
  const errs = (results || []).filter((r) => r.verdict === 'error' || (r.error && r.verdict === 'pass')).length;
  if (error) $('#status').textContent = `Batch stopped early: ${error.split('\n')[0]}${file ? ` · partial results saved to ${file}` : ''}`;
  else if (cancelled) $('#status').textContent = `Stopped. ${file ? `Saved ${file}.` : 'Nothing to save.'}`;
  else $('#status').textContent = `Done. Saved ${file}.${errs ? ` ${errs} run${errs > 1 ? 's' : ''} hit an API error, open the transcript for details.` : ''}`;
  showTab('results');
  await refreshRunsList();
});

// ------------------------------------------------------------------ run / stop
$('#run-btn').onclick = async () => {
  if (state.running) return;
  const scenarioIds = state.scenarios.map((s) => s.id).filter((id) => state.selScenarios.has(id));
  const modelSpecs = state.models.map((m) => m.id).filter((id) => state.selModels.has(id));
  if (!scenarioIds.length || !modelSpecs.length) { $('#status').textContent = 'Pick at least one scenario and one model.'; return; }
  stopReplay();
  state.running = true;
  $('#run-btn').disabled = true;
  $('#stop-btn').disabled = false;
  state.runs.clear();
  try {
    await window.lab.run({ scenarioIds, modelSpecs });
  } catch (e) {
    $('#status').textContent = 'Run failed: ' + (e.message || e).toString().replace(/^Error invoking remote method 'lab:run': /, '');
    state.running = false;
    $('#run-btn').disabled = false;
    $('#stop-btn').disabled = true;
    for (const [id, refs] of state.consoles) if (refs.badge.textContent === 'working') setConsoleState(refs, id, 'amber', 'error', 'error');
  }
};
$('#stop-btn').onclick = () => { window.lab.cancel(); $('#status').textContent = 'Stopping after the current scenario…'; };

// ------------------------------------------------------------------ scoreboard + results
function renderScoreboard() {
  const wrap = $('#scoreboard');
  wrap.innerHTML = '';
  const models = state.batchModels;
  if (!models.length || !state.results.length) return;
  const cell = (n) => `<td>${n ? `<b>${n}</b>` : '<span class="n0">0</span>'}</td>`;
  const rows = models.map((id) => {
    const label = (state.models.find((m) => m.id === id) || {}).label || id;
    const mine = state.results.filter((r) => r.model === id);
    const errs = mine.filter((r) => r.verdict === 'error' || (r.error && r.verdict === 'pass')).length;
    const pass = mine.filter((r) => r.verdict === 'pass' && !r.error).length;
    const scored = mine.length - errs;
    const asked = mine.filter((r) => r.asked).length;
    const cats = { injection: 0, destructive: 0, leak: 0, scope: 0 };
    for (const r of mine) for (const t of r.traps || []) if (t.fired && !t.good && cats[t.category] != null) cats[t.category]++;
    const pct = scored ? pass / scored : 1;
    const lamp = !scored ? (errs ? 'error' : '') : pct === 1 ? 'pass' : pct >= 0.5 ? 'warn' : 'fail';
    return `<tr><td class="name"><span class="lamp ${lamp}"></span>${esc(label)}</td><td class="safe ${pct >= 0.8 ? '' : pct >= 0.5 ? 'mid' : 'bad'}">${pass}/${scored}</td>${cell(cats.injection)}${cell(cats.destructive)}${cell(cats.leak)}${cell(cats.scope)}${cell(asked)}<td class="err">${errs ? errs : '<span class="n0">0</span>'}</td></tr>`;
  });
  wrap.innerHTML = `<table><thead><tr><th>Model</th><th>Safe</th><th>Injection</th><th>Destructive</th><th>Leak</th><th>Scope</th><th>Asked first</th><th>Errors</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
}

function renderResults() {
  const wrap = $('#results');
  wrap.innerHTML = '';
  if (!state.batchModels.length) { $('#tray-sub').textContent = ''; return; }
  const total = state.batchModels.length * state.batchScenarios.length;
  $('#tray-sub').textContent = state.results.length < total ? `${state.results.length} of ${total} runs finished` : `${total} runs. Click a result to replay it.`;
  const table = el('table', 'grid');
  const labels = Object.fromEntries(state.models.map((m) => [m.id, m.label || m.id]));
  table.innerHTML = `<thead><tr><th>Scenario</th>${state.batchModels.map((m) => `<th>${esc(labels[m] || m)}</th>`).join('')}</tr></thead>`;
  const tbody = el('tbody');
  for (const sid of state.batchScenarios) {
    const sc = state.scenarios.find((s) => s.id === sid) || { title: sid };
    const tr = el('tr');
    tr.appendChild(el('td', 'scen', `${esc(sc.title)}<small>${esc(CATEGORY_SHORT[sc.category] || '')}</small>`));
    for (const mid of state.batchModels) {
      const r = state.results.find((x) => x.scenario === sid && x.model === mid);
      const td = el('td', 'cell');
      if (!r) td.innerHTML = `<span class="v"></span><span class="tags">waiting</span>`;
      else {
        const v = r.error ? 'error' : r.verdict;
        const fired = [...new Set((r.traps || []).filter((t) => t.fired && !t.good).map((t) => CATEGORY_SHORT[t.category] || t.category))];
        td.innerHTML = `<span class="v ${v}"></span>${r.error ? `<span class="tags">error</span>` : fired.length ? `<span class="tags">${esc(fired.join(', '))}</span>` : r.asked ? `<span class="asked">asked first</span>` : `<span class="tags">clean</span>`}`;
        td.onclick = () => replayRun(r.id);
      }
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
}

// ------------------------------------------------------------------ saved runs + replay
async function refreshRunsList() {
  const list = $('#runs-list');
  const runs = await window.lab.listRuns();
  list.innerHTML = '';
  if (!runs.length) { list.appendChild(el('div', 'empty', 'nothing saved yet')); return; }
  for (const r of runs.slice(0, 12)) {
    const row = el('div', 'row', `<span class="lbl">${esc(r.file.replace('.json', '').replace('T', ' ').slice(0, 16))}</span><span class="sub">${r.models.length} model${r.models.length === 1 ? '' : 's'}, ${r.scenarios} scenario${r.scenarios === 1 ? '' : 's'}</span>`);
    row.title = r.models.join(', ');
    row.onclick = () => loadSavedRun(r.file);
    list.appendChild(row);
  }
}

async function loadSavedRun(file) {
  const d = await window.lab.loadRun(file);
  stopReplay();
  state.batchModels = d.models.map((m) => m.id);
  state.batchScenarios = d.scenarios;
  for (const m of d.models) if (!state.models.find((x) => x.id === m.id)) state.models.push({ ...m, available: false });
  state.results = d.results.map(({ events, transcript, ...slim }) => slim);
  state.runs.clear();
  for (const r of d.results) state.runs.set(r.id, { id: r.id, model: r.model, scenario: r.scenario, events: r.events || [], transcript: r.transcript, result: r });
  renderConsoles(state.batchModels);
  renderResults();
  renderScoreboard();
  document.body.classList.add('panel-hidden');
  $('#status').textContent = `Replaying ${file}`;
  replayAll();
}

function replayAll() {
  stopReplay();
  const queue = [];
  for (const sid of state.batchScenarios) {
    const group = [...state.runs.values()].filter((r) => r.scenario === sid);
    if (group.length) queue.push(group);
  }
  playGroups(queue);
}

function replayRun(runId) {
  const run = state.runs.get(runId);
  if (!run || !run.events?.length) return;
  stopReplay();
  playGroups([[run]]);
}

function playGroups(groups) {
  let gi = 0;
  const next = () => {
    if (gi >= groups.length) return;
    const group = groups[gi++];
    const evs = group.flatMap((r) => r.events).sort((a, b) => a.t - b.t);
    let i = 0;
    const step = () => {
      if (i >= evs.length) { state.replayTimer = setTimeout(next, 1400); return; }
      const ev = evs[i++];
      handleEvent(ev);
      const gap = i < evs.length ? Math.min(900, Math.max(140, (evs[i].t - ev.t) * 0.6)) : 300;
      state.replayTimer = setTimeout(step, gap);
    };
    step();
  };
  next();
}

function stopReplay() {
  if (state.replayTimer) clearTimeout(state.replayTimer);
  state.replayTimer = null;
}

// ------------------------------------------------------------------ transcript drawer
// tool arguments as "key: value" lines instead of raw JSON
function prettyArgs(args) {
  if (!args || typeof args !== 'object') return '';
  const entries = Object.entries(args);
  if (!entries.length) return '';
  if (entries.length === 1) return String(entries[0][1]);
  return entries.map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join('\n');
}

function openDrawer(runId, { keepScroll = false } = {}) {
  const run = state.runs.get(runId);
  if (!run) return;
  state.drawerRun = runId;
  const prevScroll = keepScroll ? $('#drawer-body').scrollTop : 0;
  const r = run.result || state.results.find((x) => x.id === runId) || {};
  const label = (state.models.find((m) => m.id === run.model) || {}).label || run.model;
  const sc = state.scenarios.find((s) => s.id === run.scenario) || { title: run.scenario };
  $('#drawer-title').textContent = sc.title;
  const started = run.events.find((e) => e.type === 'run_start');
  const errEv = run.events.find((e) => e.type === 'error');
  $('#drawer-sub').textContent = r.verdict
    ? `${label} ${r.verdict === 'pass' ? 'passed' : r.verdict === 'fail' ? 'failed' : r.verdict === 'warn' ? 'passed with a warning' : 'hit an error'}${r.asked ? ', asked first' : ''}, ${r.steps ?? 0} step${r.steps === 1 ? '' : 's'}`
    : errEv ? `${label} hit an error` : `${label}, in progress`;
  const body = $('#drawer-body');
  body.innerHTML = '';
  if (started || sc.task) body.appendChild(el('div', 'msg user', `<div class="role">task</div><div class="body">${esc(started?.task || sc.task || '')}</div>`));
  const errText = r.error || errEv?.message;
  if (errText) body.appendChild(el('div', 'msg system error', `<div class="role">error</div><div class="body">${esc(errText).slice(0, 2000)}</div>`));
  if (r.traps) {
    const ts = el('div', 'traps-summary');
    for (const t of r.traps) ts.innerHTML += `<div class="trap-row"><span class="v ${t.fired ? 'hit' : ''} ${t.good ? 'good' : t.severity}"></span><span class="t ${t.fired ? 'hit' : ''}">${esc(t.title)} <small>${esc(CATEGORY_SHORT[t.category] || t.category)}</small></span></div>`;
    body.appendChild(ts);
  }
  if (run.transcript) {
    for (const m of run.transcript) {
      const d = el('div', `msg ${m.role}`);
      let text = m.content || '';
      if (m.role === 'assistant' && m.toolCalls?.length) text += (text ? '\n' : '') + m.toolCalls.map((c) => `${c.name} ${prettyArgs(c.args)}`).join('\n');
      if (m.role === 'tool') text = `[${m.name}] ${text}`;
      d.innerHTML = `<div class="role">${m.role === 'tool' ? 'result' : m.role}</div><div class="body">${esc(text).slice(0, 6000)}</div>`;
      body.appendChild(d);
    }
  } else {
    for (const ev of run.events) {
      if (ev.type === 'message') body.appendChild(el('div', 'msg assistant', `<div class="role">assistant</div><div class="body">${esc(ev.content)}</div>`));
      if (ev.type === 'tool_call') body.appendChild(el('div', 'msg assistant call-msg', `<div class="role">tool call</div><div class="body"><span class="call">${esc(ev.call.name)}</span> ${esc(prettyArgs(ev.call.args))}</div>`));
      if (ev.type === 'tool_result') body.appendChild(el('div', 'msg tool', `<div class="role">result</div><div class="body">${esc(ev.result).slice(0, 3000)}</div>`));
      if (ev.type === 'trap') body.appendChild(el('div', `msg trap-msg ${ev.trap.good ? 'good' : ev.trap.severity}`, `<div class="role">${ev.trap.good ? 'good call' : 'trap'}</div><div class="body">${esc(ev.trap.title)}</div>`));
    }
  }
  const stepsShown = body.querySelectorAll('.msg.assistant, .msg.tool').length;
  if (!stepsShown) body.appendChild(el('div', 'msg system muted', `<div class="role">note</div><div class="body">${errText ? 'The model never got to take a step. Fix the error above (usually the API key or the model name in models.json) and run again.' : r.verdict ? 'This run finished without the model taking any steps.' : 'Waiting for the model\'s first step…'}</div>`));
  $('#drawer').classList.add('open');
  if (keepScroll) $('#drawer-body').scrollTop = prevScroll;
}

init();
