'use strict';

const { getDb } = require('../db/database');
const config = require('../config');
const { haversine } = require('./spatial');
const { buildFilters } = require('../api/queries');

/**
 * Journey track segmentation (plan/features.md Section 2).
 *
 * Geotagged photos are ordered chronologically and connected by polylines.
 * A segment breaks when consecutive photos exceed:
 *   - JOURNEY_SEGMENT_MAX_DISTANCE_KM (default 80km), or
 *   - JOURNEY_SEGMENT_MAX_TIME_HOURS (default 8h).
 */

function buildJourneys(q = {}) {
  const db = getDb();
  const { where, params } = buildFilters(q);
  const rows = db
    .prepare(
      `SELECT id, file_name, date_taken, latitude, longitude, country_code ` +
      `FROM photos WHERE ${where} AND latitude IS NOT NULL ` +
      `ORDER BY date_taken ASC, id ASC`
    )
    .all(params);

  const maxDist = config.spatial.JOURNEY_SEGMENT_MAX_DISTANCE_KM * 1000;
  const maxGap = config.spatial.JOURNEY_SEGMENT_MAX_TIME_HOURS * 3600 * 1000;

  const segments = [];
  let current = null;
  let prev = null;

  for (const p of rows) {
    const t = new Date(p.date_taken).getTime();
    if (prev) {
      const dist = haversine(prev.latitude, prev.longitude, p.latitude, p.longitude);
      const gap = t - new Date(prev.date_taken).getTime();
      if (dist > maxDist || gap > maxGap) {
        current = null; // break the line
      }
    }
    if (!current) {
      current = { points: [] };
      segments.push(current);
    }
    current.points.push({
      id: p.id, lat: p.latitude, lon: p.longitude,
      date: p.date_taken, name: p.file_name, country: p.country_code,
    });
    prev = p;
  }

  // Only keep multi-point segments as "tracks"; singletons are standalone markers.
  const tracks = segments.filter((s) => s.points.length >= 2);
  const singles = segments.filter((s) => s.points.length === 1).map((s) => s.points[0]);

  let totalKm = 0;
  for (const s of tracks) {
    for (let i = 1; i < s.points.length; i++) {
      totalKm += haversine(
        s.points[i - 1].lat, s.points[i - 1].lon, s.points[i].lat, s.points[i].lon
      ) / 1000;
    }
  }

  return {
    tracks,
    singles,
    stats: {
      photos: rows.length,
      segments: tracks.length,
      standalone: singles.length,
      totalKm: Math.round(totalKm),
    },
  };
}

module.exports = { buildJourneys };
