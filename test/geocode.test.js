'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { countryForCoord, isLoaded } = require('../src/services/geocode');

test('the bundled country dataset loads', () => {
  assert.ok(isLoaded(), 'data/countries.json should be present and non-empty');
});

test('resolves well-known coordinates to ISO codes', () => {
  assert.strictEqual(countryForCoord(48.8566, 2.3522), 'FR');  // Paris
  assert.strictEqual(countryForCoord(35.6762, 139.6503), 'JP'); // Tokyo
  assert.strictEqual(countryForCoord(41.9028, 12.4964), 'IT');  // Rome
});

test('open ocean and bad input resolve to null', () => {
  assert.strictEqual(countryForCoord(0, -160), null);  // mid-Pacific
  assert.strictEqual(countryForCoord(null, null), null);
  assert.strictEqual(countryForCoord(NaN, NaN), null);
});
