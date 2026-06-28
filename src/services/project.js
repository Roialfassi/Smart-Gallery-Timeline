'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config');
const runtimePaths = require('../runtime-paths');
const database = require('../db/database');

/**
 * Project lifecycle. A project IS a base folder containing a `.smartgallery/`
 * subfolder (its own SQLite DB + thumbnails + manifest). Opening a project
 * re-points the catalog engine via runtime-paths; the recent-projects registry
 * (the only app-global state) lives in the legacy app cache dir.
 */

const REGISTRY = path.join(config.paths.cacheDir, 'projects.json');
const MANIFEST_VERSION = 1;

function sgDir(baseDir) {
  return path.join(path.resolve(baseDir), '.smartgallery');
}
function manifestPath(baseDir) {
  return path.join(sgDir(baseDir), 'project.json');
}
function dbPathFor(baseDir) {
  return path.join(sgDir(baseDir), 'gallery.db');
}

/** True if the folder already holds a Smart Gallery project. */
function isProject(baseDir) {
  if (!baseDir) return false;
  return fs.existsSync(manifestPath(baseDir)) || fs.existsSync(dbPathFor(baseDir));
}

function readManifest(baseDir) {
  try {
    return JSON.parse(fs.readFileSync(manifestPath(baseDir), 'utf8'));
  } catch (_) {
    return null;
  }
}

function notFound(message, details) {
  const e = new Error(message);
  e.errorCode = 'PATH_NOT_FOUND';
  e.details = details || {};
  return e;
}

/** Activate `baseDir` as the current project (re-points the catalog engine). */
function activate(baseDir, name) {
  const abs = path.resolve(baseDir);
  database.closeDb();
  runtimePaths.setActive({ baseDir: abs, sgDir: sgDir(abs), name });
  database.getDb(); // create dirs + migrate schema against the project DB
  recordRecent(abs, name);
  return getActive();
}

/** Create a brand-new project at `baseDir` (folder may not exist yet). */
function createProject({ baseDir, name } = {}) {
  if (!baseDir || !String(baseDir).trim()) {
    const e = new Error('A base folder is required to create a project.');
    e.errorCode = 'INVALID_IMAGE_FORMAT';
    throw e;
  }
  const abs = path.resolve(baseDir);
  fs.mkdirSync(sgDir(abs), { recursive: true });
  const projectName = (name && name.trim()) || path.basename(abs) || 'Untitled Project';
  fs.writeFileSync(
    manifestPath(abs),
    JSON.stringify({ name: projectName, version: MANIFEST_VERSION, createdAt: new Date().toISOString() }, null, 2)
  );
  return activate(abs, projectName);
}

/** Open an existing project folder. */
function openProject(baseDir) {
  if (!baseDir || !String(baseDir).trim()) throw notFound('A project folder is required.');
  const abs = path.resolve(baseDir);
  if (!fs.existsSync(abs)) throw notFound('Folder does not exist: ' + abs, { path: abs });
  if (!isProject(abs)) {
    throw notFound('That folder is not a Smart Gallery project (no .smartgallery found).', { path: abs });
  }
  const manifest = readManifest(abs);
  const name = (manifest && manifest.name) || path.basename(abs);
  return activate(abs, name);
}

/** Currently open project, or null. */
function getActive() {
  const a = runtimePaths.getActive();
  if (!a) return null;
  return { baseDir: a.baseDir, name: a.name };
}

function closeProject() {
  database.closeDb();
  runtimePaths.clear();
}

/* ------------------------------- Recent registry ------------------------------ */

function loadRegistry() {
  try {
    const data = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch (_) {
    return [];
  }
}

function saveRegistry(list) {
  try {
    fs.mkdirSync(path.dirname(REGISTRY), { recursive: true });
    fs.writeFileSync(REGISTRY, JSON.stringify(list, null, 2));
  } catch (_) { /* registry is best-effort */ }
}

function recordRecent(baseDir, name) {
  const abs = path.resolve(baseDir);
  const list = loadRegistry().filter((e) => path.resolve(e.baseDir) !== abs);
  list.unshift({ baseDir: abs, name: name || path.basename(abs), lastOpened: new Date().toISOString() });
  saveRegistry(list.slice(0, 20));
}

/** Recent projects, most-recent first, pruning folders that no longer exist. */
function listRecent() {
  const list = loadRegistry().filter((e) => e && e.baseDir && isProject(e.baseDir));
  // Persist the pruned list so dead entries don't linger.
  if (list.length !== loadRegistry().length) saveRegistry(list);
  return list.map((e) => ({ baseDir: e.baseDir, name: e.name || path.basename(e.baseDir), lastOpened: e.lastOpened }));
}

module.exports = {
  sgDir, manifestPath, isProject,
  createProject, openProject, activate, getActive, closeProject,
  listRecent, recordRecent,
};
