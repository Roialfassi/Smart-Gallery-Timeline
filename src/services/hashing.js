'use strict';

const fs = require('fs');
const crypto = require('crypto');

/**
 * Metadata-invariant content hashing (plan/architecture.md Section 5).
 *
 * Tagging write-back mutates EXIF/metadata segments. To keep a stable identity
 * for move/rename detection across those writes, we hash ONLY the image pixel
 * stream for writable formats (JPEG/PNG/WebP), skipping metadata segments.
 * HEIC/RAW/video are never written back, so they use a plain full-file SHA-256.
 *
 * If any structural parsing fails (truncated/invalid markers) we fall back to a
 * full-file hash so we never throw during ingestion.
 */

function sha256Buffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function fullFileSha256(filePath) {
  return sha256Buffer(fs.readFileSync(filePath));
}

// --- JPEG: hash from Start-of-Scan (SOS, 0xFFDA) onward, skipping APPn/COM. ---
function hashJpeg(buf) {
  if (buf.length < 2 || buf[0] !== 0xff || buf[1] !== 0xd8) return null; // not SOI
  let offset = 2;
  const hash = crypto.createHash('sha256');
  while (offset < buf.length) {
    if (buf[offset] !== 0xff) return null; // marker desync
    let marker = buf[offset + 1];
    // Skip fill bytes
    while (marker === 0xff && offset + 1 < buf.length) {
      offset++;
      marker = buf[offset + 1];
    }
    // SOS: hash everything from here (entropy-coded image data) to EOI.
    if (marker === 0xda) {
      hash.update(buf.subarray(offset));
      return hash.digest('hex');
    }
    // Standalone markers (no length): RSTn, SOI, EOI, TEM
    if (marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      offset += 2;
      continue;
    }
    // Everything else has a 2-byte big-endian length following the marker.
    if (offset + 4 > buf.length) return null;
    const segLen = buf.readUInt16BE(offset + 2);
    if (segLen < 2) return null;
    offset += 2 + segLen;
  }
  return null; // never found SOS
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_SKIP_CHUNKS = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME']);

// --- PNG: hash core chunks (IHDR/PLTE/IDAT/IEND), skip text/exif/time chunks. ---
function hashPng(buf) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) return null;
  let offset = 8;
  const hash = crypto.createHash('sha256');
  while (offset + 8 <= buf.length) {
    const len = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const chunkEnd = offset + 12 + len; // length(4)+type(4)+data(len)+crc(4)
    if (chunkEnd > buf.length) return null;
    if (!PNG_SKIP_CHUNKS.has(type)) {
      hash.update(buf.subarray(offset, chunkEnd));
    }
    offset = chunkEnd;
    if (type === 'IEND') break;
  }
  return hash.digest('hex');
}

const WEBP_SKIP_CHUNKS = new Set(['EXIF', 'ICCP', 'XMP ']);

// --- WebP (RIFF): hash VP8/VP8L/VP8X/ALPH/ANMF, skip EXIF/ICCP/XMP. ---
function hashWebp(buf) {
  if (buf.length < 12) return null;
  if (buf.toString('ascii', 0, 4) !== 'RIFF') return null;
  if (buf.toString('ascii', 8, 12) !== 'WEBP') return null;
  let offset = 12;
  const hash = crypto.createHash('sha256');
  while (offset + 8 <= buf.length) {
    const fourcc = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + size;
    if (dataEnd > buf.length) return null;
    if (!WEBP_SKIP_CHUNKS.has(fourcc)) {
      hash.update(buf.subarray(dataStart, dataEnd));
    }
    // RIFF chunks are padded to even length.
    offset = dataEnd + (size % 2);
  }
  return hash.digest('hex');
}

/**
 * Compute the content hash for a file.
 * @param {string} filePath absolute path
 * @param {string} format normalized lowercase extension without dot (e.g. 'jpg')
 * @param {Buffer} [buffer] the file's bytes, if already read (avoids a re-read —
 *        the ingest pipeline reads each file once and threads the buffer through
 *        hashing, metadata, and thumbnails)
 * @returns {string} hex SHA-256
 */
function computeContentHash(filePath, format, buffer) {
  const writable = format === 'jpg' || format === 'jpeg' || format === 'png' || format === 'webp';

  let buf = buffer;
  if (!writable) return buf ? sha256Buffer(buf) : fullFileSha256(filePath);

  try {
    if (!buf) buf = fs.readFileSync(filePath);
    let result = null;
    if (format === 'jpg' || format === 'jpeg') result = hashJpeg(buf);
    else if (format === 'png') result = hashPng(buf);
    else if (format === 'webp') result = hashWebp(buf);
    if (result) return result;
    return sha256Buffer(buf); // structural parse failed but bytes are in hand
  } catch (_) {
    // fall through to full-file
  }
  return fullFileSha256(filePath);
}

module.exports = { computeContentHash, fullFileSha256, sha256Buffer };
