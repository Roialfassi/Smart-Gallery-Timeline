'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { parseOffset, formatOffset } = require('../src/services/metadata');

test('parseOffset: parses the supported shapes', () => {
  assert.strictEqual(parseOffset('+02:00'), 120);
  assert.strictEqual(parseOffset('-07:30'), -450);
  assert.strictEqual(parseOffset('+0200'), 120);
  assert.strictEqual(parseOffset('Z'), 0);
});

test('parseOffset: rejects junk', () => {
  assert.strictEqual(parseOffset(''), null);
  assert.strictEqual(parseOffset('nope'), null);
  assert.strictEqual(parseOffset(null), null);
  assert.strictEqual(parseOffset(undefined), null);
});

test('formatOffset: minutes -> string', () => {
  assert.strictEqual(formatOffset(120), '+02:00');
  assert.strictEqual(formatOffset(-450), '-07:30');
  assert.strictEqual(formatOffset(0), '+00:00');
});

test('offset round-trips through parse/format', () => {
  for (const m of [-720, -450, 0, 120, 330, 840]) {
    assert.strictEqual(parseOffset(formatOffset(m)), m);
  }
});
