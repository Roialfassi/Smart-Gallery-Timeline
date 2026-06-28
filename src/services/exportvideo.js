'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const sharp = require('sharp');
const ffmpegPath = require('ffmpeg-static');
const { getDb } = require('../db/database');
const { buildFilters } = require('../api/queries');
const thumbnails = require('./thumbnails');
const { haversine } = require('./spatial');
const runtimePaths = require('../runtime-paths');
const config = require('../config');

/**
 * MP4 video export (plan/features.md Section 5B — Phase 4 spike).
 *
 * For each photo a 1280x720 frame is composed: the photo on the left pane and a
 * schematic journey-track panel on the right (current point highlighted). Frames
 * are encoded to H.264 with the bundled ffmpeg-static binary. Optional background
 * music is mixed when a track is supplied.
 */

const W = 1280, H = 720;
const PHOTO_W = 760;
const MAP_X = PHOTO_W, MAP_W = W - PHOTO_W;

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function loadPoints(filters) {
  const db = getDb();
  const { where, params } = buildFilters(filters || {});
  return db.prepare(
    `SELECT id, file_name, folder_name, date_taken, latitude AS lat, longitude AS lon, country_code ` +
    `FROM photos WHERE ${where} AND latitude IS NOT NULL ORDER BY date_taken ASC, id ASC`
  ).all(params).slice(0, 80);
}

// Aspect-locked equirectangular projection of points into a w*h pane.
function project(points, w, h, pad) {
  let minLa = Infinity, maxLa = -Infinity, minLo = Infinity, maxLo = -Infinity;
  for (const p of points) {
    minLa = Math.min(minLa, p.lat); maxLa = Math.max(maxLa, p.lat);
    minLo = Math.min(minLo, p.lon); maxLo = Math.max(maxLo, p.lon);
  }
  if (maxLa - minLa < 1e-4) { minLa -= 0.05; maxLa += 0.05; }
  if (maxLo - minLo < 1e-4) { minLo -= 0.05; maxLo += 0.05; }
  const s = Math.min((w - 2 * pad) / (maxLo - minLo), (h - 2 * pad) / (maxLa - minLa));
  const offX = (w - (maxLo - minLo) * s) / 2;
  const offY = (h - (maxLa - minLa) * s) / 2;
  return points.map((p) => ({
    x: offX + (p.lon - minLo) * s,
    y: h - (offY + (p.lat - minLa) * s),
  }));
}

function trackSvg(points, proj, idx) {
  const maxDist = config.spatial.JOURNEY_SEGMENT_MAX_DISTANCE_KM * 1000;
  // Build polyline segments, breaking on big spatial jumps (matches journey logic).
  let lines = '';
  for (let i = 1; i < proj.length; i++) {
    const d = haversine(points[i - 1].lat, points[i - 1].lon, points[i].lat, points[i].lon);
    if (d > maxDist) continue;
    lines += `<line x1="${proj[i - 1].x.toFixed(1)}" y1="${proj[i - 1].y.toFixed(1)}" x2="${proj[i].x.toFixed(1)}" y2="${proj[i].y.toFixed(1)}" stroke="#4f9cff" stroke-width="2" opacity="0.7"/>`;
  }
  let dots = '';
  proj.forEach((p, i) => {
    const cur = i === idx;
    dots += `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${cur ? 8 : 3}" fill="${cur ? '#ffb454' : '#7c5cff'}" ${cur ? 'stroke="#fff" stroke-width="2"' : ''}/>`;
  });
  const cur = points[idx];
  const date = cur.date_taken ? new Date(cur.date_taken).toISOString().slice(0, 10) : '';
  const place = esc(cur.folder_name || cur.file_name || '');
  return `<svg width="${MAP_W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
    <rect width="100%" height="100%" fill="#14171e"/>
    <rect x="0" y="0" width="3" height="${H}" fill="#2a3040"/>
    <text x="24" y="44" font-family="Arial" font-size="22" font-weight="bold" fill="#e7e9f0">Journey</text>
    ${lines}${dots}
    <text x="24" y="${H - 70}" font-family="Arial" font-size="24" font-weight="bold" fill="#ffb454">${place}</text>
    <text x="24" y="${H - 40}" font-family="Arial" font-size="18" fill="#8b92a5">${date}  ${cur.country_code || ''}</text>
  </svg>`;
}

async function composeFrame(point, allPoints, proj, idx, outPath) {
  const preview = await thumbnails.resolveThumbnail(point.id, 'PREVIEW');
  let photoBuf, meta;
  if (preview) {
    photoBuf = await sharp(preview).resize({ width: PHOTO_W - 40, height: H - 40, fit: 'contain', background: '#0e1014' }).toBuffer();
    meta = await sharp(photoBuf).metadata();
  } else {
    photoBuf = await sharp({ create: { width: PHOTO_W - 40, height: H - 40, channels: 3, background: '#0e1014' } }).png().toBuffer();
    meta = { width: PHOTO_W - 40, height: H - 40 };
  }
  const left = Math.round((PHOTO_W - meta.width) / 2);
  const top = Math.round((H - meta.height) / 2);
  const trackBuf = await sharp(Buffer.from(trackSvg(allPoints, proj, idx))).png().toBuffer();

  await sharp({ create: { width: W, height: H, channels: 3, background: '#0e1014' } })
    .composite([
      { input: photoBuf, left, top },
      { input: trackBuf, left: MAP_X, top: 0 },
    ])
    .png()
    .toFile(outPath);
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args);
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error('ffmpeg exited ' + code + '\n' + stderr.slice(-500)))));
  });
}

/**
 * Export an MP4 for the (filtered) geotagged photo set.
 * @returns {{path:string, frames:number}}
 */
async function exportMp4({ filters = {}, secondsPerPhoto = 2.5, music = null, onProgress } = {}) {
  const points = loadPoints(filters);
  if (points.length === 0) {
    const e = new Error('No geotagged photos match the current filters to export.');
    e.errorCode = 'PATH_NOT_FOUND';
    throw e;
  }
  const emit = (evt) => onProgress && onProgress(evt);

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sgt-export-'));
  const proj = project(points, MAP_W, H, 50);

  try {
    for (let i = 0; i < points.length; i++) {
      const frameFile = path.join(work, `frame_${String(i + 1).padStart(5, '0')}.png`);
      await composeFrame(points[i], points, proj, i, frameFile);
      emit({ phase: 'frames', processed: i + 1, total: points.length });
    }

    const exportDir = runtimePaths.paths().cacheDir;
    fs.mkdirSync(exportDir, { recursive: true });
    const outPath = path.join(exportDir, 'export.mp4');

    const args = [
      '-y',
      '-framerate', String(1 / secondsPerPhoto),
      '-i', path.join(work, 'frame_%05d.png'),
    ];
    if (music && fs.existsSync(music)) args.push('-i', music, '-shortest');
    args.push(
      '-c:v', 'libx264',
      '-r', '30',
      '-pix_fmt', 'yuv420p',
      '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2',
    );
    if (music && fs.existsSync(music)) args.push('-c:a', 'aac', '-b:a', '128k');
    args.push(outPath);

    emit({ phase: 'encoding', message: 'Encoding H.264 video…' });
    await runFfmpeg(args);
    emit({ phase: 'complete', frames: points.length });
    return { path: outPath, frames: points.length };
  } finally {
    try { fs.rmSync(work, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  }
}

module.exports = { exportMp4, ffmpegPath };
