'use strict';

const { getDb } = require('../db/database');
const config = require('../config');
const { haversine } = require('./spatial');
const { buildFilters } = require('../api/queries');

/**
 * Moments segmentation — the heuristic behind the "Moments" timeline view.
 *
 * The catalog is walked chronologically and split into an ordered list of
 * segments of two kinds:
 *
 *   TRIP   — a contiguous run of photos taken "away" from home (a different
 *            country, or far from the home centroid). A trip is kept as a single
 *            unit even when it spans weeks, and is broken into ordered "stops"
 *            (place 1 -> place 2 -> ...) for the route map.
 *
 *   PERIOD — everyday / at-home photos, bucketed by calendar period. "Auto by
 *            density" splits photo-heavy months into weeks and leaves quiet
 *            months whole.
 *
 * "Home" is auto-detected as the most common country in the library; the home
 * centroid is the mean position of home-country photos. Every threshold lives in
 * config.timeline. Photos without country or GPS inherit the away/home state of
 * the previous photo (carry-forward), so a GPS-less shot inside a trip stays in
 * the trip.
 */

const PHOTO_COLS =
  'id, file_name, folder_name, date_taken, tz_offset, country_code, ' +
  'latitude, longitude, camera_make, camera_model, width, height, format, writable';

const DAY_MS = 24 * 3600 * 1000;
const ms = (iso) => new Date(iso).getTime();

function homeCountry(rows) {
  const counts = new Map();
  for (const r of rows) {
    if (!r.country_code) continue;
    counts.set(r.country_code, (counts.get(r.country_code) || 0) + 1);
  }
  let best = null;
  let bestN = 0;
  for (const [cc, n] of counts) if (n > bestN) { best = cc; bestN = n; }
  return best;
}

function homeCentroid(rows, home) {
  let sLat = 0;
  let sLon = 0;
  let n = 0;
  for (const r of rows) {
    if (r.latitude == null) continue;
    if (home && r.country_code && r.country_code !== home) continue;
    sLat += r.latitude; sLon += r.longitude; n++;
  }
  if (n === 0) { // no home-country GPS — fall back to all GPS photos
    for (const r of rows) {
      if (r.latitude == null) continue;
      sLat += r.latitude; sLon += r.longitude; n++;
    }
  }
  return n ? { lat: sLat / n, lon: sLon / n } : null;
}

/** Monday (UTC) of the week containing `iso`, as a YYYY-MM-DD key. */
function weekStart(iso) {
  const d = new Date(iso);
  const dow = (d.getUTCDay() + 6) % 7; // Mon = 0
  const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow));
  return m.toISOString().slice(0, 10);
}
const monthKey = (iso) => iso.slice(0, 7);

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
  for (let i = 0; i < n; i++) {
    out.push(photos[Math.round((i * (photos.length - 1)) / (n - 1))].id);
  }
  return [...new Set(out)];
}

/** Group a trip's GPS photos into ordered stops (place 1 -> place 2 -> ...). */
function buildStops(photos) {
  const stopRadius = config.timeline.TRIP_STOP_RADIUS_KM * 1000;
  const stops = [];
  let cur = null;
  for (const p of photos) {
    if (p.latitude == null) { if (cur) cur.count++; continue; }
    if (cur) {
      const cLat = cur.sLat / cur.gps;
      const cLon = cur.sLon / cur.gps;
      if (haversine(p.latitude, p.longitude, cLat, cLon) > stopRadius) cur = null;
    }
    if (!cur) {
      cur = { sLat: 0, sLon: 0, gps: 0, count: 0, start: p.date_taken, end: p.date_taken, country: p.country_code, coverPhotoId: p.id };
      stops.push(cur);
    }
    cur.sLat += p.latitude; cur.sLon += p.longitude; cur.gps++; cur.count++;
    cur.end = p.date_taken;
    if (p.country_code) cur.country = p.country_code;
  }
  return stops.map((s) => ({
    lat: s.sLat / s.gps, lon: s.sLon / s.gps,
    start: s.start, end: s.end, count: s.count,
    country: s.country, coverPhotoId: s.coverPhotoId,
  }));
}

function tripKm(photos) {
  let km = 0;
  let prev = null;
  for (const p of photos) {
    if (p.latitude == null) continue;
    if (prev) km += haversine(prev.latitude, prev.longitude, p.latitude, p.longitude) / 1000;
    prev = p;
  }
  return Math.round(km);
}

function makeTrip(photos) {
  const stops = buildStops(photos);
  return {
    id: `trip:${photos[0].date_taken}:${photos[photos.length - 1].date_taken}`,
    kind: 'trip',
    start: photos[0].date_taken,
    end: photos[photos.length - 1].date_taken,
    countries: uniqueCountries(photos),
    photoCount: photos.length,
    coverPhotoId: coverId(photos),
    previewIds: previewIds(photos),
    km: tripKm(photos),
    stops,
    photos,
  };
}

function makePeriod(periodKind, key, photos) {
  return {
    id: `period:${periodKind}:${key}`,
    kind: 'period',
    periodKind,
    start: photos[0].date_taken,
    end: photos[photos.length - 1].date_taken,
    countries: uniqueCountries(photos),
    photoCount: photos.length,
    coverPhotoId: coverId(photos),
    previewIds: previewIds(photos),
    photos,
  };
}

/**
 * Build the full ordered segment list (newest first). Each segment carries its
 * own `photos` array (ascending, start -> finish) for the detail view.
 */
function buildSegments(q = {}) {
  const db = getDb();
  const { where, params } = buildFilters(q);
  const rows = db
    .prepare(`SELECT ${PHOTO_COLS} FROM photos WHERE ${where} ORDER BY date_taken ASC, id ASC`)
    .all(params);

  const cfg = config.timeline;
  const home = homeCountry(rows);
  const centroid = homeCentroid(rows, home);
  const awayKm = cfg.TRIP_MIN_DISTANCE_KM * 1000;

  // Per-photo away/home flag, with carry-forward for photos lacking both
  // country and GPS so they don't fragment a surrounding trip.
  let last = false;
  const away = rows.map((p) => {
    let a = null;
    const diffCountry = p.country_code && home && p.country_code !== home;
    const farFromHome = centroid && p.latitude != null &&
      haversine(p.latitude, p.longitude, centroid.lat, centroid.lon) > awayKm;
    if (p.country_code != null || p.latitude != null) a = !!(diffCountry || farFromHome);
    if (a === null) a = last; else last = a;
    return a;
  });

  // Split into maximal runs of constant away-state with no gap > TRIP_GAP_DAYS.
  const runs = [];
  let i = 0;
  while (i < rows.length) {
    const state = away[i];
    let j = i + 1;
    while (j < rows.length) {
      if (away[j] !== state) break;
      if (ms(rows[j].date_taken) - ms(rows[j - 1].date_taken) > cfg.TRIP_GAP_DAYS * DAY_MS) break;
      j++;
    }
    runs.push({ from: i, to: j, away: state });
    i = j;
  }

  // Away-runs that clear the bar become trips; everything else feeds the
  // everyday pool that gets bucketed by period.
  const segments = [];
  const everyday = [];
  for (const run of runs) {
    const slice = rows.slice(run.from, run.to);
    const span = ms(slice[slice.length - 1].date_taken) - ms(slice[0].date_taken);
    const qualifies = run.away &&
      slice.length >= cfg.TRIP_MIN_PHOTOS &&
      span >= cfg.TRIP_MIN_HOURS * 3600 * 1000;
    if (qualifies) segments.push(makeTrip(slice));
    else for (const p of slice) everyday.push(p);
  }

  // Everyday photos -> calendar buckets. Auto density: a month with enough
  // photos splits into weeks, otherwise it stays a single month bucket.
  const months = new Map();
  for (const p of everyday) {
    const k = monthKey(p.date_taken);
    if (!months.has(k)) months.set(k, []);
    months.get(k).push(p);
  }
  for (const [mk, mphotos] of months) {
    if (mphotos.length >= cfg.PERIOD_WEEKLY_MIN_PHOTOS) {
      const weeks = new Map();
      for (const p of mphotos) {
        const wk = weekStart(p.date_taken);
        if (!weeks.has(wk)) weeks.set(wk, []);
        weeks.get(wk).push(p);
      }
      for (const [wk, wphotos] of weeks) segments.push(makePeriod('week', wk, wphotos));
    } else {
      segments.push(makePeriod('month', mk, mphotos));
    }
  }

  segments.sort((a, b) => (a.start < b.start ? 1 : a.start > b.start ? -1 : 0)); // newest first
  return { home, segments };
}

/** Lightweight cards for the rail (drops the per-segment photo arrays). */
function listSegments(q = {}) {
  const { home, segments } = buildSegments(q);
  return {
    home,
    segments: segments.map(({ photos, ...card }) => card), // eslint-disable-line no-unused-vars
  };
}

/** Full ascending photo list for one segment, found by its stable id. */
function segmentPhotos(q, id) {
  const { segments } = buildSegments(q);
  const seg = segments.find((s) => s.id === id);
  return seg ? seg.photos : null;
}

module.exports = { buildSegments, listSegments, segmentPhotos };
