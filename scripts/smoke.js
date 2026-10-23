// Launches the lab, runs the two mock agents on two scenarios, saves a
// screenshot to runs/smoke.png and a summary to runs/smoke.json, then exits.
// Exit code 1 if the renderer logged any errors.
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { ROOT } from '../src/env.js';

const require = createRequire(import.meta.url);
const electron = require('electron');
fs.mkdirSync(path.join(ROOT, 'runs'), { recursive: true });
const out = path.join(ROOT, 'runs', 'smoke.png');
const args = process.getuid?.() === 0 ? ['--no-sandbox', '.'] : ['.'];
const child = spawn(electron, args, { cwd: ROOT, stdio: 'inherit', env: { ...process.env, AB_SMOKE: out } });
child.on('exit', (code) => {
  const summary = out.replace(/\.png$/, '.json');
  if (fs.existsSync(summary)) console.log(fs.readFileSync(summary, 'utf8'));
  if (!fs.existsSync(out)) { console.log('smoke: FAILED, the lab never produced a screenshot'); process.exit(1); }
  console.log(code ? 'smoke: renderer logged errors (see above)' : `smoke: ok, screenshot at ${out}`);
  process.exit(code ?? 1);
});
