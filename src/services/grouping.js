'use strict';

const { getDb } = require('../db/database');
const config = require('../config');
const runtimePaths = require('../runtime-paths');
const { haversine } = require('./spatial');
const { buildFilters } = require('../api/queries');
const { placeName, dateRangeLabel } = require('./naming');

/**
 * Unified spatiotemporal grouping — the engine behind the zoomable Timeline view
 * (and the successor to the old fixed Moments + spatial-DBSCAN split).
 *
 * The catalog is a single chronological spine. Between each adjacent pair of
 * photos there is a boundary with two strengths: a TIME gap and (when both have
 * GPS) a SPATIAL jump. A *group* is a maximal run with no active boundary inside
 * it. A single "scale" slider sets the thresholds:
 *
 *   time       mode -> break when Δt > tau(scale)
 *   spacetime  mode -> break when Δt > tau(scale)  OR  Δd > delta(scale)
 *
 * Both tau and delta grow monotonically with scale, so widening only ever MERGES
 * neighbouring groups and narrowing only ever SPLITS them — the zoom never
 * reshuffles. tau/delta anchors + slider resolution live in config.grouping.
 */

const PHOTO_COLS =
  'id, file_name, folder_name, date_taken, tz_offset, country_code, ' +
  'latitude, longitude, camera_make, camera_model, width, height, format, writable';

const MODES = new Set(['time', 'spacetime']);

/* ------------------------------ scale resolution -------------------------- */

const logLerp = (a, b, f) => Math.exp(Math.log(a) * (1 - f) + Math.log(b) * f);

/**
 * Map an integer slider step (0 = narrowest .. STEPS = widest) to concrete
 * thresholds plus the nearest named tier (for the snap label). Anchors are
 * spread evenly across the slider and log-interpolated between.
 */
function resolveScale(step) {
  const { TIERS, STEPS } = config.grouping;
  const s = Math.max(0, Math.min(STEPS, Number.isFinite(+step) ? +step : config.grouping.DEFAULT_STEP));
  const x = (s / STEPS) * (TIERS.length - 1); // position in tier-space [0, n-1]
  const i = Math.min(TIERS.length - 2, Math.floor(x));
  const f = x - i;
  return {
    step: s,
    tau: logLerp(TIERS[i].tau, TIERS[i + 1].tau, f),
    delta: logLerp(TIERS[i].delta, TIERS[i + 1].delta, f),
    tier: TIERS[Math.round(x)].name,
  };
}

/* ------------------------------ core segmentation ------------------------- */

/**
 * Split time-ordered `rows` into groups at the given thresholds (pure; no DB).
 * `rows` must be ascending by date and each carry a numeric `t` (epoch ms).
 * Spatial breaks compare against the last GPS-bearing photo (carry-forward), so
 * GPS-less shots inside a continuous stay don't fragment it.
 */
function segmentByScale(rows, { mode, tau, delta }) {
  const groups = [];
  let cur = null;
  let prevGeo = null; // last photo that had coordinates
  for (let i = 0; i < rows.length; i++) {
    const p = rows[i];
    let brk = false;
    if (cur) {
      if (p.t - rows[i - 1].t > tau) brk = true;
      else if (mode === 'spacetime' && p.latitude != null && prevGeo) {
        if (haversine(prevGeo.latitude, prevGeo.longitude, p.latitude, p.longitude) > delta) brk = true;
      }
    }
    if (brk) cur = null;
    if (!cur) { cur = []; groups.push(cur); }
    cur.push(p);
    if (p.latitude != null) prevGeo = p;
  }
  return groups;
}

/* ------------------------------ summaries / labels ------------------------ */

function uniqueCountries(photos) {
  const seen = new Set();
  const out = [];
  for (const p of photos) {
    if (p.country_code && !seen.has(p.country_code)) { seen.add(p.country_code); out.push(p.country_code); }
  }
  return out;
}

function coverId(photos) {
  const geo = photos.find((p) => p.latitude != null);
  return (geo || photos[0]).id;
}

/** Up to `n` representative photo ids sampled evenly across the run. */
function previewIds(photos, n = 5) {
  if (photos.length <= n) return photos.map((p) => p.id);
  const out = [];
  for (let i = 0; i < n; i++) out.push(photos[Math.round((i * (photos.length - 1)) / (n - 1))].id);
  return [...new Set(out)];
}

/** Centroid, bbox and travelled path length over a group's GPS photos. */
function geoSummary(photos) {
  let sLat = 0, sLon = 0, n = 0, km = 0, prev = null;
  let minLat = Infinity, minLon = Infinity, maxLat = -Infinity, maxLon = -Infinity;
  for (const p of photos) {
    if (p.latitude == null) continue;
    sLat += p.latitude; sLon += p.longitude; n++;
    minLat = Math.min(minLat, p.latitude); maxLat = Math.max(maxLat, p.latitude);
    minLon = Math.min(minLon, p.longitude); maxLon = Math.max(maxLon, p.longitude);
    if (prev) km += haversine(prev.latitude, prev.longitude, p.latitude, p.longitude) / 1000;
    prev = p;
  }
  if (!n) return { centroid: null, bbox: null, km: 0, geoCount: 0 };
  return {
    centroid: { lat: sLat / n, lon: sLon / n },
    bbox: [minLat, minLon, maxLat, maxLon],
    km: Math.round(km),
    geoCount: n,
  };
}

function makeCard(photos, idx, mode) {
  const start = photos[0].date_taken;
  const end = photos[photos.length - 1].date_taken;
  const place = placeName(photos);
  const dateLabel = dateRangeLabel(start, end);
  const geo = geoSummary(photos);
  // In space+time the place leads (qualified by dates in the sub-line); in time
  // mode the date range IS the title.
  const title = mode === 'spacetime' && geo.geoCount ? place : dateLabel;
  return {
    id: `${mode}:${idx}:${start}`,
    index: idx,
    title,
    place,
    dateLabel,
    start,
    end,
    photoCount: photos.length,
    countries: uniqueCountries(photos),
    coverPhotoId: coverId(photos),
    previewIds: previewIds(photos),
    centroid: geo.centroid,
    bbox: geo.bbox,
    km: geo.km,
    isGeo: geo.geoCount > 0,
  };
}

/* --------------------------------- caching -------------------------------- */
/* Two-level: rows (+ epoch t) are loaded once per (project + filter); each
 * (mode, step) then re-segments those cached rows in O(n) without touching the
 * DB. Signature folds in counts + max id/mtime so any catalog change busts it. */

let rowCache = { key: null, rows: null };
let groupCache = { key: null, value: null };

function catalogSignature(db) {
  const r = db.prepare(`
    SELECT
      (SELECT COUNT(*)               FROM photos WHERE status='active' AND date_taken IS NOT NULL) n,
      (SELECT COALESCE(MAX(id),0)    FROM photos) mid,
      (SELECT COALESCE(MAX(mtime),0) FROM photos WHERE status='active') mm
  `).get();
  return `${r.n}:${r.mid}:${r.mm}`;
}

function filterKey(q) {
  const a = runtimePaths.getActive();
  const proj = a ? a.sgDir : '(default)';
  const f = {
    country: q.country ?? null, year: q.year ?? null, month: q.month ?? null,
    day: q.day ?? null, camera: q.camera ?? null, tag: q.tag ?? null,
    tagsAll: q.tagsAll ?? null, search: q.search ?? null,
  };
  return proj + '|' + JSON.stringify(f);
}

function loadRows(q, db) {
  const key = catalogSignature(db) + '||' + filterKey(q);
  if (rowCache.key === key) return rowCache.rows;
  const { where, params } = buildFilters(q);
  const rows = db
    .prepare(`SELECT ${PHOTO_COLS} FROM photos WHERE ${where} ORDER BY date_taken ASC, id ASC`)
    .all(params);
  for (const r of rows) r.t = new Date(r.date_taken).getTime();
  rowCache = { key, rows };
  return rows;
}

/** Drop memoized state (tests; production self-invalidates via the signature). */
function _resetCache() { rowCache = { key: null, rows: null }; groupCache = { key: null, value: null }; }

/* --------------------------------- public --------------------------------- */

/**
 * Build the full group list at a scale step, each group carrying its photos
 * (ascending) for the detail view. Newest group first. Cached per (mode, step).
 */
function buildGroups(q = {}, { mode = 'time', step } = {}) {
  if (!MODES.has(mode)) mode = 'time';
  const db = getDb();
  const rows = loadRows(q, db);
  const scale = resolveScale(step);
  const key = `${rowCache.key}||${mode}:${scale.step}`;
  if (groupCache.key === key) return groupCache.value;

  const runs = segmentByScale(rows, { mode, tau: scale.tau, delta: scale.delta });
  const groups = runs.map((photos, i) => ({ ...makeCard(photos, i, mode), photos }));
  groups.reverse(); // newest first
  const value = { mode, scale, total: rows.length, count: groups.length, groups };
  groupCache = { key, value };
  return value;
}

/** Cards only (drops per-group photo arrays) for the rail/spine. */
function listGroups(q = {}, opts = {}) {
  const r = buildGroups(q, opts);
  return {
    mode: r.mode,
    scale: r.scale,
    total: r.total,
    count: r.count,
    tiers: config.grouping.TIERS.map((t) => t.name),
    steps: config.grouping.STEPS,
    groups: r.groups.map(({ photos, ...card }) => card), // eslint-disable-line no-unused-vars
  };
}

/** Ascending photo list for one group, found by its stable id at this scale. */
function groupPhotos(q, id, opts = {}) {
  const r = buildGroups(q, opts);
  const g = r.groups.find((x) => x.id === id);
  return g ? g.photos : null;
}

module.exports = { buildGroups, listGroups, groupPhotos, resolveScale, segmentByScale, _resetCache };
