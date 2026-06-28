'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config');

/**
 * Offline reverse-geocoding to ISO country code (plan/architecture.md Section 6.2).
 *
 * Loads a bundled, simplified country-boundary dataset (data/countries.json) and
 * classifies a coordinate via ray-casting point-in-polygon with a bounding-box
 * prefilter. No network calls — preserves privacy and works offline.
 *
 * Dataset shape:
 *   { generated, source, countries: [ { iso, name, bbox:[minLon,minLat,maxLon,maxLat],
 *                                       polys: [ ring, ... ] } ] }
 *   where ring = [ [lon,lat], ... ] (outer ring only).
 */

let dataset = null;

function load() {
  if (dataset !== null) return dataset;
  const file = path.join(config.paths.dataDir, 'countries.json');
  try {
    dataset = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    dataset = { countries: [] };
  }
  return dataset;
}

// Standard even-odd ray casting against a single ring of [lon,lat] vertices.
function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    const intersect =
      (yi > lat) !== (yj > lat) &&
      lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * Resolve an ISO 2-letter country code for a coordinate, or null if unknown.
 */
function countryForCoord(latitude, longitude) {
  if (latitude == null || longitude == null) return null;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  const ds = load();
  for (const c of ds.countries) {
    const b = c.bbox;
    if (longitude < b[0] || longitude > b[2] || latitude < b[1] || latitude > b[3]) continue;
    for (const ring of c.polys) {
      if (pointInRing(longitude, latitude, ring)) return c.iso;
    }
  }
  return null;
}

function isLoaded() {
  return load().countries.length > 0;
}

module.exports = { countryForCoord, isLoaded };
