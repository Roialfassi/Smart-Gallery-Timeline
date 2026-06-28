'use strict';

const path = require('path');
const config = require('./config');

/**
 * Active writable paths for the *currently open project*, mutable at runtime.
 *
 * The app is project-based: each project lives in a base folder with a
 * `.smartgallery/` subfolder holding its own SQLite DB + thumbnails. When a
 * project is opened, `setActive()` re-points these paths and the catalog engine
 * (database.js, thumbnails.js, exportvideo.js) follows.
 *
 * With NO project open there is deliberately no catalog: `dbFile`/`thumbnailDir`
 * are null so the engine refuses to read or write a shared, project-less bucket.
 * This is what guarantees full per-project isolation — nothing (the demo, the
 * CLI, a stray scan) can ever land photos in a catalog that another project sees.
 * Only `cacheDir` stays meaningful while idle: it is the app-global location of
 * the recent-projects registry, not a catalog.
 */

let active = null; // { baseDir, sgDir, name } | null

function setActive({ baseDir, sgDir, name }) {
  active = { baseDir, sgDir, name: name || null };
  return active;
}

function clear() {
  active = null;
}

function getActive() {
  return active;
}

/**
 * Current writable paths. When a project is open these point inside its
 * `.smartgallery/`; when idle the catalog paths are null (no shared bucket) and
 * only `cacheDir` (the app-global registry dir) is returned.
 */
function paths() {
  if (active) {
    return {
      baseDir: active.baseDir,
      cacheDir: active.sgDir,
      dbFile: path.join(active.sgDir, 'gallery.db'),
      thumbnailDir: path.join(active.sgDir, 'thumbnails'),
    };
  }
  return {
    baseDir: null,
    cacheDir: config.paths.cacheDir, // app-global: recent-projects registry only
    dbFile: null,
    thumbnailDir: null,
  };
}

module.exports = { paths, setActive, clear, getActive };
