-- Smart Gallery Timeline schema. Mirrors plan/architecture.md Section 3.
-- All tables are created IF NOT EXISTS so this doubles as an idempotent migration.

CREATE TABLE IF NOT EXISTS directories (
  id              INTEGER PRIMARY KEY,
  path            TEXT UNIQUE NOT NULL,
  status          TEXT NOT NULL DEFAULT 'idle',      -- 'scanning' | 'idle' | 'error'
  last_scanned_at TEXT
);

CREATE TABLE IF NOT EXISTS photos (
  id            INTEGER PRIMARY KEY,
  directory_id  INTEGER NOT NULL REFERENCES directories(id) ON DELETE CASCADE,
  file_path     TEXT UNIQUE NOT NULL,
  file_name     TEXT NOT NULL,
  folder_name   TEXT,                                 -- immediate parent folder (for folder-keyword clustering)
  file_size     INTEGER NOT NULL,
  mtime         INTEGER NOT NULL,
  content_hash  TEXT,                                 -- SHA-256, metadata-invariant where supported
  format        TEXT,                                 -- normalized lowercase extension, e.g. 'jpg'
  writable      INTEGER NOT NULL DEFAULT 0,           -- 1 if EXIF write-back is supported
  date_taken    TEXT,                                 -- UTC normalized ISO timestamp
  tz_offset     TEXT,                                 -- e.g. '+02:00'
  country_code  TEXT,                                 -- ISO 2-letter, resolved offline at scan
  latitude      REAL,
  longitude     REAL,
  altitude      REAL,
  camera_make   TEXT,
  camera_model  TEXT,
  orientation   INTEGER DEFAULT 1,
  width         INTEGER,
  height        INTEGER,
  status        TEXT NOT NULL DEFAULT 'active'        -- 'active' | 'missing'
);

CREATE TABLE IF NOT EXISTS tags (
  id   INTEGER PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,                          -- normalized lowercase
  type TEXT NOT NULL DEFAULT 'manual'                 -- 'manual' | 'automatic'
);

CREATE TABLE IF NOT EXISTS photo_tags (
  photo_id INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
  tag_id   INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (photo_id, tag_id)
);

CREATE TABLE IF NOT EXISTS thumbnail_cache (
  photo_id         INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
  size_type        TEXT NOT NULL,                     -- 'MICRO' | 'PREVIEW'
  file_path        TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  last_accessed_at TEXT NOT NULL,
  PRIMARY KEY (photo_id, size_type)
);

CREATE TABLE IF NOT EXISTS clusters (
  id               INTEGER PRIMARY KEY,
  name             TEXT,
  type             TEXT NOT NULL,                     -- 'spatial' | 'temporal' | 'semantic'
  radius_meters    REAL,
  center_latitude  REAL,
  center_longitude REAL,
  custom_named     INTEGER NOT NULL DEFAULT 0         -- 1 if user renamed (preserved across recompute)
);

CREATE TABLE IF NOT EXISTS photo_clusters (
  photo_id   INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
  cluster_id INTEGER NOT NULL REFERENCES clusters(id) ON DELETE CASCADE,
  PRIMARY KEY (photo_id, cluster_id)
);

CREATE TABLE IF NOT EXISTS timeline_rollups (
  id                   INTEGER PRIMARY KEY,
  period_type          TEXT NOT NULL,                 -- 'decade' | 'year' | 'month'
  period_key           TEXT NOT NULL,                 -- '2020s' | '2026' | '2026-06'
  photo_count          INTEGER NOT NULL DEFAULT 0,
  countries_list       TEXT NOT NULL DEFAULT '[]',    -- JSON array of ISO codes
  camera_models_counts TEXT NOT NULL DEFAULT '{}'     -- JSON dict model -> count
);

-- Indexes (plan/architecture.md Section 3, "Database Index Definitions")
CREATE UNIQUE INDEX IF NOT EXISTS idx_photos_file_path     ON photos(file_path);
CREATE INDEX        IF NOT EXISTS idx_photos_content_hash  ON photos(content_hash);
CREATE INDEX        IF NOT EXISTS idx_photos_timeline_keyset ON photos(date_taken DESC, id DESC);
CREATE INDEX        IF NOT EXISTS idx_photos_coords        ON photos(latitude, longitude) WHERE latitude IS NOT NULL;
CREATE INDEX        IF NOT EXISTS idx_photo_tags_photo     ON photo_tags(photo_id);
CREATE INDEX        IF NOT EXISTS idx_photo_tags_tag       ON photo_tags(tag_id);
CREATE INDEX        IF NOT EXISTS idx_thumbnails_photo     ON thumbnail_cache(photo_id);
CREATE INDEX        IF NOT EXISTS idx_thumbnails_lru       ON thumbnail_cache(last_accessed_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_rollups_key          ON timeline_rollups(period_type, period_key);
