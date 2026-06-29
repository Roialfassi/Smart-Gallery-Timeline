'use strict';

const exifr = require('exifr');
const sharp = require('sharp');
const geocode = require('./geocode');
const config = require('../config');

/**
 * Metadata extraction pipeline (plan/architecture.md Section 6).
 *
 * Produces a normalized record:
 *   { date_taken (UTC ISO), tz_offset, country_code, latitude, longitude,
 *     altitude, camera_make, camera_model, orientation, width, height }
 *
 * Timezone resolution order (Section 6.1):
 *   1. EXIF OffsetTimeOriginal / OffsetTime
 *   2. Approximate from GPS longitude (lon/15h) when coordinates exist
 *   3. Host system offset
 * date_taken is stored normalized to UTC; tz_offset preserves the original.
 */

function num(v) {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function pad2(n) {
  return String(Math.abs(n)).padStart(2, '0');
}

function formatOffset(minutes) {
  const sign = minutes < 0 ? '-' : '+';
  const h = Math.floor(Math.abs(minutes) / 60);
  const m = Math.abs(minutes) % 60;
  return `${sign}${pad2(h)}:${pad2(m)}`;
}

// "+02:00" / "+0200" / "Z" -> minutes, or null.
function parseOffset(str) {
  if (!str || typeof str !== 'string') return null;
  const s = str.trim();
  if (s === 'Z') return 0;
  const m = s.match(/^([+-])(\d{2}):?(\d{2})$/);
  if (!m) return null;
  const sign = m[1] === '-' ? -1 : 1;
  return sign * (parseInt(m[2], 10) * 60 + parseInt(m[3], 10));
}

// "YYYY:MM:DD HH:MM:SS" (EXIF) -> components, or null.
function parseExifDateString(str) {
  if (!str || typeof str !== 'string') return null;
  const m = str.match(/^(\d{4})[:-](\d{2})[:-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  return {
    y: +m[1], mo: +m[2], d: +m[3], h: +m[4], mi: +m[5], s: +m[6],
  };
}

async function extractMetadata(filePath, buffer) {
  // When the caller already has the bytes (ingest reads each file once), parse
  // from the in-memory buffer so sharp + the two exifr passes don't each re-open
  // the file from disk.
  const src = buffer || filePath;

  // Reliable dimensions + orientation via sharp (works across formats).
  let width = null, height = null, orientation = 1;
  try {
    const m = await sharp(src, { failOn: 'none' }).metadata();
    width = m.width || null;
    height = m.height || null;
    orientation = m.orientation || 1;
  } catch (_) { /* non-fatal */ }

  let exif = {};
  try {
    exif = (await exifr.parse(src, { tiff: true, ifd0: true, exif: true, gps: true })) || {};
  } catch (_) { exif = {}; }

  // Raw (unrevived) date + offset strings for deterministic UTC normalization.
  let raw = {};
  try {
    raw = (await exifr.parse(src, {
      pick: ['DateTimeOriginal', 'CreateDate', 'DateTime', 'OffsetTimeOriginal', 'OffsetTime'],
      reviveValues: false,
    })) || {};
  } catch (_) { raw = {}; }

  const latitude = num(exif.latitude);
  const longitude = num(exif.longitude);
  const altitude = num(exif.GPSAltitude);

  const rawDateStr = raw.DateTimeOriginal || raw.CreateDate || raw.DateTime || null;
  let offsetMin = parseOffset(raw.OffsetTimeOriginal) ?? parseOffset(raw.OffsetTime);
  if (offsetMin == null && longitude != null) offsetMin = Math.round(longitude / 15) * 60;
  if (offsetMin == null) offsetMin = config.system.tzOffsetMinutes;

  let date_taken = null;
  let tz_offset = null;
  const parts = parseExifDateString(rawDateStr);
  if (parts) {
    const wallMs = Date.UTC(parts.y, parts.mo - 1, parts.d, parts.h, parts.mi, parts.s);
    date_taken = new Date(wallMs - offsetMin * 60000).toISOString();
    tz_offset = formatOffset(offsetMin);
  }

  const country_code =
    latitude != null && longitude != null ? geocode.countryForCoord(latitude, longitude) : null;

  return {
    date_taken,
    tz_offset,
    country_code,
    latitude,
    longitude,
    altitude,
    camera_make: exif.Make ? String(exif.Make).trim() : null,
    camera_model: exif.Model ? String(exif.Model).trim() : null,
    orientation,
    width,
    height,
  };
}

module.exports = { extractMetadata, parseOffset, formatOffset };
