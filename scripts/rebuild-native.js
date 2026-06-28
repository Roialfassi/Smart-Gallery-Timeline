'use strict';

/*
 * Ensures the native better-sqlite3 binary matches the ABI of whatever is about
 * to run it:
 *   - `node scripts/rebuild-native.js node`     -> Node ABI   (npm start / scan)
 *   - `node scripts/rebuild-native.js electron`  -> Electron ABI (electron / dist)
 *
 * Electron 33 and Node 20 use different NODE_MODULE_VERSIONs, so the same .node
 * file can't serve both. A marker file records the last target and we skip the
 * (slow) rebuild when it already matches — so this is a cheap no-op in steady state.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const MARKER = path.join(ROOT, 'node_modules', '.sgt-native-abi');
const target = (process.argv[2] || 'node').toLowerCase();

function log(m) { console.log('[rebuild-native] ' + m); }
function readMarker() { try { return fs.readFileSync(MARKER, 'utf8').trim(); } catch (_) { return null; } }
function writeMarker(v) { try { fs.writeFileSync(MARKER, v); } catch (_) { /* best effort */ } }

function electronTag() {
  const v = require(path.join(ROOT, 'node_modules', 'electron', 'package.json')).version;
  return 'electron-' + v;
}

function main() {
  if (target === 'electron') {
    const tag = electronTag();
    if (readMarker() === tag) { log('better-sqlite3 already built for ' + tag + ' — skipping'); return; }
    const electronVersion = tag.replace('electron-', '');
    log('rebuilding better-sqlite3 for Electron ' + electronVersion + '...');
    const { rebuild } = require('@electron/rebuild');
    rebuild({ buildPath: ROOT, electronVersion, onlyModules: ['better-sqlite3'], force: true })
      .then(() => { writeMarker(tag); log('done.'); })
      .catch((e) => { console.error('[rebuild-native] FAILED:', e.message); process.exit(1); });
    return;
  }

  // node target
  if (readMarker() === 'node') { log('better-sqlite3 already built for Node — skipping'); return; }
  log('rebuilding better-sqlite3 for Node...');
  const r = spawnSync('npm', ['rebuild', 'better-sqlite3'], { stdio: 'inherit', shell: true, cwd: ROOT });
  if (r.status !== 0) { console.error('[rebuild-native] npm rebuild failed'); process.exit(1); }
  writeMarker('node');
  log('done.');
}

main();
