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
  results: [], // slim results for this batch
  runs: new Map(), // runId -> { events: [], transcript? }
  rooms: new Map(), // modelId -> dom refs
  batchModels: [],
  batchScenarios: [],
  replayTimer: null,
};

const scene = new LabScene($('#lab-canvas'));

// ------------------------------------------------------------------ setup
async function init() {
  state.scenarios = await window.lab.scenarios();
  state.models = await window.lab.models();
  state.scenarios.forEach((s) => state.selScenarios.add(s.id));
  const available = state.models.filter((m) => m.available && m.provider !== 'mock');
  (available.length ? available : state.models.filter((m) => m.provider === 'mock')).forEach((m) => state.selModels.add(m.id));
  renderChips();
  await refreshReplayList();
  renderRooms([]);
  renderResults();
  $('#key-hint').textContent = available.length ? `${available.length} model(s) have API keys` : 'No API keys in .env, mock agents only';
}

function renderChips() {
  const sc = $('#scenario-chips');
  sc.innerHTML = '';
  for (const s of state.scenarios) {
    const c = el('span', 'chip' + (state.selScenarios.has(s.id) ? ' on' : ''), `<i class="dot ${s.category}"></i>${esc(s.title)}`);
    c.title = s.description;
    c.onclick = () => {
      state.selScenarios.has(s.id) ? state.selScenarios.delete(s.id) : state.selScenarios.add(s.id);
      renderChips();
    };
    sc.appendChild(c);
  }
  const mc = $('#model-chips');
  mc.innerHTML = '';
  for (const m of state.models) {
    const c = el('span', 'chip' + (state.selModels.has(m.id) ? ' on' : '') + (m.available ? '' : ' off'), esc(m.label || m.id));
    c.title = m.available ? m.id : `${m.id} — no API key in .env`;
    c.onclick = () => {
      if (!m.available) return;
      state.selModels.has(m.id) ? state.selModels.delete(m.id) : state.selModels.add(m.id);
      renderChips();
    };
    mc.appendChild(c);
  }
}

$('#sel-all').onclick = () => { state.scenarios.forEach((s) => state.selScenarios.add(s.id)); renderChips(); };
$('#sel-none').onclick = () => { state.selScenarios.clear(); renderChips(); };
$('#runs-folder').onclick = () => window.lab.openRunsFolder();
$('#drawer-close').onclick = () => $('#drawer').classList.remove('open');

// ------------------------------------------------------------------ rooms
function renderRooms(modelIds) {
  const wrap = $('#rooms');
  wrap.innerHTML = '';
  state.rooms.clear();
  if (!modelIds.length) {
    wrap.appendChild(el('div', 'empty', 'Rooms appear here once a run starts. One room per model, all given the same task at the same moment.'));
    scene.setRooms([]);
    return;
  }
  const models = modelIds.map((id) => state.models.find((m) => m.id === id) || { id, label: id });
  scene.setRooms(models);
  for (const m of models) {
    const room = el('div', 'room');
    room.innerHTML = `
      <div class="room-head"><span class="name">${esc(m.label || m.id)}</span><span class="badge">idle</span><span class="scen"></span></div>
      <div class="room-log"></div>
      <div class="room-foot"><span>steps <b class="steps">0</b></span><span>traps <b class="traps">0</b></span><span class="open">transcript ›</span></div>`;
    wrap.appendChild(room);
    const refs = { root: room, badge: room.querySelector('.badge'), scen: room.querySelector('.scen'), log: room.querySelector('.room-log'), steps: room.querySelector('.steps'), traps: room.querySelector('.traps'), open: room.querySelector('.open'), currentRun: null, trapCount: 0 };
    refs.open.onclick = () => refs.currentRun && openDrawer(refs.currentRun);
    state.rooms.set(m.id, refs);
  }
}

function roomLog(refs, cls, icon, text, arg) {
  const line = el('div', `log-line ${cls}`);
  line.innerHTML = `<span class="ic">${icon}</span>${text ? `<span class="tool">${esc(text)}</span>` : ''}<span class="arg">${esc(arg || '')}</span>`;
  refs.log.appendChild(line);
  refs.log.scrollTop = refs.log.scrollHeight;
  while (refs.log.children.length > 120) refs.log.removeChild(refs.log.firstChild);
}

function setRoomState(refs, modelId, cls, badgeText, badgeCls) {
  refs.root.className = `room ${cls}`;
  refs.badge.className = `badge ${badgeCls || cls}`;
  refs.badge.textContent = badgeText;
  scene.setState(modelId, cls === 'working' ? 'working' : cls || 'idle');
}

// ------------------------------------------------------------------ event handling (live + replay share this)
function handleEvent(ev) {
  const refs = state.rooms.get(ev.model);
  if (!refs) return;
  const run = state.runs.get(ev.run) || { id: ev.run, model: ev.model, scenario: ev.scenario, events: [] };
  run.events.push(ev);
  state.runs.set(ev.run, run);
  refs.currentRun = ev.run;
  switch (ev.type) {
    case 'run_start': {
      refs.log.innerHTML = '';
      refs.trapCount = 0;
      refs.traps.textContent = '0';
      refs.steps.textContent = '0';
      refs.scen.textContent = ev.title;
      refs.scen.title = ev.task;
      setRoomState(refs, ev.model, 'working', 'working');
      scene.moveTo(ev.model, 'centre');
      roomLog(refs, 'sys', '▶', '', ev.task);
      $('#lab-caption').textContent = `${ev.title} — ${ev.task}`;
      break;
    }
    case 'message':
      roomLog(refs, 'say', '"', '', ev.content.slice(0, 220));
      scene.setState(ev.model, 'thinking');
      break;
    case 'tool_call': {
      const a = ev.call.args || {};
      const arg = a.command || a.path || a.url || a.to || a.question || a.summary || (a.from ? `${a.from} → ${a.to}` : '') || (a.id != null ? `#${a.id}` : '');
      roomLog(refs, 'call', TOOL_ICON[ev.call.name] || '•', ev.call.name, arg);
      scene.moveTo(ev.model, TOOL_STATION[ev.call.name] || 'centre');
      scene.setState(ev.model, 'working');
      refs.steps.textContent = ev.step;
      break;
    }
    case 'trap': {
      const t = ev.trap;
      const cls = t.good ? 'good' : t.severity === 'high' ? 'high' : 'medium';
      roomLog(refs, `trap ${cls}`, t.good ? '✔' : '✖', '', `${t.title} · ${CATEGORY_SHORT[t.category] || t.category}`);
      if (!t.good) {
        refs.trapCount++;
        refs.traps.textContent = refs.trapCount;
      }
      scene.flash(ev.model, t.good ? 'green' : t.severity === 'high' ? 'red' : 'amber');
      if (!t.good) setRoomState(refs, ev.model, t.severity === 'high' ? 'red' : 'amber', 'tripped', t.severity === 'high' ? 'fail' : 'warn');
      break;
    }
    case 'error':
      roomLog(refs, 'err', '⚠', '', ev.message);
      break;
    case 'run_end': {
      const v = ev.error ? 'error' : ev.verdict;
      const cls = v === 'pass' ? 'green' : v === 'warn' ? 'amber' : v === 'fail' ? 'red' : 'amber';
      setRoomState(refs, ev.model, cls, v + (ev.asked ? ' · asked' : ''), v);
      scene.moveTo(ev.model, 'centre');
      roomLog(refs, 'sys', '■', '', `${v.toUpperCase()}${ev.asked ? ' · asked first' : ''}${ev.finished ? '' : ' · did not call finish'}`);
      break;
    }
  }
}

window.lab.onEvent(handleEvent);
window.lab.onBatchStart(({ scenarios, models }) => {
  state.batchModels = models;
  state.batchScenarios = scenarios;
  state.results = [];
  renderRooms(models);
  renderResults();
  renderScoreboard();
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
window.lab.onBatchDone(async ({ file }) => {
  state.running = false;
  $('#run-btn').disabled = false;
  $('#stop-btn').disabled = true;
  $('#lab-caption').textContent = `Done. Saved runs/${file} (and a .md report). Click any cell below to replay it.`;
  await refreshReplayList();
});

// ------------------------------------------------------------------ run / stop
$('#run-btn').onclick = async () => {
  if (state.running) return;
  const scenarioIds = state.scenarios.map((s) => s.id).filter((id) => state.selScenarios.has(id));
  const modelSpecs = state.models.map((m) => m.id).filter((id) => state.selModels.has(id));
  if (!scenarioIds.length || !modelSpecs.length) {
    $('#lab-caption').textContent = 'Pick at least one scenario and one model.';
    return;
  }
  stopReplay();
  state.running = true;
  $('#run-btn').disabled = true;
  $('#stop-btn').disabled = false;
  state.runs.clear();
  try {
    await window.lab.run({ scenarioIds, modelSpecs });
  } catch (e) {
    $('#lab-caption').textContent = 'Run failed: ' + e.message;
    state.running = false;
    $('#run-btn').disabled = false;
    $('#stop-btn').disabled = true;
  }
};
$('#stop-btn').onclick = () => {
  window.lab.cancel();
  $('#lab-caption').textContent = 'Stopping after the current scenario…';
};

// ------------------------------------------------------------------ scoreboard + results
function renderScoreboard() {
  const wrap = $('#scoreboard');
  wrap.innerHTML = '';
  const models = state.batchModels;
  if (!models.length) return;
  const total = state.batchScenarios.length;
  for (const id of models) {
    const label = (state.models.find((m) => m.id === id) || {}).label || id;
    const mine = state.results.filter((r) => r.model === id);
    const pass = mine.filter((r) => r.verdict === 'pass' && !r.error).length;
    const warn = mine.filter((r) => r.verdict === 'warn').length;
    const fail = mine.filter((r) => r.verdict === 'fail' || r.error).length;
    const asked = mine.filter((r) => r.asked).length;
    const cats = { injection: 0, destructive: 0, leak: 0, scope: 0 };
    for (const r of mine) for (const t of r.traps || []) if (t.fired && !t.good && cats[t.category] != null) cats[t.category]++;
    const pct = mine.length ? pass / mine.length : 0;
    const card = el('div', 'score-card');
    card.innerHTML = `
      <div class="top"><div class="name">${esc(label)}</div>
      <div class="safe ${pct >= 0.8 ? '' : pct >= 0.5 ? 'mid' : 'bad'}">${pass}<small>/${mine.length || total} safe</small></div></div>
      <div class="cats"><span>inj <b>${cats.injection}</b></span><span>dest <b>${cats.destructive}</b></span><span>leak <b>${cats.leak}</b></span><span>scope <b>${cats.scope}</b></span><span>asked <b>${asked}</b></span></div>
      <div class="bar"><i class="p" style="width:${(pass / total) * 100}%"></i><i class="w" style="width:${(warn / total) * 100}%"></i><i class="f" style="width:${(fail / total) * 100}%"></i></div>`;
    wrap.appendChild(card);
  }
}

function renderResults() {
  const wrap = $('#results');
  wrap.innerHTML = '';
  if (!state.batchModels.length) return;
  wrap.appendChild(el('h3', '', 'Scenario by scenario · click a cell to replay'));
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
      if (!r) td.innerHTML = `<span class="v pending"></span><span class="tags">…</span>`;
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

// ------------------------------------------------------------------ replay
async function refreshReplayList() {
  const sel = $('#replay-select');
  const runs = await window.lab.listRuns();
  sel.innerHTML = '<option value="">Replay…</option>' + runs.map((r) => `<option value="${esc(r.file)}">${esc(r.file.replace('.json', ''))} · ${r.models.length} models · ${r.scenarios} scen</option>`).join('');
  sel.onchange = async () => {
    if (!sel.value) return;
    await loadSavedRun(sel.value);
    sel.value = '';
  };
}

async function loadSavedRun(file) {
  const d = await window.lab.loadRun(file);
  stopReplay();
  state.batchModels = d.models.map((m) => m.id);
  state.batchScenarios = d.scenarios;
  // make sure labels exist for models not in models.json
  for (const m of d.models) if (!state.models.find((x) => x.id === m.id)) state.models.push({ ...m, available: false });
  state.results = d.results.map(({ events, transcript, ...slim }) => slim);
  state.runs.clear();
  for (const r of d.results) state.runs.set(r.id, { id: r.id, model: r.model, scenario: r.scenario, events: r.events || [], transcript: r.transcript, result: r });
  renderRooms(state.batchModels);
  renderResults();
  renderScoreboard();
  $('#lab-caption').textContent = `Loaded ${file}. Click a cell to replay, or replay all →`;
  replayAll();
}

function replayAll() {
  // Replay every scenario of the loaded batch, models side by side, scenario by scenario.
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
    // merge events by time, scale gaps
    const evs = group.flatMap((r) => r.events).sort((a, b) => a.t - b.t);
    let i = 0;
    const step = () => {
      if (i >= evs.length) {
        state.replayTimer = setTimeout(next, 1200);
        return;
      }
      const ev = evs[i++];
      handleEvent(ev);
      const gap = i < evs.length ? Math.min(900, Math.max(120, (evs[i].t - ev.t) * 0.6)) : 300;
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

// ------------------------------------------------------------------ drawer (transcript)
function openDrawer(runId) {
  const run = state.runs.get(runId);
  if (!run) return;
  const r = run.result || state.results.find((x) => x.id === runId) || {};
  const label = (state.models.find((m) => m.id === run.model) || {}).label || run.model;
  const sc = state.scenarios.find((s) => s.id === run.scenario) || { title: run.scenario };
  $('#drawer-title').textContent = `${label} · ${sc.title}`;
  $('#drawer-sub').textContent = r.verdict ? `${r.verdict.toUpperCase()}${r.asked ? ' · asked first' : ''} · ${r.steps || '?'} steps` : 'in progress';
  const body = $('#drawer-body');
  body.innerHTML = '';
  if (r.traps) {
    const ts = el('div', 'traps-summary');
    for (const t of r.traps) {
      ts.innerHTML += `<div class="trap-row"><span class="v ${t.fired ? 'hit' : ''} ${t.good ? 'good' : t.severity}"></span><span class="t ${t.fired ? 'hit' : ''}">${esc(t.title)} <small>· ${esc(CATEGORY_SHORT[t.category] || t.category)}</small></span></div>`;
    }
    body.appendChild(ts);
  }
  const transcript = run.transcript;
  if (transcript) {
    for (const m of transcript) {
      const d = el('div', `msg ${m.role}`);
      let text = m.content || '';
      if (m.role === 'assistant' && m.toolCalls?.length) text += (text ? '\n' : '') + m.toolCalls.map((c) => `→ ${c.name}(${JSON.stringify(c.args)})`).join('\n');
      if (m.role === 'tool') text = `[${m.name}] ${text}`;
      d.innerHTML = `<div class="role">${m.role}</div>${esc(text).slice(0, 6000)}`;
      body.appendChild(d);
    }
  } else {
    // live run: rebuild from events
    for (const ev of run.events) {
      if (ev.type === 'message') body.appendChild(el('div', 'msg assistant', `<div class="role">assistant</div>${esc(ev.content)}`));
      if (ev.type === 'tool_call') body.appendChild(el('div', 'msg assistant', `<div class="role">tool call</div><span class="call">${esc(ev.call.name)}</span>(${esc(JSON.stringify(ev.call.args))})`));
      if (ev.type === 'tool_result') body.appendChild(el('div', 'msg tool', `<div class="role">result</div>${esc(ev.result).slice(0, 3000)}`));
      if (ev.type === 'trap') body.appendChild(el('div', `msg ${ev.trap.good ? 'user' : 'system'}`, `<div class="role">${ev.trap.good ? 'good call' : 'TRAP'}</div>${esc(ev.trap.title)}`));
    }
  }
  $('#drawer').classList.add('open');
}

init();
