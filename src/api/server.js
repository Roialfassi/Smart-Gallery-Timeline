'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');
const { EventEmitter } = require('events');
const config = require('../config');
const pkg = require('../../package.json');
const runtimePaths = require('../runtime-paths');
const { getDb } = require('../db/database');
const queries = require('./queries');
const thumbnails = require('../services/thumbnails');
const { scanDirectory } = require('../services/scanner');
const { buildJourneys } = require('../services/journeys');
const segments = require('../services/segments');
const clustering = require('../services/clustering');
const { recommend } = require('../services/recommend');
const { writeTagsToJpeg } = require('../services/exifwriter');
const { exportMp4 } = require('../services/exportvideo');
const project = require('../services/project');
const importer = require('../services/importer');
const fsbrowse = require('../services/fsbrowse');

const MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.heic': 'image/heic', '.heif': 'image/heif',
};

function err(res, code, status, message, details) {
  res.status(status).json({ errorCode: code, message, details: details || {} });
}

// Wrap async handlers so rejections become structured 500s.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/**
 * In-process scan/import coordinator: one job at a time, progress via SSE.
 * Scans and imports share this so the same progress bar + /api/scan/stream serve both.
 */
const scanBus = new EventEmitter();
scanBus.setMaxListeners(50);
let scanState = { running: false, lastSummary: null, lastEvent: null, path: null, terminal: null };

async function runProgressJob(job, meta = {}) {
  if (scanState.running) throw new Error('A scan or import is already in progress');
  scanState = { running: true, lastSummary: null, lastEvent: null, terminal: null, ...meta };
  try {
    const summary = await job((evt) => {
      scanState.lastEvent = evt;
      scanBus.emit('progress', evt);
    });
    scanState.running = false;
    scanState.lastSummary = summary;
    // Remember the terminal event. A client that attaches to the SSE stream
    // *after* a fast job already finished (notably the one-click demo import,
    // which starts before the UI subscribes) reads this from the connect
    // snapshot and finalizes, instead of waiting on an event it already missed.
    scanState.terminal = { phase: 'complete', summary };
    scanBus.emit('progress', scanState.terminal);
    return summary;
  } catch (e) {
    scanState.running = false;
    scanState.terminal = { phase: 'fatal', message: e.message };
    scanBus.emit('progress', scanState.terminal);
    throw e;
  }
}

const runScan = (targetPath) =>
  runProgressJob((onProgress) => scanDirectory(targetPath, { onProgress }), { path: targetPath });

/** In-process MP4 export coordinator: one export at a time, progress via SSE. */
const exportBus = new EventEmitter();
exportBus.setMaxListeners(50);
let exportState = { running: false, lastResult: null, lastEvent: null, error: null };

async function runExport(options) {
  if (exportState.running) throw new Error('An export is already in progress');
  exportState = { running: true, lastResult: null, lastEvent: null, error: null };
  try {
    const result = await exportMp4({
      ...options,
      onProgress: (evt) => {
        exportState.lastEvent = evt;
        exportBus.emit('progress', evt);
      },
    });
    exportState.running = false;
    exportState.lastResult = result;
    exportBus.emit('progress', { phase: 'complete', frames: result.frames });
    return result;
  } catch (e) {
    exportState.running = false;
    exportState.error = e.message;
    exportBus.emit('progress', { phase: 'fatal', message: e.message, errorCode: e.errorCode });
    throw e;
  }
}

function createApp() {
  const app = express();
  // Import endpoints POST arbitrarily long arrays of source paths; the 100kb
  // express default 413s a large multi-select, so widen the JSON body cap.
  app.use(express.json({ limit: '5mb' }));

  const pub = path.join(config.paths.root, 'public');
  app.use(express.static(pub));

  // --- Health ---
  app.get('/api/health', (req, res) => res.json({ ok: true, version: pkg.version }));

  // --- Projects (no active project required) ---
  app.get('/api/projects/active', (req, res) => res.json({ project: project.getActive() }));
  app.get('/api/projects/recent', (req, res) => res.json({ projects: project.listRecent() }));

  app.post('/api/projects/new', wrap((req, res) => {
    const { baseDir, name } = req.body || {};
    if (!baseDir || !String(baseDir).trim()) {
      return err(res, 'INVALID_IMAGE_FORMAT', 400, 'A base folder is required.');
    }
    if (project.isProject(baseDir)) {
      return err(res, 'WRITE_LOCK_FAILED', 409,
        'That folder already contains a Smart Gallery project — open it instead.', { path: baseDir });
    }
    try {
      const active = project.createProject({ baseDir, name });
      res.json({ ok: true, project: active });
    } catch (e) {
      return err(res, e.errorCode || 'INTERNAL_ERROR', 400, e.message, e.details);
    }
  }));

  app.post('/api/projects/open', wrap((req, res) => {
    const { baseDir } = req.body || {};
    try {
      const active = project.openProject(baseDir);
      res.json({ ok: true, project: active });
    } catch (e) {
      return err(res, e.errorCode || 'INTERNAL_ERROR', e.errorCode === 'PATH_NOT_FOUND' ? 404 : 400, e.message, e.details);
    }
  }));

  // --- One-click demo: open/create a project and import the bundled library ---
  app.post('/api/projects/demo', wrap((req, res) => {
    const demoSrc = path.join(config.paths.root, 'demo-photos');
    if (!fs.existsSync(demoSrc)) {
      return err(res, 'PATH_NOT_FOUND', 404, 'Demo library not found on disk. Run "npm run seed" first.');
    }
    const baseDir = path.join(config.paths.cacheDir, 'Demo Library');
    let active;
    try {
      active = project.isProject(baseDir)
        ? project.openProject(baseDir)
        : project.createProject({ baseDir, name: 'Demo Library' });
    } catch (e) {
      return err(res, e.errorCode || 'INTERNAL_ERROR', 400, e.message, e.details);
    }
    const count = getDb().prepare("SELECT COUNT(*) n FROM photos WHERE status='active'").get().n;
    if (count === 0) {
      if (scanState.running) return err(res, 'WRITE_LOCK_FAILED', 409, 'A scan or import is already running');
      const sources = fs.readdirSync(demoSrc)
        .map((d) => path.join(demoSrc, d))
        .filter((p) => { try { return fs.statSync(p).isDirectory(); } catch (_) { return false; } });
      runProgressJob((onProgress) => importer.importFolders({ sources, onProgress })).catch(() => {});
      return res.json({ ok: true, project: active, importing: true });
    }
    res.json({ ok: true, project: active, importing: false });
  }));

  // --- Host folder browser (no active project required) — backs the in-app
  //     New/Open project folder picker so path entry is never a typed prompt. ---
  app.get('/api/fs/list', wrap((req, res) => {
    try {
      res.json(fsbrowse.list(req.query.path));
    } catch (e) {
      const status = e.fsCode === 'EACCES' ? 403 : 404;
      return err(res, 'PATH_NOT_FOUND', status, e.message || 'Cannot open that folder', { path: req.query.path || null });
    }
  }));

  app.post('/api/fs/mkdir', wrap((req, res) => {
    const { parent, name } = req.body || {};
    try {
      res.json({ ok: true, ...fsbrowse.makeDir(parent, name) });
    } catch (e) {
      return err(res, 'INVALID_IMAGE_FORMAT', 400, e.message || 'Could not create that folder');
    }
  }));

  // --- Guard: everything below requires an open project ---
  app.use('/api', (req, res, next) => {
    if (project.getActive()) return next();
    return err(res, 'NO_ACTIVE_PROJECT', 409, 'No project is open. Create or open a project first.');
  });

  // --- Stats ---
  app.get('/api/stats', wrap((req, res) => res.json(queries.stats())));

  // --- Timeline (keyset pagination) ---
  app.get('/api/timeline', wrap((req, res) => res.json(queries.timeline(req.query))));

  // --- Rollup summaries ---
  app.get('/api/rollups', wrap((req, res) => {
    const type = req.query.type || 'year';
    if (!['decade', 'year', 'month'].includes(type)) {
      return err(res, 'INVALID_IMAGE_FORMAT', 400, `Unknown rollup type: ${type}`);
    }
    res.json({ type, rollups: queries.rollups(type) });
  }));

  // --- Photo detail ---
  app.get('/api/photos/:id', wrap((req, res) => {
    const photo = queries.photoDetail(Number(req.params.id));
    if (!photo) return err(res, 'PATH_NOT_FOUND', 404, 'Photo not found');
    res.json(photo);
  }));

  // --- Thumbnails ---
  app.get('/api/thumb/:id', wrap(async (req, res) => {
    const size = (req.query.size || 'MICRO').toUpperCase();
    const file = await thumbnails.resolveThumbnail(Number(req.params.id), size);
    if (!file || !fs.existsSync(file)) return err(res, 'PATH_NOT_FOUND', 404, 'Thumbnail unavailable');
    res.set('Cache-Control', 'public, max-age=86400');
    res.type('image/jpeg').sendFile(file);
  }));

  // --- Original image bytes ---
  app.get('/api/original/:id', wrap((req, res) => {
    const db = getDb();
    const photo = db.prepare('SELECT file_path, format FROM photos WHERE id = ?').get(Number(req.params.id));
    if (!photo) return err(res, 'PATH_NOT_FOUND', 404, 'Photo not found');
    if (!fs.existsSync(photo.file_path)) {
      return err(res, 'PATH_NOT_FOUND', 404, 'Original file is missing on disk', { path: photo.file_path });
    }
    res.type(MIME['.' + photo.format] || 'application/octet-stream');
    res.set('Cache-Control', 'public, max-age=86400');
    res.sendFile(photo.file_path);
  }));

  // --- Tag recommendations (weighted spatial/temporal/folder) ---
  app.get('/api/photos/:id/recommendations', wrap((req, res) => {
    res.json({ recommendations: recommend(Number(req.params.id)) });
  }));

  // --- Add a tag (optionally writing back to the file header) ---
  app.post('/api/photos/:id/tags', wrap((req, res) => {
    const db = getDb();
    const id = Number(req.params.id);
    const name = ((req.body && req.body.name) || '').trim().toLowerCase();
    const writeback = !!(req.body && req.body.writeback);
    if (!name) return err(res, 'INVALID_IMAGE_FORMAT', 400, 'Tag name is required');

    const photo = db.prepare('SELECT * FROM photos WHERE id = ?').get(id);
    if (!photo) return err(res, 'PATH_NOT_FOUND', 404, 'Photo not found');

    const canWriteBack = config.formats.WRITEBACK.includes('.' + (photo.format || '').toLowerCase());
    if (writeback && !canWriteBack) {
      return err(res, 'INVALID_IMAGE_FORMAT', 400,
        'Tag write-back to the file header is only supported for JPEG in this build. Tags for PNG, WebP, HEIC and RAW are stored in the database index only.',
        { format: photo.format });
    }

    // DB index (always)
    const addTag = db.transaction(() => {
      db.prepare("INSERT INTO tags (name, type) VALUES (?, 'manual') ON CONFLICT(name) DO NOTHING").run(name);
      const tag = db.prepare('SELECT id FROM tags WHERE name = ?').get(name);
      db.prepare('INSERT OR IGNORE INTO photo_tags (photo_id, tag_id) VALUES (?, ?)').run(id, tag.id);
      return tag.id;
    });
    addTag();

    let wroteBack = false;
    if (writeback) {
      const allTags = db.prepare('SELECT t.name FROM tags t JOIN photo_tags pt ON pt.tag_id = t.id WHERE pt.photo_id = ? ORDER BY t.name').all(id).map((r) => r.name);
      try {
        const stats = writeTagsToJpeg(photo.file_path, allTags);
        // Sync DB mtime/size so the scanner does not flag this as an external edit.
        db.prepare('UPDATE photos SET file_size = ?, mtime = ? WHERE id = ?').run(stats.file_size, stats.mtime, id);
        wroteBack = true;
      } catch (e) {
        return err(res, e.errorCode || 'INTERNAL_ERROR', e.errorCode === 'WRITE_LOCK_FAILED' ? 409 : 400, e.message, e.details);
      }
    }
    res.json({ ok: true, wroteBack, photo: queries.photoDetail(id) });
  }));

  // --- Remove a tag (database index only) ---
  app.delete('/api/photos/:id/tags/:tagId', wrap((req, res) => {
    const db = getDb();
    db.prepare('DELETE FROM photo_tags WHERE photo_id = ? AND tag_id = ?')
      .run(Number(req.params.id), Number(req.params.tagId));
    res.json({ ok: true, photo: queries.photoDetail(Number(req.params.id)) });
  }));

  // --- Geotagged photos for the map (filter-aware) ---
  app.get('/api/geo', wrap((req, res) => {
    const db = getDb();
    const { buildFilters } = queries;
    const { where, params } = buildFilters(req.query);
    const rows = db.prepare(
      `SELECT id, file_name, date_taken, latitude, longitude, country_code, camera_model ` +
      `FROM photos WHERE ${where} AND latitude IS NOT NULL ORDER BY date_taken ASC`
    ).all(params);
    res.json({ photos: rows });
  }));

  // --- Journey tracks ---
  app.get('/api/journeys', wrap((req, res) => res.json(buildJourneys(req.query))));

  // --- Moments timeline: trip/period segments + a single segment's photos ---
  // ?withPhotos=1 inlines each segment's photos for the continuous "whole" view.
  app.get('/api/segments', wrap((req, res) => {
    if (req.query.withPhotos) return res.json(segments.buildSegments(req.query));
    res.json(segments.listSegments(req.query));
  }));

  app.get('/api/segments/photos', wrap((req, res) => {
    const id = req.query.id;
    if (!id) return err(res, 'INVALID_IMAGE_FORMAT', 400, 'A segment id is required');
    const photos = segments.segmentPhotos(req.query, id);
    if (!photos) return err(res, 'PATH_NOT_FOUND', 404, 'Segment not found');
    res.json({ id, photos });
  }));

  // --- Spatial clusters (DBSCAN, stable IDs) ---
  // POST, not GET: computing clusters persists stable IDs (insert/update/delete in
  // clusters + photo_clusters), so this is a mutating, non-idempotent operation.
  app.post('/api/clusters', wrap((req, res) => {
    const body = req.body || {};
    const radius = body.radius || config.spatial.SPATIAL_CLUSTER_RADIUS_DEFAULT_METERS;
    res.json(clustering.computeSpatialClusters(radius, body));
  }));

  app.post('/api/clusters/:id/name', wrap((req, res) => {
    const db = getDb();
    const name = (req.body && req.body.name || '').trim();
    if (!name) return err(res, 'INVALID_IMAGE_FORMAT', 400, 'Name is required');
    const info = db.prepare('UPDATE clusters SET name = ?, custom_named = 1 WHERE id = ?')
      .run(name, Number(req.params.id));
    if (info.changes === 0) return err(res, 'PATH_NOT_FOUND', 404, 'Cluster not found');
    res.json({ ok: true, id: Number(req.params.id), name });
  }));

  // --- Keyword intersection itemsets (Apriori) ---
  app.get('/api/clusters/words', wrap((req, res) => res.json(clustering.wordItemsets(req.query))));

  // --- Directories ---
  app.get('/api/directories', wrap((req, res) => {
    const db = getDb();
    res.json(db.prepare('SELECT * FROM directories ORDER BY id').all());
  }));

  // --- Re-scan / refresh the active project's base folder (picks up external edits) ---
  app.post('/api/scan', wrap(async (req, res) => {
    const active = project.getActive();
    const target = active.baseDir;
    if (!fs.existsSync(target)) {
      return err(res, 'PATH_NOT_FOUND', 404, `Project folder does not exist: ${target}`, { path: target });
    }
    if (scanState.running) return err(res, 'WRITE_LOCK_FAILED', 409, 'A scan is already running');
    runScan(target).catch(() => { /* surfaced via SSE */ });
    res.json({ started: true, path: target });
  }));

  // --- Import: copy folders/files into the project, then scan (shared SSE) ---
  app.post('/api/import/folders', wrap((req, res) => {
    const sources = (req.body && req.body.sources) || [];
    if (!Array.isArray(sources) || sources.length === 0) {
      return err(res, 'INVALID_IMAGE_FORMAT', 400, 'Provide one or more source folders.');
    }
    if (scanState.running) return err(res, 'WRITE_LOCK_FAILED', 409, 'A scan or import is already running');
    runProgressJob((onProgress) => importer.importFolders({ sources, onProgress })).catch(() => {});
    res.json({ started: true, sources });
  }));

  app.post('/api/import/files', wrap((req, res) => {
    const files = (req.body && req.body.files) || [];
    const subdir = (req.body && req.body.subdir) || 'Imported';
    if (!Array.isArray(files) || files.length === 0) {
      return err(res, 'INVALID_IMAGE_FORMAT', 400, 'Provide one or more image files.');
    }
    if (scanState.running) return err(res, 'WRITE_LOCK_FAILED', 409, 'A scan or import is already running');
    runProgressJob((onProgress) => importer.importFiles({ files, subdir, onProgress })).catch(() => {});
    res.json({ started: true, count: files.length });
  }));

  // --- Calendar drill-down (Date tab) ---
  app.get('/api/calendar', wrap((req, res) => {
    res.json(queries.calendar({ year: req.query.year, month: req.query.month }));
  }));

  app.get('/api/scan/status', (req, res) => res.json(scanState));

  app.get('/api/scan/stream', (req, res) => {
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.flushHeaders();
    res.write(`data: ${JSON.stringify({ phase: 'connected', scanState })}\n\n`);
    const onProgress = (evt) => res.write(`data: ${JSON.stringify(evt)}\n\n`);
    scanBus.on('progress', onProgress);
    const keepAlive = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => {
      clearInterval(keepAlive);
      scanBus.off('progress', onProgress);
    });
  });

  // --- MP4 export (Phase 4) ---
  app.post('/api/export/mp4', wrap(async (req, res) => {
    if (exportState.running) return err(res, 'WRITE_LOCK_FAILED', 409, 'An export is already running');
    const body = req.body || {};
    const secondsPerPhoto = Math.min(10, Math.max(0.5, Number(body.secondsPerPhoto) || 2.5));
    const filters = body.filters || {};
    runExport({ filters, secondsPerPhoto }).catch(() => { /* surfaced via SSE */ });
    res.json({ started: true });
  }));

  app.get('/api/export/status', (req, res) => res.json(exportState));

  app.get('/api/export/stream', (req, res) => {
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.flushHeaders();
    res.write(`data: ${JSON.stringify({ phase: 'connected', exportState })}\n\n`);
    const onProgress = (evt) => res.write(`data: ${JSON.stringify(evt)}\n\n`);
    exportBus.on('progress', onProgress);
    const keepAlive = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => {
      clearInterval(keepAlive);
      exportBus.off('progress', onProgress);
    });
  });

  app.get('/api/export/download', (req, res) => {
    const file = path.join(runtimePaths.paths().cacheDir, 'export.mp4');
    if (!fs.existsSync(file)) return err(res, 'PATH_NOT_FOUND', 404, 'No export available yet');
    res.set('Content-Disposition', 'attachment; filename="journey.mp4"');
    res.type('video/mp4').sendFile(file);
  });

  // SPA fallback
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(pub, 'index.html'));
  });

  // Structured error handler
  app.use((e, req, res, _next) => {
    err(res, 'INTERNAL_ERROR', 500, e.message || 'Unexpected error');
  });

  return app;
}

module.exports = { createApp, runScan, runProgressJob, scanBus, runExport, exportBus };
