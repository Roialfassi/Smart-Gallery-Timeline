'use strict';

const { getDb } = require('../db/database');
const config = require('../config');

/**
 * Read queries for the timeline grid and detail views.
 * Timeline uses keyset/cursor pagination on (date_taken, id) DESC
 * (plan/features.md Section 1) — no LIMIT/OFFSET.
 */

const PHOTO_COLS =
  'id, file_name, folder_name, date_taken, tz_offset, country_code, ' +
  'latitude, longitude, camera_make, camera_model, width, height, format, writable';

function buildFilters(q) {
  const where = ["status = 'active'", 'date_taken IS NOT NULL'];
  const params = {};
  if (q.country) { where.push('country_code = @country'); params.country = q.country; }
  if (q.year) { where.push('substr(date_taken,1,4) = @year'); params.year = String(q.year); }
  if (q.month) { where.push('substr(date_taken,1,7) = @month'); params.month = q.month; }
  if (q.day) { where.push('substr(date_taken,1,10) = @day'); params.day = String(q.day); }
  if (q.camera) { where.push('camera_model = @camera'); params.camera = q.camera; }
  if (q.cluster) { where.push('id IN (SELECT photo_id FROM photo_clusters WHERE cluster_id = @cluster)'); params.cluster = Number(q.cluster); }
  if (q.tag) { where.push('id IN (SELECT photo_id FROM photo_tags pt JOIN tags t ON t.id = pt.tag_id WHERE t.name = @tag)'); params.tag = String(q.tag).toLowerCase(); }
  if (q.tagsAll) {
    const tags = String(q.tagsAll).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    tags.forEach((tg, i) => {
      where.push(`id IN (SELECT photo_id FROM photo_tags pt JOIN tags t ON t.id = pt.tag_id WHERE t.name = @tagAll${i})`);
      params[`tagAll${i}`] = tg;
    });
  }
  if (q.search) {
    where.push('(lower(file_name) LIKE @s OR lower(folder_name) LIKE @s)');
    params.s = '%' + String(q.search).toLowerCase() + '%';
  }
  return { where: where.join(' AND '), params };
}

function timeline(q = {}) {
  const db = getDb();
  const limit = Math.min(Number(q.limit) || config.server.PAGE_SIZE, 500);
  const { where, params } = buildFilters(q);

  let cursorClause = '';
  if (q.cursor) {
    const sep = String(q.cursor).lastIndexOf('|');
    params.cd = String(q.cursor).slice(0, sep);
    params.ci = Number(String(q.cursor).slice(sep + 1));
    cursorClause = ' AND (date_taken < @cd OR (date_taken = @cd AND id < @ci))';
  }

  const rows = db.prepare(
    `SELECT ${PHOTO_COLS} FROM photos WHERE ${where}${cursorClause} ` +
    `ORDER BY date_taken DESC, id DESC LIMIT @limit`
  ).all({ ...params, limit });

  let nextCursor = null;
  if (rows.length === limit) {
    const last = rows[rows.length - 1];
    nextCursor = `${last.date_taken}|${last.id}`;
  }
  return { photos: rows, nextCursor, count: rows.length };
}

function photoDetail(id) {
  const db = getDb();
  const photo = db.prepare('SELECT * FROM photos WHERE id = ?').get(id);
  if (!photo) return null;
  photo.tags = db
    .prepare('SELECT t.id, t.name, t.type FROM tags t JOIN photo_tags pt ON pt.tag_id = t.id WHERE pt.photo_id = ? ORDER BY t.name')
    .all(id);
  return photo;
}

function rollups(periodType) {
  const db = getDb();
  const rows = db
    .prepare('SELECT period_key, photo_count, countries_list, camera_models_counts FROM timeline_rollups WHERE period_type = ? ORDER BY period_key DESC')
    .all(periodType);
  return rows.map((r) => ({
    period_key: r.period_key,
    photo_count: r.photo_count,
    countries: JSON.parse(r.countries_list || '[]'),
    cameras: JSON.parse(r.camera_models_counts || '{}'),
  }));
}

function stats() {
  const db = getDb();
  const base = db.prepare(
    "SELECT COUNT(*) total, COUNT(latitude) geotagged, " +
    "MIN(date_taken) min_date, MAX(date_taken) max_date " +
    "FROM photos WHERE status = 'active' AND date_taken IS NOT NULL"
  ).get();
  const countries = db.prepare(
    "SELECT country_code code, COUNT(*) n FROM photos WHERE status='active' AND country_code IS NOT NULL GROUP BY country_code ORDER BY n DESC"
  ).all();
  const cameras = db.prepare(
    "SELECT camera_model model, COUNT(*) n FROM photos WHERE status='active' AND camera_model IS NOT NULL GROUP BY camera_model ORDER BY n DESC"
  ).all();
  const years = db.prepare(
    "SELECT substr(date_taken,1,4) year, COUNT(*) n FROM photos WHERE status='active' AND date_taken IS NOT NULL GROUP BY year ORDER BY year DESC"
  ).all();
  const missing = db.prepare("SELECT COUNT(*) n FROM photos WHERE status='missing'").get().n;
  return { ...base, missing, countries, cameras, years };
}

/**
 * Calendar drill-down counts for the Date tab.
 *   - no year         -> { level:'years',  years:[{year,n}] }
 *   - year, no month  -> { level:'months', year, months:[{month:'YYYY-MM', n}] }
 *   - year + month    -> { level:'days',   year, month, days:[{day:'YYYY-MM-DD', n}] }
 */
function calendar({ year, month } = {}) {
  const db = getDb();
  const base = "FROM photos WHERE status='active' AND date_taken IS NOT NULL";

  if (!year) {
    const years = db.prepare(
      `SELECT substr(date_taken,1,4) year, COUNT(*) n ${base} GROUP BY year ORDER BY year DESC`
    ).all();
    return { level: 'years', years };
  }

  if (!month) {
    const months = db.prepare(
      `SELECT substr(date_taken,1,7) month, COUNT(*) n ${base} AND substr(date_taken,1,4) = @year ` +
      `GROUP BY month ORDER BY month ASC`
    ).all({ year: String(year) });
    return { level: 'months', year: String(year), months };
  }

  // month is 'YYYY-MM'
  const days = db.prepare(
    `SELECT substr(date_taken,1,10) day, COUNT(*) n ${base} AND substr(date_taken,1,7) = @month ` +
    `GROUP BY day ORDER BY day ASC`
  ).all({ month: String(month) });
  return { level: 'days', year: String(year), month: String(month), days };
}

module.exports = { timeline, photoDetail, rollups, stats, buildFilters, calendar };
