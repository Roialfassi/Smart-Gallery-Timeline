'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { resolveScale, segmentByScale } = require('../src/services/grouping');
const { dateRangeLabel, placeName } = require('../src/services/naming');
const config = require('../src/config');

const HOUR = 3600e3;
const DAY = 24 * HOUR;

// Build ascending rows from [{ hoursFromStart, lat, lon, folder, cc }].
function rows(specs) {
  const t0 = Date.UTC(2024, 0, 1, 0, 0, 0);
  return specs.map((s, i) => ({
    id: i + 1,
    t: t0 + (s.h || 0) * HOUR,
    date_taken: new Date(t0 + (s.h || 0) * HOUR).toISOString(),
    latitude: s.lat ?? null,
    longitude: s.lon ?? null,
    folder_name: s.folder || '',
    country_code: s.cc || null,
  }));
}

// Boundary set = indices (into rows) where a new group begins.
function boundaries(groups) {
  const b = new Set();
  let idx = 0;
  for (const g of groups) { b.add(idx); idx += g.length; }
  return b;
}

test('resolveScale: ends snap to first/last tier, thresholds grow monotonically', () => {
  const { TIERS, STEPS } = config.grouping;
  assert.strictEqual(resolveScale(0).tier, TIERS[0].name);
  assert.strictEqual(resolveScale(STEPS).tier, TIERS[TIERS.length - 1].name);
  let prevTau = -1, prevDelta = -1;
  for (let s = 0; s <= STEPS; s++) {
    const r = resolveScale(s);
    assert.ok(r.tau >= prevTau, `tau monotonic at step ${s}`);
    assert.ok(r.delta >= prevDelta, `delta monotonic at step ${s}`);
    prevTau = r.tau; prevDelta = r.delta;
  }
});

test('resolveScale clamps out-of-range steps', () => {
  assert.strictEqual(resolveScale(-5).step, 0);
  assert.strictEqual(resolveScale(9999).step, config.grouping.STEPS);
});

test('time mode: splits on time gaps, ignores location', () => {
  // Two bursts 10 days apart; second burst is at a wildly different location.
  const r = rows([
    { h: 0, lat: 10, lon: 10 }, { h: 1, lat: 10, lon: 10 },
    { h: 10 * 24, lat: 50, lon: 50 }, { h: 10 * 24 + 1, lat: 50, lon: 50 },
  ]);
  const tight = segmentByScale(r, { mode: 'time', tau: 2 * HOUR, delta: 0 });
  assert.strictEqual(tight.length, 2, 'a 10-day gap splits into two');
  const wide = segmentByScale(r, { mode: 'time', tau: 30 * DAY, delta: 0 });
  assert.strictEqual(wide.length, 1, 'a huge tau merges everything');
});

test('spacetime mode: a far location jump splits even within continuous time', () => {
  // Photos every hour (no time gap), but one hops 100s of km away.
  const r = rows([
    { h: 0, lat: 48.85, lon: 2.35 }, { h: 1, lat: 48.86, lon: 2.34 }, // Paris
    { h: 2, lat: 41.9, lon: 12.5 }, { h: 3, lat: 41.9, lon: 12.5 },   // Rome
  ]);
  const timeOnly = segmentByScale(r, { mode: 'time', tau: 6 * HOUR, delta: 0 });
  assert.strictEqual(timeOnly.length, 1, 'time mode keeps the continuous run whole');
  const spaceTime = segmentByScale(r, { mode: 'spacetime', tau: 6 * HOUR, delta: 50000 });
  assert.strictEqual(spaceTime.length, 2, 'the Paris->Rome jump splits in spacetime');
});

test('monotonic zoom: boundaries at a wider scale nest inside narrower ones', () => {
  // A varied sequence of bursts at growing gaps and distances.
  const r = rows([
    { h: 0, lat: 10, lon: 10 }, { h: 0.5, lat: 10, lon: 10 },
    { h: 5, lat: 10.2, lon: 10.2 },
    { h: 30, lat: 12, lon: 12 },
    { h: 24 * 6, lat: 40, lon: 40 }, { h: 24 * 6 + 1, lat: 40, lon: 40 },
    { h: 24 * 50, lat: 41, lon: 41 },
  ]);
  for (const mode of ['time', 'spacetime']) {
    let prevCount = Infinity;
    let prevBounds = null;
    for (let s = 0; s <= config.grouping.STEPS; s++) {
      const sc = resolveScale(s);
      const groups = segmentByScale(r, { mode, tau: sc.tau, delta: sc.delta });
      assert.ok(groups.length <= prevCount, `[${mode}] group count non-increasing at step ${s}`);
      const b = boundaries(groups);
      if (prevBounds) for (const x of b) assert.ok(prevBounds.has(x), `[${mode}] boundary ${x} must persist from narrower scale`);
      prevCount = groups.length;
      prevBounds = b;
    }
  }
});

test('dateRangeLabel: collapses coarser as the span widens', () => {
  assert.strictEqual(dateRangeLabel('2024-05-05T09:00:00Z', '2024-05-05T18:00:00Z'), 'May 5, 2024');
  assert.strictEqual(dateRangeLabel('2024-05-04T00:00:00Z', '2024-05-07T00:00:00Z'), 'May 4–7, 2024');
  assert.strictEqual(dateRangeLabel('2024-01-01T00:00:00Z', '2024-12-30T00:00:00Z'), '2024');
  assert.strictEqual(dateRangeLabel('2019-03-01T00:00:00Z', '2024-09-01T00:00:00Z'), '2019–2024');
});

test('placeName: leads with the place, qualified by the country', () => {
  const photos = [
    { folder_name: 'Tokyo Japan Adventure 2025', country_code: 'JP' },
    { folder_name: 'Tokyo Japan Adventure 2025', country_code: 'JP' },
  ];
  assert.strictEqual(placeName(photos), 'Tokyo, Japan');
  assert.strictEqual(placeName([{ folder_name: '', country_code: 'FR' }]), 'France');
  assert.strictEqual(placeName([{ folder_name: '', country_code: null }]), 'Area');
});
