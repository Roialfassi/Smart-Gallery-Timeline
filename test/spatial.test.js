'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { haversine, dbscan, centroid } = require('../src/services/spatial');

test('haversine: Paris -> London is ~344 km', () => {
  const km = haversine(48.8566, 2.3522, 51.5074, -0.1278) / 1000;
  assert.ok(Math.abs(km - 344) < 15, `expected ~344 km, got ${km.toFixed(1)}`);
});

test('haversine: identical points are 0', () => {
  assert.strictEqual(haversine(10, 10, 10, 10), 0);
});

test('dbscan: two tight groups become two clusters', () => {
  const pts = [
    { id: 1, lat: 48.8584, lon: 2.2945 }, { id: 2, lat: 48.8585, lon: 2.2946 }, { id: 3, lat: 48.8586, lon: 2.2944 },
    { id: 4, lat: 41.8902, lon: 12.4922 }, { id: 5, lat: 41.8903, lon: 12.4923 }, { id: 6, lat: 41.8901, lon: 12.4921 },
  ];
  const clusters = dbscan(pts, 300, 2);
  assert.strictEqual(clusters.length, 2);
  assert.deepStrictEqual(clusters.map((c) => c.length).sort(), [3, 3]);
});

test('dbscan: an isolated point is noise (omitted)', () => {
  const pts = [
    { id: 1, lat: 0, lon: 0 }, { id: 2, lat: 0.0001, lon: 0.0001 },
    { id: 3, lat: 50, lon: 50 },
  ];
  const clusters = dbscan(pts, 100, 2);
  assert.strictEqual(clusters.length, 1);
  assert.strictEqual(clusters[0].length, 2);
});

test('centroid: mean of points', () => {
  const c = centroid([{ lat: 0, lon: 0 }, { lat: 2, lon: 4 }]);
  assert.deepStrictEqual(c, { lat: 1, lon: 2 });
});
