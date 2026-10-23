#!/usr/bin/env node
// agent-breaker CLI
//   node src/cli.js list
//   node src/cli.js run --scenario 01_notes_injection --models mock:naive,mock:careful
//   node src/cli.js run --all --models anthropic:claude-sonnet-4-5,openai:gpt-4o
//   node src/cli.js run --all                     (every model in models.json that has a key)
//   node src/cli.js report runs/<file>.json       (print the markdown table again)
import fs from 'node:fs';
import path from 'node:path';
import { loadEnv, loadModelsConfig, ROOT } from './env.js';
import { loadAllScenarios, loadScenariosByIds } from './scenarios.js';
import { runMatrix } from './runner.js';
import { markdownReport, consoleTable } from './report.js';
import { providerAvailable, parseModelSpec } from './providers/index.js';
import { CATEGORIES } from './traps.js';
import { discoverAll } from './providers/discover.js';

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m',
};
const paint = (c, s) => (process.stdout.isTTY ? `${C[c]}${s}${C.reset}` : s);

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) args[k] = true;
      else args[k] = next, i++;
    } else args._.push(a);
  }
  return args;
}

// --tier easy|medium|hard keeps only scenarios of that difficulty.
function filterTier(list, args) {
  if (!args.tier) return list;
  const tier = String(args.tier).toLowerCase();
  const out = list.filter((s) => (s.difficulty || 'easy') === tier);
  if (!out.length) throw new Error(`No scenarios with tier "${tier}"`);
  return out;
}

function resolveModels(args, env) {
  if (args.models) return String(args.models).split(',').map((s) => s.trim()).filter(Boolean).map(parseModelSpec);
  const configured = loadModelsConfig();
  const usable = configured.filter((m) => m.provider !== 'mock' && providerAvailable(m, env));
  if (!usable.length) {
    console.log(paint('yellow', 'No API keys found in .env, running the two mock agents so you can see the harness work.'));
    return configured.filter((m) => m.provider === 'mock');
  }
  return usable;
}

async function main() {
  const env = loadEnv();
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] || 'help';

  if (cmd === 'list') {
    for (const s of filterTier(loadAllScenarios(), args)) {
      console.log(`${paint('bold', s.id.padEnd(22))} ${s.title.padEnd(28)} ${paint('dim', CATEGORIES[s.category]?.short || s.category)}  ${paint('dim', s.difficulty || '')}`);
    }
    return;
  }

  if (cmd === 'models') {
    const { models, errors } = await discoverAll(env);
    if (!models.length && !Object.keys(errors).length) console.log(paint('yellow', 'No API keys in .env, so nothing to list. Add keys and run again.'));
    let last = '';
    for (const m of models) {
      if (m.provider !== last) { console.log(paint('bold', '\n' + m.provider)); last = m.provider; }
      console.log('  ' + m.id.padEnd(44) + paint('dim', m.label));
    }
    for (const [p, e] of Object.entries(errors)) if (p !== 'ollama') console.log(paint('red', `\n${p}: ${e}`));
    console.log(paint('dim', '\nUse any of these with --models provider:model'));
    return;
  }

  if (cmd === 'report') {
    const file = args._[1];
    if (!file) throw new Error('report needs a runs/*.json file');
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    console.log(markdownReport(data.results, { title: data.title }));
    return;
  }

  if (cmd === 'run') {
    const scenarios = filterTier(args.all || !args.scenario ? loadAllScenarios() : loadScenariosByIds(String(args.scenario).split(',')), args);
    const models = resolveModels(args, env);
    const maxSteps = args.steps ? Number(args.steps) : undefined;
    const repeat = args.repeat ? Math.max(1, Number(args.repeat)) : 1;
    console.log(paint('bold', `Agent Breaker`), paint('dim', `${scenarios.length} scenario(s) × ${models.length} model(s)${repeat > 1 ? ` × ${repeat} repeats` : ''}`));
    console.log(paint('dim', `models: ${models.map((m) => m.label || m.id).join(', ')}`), '\n');

    const onEvent = (ev) => {
      const tag = paint('cyan', `[${ev.modelLabel}]`);
      switch (ev.type) {
        case 'run_start':
          console.log(`${tag} ${paint('bold', ev.title)} ${paint('dim', '— ' + ev.task.slice(0, 90))}`);
          break;
        case 'message':
          if (!args.quiet) console.log(`${tag} ${paint('dim', '💬 ' + ev.content.replace(/\s+/g, ' ').slice(0, 140))}`);
          break;
        case 'tool_call': {
          const a = ev.call.args || {};
          const short = a.command || a.path || a.url || a.to || a.question || a.summary || a.from || '';
          console.log(`${tag} ${paint('blue', ev.call.name)} ${paint('dim', String(short).slice(0, 110))}`);
          break;
        }
        case 'trap': {
          const col = ev.trap.good ? 'green' : ev.trap.severity === 'high' ? 'red' : 'yellow';
          const icon = ev.trap.good ? '✔' : '✖';
          console.log(`${tag} ${paint(col, `${icon} TRAP ${ev.trap.title}`)} ${paint('dim', ev.trap.good ? '(good practice)' : '(' + (CATEGORIES[ev.trap.category]?.short || ev.trap.category) + ')')}`);
          break;
        }
        case 'error':
          console.log(`${tag} ${paint('red', '⚠ ' + ev.message)}`);
          break;
        case 'run_end': {
          const col = ev.verdict === 'pass' ? 'green' : ev.verdict === 'warn' ? 'yellow' : 'red';
          console.log(`${tag} ${paint(col, ev.verdict.toUpperCase())}${ev.asked ? paint('green', ' · asked first') : ''}${ev.finished ? '' : paint('dim', ' · did not call finish')}\n`);
          break;
        }
      }
    };

    const results = await runMatrix({ scenarios, models, onEvent, maxSteps, env, repeat });

    const runsDir = path.join(ROOT, 'runs');
    fs.mkdirSync(runsDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const title = `Agent Breaker · ${stamp}`;
    const jsonPath = path.join(runsDir, `${stamp}.json`);
    const mdPath = path.join(runsDir, `${stamp}.md`);
    fs.writeFileSync(jsonPath, JSON.stringify({ title, createdAt: Date.now(), models, scenarios: scenarios.map((s) => s.id), repeat, results }, null, 2));
    fs.writeFileSync(mdPath, markdownReport(results, { title }));
    fs.writeFileSync(path.join(runsDir, 'latest.json'), JSON.stringify({ title, createdAt: Date.now(), models, scenarios: scenarios.map((s) => s.id), results }));

    console.log(consoleTable(results));
    console.log(paint('dim', `\nSaved ${path.relative(process.cwd(), jsonPath)} and ${path.relative(process.cwd(), mdPath)}`));
    return;
  }

  console.log(`agent-breaker

  list                                   list scenarios
  list [--tier easy|medium|hard]         list scenarios (optionally one tier)
  models                                 list every model your API keys can use
  run [--all] [--scenario a,b] [--tier hard] [--models p:m,p:m] [--repeat N] [--steps N] [--quiet]
  report runs/<file>.json                reprint the markdown report

  models are provider:model, e.g. anthropic:claude-sonnet-4-5  openai:gpt-4o
  gemini:gemini-2.0-flash  ollama:llama3.1  mock:naive  mock:careful`);
}

main().catch((e) => {
  console.error(paint('red', e.stack || e.message));
  process.exit(1);
});
