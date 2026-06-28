'use strict';

const { getDb } = require('../db/database');
const config = require('../config');
const { dbscan, centroid, haversine } = require('./spatial');
const { buildFilters } = require('../api/queries');
const { extractKeywords } = require('./keywords');

/**
 * Spatial DBSCAN clustering with stable IDs (plan/architecture.md Section 8)
 * and Apriori keyword-intersection itemsets (plan/features.md Section 3B).
 */

const { JACCARD_STABLE_THRESHOLD, CENTROID_SHIFT_STABLE_METERS } = config.clustering;

function jaccard(aSet, bSet) {
  let inter = 0;
  for (const x of aSet) if (bSet.has(x)) inter++;
  const union = aSet.size + bSet.size - inter;
  return union === 0 ? 0 : inter / union;
}

function autoName(memberPhotos) {
  // Most frequent folder keyword among members; fallback to country; else "Area".
  const counts = new Map();
  for (const p of memberPhotos) {
    for (const kw of extractKeywords(p.folder_name)) {
      counts.set(kw, (counts.get(kw) || 0) + 1);
    }
  }
  let best = null, bestN = 0;
  for (const [kw, n] of counts) if (n > bestN) { best = kw; bestN = n; }
  if (best) return best.charAt(0).toUpperCase() + best.slice(1);
  const cc = memberPhotos.find((p) => p.country_code)?.country_code;
  return cc ? `Area (${cc})` : 'Area';
}

/**
 * Compute (and persist with stable IDs) spatial clusters at a given radius.
 */
function computeSpatialClusters(radiusMeters, q = {}) {
  const db = getDb();
  const radius = Math.max(
    config.spatial.SPATIAL_CLUSTER_RADIUS_MIN_METERS,
    Math.min(config.spatial.SPATIAL_CLUSTER_RADIUS_MAX_METERS, Number(radiusMeters) || config.spatial.SPATIAL_CLUSTER_RADIUS_DEFAULT_METERS)
  );

  const { where, params } = buildFilters(q);
  const rows = db
    .prepare(`SELECT id, latitude AS lat, longitude AS lon, folder_name, country_code FROM photos WHERE ${where} AND latitude IS NOT NULL`)
    .all(params);
  const byId = new Map(rows.map((r) => [r.id, r]));

  const rawClusters = dbscan(rows, radius, 2);

  // Existing clusters at this radius (for stable-ID re-association).
  const existing = db
    .prepare("SELECT * FROM clusters WHERE type = 'spatial' AND radius_meters = ?")
    .all(radius)
    .map((c) => ({
      ...c,
      members: new Set(db.prepare('SELECT photo_id FROM photo_clusters WHERE cluster_id = ?').all(c.id).map((r) => r.photo_id)),
    }));
  const usedExisting = new Set();

  const resolved = rawClusters.map((pts) => {
    const ids = new Set(pts.map((p) => p.id));
    const c = centroid(pts);
    let match = null, matchScore = 0;
    for (const ex of existing) {
      if (usedExisting.has(ex.id)) continue;
      const j = jaccard(ids, ex.members);
      const shift = haversine(c.lat, c.lon, ex.center_latitude, ex.center_longitude);
      const shares = [...ids].some((id) => ex.members.has(id));
      if (j > JACCARD_STABLE_THRESHOLD || (shift < CENTROID_SHIFT_STABLE_METERS && shares)) {
        if (j >= matchScore) { match = ex; matchScore = j; }
      }
    }
    if (match) usedExisting.add(match.id);
    return { ids: [...ids], center: c, match, members: pts.map((p) => byId.get(p.id)) };
  });

  // Persist: drop unused existing clusters of this radius, upsert matched/new,
  // and replace memberships.
  const tx = db.transaction(() => {
    for (const ex of existing) {
      if (!usedExisting.has(ex.id)) {
        db.prepare('DELETE FROM clusters WHERE id = ?').run(ex.id); // cascades photo_clusters
      }
    }
    const insCluster = db.prepare(
      "INSERT INTO clusters (name, type, radius_meters, center_latitude, center_longitude, custom_named) VALUES (?, 'spatial', ?, ?, ?, 0)"
    );
    const updCluster = db.prepare(
      'UPDATE clusters SET center_latitude = ?, center_longitude = ?, name = ? WHERE id = ?'
    );
    const clearMembers = db.prepare('DELETE FROM photo_clusters WHERE cluster_id = ?');
    const addMember = db.prepare('INSERT OR IGNORE INTO photo_clusters (photo_id, cluster_id) VALUES (?, ?)');

    for (const r of resolved) {
      let clusterId;
      let name;
      if (r.match) {
        clusterId = r.match.id;
        name = r.match.custom_named ? r.match.name : autoName(r.members);
        updCluster.run(r.center.lat, r.center.lon, name, clusterId);
        clearMembers.run(clusterId);
      } else {
        name = autoName(r.members);
        const info = insCluster.run(name, radius, r.center.lat, r.center.lon);
        clusterId = info.lastInsertRowid;
      }
      r.id = clusterId; r.name = name;
      for (const id of r.ids) addMember.run(id, clusterId);
    }
  });
  tx();

  // Build response payload.
  return {
    radius,
    count: resolved.length,
    clusters: resolved
      .map((r) => ({
        id: r.id,
        name: r.name,
        center: r.center,
        radius,
        photoCount: r.ids.length,
        sampleIds: r.ids.slice(0, 4),
        countries: [...new Set(r.members.map((m) => m.country_code).filter(Boolean))],
      }))
      .sort((a, b) => b.photoCount - a.photoCount),
  };
}

/**
 * Apriori keyword-intersection itemsets (sizes 2-3) above the min-support
 * threshold (default 5% of the active gallery).
 */
function wordItemsets(q = {}) {
  const db = getDb();
  const { where, params } = buildFilters(q);
  const photoIds = db.prepare(`SELECT id FROM photos WHERE ${where}`).all(params).map((r) => r.id);
  const total = photoIds.length;
  if (total === 0) return { total: 0, minSupport: 0, itemsets: [] };

  const idSet = new Set(photoIds);
  const rows = db
    .prepare('SELECT pt.photo_id, t.name FROM photo_tags pt JOIN tags t ON t.id = pt.tag_id')
    .all();
  const tx = new Map(); // photo_id -> Set(tags)
  for (const r of rows) {
    if (!idSet.has(r.photo_id)) continue;
    let s = tx.get(r.photo_id);
    if (!s) { s = new Set(); tx.set(r.photo_id, s); }
    s.add(r.name);
  }
  const transactions = [...tx.values()].map((s) => [...s]);
  const minSupportCount = Math.max(2, Math.ceil(config.tagging.MIN_SUPPORT_TAG_INTERSECTION * total));

  // L1
  const single = new Map();
  for (const t of transactions) for (const item of t) single.set(item, (single.get(item) || 0) + 1);
  const freq1 = [...single.entries()].filter(([, c]) => c >= minSupportCount).map(([k]) => k);
  const freq1Set = new Set(freq1);

  const countItemset = (items) => {
    let c = 0;
    for (const t of transactions) {
      const ts = new Set(t);
      if (items.every((i) => ts.has(i))) c++;
    }
    return c;
  };

  // L2
  const pairs = [];
  for (let i = 0; i < freq1.length; i++) {
    for (let j = i + 1; j < freq1.length; j++) {
      const items = [freq1[i], freq1[j]].sort();
      const c = countItemset(items);
      if (c >= minSupportCount) pairs.push({ items, support: c });
    }
  }

  // L3 (join frequent pairs sharing one item)
  const triples = [];
  const seenTriple = new Set();
  for (let a = 0; a < pairs.length; a++) {
    for (let b = a + 1; b < pairs.length; b++) {
      const merged = [...new Set([...pairs[a].items, ...pairs[b].items])].sort();
      if (merged.length !== 3) continue;
      const key = merged.join('|');
      if (seenTriple.has(key)) continue;
      seenTriple.add(key);
      if (!merged.every((i) => freq1Set.has(i))) continue;
      const c = countItemset(merged);
      if (c >= minSupportCount) triples.push({ items: merged, support: c });
    }
  }

  const itemsets = [...pairs, ...triples]
    .map((s) => ({ items: s.items, count: s.support, support: +(s.support / total).toFixed(3) }))
    .sort((a, b) => b.count - a.count || a.items.length - b.items.length)
    .slice(0, 40);

  return { total, minSupport: +(minSupportCount / total).toFixed(3), minSupportCount, itemsets };
}

module.exports = { computeSpatialClusters, wordItemsets };
