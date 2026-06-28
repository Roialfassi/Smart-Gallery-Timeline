'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const runtimePaths = require('../runtime-paths');

let db = null;
let dbPath = null;

/**
 * Open (or create) the SQLite database, apply pragmas, and run the schema.
 * Idempotent — calling more than once returns the same connection.
 *
 * The target file comes from runtime-paths, which points at the currently open
 * project's `.smartgallery/gallery.db` (or the legacy default cache when no
 * project is active). `closeDb()` resets the handle so a later `getDb()` opens
 * the now-active project's database — that's how project switching re-points
 * the whole catalog engine.
 */
function getDb() {
  const p = runtimePaths.paths();
  if (db && dbPath === p.dbFile) return db;
  if (db && dbPath !== p.dbFile) closeDb(); // active project changed — reopen

  fs.mkdirSync(p.cacheDir, { recursive: true });
  fs.mkdirSync(p.thumbnailDir, { recursive: true });

  db = new Database(p.dbFile);
  dbPath = p.dbFile;
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');

  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);

  return db;
}

function closeDb() {
  if (db) {
    db.close();
    db = null;
    dbPath = null;
  }
}

module.exports = { getDb, closeDb };
