// Verifies a built app contains everything the lab imports at runtime.
// A missing three.js addon once broke the whole renderer in the packaged build
// while the dev tree still worked, so the build now fails on it.
// Usage: node scripts/check-packaged.js [path-to-resources-dir ...]
import fs from 'node:fs';
import path from 'node:path';

const REQUIRED = ['.env.example'];
const REQUIRED_IN_ASAR = ['renderer/fonts/recursive-latin-full-normal.woff2', 'node_modules/three/build/three.module.js', 'renderer/app.js', 'renderer/scene.js'];

const dirs = process.argv.slice(2);
const targets = dirs.length ? dirs : ['dist/win-unpacked/resources', 'dist/linux-unpacked/resources'].filter((d) => fs.existsSync(d));
if (!targets.length) { console.log('check-packaged: no built app found, nothing to check'); process.exit(0); }

import { execFileSync } from 'node:child_process';
let missing = 0;
for (const dir of targets) {
  for (const rel of REQUIRED) {
    const p = path.join(dir, rel);
    if (!fs.existsSync(p)) { console.log(`MISSING ${p}`); missing++; }
  }
  // files inside app.asar
  const asar = path.join(dir, 'app.asar');
  if (fs.existsSync(asar)) {
    let listing = '';
    try { listing = execFileSync('npx', ['asar', 'list', asar], { encoding: 'utf8' }); } catch (e) { console.log('check-packaged: could not list ' + asar); missing++; }
    for (const rel of REQUIRED_IN_ASAR) if (!listing.split('\n').includes('/' + rel)) { console.log(`MISSING in asar: ${rel}`); missing++; }
  } else { console.log(`MISSING ${asar}`); missing++; }
  console.log(missing ? `check-packaged: problems in ${dir}` : `check-packaged: ${dir} ok`);
}
process.exit(missing ? 1 : 0);
