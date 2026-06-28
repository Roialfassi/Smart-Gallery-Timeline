'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Host-filesystem browser backing the in-app folder picker (New / Open project).
 *
 * The app is local-first and bound to loopback, so the renderer cannot see real
 * OS paths on its own. These helpers let the same-machine server enumerate
 * folders (drives, quick-access shortcuts, subdirectories) and create one, so the
 * UI can offer a proper folder explorer instead of a typed-path prompt. Only
 * directories are ever listed — never file contents.
 */

const SG_DIR = '.smartgallery';
// Filesystem-reserved characters by char code: < > : " / \ | ? *  (spaces &
// dashes are allowed in folder names, so they are deliberately not included).
const RESERVED = new Set([60, 62, 58, 34, 47, 92, 124, 63, 42]);

// Drop reserved + control characters from a proposed new-folder name.
function cleanName(name) {
  return String(name || '')
    .split('')
    .filter((ch) => { const cc = ch.charCodeAt(0); return cc >= 32 && !RESERVED.has(cc); })
    .join('')
    .trim();
}

function isProjectDir(dir) {
  try {
    return (
      fs.existsSync(path.join(dir, SG_DIR, 'project.json')) ||
      fs.existsSync(path.join(dir, SG_DIR, 'gallery.db'))
    );
  } catch (_) {
    return false;
  }
}

// Existing Windows drive roots (C:\, D:\, …); the filesystem root off Windows.
function drives() {
  if (process.platform !== 'win32') {
    return [{ name: '/', path: path.parse(os.homedir()).root, kind: 'drive' }];
  }
  const out = [];
  for (let c = 65; c <= 90; c++) {
    const root = String.fromCharCode(c) + ':' + path.sep;
    try {
      if (fs.existsSync(root)) out.push({ name: String.fromCharCode(c) + ':', path: root, kind: 'drive' });
    } catch (_) { /* not ready (e.g. empty card reader) — skip */ }
  }
  return out;
}

// Standard user folders that actually exist, for one-click access.
function shortcuts() {
  const home = os.homedir();
  return [
    { name: 'Home', path: home },
    { name: 'Desktop', path: path.join(home, 'Desktop') },
    { name: 'Documents', path: path.join(home, 'Documents') },
    { name: 'Pictures', path: path.join(home, 'Pictures') },
    { name: 'Downloads', path: path.join(home, 'Downloads') },
  ].filter((s) => {
    try { return fs.statSync(s.path).isDirectory(); } catch (_) { return false; }
  }).map((s) => ({ ...s, kind: 'shortcut' }));
}

/**
 * List the directories inside `dir`. With no `dir` (the "This PC" root) returns
 * just the places (shortcuts + drives). `places` is always included so the UI
 * can render a stable quick-access sidebar.
 */
function list(dir) {
  const places = [...shortcuts(), ...drives()];
  if (!dir || !String(dir).trim()) {
    return { path: null, parent: null, name: 'This PC', isProject: false, places, entries: [] };
  }

  const abs = path.resolve(String(dir).trim());
  const st = fs.statSync(abs); // ENOENT here -> handled by the route as 404
  if (!st.isDirectory()) {
    const e = new Error('Not a folder: ' + abs);
    e.fsCode = 'ENOTDIR';
    throw e;
  }

  let dirents;
  try {
    dirents = fs.readdirSync(abs, { withFileTypes: true });
  } catch (_) {
    const e = new Error('Cannot read this folder (permission denied).');
    e.fsCode = 'EACCES';
    throw e;
  }

  const entries = dirents
    .filter((d) => {
      try { if (!d.isDirectory()) return false; } catch (_) { return false; }
      if (d.name === SG_DIR || d.name.startsWith('.')) return false; // hide catalog + dotfolders
      return true;
    })
    .map((d) => {
      const full = path.join(abs, d.name);
      return { name: d.name, path: full, kind: 'dir', isProject: isProjectDir(full) };
    })
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

  const parentPath = path.dirname(abs);
  return {
    path: abs,
    parent: parentPath !== abs ? parentPath : null, // null at a drive root
    name: path.basename(abs) || abs,
    isProject: isProjectDir(abs),
    places,
    entries,
  };
}

/** Create `name` inside `parent` and return its absolute path. */
function makeDir(parent, name) {
  if (!parent || !String(parent).trim()) {
    const e = new Error('Pick a location first.'); e.fsCode = 'EINVAL'; throw e;
  }
  const clean = cleanName(name);
  if (!clean) {
    const e = new Error('Enter a valid folder name.'); e.fsCode = 'EINVAL'; throw e;
  }
  const absParent = path.resolve(String(parent).trim());
  if (!fs.existsSync(absParent) || !fs.statSync(absParent).isDirectory()) {
    const e = new Error('That location no longer exists.'); e.fsCode = 'ENOENT'; throw e;
  }
  const target = path.join(absParent, clean);
  fs.mkdirSync(target, { recursive: true });
  return { path: target, name: clean };
}

module.exports = { list, makeDir, isProjectDir };
