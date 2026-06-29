'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const config = require('../config');
const { getDb } = require('../db/database');
const { computeContentHash } = require('./hashing');
const { extractMetadata } = require('./metadata');
const thumbnails = require('./thumbnails');
const rollups = require('./rollups');
const keywords = require('./keywords');

/**
 * Ingestion & incremental scan engine (plan/architecture.md Section 4).
 *
 * Ordering is strict to resolve renames/deletes without duplication:
 *   1. File system discovery
 *   2. Purge pass (mark DB paths absent from disk as 'missing')   -- runs FIRST
 *   3. Change & move detection (mtime+size skip; hash-based move re-association)
 *   4. Rollup rebuild                                              -- runs LAST
 */

const IGNORE_EXT = new Set(config.scanning.IGNORE_EXTENSIONS);
const IMAGE_EXT = new Set(config.formats.ALL_IMAGES);
const WRITABLE_EXT = new Set(config.formats.WRITABLE);
const CONCURRENCY = Math.max(1, config.scanning.SCAN_CONCURRENCY || 4);

/**
 * Run `worker` over `items` with at most `limit` in flight at once, preserving
 * input order in the returned array. Used to fan the per-file ingest work
 * (read + hash + EXIF + thumbnail decode) onto the libuv threadpool while the
 * caller keeps all SQLite writes serial.
 */
async function mapLimit(items, limit, worker) {
  const ret = new Array(items.length);
  let next = 0;
  async function run() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      ret[i] = await worker(items[i], i);
    }
  }
  const lanes = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: lanes }, run));
  return ret;
}

function normExt(file) {
  return path.extname(file).toLowerCase();
}

function isImage(file) {
  const ext = normExt(file);
  if (IGNORE_EXT.has(ext)) return false;
  return IMAGE_EXT.has(ext);
}

// Recursively discover image files under root. Returns [{path, size, mtime}].
async function discover(root) {
  const out = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (err) {
      return; // unreadable directory — skip
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue;
        // Hard project boundary: a subfolder that is itself a project owns its
        // own catalog, so we never descend into it — its photos must not bleed
        // into this scan. (Keeps the demo / sibling projects fully isolated even
        // when one project's base folder nests another.)
        if (fs.existsSync(path.join(full, '.smartgallery'))) continue;
        await walk(full);
      } else if (ent.isFile() && isImage(ent.name)) {
        try {
          const st = await fsp.stat(full);
          out.push({ path: full, size: st.size, mtime: Math.floor(st.mtimeMs) });
        } catch (_) { /* race: file vanished */ }
      }
    }
  }
  await walk(root);
  return out;
}

function getOrCreateDirectory(dirPath) {
  const db = getDb();
  const abs = path.resolve(dirPath);
  const existing = db.prepare('SELECT * FROM directories WHERE path = ?').get(abs);
  if (existing) return existing;
  const info = db.prepare('INSERT INTO directories (path, status) VALUES (?, ?)').run(abs, 'idle');
  return db.prepare('SELECT * FROM directories WHERE id = ?').get(info.lastInsertRowid);
}

async function buildPhotoRecord(directoryId, file, buffer) {
  const ext = normExt(file.path);
  const format = ext.replace('.', '');
  const writable = WRITABLE_EXT.has(ext) ? 1 : 0;
  const content_hash = computeContentHash(file.path, format, buffer);
  const meta = await extractMetadata(file.path, buffer);
  return {
    directory_id: directoryId,
    file_path: file.path,
    file_name: path.basename(file.path),
    folder_name: path.basename(path.dirname(file.path)),
    file_size: file.size,
    mtime: file.mtime,
    content_hash,
    format,
    writable,
    date_taken: meta.date_taken,
    tz_offset: meta.tz_offset,
    country_code: meta.country_code,
    latitude: meta.latitude,
    longitude: meta.longitude,
    altitude: meta.altitude,
    camera_make: meta.camera_make,
    camera_model: meta.camera_model,
    orientation: meta.orientation,
    width: meta.width,
    height: meta.height,
    status: 'active',
  };
}

const INSERT_PHOTO = `
  INSERT INTO photos (
    directory_id, file_path, file_name, folder_name, file_size, mtime, content_hash,
    format, writable, date_taken, tz_offset, country_code, latitude, longitude, altitude,
    camera_make, camera_model, orientation, width, height, status
  ) VALUES (
    @directory_id, @file_path, @file_name, @folder_name, @file_size, @mtime, @content_hash,
    @format, @writable, @date_taken, @tz_offset, @country_code, @latitude, @longitude, @altitude,
    @camera_make, @camera_model, @orientation, @width, @height, @status
  )
`;

const UPDATE_PHOTO_META = `
  UPDATE photos SET
    file_size=@file_size, mtime=@mtime, content_hash=@content_hash, format=@format,
    writable=@writable, date_taken=@date_taken, tz_offset=@tz_offset, country_code=@country_code,
    latitude=@latitude, longitude=@longitude, altitude=@altitude, camera_make=@camera_make,
    camera_model=@camera_model, orientation=@orientation, width=@width, height=@height,
    folder_name=@folder_name, status='active'
  WHERE id=@id
`;

/**
 * Scan a directory. `onProgress(evt)` receives {phase, processed, total, ...}.
 * Returns a summary of counts.
 */
async function scanDirectory(dirPath, { onProgress } = {}) {
  const db = getDb();
  const dir = getOrCreateDirectory(dirPath);
  db.prepare('UPDATE directories SET status = ? WHERE id = ?').run('scanning', dir.id);
  const emit = (evt) => { if (onProgress) onProgress(evt); };

  const summary = { added: 0, updated: 0, moved: 0, missing: 0, skipped: 0, failed: 0 };

  try {
    // --- 1. Discovery ---
    emit({ phase: 'discovery', message: 'Scanning filesystem...' });
    const diskFiles = await discover(dir.path);
    const diskByPath = new Map(diskFiles.map((f) => [f.path, f]));

    // --- 2. Purge pass (FIRST): mark DB rows absent from disk as missing ---
    emit({ phase: 'purge', message: 'Detecting removed files...' });
    const dbRows = db
      .prepare('SELECT id, file_path, status FROM photos WHERE directory_id = ?')
      .all(dir.id);
    const markMissing = db.prepare("UPDATE photos SET status = 'missing' WHERE id = ?");
    const purgeTx = db.transaction(() => {
      for (const row of dbRows) {
        if (!diskByPath.has(row.file_path) && row.status !== 'missing') {
          markMissing.run(row.id);
          summary.missing++;
        }
      }
    });
    purgeTx();

    // --- 3. Change & move detection (SECOND) ---
    const total = diskFiles.length;
    const insertStmt = db.prepare(INSERT_PHOTO);
    const updateStmt = db.prepare(UPDATE_PHOTO_META);
    const findByPath = db.prepare('SELECT id, file_size, mtime, status FROM photos WHERE file_path = ?');
    const findMissingByHash = db.prepare(
      "SELECT * FROM photos WHERE content_hash = ? AND status = 'missing' LIMIT 1"
    );
    const reactivate = db.prepare("UPDATE photos SET status = 'active' WHERE id = ?");
    const reassignMove = db.prepare(
      "UPDATE photos SET file_path=@file_path, file_name=@file_name, folder_name=@folder_name, " +
      "file_size=@file_size, mtime=@mtime, status='active' WHERE id=@id"
    );

    // 3a. Classify every disk file by path (serial, cheap — no file I/O). Files
    // that are byte-identical to their DB row (same size+mtime) are skipped here;
    // the rest queue for the heavy compute phase below.
    const toProcess = []; // { file, kind: 'update'|'new', existingId? }
    for (const file of diskFiles) {
      const existing = findByPath.get(file.path);
      if (existing) {
        if (existing.file_size === file.size && existing.mtime === file.mtime) {
          if (existing.status === 'missing') reactivate.run(existing.id);
          summary.skipped++;
        } else {
          toProcess.push({ file, kind: 'update', existingId: existing.id });
        }
      } else {
        toProcess.push({ file, kind: 'new' });
      }
    }

    // 3b. Heavy per-file work in parallel: read the bytes ONCE, then hash +
    // extract metadata + render both thumbnail tiers off that single buffer.
    // No SQLite here — thumbnail files are keyed by content hash, so this phase
    // is pure I/O and safe to fan out; the DB writes happen serially in 3c.
    let processed = summary.skipped; // skipped files are already "done"
    await mapLimit(toProcess, CONCURRENCY, async (item) => {
      try {
        let buffer = null;
        try { buffer = await fsp.readFile(item.file.path); } catch (_) { /* re-read fallback below */ }
        item.rec = await buildPhotoRecord(dir.id, item.file, buffer);
        item.thumbFiles = await thumbnails
          .renderTiers(buffer || item.file.path, item.rec.content_hash)
          .catch(() => ({}));
      } catch (err) {
        item.error = err;
      }
      processed++; // single-threaded between awaits, so this counter is race-free
      if (processed % 10 === 0 || processed === total) {
        emit({ phase: 'ingest', processed, total, summary });
      }
    });

    // 3c. Apply DB writes serially and IN ORDER so move/rename re-association
    // (claiming a 'missing' row by content hash) stays deterministic — exactly
    // as the original single-pass loop did.
    for (const item of toProcess) {
      if (item.error || !item.rec) {
        summary.failed++;
        emit({ phase: 'error', file: item.file.path, message: item.error ? item.error.message : 'compute failed' });
        continue;
      }
      try {
        if (item.kind === 'update') {
          updateStmt.run({ ...item.rec, id: item.existingId });
          thumbnails.recordThumbnails(item.existingId, item.thumbFiles || {});
          summary.updated++;
        } else {
          const movedRow = findMissingByHash.get(item.rec.content_hash);
          if (movedRow) {
            reassignMove.run({
              id: movedRow.id,
              file_path: item.file.path,
              file_name: item.rec.file_name,
              folder_name: item.rec.folder_name,
              file_size: item.file.size,
              mtime: item.file.mtime,
            });
            thumbnails.recordThumbnails(movedRow.id, item.thumbFiles || {}); // reused via stable hash
            summary.moved++;
          } else {
            const info = insertStmt.run(item.rec);
            thumbnails.recordThumbnails(info.lastInsertRowid, item.thumbFiles || {});
            summary.added++;
          }
        }
      } catch (err) {
        summary.failed++;
        emit({ phase: 'error', file: item.file.path, message: err.message });
      }
    }

    // --- 4. Rollup rebuild + derived keyword tags (LAST) ---
    emit({ phase: 'rollups', message: 'Rebuilding timeline summaries...' });
    rollups.rebuildAll();
    keywords.regenerateFolderTags();
    thumbnails.enforceLruEviction();

    db.prepare('UPDATE directories SET status = ?, last_scanned_at = ? WHERE id = ?')
      .run('idle', new Date().toISOString(), dir.id);
    emit({ phase: 'done', summary });
    return { ...summary, directoryId: dir.id, total };
  } catch (err) {
    db.prepare('UPDATE directories SET status = ? WHERE id = ?').run('error', dir.id);
    emit({ phase: 'fatal', message: err.message });
    throw err;
  }
}

module.exports = { scanDirectory, getOrCreateDirectory, discover };
