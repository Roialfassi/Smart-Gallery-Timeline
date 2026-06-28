'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { periodKeysFor } = require('../src/services/rollups');

test('periodKeysFor: derives decade / year / month (UTC)', () => {
  assert.deepStrictEqual(periodKeysFor('2024-05-04T10:00:00.000Z'),
    { decade: '2020s', year: '2024', month: '2024-05' });
  assert.deepStrictEqual(periodKeysFor('2009-12-31T23:00:00.000Z'),
    { decade: '2000s', year: '2009', month: '2009-12' });
});

test('periodKeysFor: invalid date -> null', () => {
  assert.strictEqual(periodKeysFor('not-a-date'), null);
});
