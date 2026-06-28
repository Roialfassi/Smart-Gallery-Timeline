'use strict';

// Guards full per-project isolation: no shared catalog when idle, and a scan
// never crosses into a nested project. Sets SGT_CACHE_DIR before requiring app
// modules so nothing touches the real app cache. (node --test = own process.)
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sgt-iso-'));
process.env.SGT_CACHE_DIR = path.join(TMP, 'cache');

const { test } = require('node:test');
const assert = require('node:assert');
const { getDb } = require('../src/db/database');
const { discover } = require('../src/services/scanner');

test('getDb refuses to open a catalog when no project is active (no shared bucket)', () => {
  assert.throws(() => getDb(), (e) => e.errorCode === 'NO_ACTIVE_PROJECT');
});

test('discover never crosses into a nested project (hard isolation boundary)', async () => {
  const parent = path.join(TMP, 'parent');
  fs.mkdirSync(parent, { recursive: true });
  fs.writeFileSync(path.join(parent, 'parent.jpg'), 'x');

  // A nested project: its own .smartgallery marker + a photo that must NOT be seen.
  const nested = path.join(parent, 'Other Project');
  fs.mkdirSync(path.join(nested, '.smartgallery'), { recursive: true });
  fs.writeFileSync(path.join(nested, 'nested.jpg'), 'y');

  const found = (await discover(parent)).map((f) => path.basename(f.path));
  assert.deepStrictEqual(found, ['parent.jpg'], 'only the parent photo, never the nested project');
});
