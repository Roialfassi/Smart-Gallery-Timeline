'use strict';

const { getDb } = require('../db/database');
const config = require('../config');
const { SpatialIndex } = require('./spatial');

/**
 * Weighted tag recommendation engine (plan/features.md Section 4).
 *
 *   R(T) = w_spatial·S(T) + w_temporal·T(T) + w_folder·F(T)
 *
 *   S(T): occurrences of T among photos within TAG_SUGGESTION_RADIUS_METERS
 *         of P, divided by photos in that radius.                w = 0.5
 *   T(T): occurrences of T among photos within TEMPORAL_WINDOW_HOURS of P,
 *         divided by photos in that window.                      w = 0.3
 *   F(T): 1 if T appears on other photos in the same folder.     w = 0.2
 *
 * Tags scoring above RECOMMENDATION_THRESHOLD are returned as chips.
 */

const { WEIGHT_SPATIAL, WEIGHT_TEMPORAL, WEIGHT_FOLDER, TEMPORAL_WINDOW_HOURS, RECOMMENDATION_THRESHOLD } = config.tagging;

function tagCountsIn(db, ids) {
  if (ids.length === 0) return { map: new Map(), total: 0 };
  const placeholders = ids.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT tag_id, COUNT(*) c FROM photo_tags WHERE photo_id IN (${placeholders}) GROUP BY tag_id`)
    .all(...ids);
  return { map: new Map(rows.map((r) => [r.tag_id, r.c])), total: ids.length };
}

function recommend(photoId) {
  const db = getDb();
  const p = db.prepare('SELECT * FROM photos WHERE id = ?').get(photoId);
  if (!p) return [];

  const existing = new Set(
    db.prepare('SELECT tag_id FROM photo_tags WHERE photo_id = ?').all(photoId).map((r) => r.tag_id)
  );

  // Spatial neighbourhood (R-Tree role via SpatialIndex)
  let spatialIds = [];
  if (p.latitude != null) {
    const all = db.prepare("SELECT id, latitude AS lat, longitude AS lon FROM photos WHERE status='active' AND latitude IS NOT NULL").all();
    const idx = new SpatialIndex();
    all.forEach((x) => idx.insert(x));
    spatialIds = idx.within(p.latitude, p.longitude, config.spatial.TAG_SUGGESTION_RADIUS_METERS)
      .map((x) => x.id).filter((id) => id !== photoId);
  }

  // Temporal window
  let temporalIds = [];
  if (p.date_taken) {
    const t = new Date(p.date_taken).getTime();
    const windowMs = TEMPORAL_WINDOW_HOURS * 3600 * 1000;
    temporalIds = db.prepare("SELECT id, date_taken FROM photos WHERE status='active' AND date_taken IS NOT NULL").all()
      .filter((x) => x.id !== photoId && Math.abs(new Date(x.date_taken).getTime() - t) <= windowMs)
      .map((x) => x.id);
  }

  // Folder peers
  const folderIds = db.prepare("SELECT id FROM photos WHERE status='active' AND folder_name = ? AND id != ?")
    .all(p.folder_name, photoId).map((r) => r.id);

  const S = tagCountsIn(db, spatialIds);
  const T = tagCountsIn(db, temporalIds);
  const folderTagSet = new Set();
  if (folderIds.length) {
    const placeholders = folderIds.map(() => '?').join(',');
    db.prepare(`SELECT DISTINCT tag_id FROM photo_tags WHERE photo_id IN (${placeholders})`)
      .all(...folderIds).forEach((r) => folderTagSet.add(r.tag_id));
  }

  const tagsById = new Map(db.prepare('SELECT id, name, type FROM tags').all().map((t) => [t.id, t]));
  const candidates = new Set([...S.map.keys(), ...T.map.keys(), ...folderTagSet]);

  const results = [];
  for (const tid of candidates) {
    if (existing.has(tid)) continue;
    const info = tagsById.get(tid);
    if (!info) continue;
    const s = S.total ? (S.map.get(tid) || 0) / S.total : 0;
    const tt = T.total ? (T.map.get(tid) || 0) / T.total : 0;
    const f = folderTagSet.has(tid) ? 1 : 0;
    const score = WEIGHT_SPATIAL * s + WEIGHT_TEMPORAL * tt + WEIGHT_FOLDER * f;
    if (score > RECOMMENDATION_THRESHOLD) {
      results.push({ id: tid, name: info.name, type: info.type, score: +score.toFixed(3),
        breakdown: { spatial: +s.toFixed(2), temporal: +tt.toFixed(2), folder: f } });
    }
  }
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, 12);
}

module.exports = { recommend };
