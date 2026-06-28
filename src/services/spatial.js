'use strict';

/**
 * Spatial indexing & clustering primitives (plan/architecture.md Section 8).
 *
 * SpatialIndex fills the role of the in-memory R-Tree: a grid-bucketed index
 * supporting O(1)-ish radius/neighbourhood queries used by both DBSCAN and the
 * Phase-3 tag recommendation engine. Exact distances use the Haversine formula.
 */

const EARTH_R = 6371000; // metres
const toRad = (d) => (d * Math.PI) / 180;

function haversine(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(a)));
}

class SpatialIndex {
  constructor(cellDeg = 0.25) {
    this.cell = cellDeg;
    this.buckets = new Map(); // "ci:cj" -> [point]
    this.points = [];
  }

  _key(ci, cj) { return ci + ':' + cj; }

  insert(p) {
    this.points.push(p);
    const ci = Math.floor(p.lat / this.cell);
    const cj = Math.floor(p.lon / this.cell);
    const k = this._key(ci, cj);
    let b = this.buckets.get(k);
    if (!b) { b = []; this.buckets.set(k, b); }
    b.push(p);
  }

  /** All indexed points within `radM` metres of (lat, lon), inclusive. */
  within(lat, lon, radM) {
    const dLat = radM / 111320;
    const cosLat = Math.cos(toRad(lat));
    const dLon = radM / (111320 * (Math.abs(cosLat) < 1e-6 ? 1e-6 : cosLat));
    const ciMin = Math.floor((lat - dLat) / this.cell);
    const ciMax = Math.floor((lat + dLat) / this.cell);
    const cjMin = Math.floor((lon - dLon) / this.cell);
    const cjMax = Math.floor((lon + dLon) / this.cell);
    const out = [];
    for (let ci = ciMin; ci <= ciMax; ci++) {
      for (let cj = cjMin; cj <= cjMax; cj++) {
        const b = this.buckets.get(this._key(ci, cj));
        if (!b) continue;
        for (const p of b) {
          if (haversine(lat, lon, p.lat, p.lon) <= radM) out.push(p);
        }
      }
    }
    return out;
  }

  get size() { return this.points.length; }
}

/**
 * DBSCAN over geographic points using the SpatialIndex for region queries.
 * @param {Array<{id,lat,lon}>} points
 * @param {number} epsMeters neighbourhood radius
 * @param {number} minPts minimum neighbourhood size (incl. the point itself)
 * @returns {Array<Array<point>>} clusters (noise points omitted)
 */
function dbscan(points, epsMeters, minPts = 2) {
  const index = new SpatialIndex(Math.max(0.05, epsMeters / 111320));
  for (const p of points) index.insert(p);

  const visited = new Set();
  const assigned = new Set();
  const clusters = [];

  for (const p of points) {
    if (visited.has(p.id)) continue;
    visited.add(p.id);
    const neighbours = index.within(p.lat, p.lon, epsMeters);
    if (neighbours.length < minPts) continue; // noise (may be claimed as border later)

    const cluster = [];
    clusters.push(cluster);
    assigned.add(p.id);
    cluster.push(p);

    const queue = neighbours.filter((q) => q.id !== p.id);
    while (queue.length) {
      const q = queue.shift();
      if (!visited.has(q.id)) {
        visited.add(q.id);
        const qn = index.within(q.lat, q.lon, epsMeters);
        if (qn.length >= minPts) {
          for (const x of qn) if (!assigned.has(x.id)) queue.push(x);
        }
      }
      if (!assigned.has(q.id)) {
        assigned.add(q.id);
        cluster.push(q);
      }
    }
  }
  return clusters;
}

function centroid(points) {
  let la = 0, lo = 0;
  for (const p of points) { la += p.lat; lo += p.lon; }
  return { lat: la / points.length, lon: lo / points.length };
}

module.exports = { SpatialIndex, dbscan, haversine, centroid };
