'use strict';

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const config = require('../config');
const runtimePaths = require('../runtime-paths');
const { getDb } = require('../db/database');

/**
 * Thumbnail generation pipeline (plan/features.md Section 6).
 *
 * Two tiers keyed by content hash (so moved/renamed files reuse thumbnails):
 *   MICRO   - 150px wide, JPG q75 — fast scrolling timeline grid
 *   PREVIEW - 800px wide, JPG q80 — lightbox & slideshow
 *
 * LRU eviction on a 1GB cap, driven by thumbnail_cache.last_accessed_at which
 * is refreshed on every retrieval.
 */

const TIERS = {
  MICRO: {
    width: config.scanning.THUMBNAIL_MICRO_WIDTH_PX,
    quality: config.scanning.THUMBNAIL_MICRO_QUALITY,
  },
  PREVIEW: {
    width: config.scanning.THUMBNAIL_PREVIEW_WIDTH_PX,
    quality: config.scanning.THUMBNAIL_PREVIEW_QUALITY,
  },
};

function thumbFile(hash, sizeType) {
  const safe = (hash || 'nohash').slice(0, 64);
  return path.join(runtimePaths.paths().thumbnailDir, `${safe}_${sizeType}.jpg`);
}

async function renderTier(srcPath, hash, sizeType) {
  const tier = TIERS[sizeType];
  const out = thumbFile(hash, sizeType);
  if (fs.existsSync(out) && fs.statSync(out).size > 0) return out;
  await sharp(srcPath, { failOn: 'none' })
    .rotate() // auto-orient using EXIF orientation
    .resize({ width: tier.width, withoutEnlargement: true })
    .jpeg({ quality: tier.quality })
    .toFile(out);
  return out;
}

/**
 * Generate both tiers for a photo row and upsert thumbnail_cache entries.
 * Returns true on success, false if the source could not be decoded.
 */
async function generateForPhoto(photo) {
  const db = getDb();
  const now = new Date().toISOString();
  const upsert = db.prepare(`
    INSERT INTO thumbnail_cache (photo_id, size_type, file_path, created_at, last_accessed_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(photo_id, size_type) DO UPDATE SET file_path = excluded.file_path
  `);
  let ok = true;
  for (const sizeType of Object.keys(TIERS)) {
    try {
      const file = await renderTier(photo.file_path, photo.content_hash, sizeType);
      upsert.run(photo.id, sizeType, file, now, now);
    } catch (_) {
      ok = false; // unsupported/corrupt source — non-fatal
    }
  }
  return ok;
}

/**
 * Refresh a thumbnail's last_accessed_at (LRU bookkeeping) off the response
 * path. This value only orders eviction, so the image bytes never need to wait
 * on the write — deferring it keeps thumbnail serving read-only in the hot path
 * even when a full grid requests dozens of tiles at once. Best-effort: a closed
 * project or a vanished row between request and defer is harmless.
 */
function touchLru(photoId, sizeType, file) {
  setImmediate(() => {
    try {
      const now = new Date().toISOString();
      getDb().prepare(`
        INSERT INTO thumbnail_cache (photo_id, size_type, file_path, created_at, last_accessed_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(photo_id, size_type) DO UPDATE SET last_accessed_at = excluded.last_accessed_at
      `).run(photoId, sizeType, file, now, now);
    } catch (_) { /* LRU touch is best-effort */ }
  });
}

/**
 * Resolve a thumbnail path for the UI, regenerating on demand if the cached
 * file is missing, and refreshing last_accessed_at for LRU.
 */
async function resolveThumbnail(photoId, sizeType) {
  if (!TIERS[sizeType]) sizeType = 'MICRO';
  const db = getDb();
  const photo = db.prepare('SELECT content_hash, file_path FROM photos WHERE id = ?').get(photoId);
  if (!photo) return null;

  let file = thumbFile(photo.content_hash, sizeType);
  if (!fs.existsSync(file) || fs.statSync(file).size === 0) {
    try {
      file = await renderTier(photo.file_path, photo.content_hash, sizeType);
    } catch (_) {
      return null;
    }
  }
  touchLru(photoId, sizeType, file);
  return file;
}

/** Evict least-recently-used thumbnails when total cache exceeds the cap. */
function enforceLruEviction() {
  const db = getDb();
  const rows = db
    .prepare('SELECT photo_id, size_type, file_path FROM thumbnail_cache ORDER BY last_accessed_at ASC')
    .all();
  let total = 0;
  const sized = [];
  for (const r of rows) {
    try {
      const size = fs.statSync(r.file_path).size;
      total += size;
      sized.push({ ...r, size });
    } catch (_) { /* file already gone */ }
  }
  if (total <= config.cache.THUMBNAIL_MAX_BYTES) return { evicted: 0, total };
  const del = db.prepare('DELETE FROM thumbnail_cache WHERE photo_id = ? AND size_type = ?');
  let evicted = 0;
  for (const r of sized) {
    if (total <= config.cache.THUMBNAIL_MAX_BYTES) break;
    try { fs.unlinkSync(r.file_path); } catch (_) { /* ignore */ }
    del.run(r.photo_id, r.size_type);
    total -= r.size;
    evicted++;
  }
  return { evicted, total };
}

module.exports = { generateForPhoto, resolveThumbnail, enforceLruEviction, thumbFile };
