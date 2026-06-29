'use strict';

const path = require('path');
const os = require('os');

// ROOT points at bundled, read-only resources (src/public/data/demo-photos).
// CACHE_DIR holds the writable SQLite DB + thumbnails. When packaged (e.g. inside
// an Electron installer under Program Files), the Electron main process sets
// SGT_CACHE_DIR to a writable per-user location; in dev both default to the repo.
const ROOT = process.env.SGT_RESOURCES_DIR
  ? path.resolve(process.env.SGT_RESOURCES_DIR)
  : path.resolve(__dirname, '..');
const CACHE_DIR = process.env.SGT_CACHE_DIR
  ? path.resolve(process.env.SGT_CACHE_DIR)
  : path.join(ROOT, 'cache');

/**
 * Centralized configuration parameters.
 * Mirrors plan/architecture.md Section 2 ("Centralized Configuration Parameters").
 * Every subsystem references this single block — do not hard-code these values elsewhere.
 */
const config = {
  paths: {
    root: ROOT,
    cacheDir: CACHE_DIR,
    dbFile: path.join(CACHE_DIR, 'gallery.db'),
    thumbnailDir: path.join(CACHE_DIR, 'thumbnails'),
    tileCacheDir: path.join(CACHE_DIR, 'tiles'),
    dataDir: path.join(ROOT, 'data'),
  },

  spatial: {
    SPATIAL_CLUSTER_RADIUS_DEFAULT_METERS: 300,
    SPATIAL_CLUSTER_RADIUS_MIN_METERS: 50,
    SPATIAL_CLUSTER_RADIUS_MAX_METERS: 50000,
    TAG_SUGGESTION_RADIUS_METERS: 200,
    JOURNEY_SEGMENT_MAX_DISTANCE_KM: 80,
    JOURNEY_SEGMENT_MAX_TIME_HOURS: 8,
  },

  // Moments timeline segmentation (trip detection + everyday period bucketing).
  timeline: {
    TRIP_GAP_DAYS: 3,            // a gap larger than this breaks a trip into two
    TRIP_MIN_PHOTOS: 6,          // a run needs at least this many photos to be a trip
    TRIP_MIN_HOURS: 6,           // ...and must span at least this long
    TRIP_MIN_DISTANCE_KM: 150,   // distance from home centroid that counts as "away"
    TRIP_STOP_RADIUS_KM: 25,     // a new stop ("place") starts beyond this from the stop centroid
    PERIOD_WEEKLY_MIN_PHOTOS: 30, // a non-trip month with >= this many photos splits into weeks
  },

  scanning: {
    THUMBNAIL_MICRO_WIDTH_PX: 150,
    THUMBNAIL_PREVIEW_WIDTH_PX: 800,
    THUMBNAIL_MICRO_QUALITY: 75,
    THUMBNAIL_PREVIEW_QUALITY: 80,
    DUPLICATE_STRATEGY: 'index_all_reference_hash',
    IGNORE_EXTENSIONS: ['.tmp', '.lock', '.bak'],
    // How many photos the ingest pipeline hashes/decodes/thumbnails in parallel.
    // DB writes stay serialized; this only fans out the file I/O + sharp/exifr
    // work onto the libuv threadpool. Clamped to [2, 8] around the core count so
    // a laptop doesn't thrash and a big box still saturates.
    SCAN_CONCURRENCY: Math.max(2, Math.min(8, (os.cpus() || []).length || 4)),
  },

  tagging: {
    MIN_SUPPORT_TAG_INTERSECTION: 0.05,
    STOPWORDS: ['dcim', 'canon', 'apple', 'camera', 'photo', 'image', 'dsc', 'img'],
    RECOMMENDATION_THRESHOLD: 0.15,
    TEMPORAL_WINDOW_HOURS: 12,
    WEIGHT_SPATIAL: 0.5,
    WEIGHT_TEMPORAL: 0.3,
    WEIGHT_FOLDER: 0.2,
  },

  clustering: {
    JACCARD_STABLE_THRESHOLD: 0.5,
    CENTROID_SHIFT_STABLE_METERS: 100,
  },

  // Unified spatiotemporal grouping for the zoomable Timeline view. The catalog
  // is walked chronologically and split wherever the gap to the next photo is
  // "too big" for the current granularity. A single slider scales BOTH the time
  // and distance thresholds together (tau = max time gap, delta = max location
  // jump); the named TIERS are the anchor stops the slider snaps its label to,
  // and intermediate positions log-interpolate between neighbouring anchors.
  // Wider scale => bigger thresholds => fewer/larger groups (monotonic: zooming
  // only ever merges or splits, never reshuffles). In 'time' mode delta is
  // ignored; in 'spacetime' mode a break fires when EITHER threshold is crossed.
  grouping: {
    TIERS: [
      { name: 'Event', tau: 2 * 3600e3, delta: 1000 },          // a few hours / one place
      { name: 'Trip', tau: 3 * 24 * 3600e3, delta: 50000 },     // days away / a city
      { name: 'Month', tau: 12 * 24 * 3600e3, delta: 400000 },  // a month / a region
      { name: 'Year', tau: 90 * 24 * 3600e3, delta: 3000000 },  // a year / a country-hop
    ],
    STEPS: 24,           // slider resolution between the first and last tier
    DEFAULT_STEP: 8,     // initial position (~"Trip")
  },

  cache: {
    THUMBNAIL_MAX_BYTES: 1024 * 1024 * 1024, // 1GB
    TILE_MAX_BYTES: 500 * 1024 * 1024, // 500MB
  },

  // Supported format classes. WRITABLE formats use metadata-invariant (structural)
  // hashing so an EXIF rewrite never changes their content hash; READ_ONLY formats
  // use full-file SHA-256. WRITEBACK is the (narrower) set whose tags can actually
  // be written back into the file header — JPEG only in this build. Tags for every
  // other format are kept in the database index. Keep WRITEBACK ⊆ WRITABLE.
  formats: {
    WRITABLE: ['.jpg', '.jpeg', '.png', '.webp'],
    READ_ONLY: ['.heic', '.heif', '.cr2', '.cr3', '.nef', '.arw', '.dng', '.raf', '.orf', '.rw2'],
    WRITEBACK: ['.jpg', '.jpeg'],
    get ALL_IMAGES() {
      return [...this.WRITABLE, ...this.READ_ONLY];
    },
  },

  server: {
    PORT: process.env.PORT ? Number(process.env.PORT) : 4173,
    HOST: process.env.HOST || '127.0.0.1',
    PAGE_SIZE: 120, // default keyset page size for the timeline grid
  },

  system: {
    tzOffsetMinutes: -new Date().getTimezoneOffset(),
    hostname: os.hostname(),
  },
};

module.exports = config;
