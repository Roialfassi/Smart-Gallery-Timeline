'use strict';

const { getDb } = require('../db/database');

/**
 * Materialized timeline rollups (plan/architecture.md Section 4, Phase 3).
 *
 * Decade/Year/Month summary aggregates so large-scope timeline queries read
 * pre-computed metrics instead of GROUP BY over the photos table.
 */

function periodKeysFor(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  return {
    decade: `${Math.floor(y / 10) * 10}s`,
    year: String(y),
    month: `${y}-${mo}`,
  };
}

/**
 * Full rebuild of all rollups from the active photo set. Correct and cheap for
 * catalog sizes in the tens/hundreds of thousands; runs in a single transaction.
 */
function rebuildAll() {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT date_taken, country_code, camera_model FROM photos " +
      "WHERE status = 'active' AND date_taken IS NOT NULL"
    )
    .all();

  const agg = new Map(); // `${type}|${key}` -> { type, key, count, countries:Set, cameras:Map }
  for (const r of rows) {
    const keys = periodKeysFor(r.date_taken);
    if (!keys) continue;
    for (const [type, key] of [['decade', keys.decade], ['year', keys.year], ['month', keys.month]]) {
      const id = `${type}|${key}`;
      let e = agg.get(id);
      if (!e) {
        e = { type, key, count: 0, countries: new Set(), cameras: new Map() };
        agg.set(id, e);
      }
      e.count++;
      if (r.country_code) e.countries.add(r.country_code);
      if (r.camera_model) e.cameras.set(r.camera_model, (e.cameras.get(r.camera_model) || 0) + 1);
    }
  }

  const tx = db.transaction(() => {
    db.prepare('DELETE FROM timeline_rollups').run();
    const ins = db.prepare(
      'INSERT INTO timeline_rollups (period_type, period_key, photo_count, countries_list, camera_models_counts) ' +
      'VALUES (?, ?, ?, ?, ?)'
    );
    for (const e of agg.values()) {
      ins.run(
        e.type,
        e.key,
        e.count,
        JSON.stringify([...e.countries].sort()),
        JSON.stringify(Object.fromEntries([...e.cameras.entries()].sort((a, b) => b[1] - a[1])))
      );
    }
  });
  tx();
  return agg.size;
}

module.exports = { rebuildAll, periodKeysFor };
