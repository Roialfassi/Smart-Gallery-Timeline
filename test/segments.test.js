'use strict';

// Integration test: drives the real segmentation engine against a throwaway
// project DB. Sets SGT_CACHE_DIR before anything is required so the registry
// lands in a temp dir. (node --test runs each file in its own process.)
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sgt-seg-'));
process.env.SGT_CACHE_DIR = path.join(TMP, 'cache');

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const project = require('../src/services/project');
const { getDb, closeDb } = require('../src/db/database');
const segments = require('../src/services/segments');

let db;
const ins = (p) => db.prepare(`INSERT INTO photos
  (directory_id,file_path,file_name,folder_name,file_size,mtime,content_hash,format,writable,date_taken,latitude,longitude,country_code,status)
  VALUES (1,@fp,@fn,@fld,100,@mt,@h,'jpg',1,@dt,@lat,@lon,@cc,'active')`).run(p);

before(() => {
  project.createProject({ baseDir: path.join(TMP, 'proj'), name: 'Seg' });
  db = getDb();
  db.prepare("INSERT INTO directories (id,path,status) VALUES (1,?,'idle')").run(path.join(TMP, 'proj'));

  let n = 0;
  const add = (dateIso, lat, lon, cc) =>
    ins({ fp: 'f' + n, fn: 'IMG_' + n + '.jpg', fld: cc || 'home', mt: n, h: 'h' + (n++), dt: dateIso, lat, lon, cc });

  // 10 home (FR) photos, one per day -> everyday period bucket.
  for (let d = 1; d <= 10; d++) add(`2024-05-${String(d).padStart(2, '0')}T12:00:00.000Z`, 48.8584, 2.2945, 'FR');
  // 6 away (IT) photos on one day spanning 10h -> qualifies as a trip.
  for (let h = 8; h <= 18; h += 2) add(`2024-06-15T${String(h).padStart(2, '0')}:00:00.000Z`, 41.8902, 12.4922, 'IT');
});

after(() => { closeDb(); });

test('detects the home country as the most common', () => {
  segments._resetCache();
  const { home } = segments.buildSegments({});
  assert.strictEqual(home, 'FR');
});

test('an away run that clears the bar becomes a single trip', () => {
  const { segments: segs } = segments.buildSegments({});
  const trips = segs.filter((s) => s.kind === 'trip');
  assert.strictEqual(trips.length, 1);
  assert.deepStrictEqual(trips[0].countries, ['IT']);
  assert.strictEqual(trips[0].photoCount, 6);
});

test('home photos fall into period buckets, not a trip', () => {
  const { segments: segs } = segments.buildSegments({});
  const periods = segs.filter((s) => s.kind === 'period');
  assert.ok(periods.length >= 1);
  const homePhotos = periods.reduce((a, s) => a + s.photoCount, 0);
  assert.strictEqual(homePhotos, 10);
});

test('listSegments drops the per-segment photo arrays', () => {
  const { segments: cards } = segments.listSegments({});
  assert.ok(cards.length > 0);
  assert.ok(cards.every((c) => !('photos' in c)));
});

test('segmentPhotos returns the ascending photo list for an id', () => {
  const { segments: segs } = segments.buildSegments({});
  const trip = segs.find((s) => s.kind === 'trip');
  const photos = segments.segmentPhotos({}, trip.id);
  assert.strictEqual(photos.length, 6);
  for (let i = 1; i < photos.length; i++) {
    assert.ok(photos[i - 1].date_taken <= photos[i].date_taken, 'photos must be ascending');
  }
});

test('result is memoized and self-invalidates when the catalog changes', () => {
  const r1 = segments.buildSegments({});
  const r2 = segments.buildSegments({});
  assert.strictEqual(r1, r2, 'identical catalog state should hit the cache (same reference)');

  // Mutating the catalog must bump the signature and force a recompute.
  ins({ fp: 'extra', fn: 'IMG_extra.jpg', fld: 'FR', mt: 999, h: 'hextra',
    dt: '2024-05-20T12:00:00.000Z', lat: 48.8584, lon: 2.2945, cc: 'FR' });
  const r3 = segments.buildSegments({});
  assert.notStrictEqual(r1, r3, 'a new photo should invalidate the cache');
});
