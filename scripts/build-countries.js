'use strict';

/**
 * Build a compact, simplified country-boundary dataset for offline geocoding.
 * Input:  data/_tmp_countries.geojson  (full-resolution country polygons)
 * Output: data/countries.json          (simplified)
 *
 * Simplification strategy (deterministic, dependency-free):
 *  - Keep only the outer ring of each polygon part.
 *  - Drop polygon parts whose bbox area is below a threshold (tiny islands).
 *  - Simplify each ring with Ramer-Douglas-Peucker (preserves coastline shape
 *    far better than grid snapping at the same vertex count).
 *  - Store a bbox per country for fast prefiltering.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const IN = path.join(ROOT, 'data', '_tmp_countries.geojson');
const OUT = path.join(ROOT, 'data', 'countries.json');

const EPSILON = 0.01; // RDP tolerance in degrees (~1.1km) — good coastal fidelity
const MIN_PART_AREA = 0.02; // min bbox area (deg^2) for a polygon part to be kept

// Datasets derived from Natural Earth tag a few sovereign states as '-99'.
// Map them back to the correct ISO 3166-1 alpha-2 by name.
const NAME_TO_ISO = {
  France: 'FR',
  Norway: 'NO',
  Kosovo: 'XK',
  'Northern Cyprus': 'CY',
  Somaliland: 'SO',
};

function perpDist(p, a, b) {
  const [px, py] = p, [ax, ay] = a, [bx, by] = b;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

// Iterative Ramer-Douglas-Peucker to avoid deep recursion on huge rings.
function rdp(points, eps) {
  if (points.length < 3) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [start, end] = stack.pop();
    let maxDist = -1, idx = -1;
    for (let i = start + 1; i < end; i++) {
      const d = perpDist(points[i], points[start], points[end]);
      if (d > maxDist) { maxDist = d; idx = i; }
    }
    if (maxDist > eps && idx !== -1) {
      keep[idx] = 1;
      stack.push([start, idx], [idx, end]);
    }
  }
  const out = [];
  for (let i = 0; i < points.length; i++) {
    if (keep[i]) out.push([Number(points[i][0].toFixed(4)), Number(points[i][1].toFixed(4))]);
  }
  return out;
}

function ringBbox(ring) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [lon, lat] of ring) {
    if (lon < minX) minX = lon;
    if (lon > maxX) maxX = lon;
    if (lat < minY) minY = lat;
    if (lat > maxY) maxY = lat;
  }
  return { area: (maxX - minX) * (maxY - minY), minX, minY, maxX, maxY };
}

function main() {
  if (!fs.existsSync(IN)) {
    console.error('Missing input:', IN);
    process.exit(1);
  }

  const gj = JSON.parse(fs.readFileSync(IN, 'utf8'));
  const countries = [];

  for (const feat of gj.features) {
    const props = feat.properties || {};
    const name = props.name || props.ADMIN || props.NAME || 'Unknown';
    let rawIso = props['ISO3166-1-Alpha-2'] || props.ISO_A2_EH || props.ISO_A2 || null;
    if (!rawIso || rawIso === '-99') rawIso = NAME_TO_ISO[name] || null;
    const iso = rawIso ? String(rawIso).toUpperCase() : null;
    if (!iso) continue;

    const geom = feat.geometry;
    if (!geom) continue;
    const partsRaw = geom.type === 'Polygon' ? [geom.coordinates] :
                     geom.type === 'MultiPolygon' ? geom.coordinates : [];

    const polys = [];
    let cMinX = Infinity, cMinY = Infinity, cMaxX = -Infinity, cMaxY = -Infinity;

    for (const part of partsRaw) {
      const outer = part[0];
      if (!outer || outer.length < 4) continue;
      const bb = ringBbox(outer);
      if (bb.area < MIN_PART_AREA) continue;
      const ring = rdp(outer, EPSILON);
      if (ring.length < 4) continue;
      polys.push(ring);
      const rb = ringBbox(ring);
      if (rb.minX < cMinX) cMinX = rb.minX;
      if (rb.minY < cMinY) cMinY = rb.minY;
      if (rb.maxX > cMaxX) cMaxX = rb.maxX;
      if (rb.maxY > cMaxY) cMaxY = rb.maxY;
    }

    if (polys.length === 0) continue;
    countries.push({
      iso, name,
      bbox: [
        Number(cMinX.toFixed(4)), Number(cMinY.toFixed(4)),
        Number(cMaxX.toFixed(4)), Number(cMaxY.toFixed(4)),
      ],
      polys,
    });
  }

  const out = {
    generated: new Date().toISOString(),
    source: 'Open country polygons, RDP-simplified for offline geocoding',
    epsilon: EPSILON,
    countries,
  };
  fs.writeFileSync(OUT, JSON.stringify(out));
  const kb = (fs.statSync(OUT).size / 1024).toFixed(0);
  console.log(`Wrote ${countries.length} countries -> ${OUT} (${kb} KB)`);
}

main();
