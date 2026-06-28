'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const config = require('../config');
const runtimePaths = require('../runtime-paths');
const { discover, scanDirectory } = require('./scanner');

/**
 * Import = COPY image files into the active project's base folder, then run the
 * existing incremental scanner over that base folder to index them. This keeps
 * each project self-contained / portable (the chosen import model) while reusing
 * the whole scan -> thumbnail -> rollup pipeline unchanged.
 */

const IMAGE_EXT = new Set(config.formats.ALL_IMAGES);
const ILLEGAL = /[<>:"/\\|?*]/g; // Windows-illegal filename characters

function isImageFile(file) {
  return IMAGE_EXT.has(path.extname(file).toLowerCase());
}

function activeBaseDir() {
  const a = runtimePaths.getActive();
  if (!a) {
    const e = new Error('No active project. Open or create a project before importing.');
    e.errorCode = 'NO_ACTIVE_PROJECT';
    throw e;
  }
  return a.baseDir;
}

// Return a destination path that does not collide, appending " (n)" before the ext.
function uniqueDest(dest) {
  if (!fs.existsSync(dest)) return dest;
  const dir = path.dirname(dest);
  const ext = path.extname(dest);
  const stem = path.basename(dest, ext);
  let n = 1;
  let candidate;
  do {
    candidate = path.join(dir, stem + ' (' + n + ')' + ext);
    n++;
  } while (fs.existsSync(candidate));
  return candidate;
}

// Pick a destination subfolder name under base that doesn't already exist.
function uniqueSubdir(baseDir, name) {
  const safe = (name || 'Imported').replace(ILLEGAL, '_').trim() || 'Imported';
  let candidate = path.join(baseDir, safe);
  let n = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(baseDir, safe + ' (' + n + ')');
    n++;
  }
  return candidate;
}

async function copyOne(srcPath, destPath) {
  await fsp.mkdir(path.dirname(destPath), { recursive: true });
  await fsp.copyFile(srcPath, uniqueDest(destPath));
}

/**
 * Copy whole folders into the project. Each source folder becomes its own
 * subfolder under the base dir, preserving the source's internal structure.
 */
async function importFolders({ sources = [], onProgress } = {}) {
  const baseDir = activeBaseDir();
  const emit = (evt) => onProgress && onProgress(evt);
  const list = (Array.isArray(sources) ? sources : [sources]).filter(Boolean);

  // 1) Enumerate everything first so we can report a real total.
  const jobs = [];
  for (const src of list) {
    const abs = path.resolve(src);
    if (!fs.existsSync(abs)) continue;
    const destRoot = uniqueSubdir(baseDir, path.basename(abs));
    const files = await discover(abs);
    for (const f of files) {
      jobs.push({ src: f.path, dest: path.join(destRoot, path.relative(abs, f.path)) });
    }
  }

  if (jobs.length === 0) {
    const e = new Error('No images found in the selected folder(s).');
    e.errorCode = 'PATH_NOT_FOUND';
    throw e;
  }

  // 2) Copy.
  emit({ phase: 'copy', processed: 0, total: jobs.length });
  let copied = 0;
  for (const job of jobs) {
    try { await copyOne(job.src, job.dest); copied++; } catch (_) { /* skip unreadable */ }
    if (copied % 10 === 0 || copied === jobs.length) {
      emit({ phase: 'copy', processed: copied, total: jobs.length });
    }
  }

  // 3) Index the base folder (incremental scan: thumbnails, rollups, etc.).
  const summary = await scanDirectory(baseDir, { onProgress });
  return { ...summary, copied };
}

/**
 * Copy individually-selected image files into a single subfolder, then scan.
 */
async function importFiles({ files = [], subdir = 'Imported', onProgress } = {}) {
  const baseDir = activeBaseDir();
  const emit = (evt) => onProgress && onProgress(evt);
  const list = (Array.isArray(files) ? files : [files])
    .filter((f) => f && fs.existsSync(f) && isImageFile(f));

  if (list.length === 0) {
    const e = new Error('No valid image files selected.');
    e.errorCode = 'PATH_NOT_FOUND';
    throw e;
  }

  const destRoot = uniqueSubdir(baseDir, subdir);
  emit({ phase: 'copy', processed: 0, total: list.length });
  let copied = 0;
  for (const f of list) {
    try { await copyOne(f, path.join(destRoot, path.basename(f))); copied++; } catch (_) { /* skip */ }
    if (copied % 10 === 0 || copied === list.length) {
      emit({ phase: 'copy', processed: copied, total: list.length });
    }
  }

  const summary = await scanDirectory(baseDir, { onProgress });
  return { ...summary, copied };
}

module.exports = { importFolders, importFiles };
