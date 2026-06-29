'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
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

function thumbReady(file) {
  try { return fs.statSync(file).size > 0; } catch (_) { return false; }
}

async function renderTier(srcPath, hash, sizeType) {
  const tier = TIERS[sizeType];
  const out = thumbFile(hash, sizeType);
  if (thumbReady(out)) return out;
  await sharp(srcPath, { failOn: 'none' })
    .rotate() // auto-orient using EXIF orientation
    .resize({ width: tier.width, withoutEnlargement: true })
    .jpeg({ quality: tier.quality })
    .toFile(out);
  return out;
}

/**
 * Render both thumbnail tiers for a content hash, decoding the source ONCE.
 *
 * The full-resolution source is decoded a single time into the PREVIEW (800px)
 * buffer; the MICRO (150px) tier is then derived from that already-decoded
 * preview rather than decoding the multi-megapixel original a second time. Tiers
 * already present on disk (keyed by content hash) are reused, so a moved/renamed
 * file — or a re-scan — costs nothing here.
 *
 * Pure I/O: writes the hash-named jpgs and returns their paths; it touches no DB
 * row, so it is safe to run on the threadpool in parallel ahead of the (serial)
 * thumbnail_cache bookkeeping in `recordThumbnails`.
 *
 * @param {string|Buffer} input source path or already-read bytes
 * @returns {Promise<{MICRO?:string, PREVIEW?:string}>} paths of rendered tiers
 */
async function renderTiers(input, hash) {
  const out = { MICRO: thumbFile(hash, 'MICRO'), PREVIEW: thumbFile(hash, 'PREVIEW') };
  const result = {};
  if (thumbReady(out.MICRO)) result.MICRO = out.MICRO;
  if (thumbReady(out.PREVIEW)) result.PREVIEW = out.PREVIEW;
  if (result.MICRO && result.PREVIEW) return result;

  let previewBuf = null;
  if (!result.PREVIEW) {
    try {
      previewBuf = await sharp(input, { failOn: 'none' })
        .rotate()
        .resize({ width: TIERS.PREVIEW.width, withoutEnlargement: true })
        .jpeg({ quality: TIERS.PREVIEW.quality })
        .toBuffer();
      await fsp.writeFile(out.PREVIEW, previewBuf);
      result.PREVIEW = out.PREVIEW;
    } catch (_) { /* unsupported/corrupt source — non-fatal */ }
  }

  if (!result.MICRO) {
    try {
      // Derive MICRO from the freshly-decoded (already oriented) preview buffer
      // when available, so we avoid a second full-resolution decode. previewBuf
      // carries no EXIF, so the .rotate() below is a harmless no-op for it and a
      // proper auto-orient when we fall back to the original source.
      const microInput = previewBuf || input;
      await sharp(microInput, { failOn: 'none' })
        .rotate()
        .resize({ width: TIERS.MICRO.width, withoutEnlargement: true })
        .jpeg({ quality: TIERS.MICRO.quality })
        .toFile(out.MICRO);
      result.MICRO = out.MICRO;
    } catch (_) { /* non-fatal */ }
  }
  return result;
}

/** Upsert thumbnail_cache rows for already-rendered tier files (serial / DB). */
function recordThumbnails(photoId, files) {
  const db = getDb();
  const now = new Date().toISOString();
  const upsert = db.prepare(`
    INSERT INTO thumbnail_cache (photo_id, size_type, file_path, created_at, last_accessed_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(photo_id, size_type) DO UPDATE SET file_path = excluded.file_path
  `);
  for (const sizeType of Object.keys(TIERS)) {
    if (files[sizeType]) upsert.run(photoId, sizeType, files[sizeType], now, now);
  }
  return !!(files.MICRO && files.PREVIEW);
}

/**
 * Generate both tiers for a photo row and upsert thumbnail_cache entries.
 * Returns true on success, false if the source could not be decoded.
 * @param {Buffer} [buffer] source bytes if already read (avoids a disk re-read)
 */
async function generateForPhoto(photo, buffer) {
  const files = await renderTiers(buffer || photo.file_path, photo.content_hash);
  return recordThumbnails(photo.id, files);
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

module.exports = {
  generateForPhoto, resolveThumbnail, enforceLruEviction, thumbFile,
  renderTiers, recordThumbnails,
};
