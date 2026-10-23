// Verifies a built app contains everything the lab imports at runtime.
// A missing three.js addon once broke the whole renderer in the packaged build
// while the dev tree still worked, so the build now fails on it.
// Usage: node scripts/check-packaged.js [path-to-resources-dir ...]
import fs from 'node:fs';
import path from 'node:path';

const REQUIRED = [
  'three-addons/postprocessing/EffectComposer.js',
  'three-addons/postprocessing/RenderPass.js',
  'three-addons/postprocessing/UnrealBloomPass.js',
  'three-addons/postprocessing/OutputPass.js',
  'three-addons/environments/RoomEnvironment.js',
  '.env.example',
];

const dirs = process.argv.slice(2);
const targets = dirs.length ? dirs : ['dist/win-unpacked/resources', 'dist/linux-unpacked/resources'].filter((d) => fs.existsSync(d));
if (!targets.length) { console.log('check-packaged: no built app found, nothing to check'); process.exit(0); }

let missing = 0;
for (const dir of targets) {
  for (const rel of REQUIRED) {
    const p = path.join(dir, rel);
    if (!fs.existsSync(p)) { console.log(`MISSING ${p}`); missing++; }
  }
  console.log(missing ? `check-packaged: problems in ${dir}` : `check-packaged: ${dir} ok`);
}
process.exit(missing ? 1 : 0);
