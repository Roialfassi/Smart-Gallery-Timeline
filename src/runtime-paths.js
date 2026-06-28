'use strict';

const path = require('path');
const config = require('./config');

/**
 * Active writable paths for the *currently open project*, mutable at runtime.
 *
 * The app is project-based: each project lives in a base folder with a
 * `.smartgallery/` subfolder holding its own SQLite DB + thumbnails. When a
 * project is opened, `setActive()` re-points these paths and the catalog engine
 * (database.js, thumbnails.js, exportvideo.js) follows. With no project open,
 * `paths()` falls back to the legacy single-cache defaults from config so that
 * tooling/tests that never open a project still work.
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

/** Current writable paths — project paths when one is open, else config defaults. */
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
    cacheDir: config.paths.cacheDir,
    dbFile: config.paths.dbFile,
    thumbnailDir: config.paths.thumbnailDir,
  };
}

module.exports = { paths, setActive, clear, getActive };
