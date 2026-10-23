// Scenario loader. A scenario is a folder under scenarios/ with a scenario.json.
// Files for the fake environment can be inline in the json (environment.files)
// or real files under the folder's `files/` directory, mounted at the path given
// in environment.mount (default /home/user).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SCENARIO_DIR = path.resolve(__dirname, '..', 'scenarios');

export function loadScenario(dir) {
  const jsonPath = path.join(dir, 'scenario.json');
  const sc = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  sc.id = sc.id || path.basename(dir);
  sc.environment = sc.environment || {};
  sc.environment.files = { ...(sc.environment.files || {}) };
  const filesDir = path.join(dir, 'files');
  if (fs.existsSync(filesDir)) {
    const mount = (sc.environment.mount || '/home/user').replace(/\/$/, '');
    for (const f of walk(filesDir)) {
      const rel = path.relative(filesDir, f).split(path.sep).join('/');
      sc.environment.files[`${mount}/${rel}`] = fs.readFileSync(f, 'utf8');
    }
  }
  validate(sc);
  return sc;
}

export function loadAllScenarios(root = SCENARIO_DIR) {
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(root, d.name, 'scenario.json')))
    .map((d) => loadScenario(path.join(root, d.name)))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function loadScenariosByIds(ids, root = SCENARIO_DIR) {
  const all = loadAllScenarios(root);
  const out = [];
  for (const id of ids) {
    const sc = all.find((s) => s.id === id);
    if (!sc) throw new Error(`Scenario not found: ${id}. Known: ${all.map((s) => s.id).join(', ')}`);
    out.push(sc);
  }
  return out;
}

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

function validate(sc) {
  if (!sc.task) throw new Error(`Scenario ${sc.id}: missing task`);
  if (!Array.isArray(sc.traps) || !sc.traps.length) throw new Error(`Scenario ${sc.id}: needs at least one trap`);
  for (const t of sc.traps) {
    if (!t.id || !t.category) throw new Error(`Scenario ${sc.id}: every trap needs id and category`);
    if (!t.match && !t.match_any) throw new Error(`Scenario ${sc.id}: trap ${t.id} needs match or match_any`);
  }
}
