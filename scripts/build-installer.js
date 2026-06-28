'use strict';

/*
 * Builds the Windows installer for Smart Gallery Timeline in two steps:
 *   1) electron-builder --dir  ->  dist-installer/win-unpacked
 *   2) makensis build/installer.nsi  ->  dist-installer/Smart Gallery Timeline Setup <ver>.exe
 *
 * Why not plain `electron-builder --win nsis`?
 *   - electron-builder's winCodeSign tooling archive contains macOS .dylib SYMLINKS
 *     that cannot be extracted on Windows without symlink privilege (Developer Mode
 *     or admin). On a stock user account this aborts the build. We work around it by
 *     pre-extracting that archive into the cache while excluding the (unused-on-Windows)
 *     *.dylib entries, so app-builder finds it already unpacked and skips extraction.
 *   - electron-builder's bundled NSIS template also tripped a "VERSION already defined"
 *     error in this toolchain, so we drive makensis directly with our own installer.nsi.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const VERSION = require(path.join(ROOT, 'package.json')).version;
const LOCALAPPDATA = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const CACHE = path.join(LOCALAPPDATA, 'electron-builder', 'Cache');

function log(msg) { console.log('[build-installer] ' + msg); }

// Pre-extract winCodeSign (excluding macOS symlinks) so app-builder skips extraction.
function fixWinCodeSignCache() {
  const wcsDir = path.join(CACHE, 'winCodeSign');
  const finalDir = path.join(wcsDir, 'winCodeSign-2.6.0');
  if (fs.existsSync(path.join(finalDir, 'rcedit-x64.exe'))) return true; // already good
  if (!fs.existsSync(wcsDir)) return false; // nothing downloaded yet
  const archive = fs.readdirSync(wcsDir).find((f) => f.endsWith('.7z'));
  if (!archive) return false;
  const sevenZip = path.join(ROOT, 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe');
  if (!fs.existsSync(sevenZip)) return false;
  log('pre-extracting winCodeSign (excluding macOS *.dylib symlinks)...');
  spawnSync(sevenZip, ['x', path.join(wcsDir, archive), `-o${finalDir}`, '-xr!*.dylib', '-y', '-bso0'], { stdio: 'inherit' });
  return fs.existsSync(path.join(finalDir, 'rcedit-x64.exe'));
}

function findMakensis() {
  // 1) electron-builder's downloaded copy (present locally after a full nsis build).
  const nsisRoot = path.join(CACHE, 'nsis');
  if (fs.existsSync(nsisRoot)) {
    const ver = fs.readdirSync(nsisRoot).find((d) => d.startsWith('nsis-3'));
    if (ver) {
      const exe = path.join(nsisRoot, ver, 'makensis.exe');
      if (fs.existsSync(exe)) return exe;
    }
  }
  // 2) A system-wide NSIS install (e.g. `choco install nsis` in CI, or a manual install).
  const programFiles86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  for (const exe of [
    path.join(programFiles86, 'NSIS', 'makensis.exe'),
    path.join(programFiles, 'NSIS', 'makensis.exe'),
  ]) {
    if (fs.existsSync(exe)) return exe;
  }
  // 3) Anything named makensis on PATH.
  const onPath = spawnSync('where', ['makensis'], { encoding: 'utf8' });
  if (onPath.status === 0) {
    const hit = onPath.stdout.split(/\r?\n/).map((s) => s.trim()).find((s) => s && fs.existsSync(s));
    if (hit) return hit;
  }
  return null;
}

function packAppDir() {
  // First attempt; if winCodeSign extraction blocks it, fix the cache and retry.
  let r = spawnSync('npx', ['electron-builder', '--dir'], { stdio: 'inherit', shell: true, cwd: ROOT });
  const exe = path.join(ROOT, 'dist-installer', 'win-unpacked', 'Smart Gallery Timeline.exe');
  if (fs.existsSync(exe)) { fixWinCodeSignCache(); return true; }
  log('first pack attempt did not produce the app; applying winCodeSign cache fix and retrying...');
  fixWinCodeSignCache();
  r = spawnSync('npx', ['electron-builder', '--dir'], { stdio: 'inherit', shell: true, cwd: ROOT });
  return fs.existsSync(exe);
}

(function main() {
  // Ensure better-sqlite3 matches Electron's ABI (no-op when already built for it).
  log('ensuring native modules target Electron ABI...');
  const rb = spawnSync('node', [path.join(ROOT, 'scripts', 'rebuild-native.js'), 'electron'], { stdio: 'inherit', cwd: ROOT });
  if (rb.status !== 0) { log('ERROR: native rebuild for Electron failed.'); process.exit(1); }

  if (!packAppDir()) {
    log('ERROR: electron-builder failed to produce dist-installer/win-unpacked.');
    process.exit(1);
  }
  const makensis = findMakensis();
  if (!makensis) {
    log('ERROR: makensis not found. Install NSIS (e.g. "choco install nsis") or run a full');
    log('       electron-builder nsis build once so it downloads NSIS into the cache.');
    process.exit(1);
  }
  const nsi = path.join(ROOT, 'build', 'installer.nsi');
  log('building installer v' + VERSION + ' with ' + makensis + ' ...');
  const r = spawnSync(makensis, [`-DROOT=${ROOT}`, `-DVERSION=${VERSION}`, nsi], { stdio: 'inherit' });
  if (r.status !== 0) { log('ERROR: makensis failed.'); process.exit(1); }
  log('Done. Installer is in dist-installer/.');
})();
