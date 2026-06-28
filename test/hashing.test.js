'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const piexif = require('piexifjs');
const { computeContentHash, fullFileSha256 } = require('../src/services/hashing');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sgt-hash-'));

async function makeJpeg(p) {
  await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 12, g: 120, b: 200 } } })
    .jpeg({ quality: 90 }).toFile(p);
}

test('JPEG content hash is metadata-invariant (EXIF rewrite preserves it)', async () => {
  const p = path.join(tmp, 'a.jpg');
  await makeJpeg(p);
  const hashBefore = computeContentHash(p, 'jpg');
  const fileBefore = fullFileSha256(p);

  // Inject EXIF (Make tag) the way the tag write-back / seeder do.
  const bin = fs.readFileSync(p).toString('binary');
  const exifStr = piexif.dump({ '0th': { [piexif.ImageIFD.Make]: 'TestCam' }, Exif: {}, GPS: {} });
  fs.writeFileSync(p, Buffer.from(piexif.insert(exifStr, bin), 'binary'));

  const hashAfter = computeContentHash(p, 'jpg');
  const fileAfter = fullFileSha256(p);

  assert.strictEqual(hashAfter, hashBefore, 'content hash must survive an EXIF rewrite');
  assert.notStrictEqual(fileAfter, fileBefore, 'the raw file bytes should have changed');
});

test('different images produce different content hashes', async () => {
  const a = path.join(tmp, 'red.jpg');
  const b = path.join(tmp, 'blue.jpg');
  await sharp({ create: { width: 32, height: 32, channels: 3, background: { r: 220, g: 10, b: 10 } } }).jpeg().toFile(a);
  await sharp({ create: { width: 32, height: 32, channels: 3, background: { r: 10, g: 10, b: 220 } } }).jpeg().toFile(b);
  assert.notStrictEqual(computeContentHash(a, 'jpg'), computeContentHash(b, 'jpg'));
});

test('read-only formats fall back to a full-file SHA-256', () => {
  const p = path.join(tmp, 'x.heic');
  fs.writeFileSync(p, Buffer.from('definitely not a real heic file'));
  assert.strictEqual(computeContentHash(p, 'heic'), fullFileSha256(p));
});
