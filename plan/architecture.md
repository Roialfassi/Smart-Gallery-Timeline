# Comprehensive System Architecture (Agnostic Design)

This document specifies the technical design, logical models, algorithms, and protocols for the **Smart Gallery Timeline** application. All boundaries are defined in a **technology-stack and framework agnostic** manner.

---

## 1. Project Phases & Milestones

The project is structured in four sequential phases to manage risk:

```
+------------------------------------------------------------------------+
| PHASE 1: Core Catalog Engine (MVP)                                     |
| - Directory scanning: purge/missing pass executed FIRST                |
| - Ingestion change detection (mtime + size), duplicate index by hash   |
| - EXIF-invariant content hashing (JPEG/PNG/WebP stream; HEIC/RAW full) |
| - Keyset/Cursor paginated timeline grid and virtual scrolling          |
| - Materialized Timeline Rollup summaries for Decade/Year/Month         |
+-----------------------------------+------------------------------------+
                                    |
                                    v
+------------------------------------------------------------------------+
| PHASE 2: Map & Journey Visualization (GIS & R-Tree)                    |
| - Interactive Map Component (Offline tile cache & online fallbacks)    |
| - Bounded offline geocoding (simplified country boundaries)            |
| - In-memory spatial R-Tree index, built at startup and incremental      |
| - DBSCAN Clustering (Stable IDs via fuzzy Jaccard re-association)      |
+-----------------------------------+------------------------------------+
                                    |
                                    v
+------------------------------------------------------------------------+
| PHASE 3: Metadata Tagging & Safety Writeback                           |
| - Tag editor UI, greyed-out settings for unsupported files (HEIC/RAW)  |
| - Recommendation engine (weighted spatial/temporal formula)            |
| - OS-level Advisory locking and atomic file swap writes                |
+-----------------------------------+------------------------------------+
                                    |
                                    v
+------------------------------------------------------------------------+
| PHASE 4: Presentations & Media Exports (Slideshow & Video)             |
| - Interactive in-app slideshow synced with map panning                 |
| - MP4 Video Exporter Spike (Headless map render, dual audio paths)     |
+------------------------------------------------------------------------+
```

---

## 2. Centralized Configuration Parameters

All subsystems reference this unified global configuration block:

```json
{
  "spatial": {
    "SPATIAL_CLUSTER_RADIUS_DEFAULT_METERS": 300,
    "SPATIAL_CLUSTER_RADIUS_MIN_METERS": 50,
    "SPATIAL_CLUSTER_RADIUS_MAX_METERS": 50000,
    "TAG_SUGGESTION_RADIUS_METERS": 200,
    "JOURNEY_SEGMENT_MAX_DISTANCE_KM": 80,
    "JOURNEY_SEGMENT_MAX_TIME_HOURS": 8
  },
  "scanning": {
    "THUMBNAIL_MICRO_WIDTH_PX": 150,
    "THUMBNAIL_PREVIEW_WIDTH_PX": 800,
    "THUMBNAIL_COMPRESSION_QUALITY": 0.8,
    "DUPLICATE_STRATEGY": "index_all_reference_hash"
  },
  "tagging": {
    "MIN_SUPPORT_TAG_INTERSECTION": 0.05,
    "STOPWORDS": ["dcim", "canon", "apple", "camera", "photo", "image", "dsc", "img"]
  }
}
```

---

## 3. Database Schema & Index Definitions

### Table Schemas

#### A. Table: `directories`
* `id` (INTEGER, Primary Key)
* `path` (TEXT, Unique): Absolute directory path.
* `status` (TEXT): `'scanning'`, `'idle'`, `'error'`.
* `last_scanned_at` (TIMESTAMP, Nullable)

#### B. Table: `photos`
* `id` (INTEGER, Primary Key)
* `directory_id` (INTEGER, Foreign Key referencing `directories.id`)
* `file_path` (TEXT, Unique): Absolute file path.
* `file_name` (TEXT)
* `file_size` (INTEGER): Bytes.
* `mtime` (INTEGER): Filesystem last modified timestamp.
* `content_hash` (TEXT): SHA-256 metadata-invariant hash.
* `date_taken` (TIMESTAMP): UTC normalized timestamp.
* `tz_offset` (TEXT): Offset string, e.g. `"+02:00"`.
* `country_code` (TEXT, Nullable): ISO 2-letter country code resolved offline during scan.
* `latitude` (REAL, Nullable)
* `longitude` (REAL, Nullable)
* `altitude` (REAL, Nullable)
* `camera_make` (TEXT, Nullable)
* `camera_model` (TEXT, Nullable)
* `orientation` (INTEGER): EXIF orientation value.
* `width` (INTEGER)
* `height` (INTEGER)
* `status` (TEXT): `'active'`, `'missing'`.

#### C. Table: `tags`
* `id` (INTEGER, Primary Key)
* `name` (TEXT, Unique): Normalised lowercase tag.
* `type` (TEXT): `'manual'`, `'automatic'`.

#### D. Table: `photo_tags`
* `photo_id` (INTEGER, Foreign Key referencing `photos.id` ON DELETE CASCADE)
* `tag_id` (INTEGER, Foreign Key referencing `tags.id` ON DELETE CASCADE)
* Primary Key: `(photo_id, tag_id)`

#### E. Table: `thumbnail_cache`
* `photo_id` (INTEGER, Foreign Key referencing `photos.id` ON DELETE CASCADE)
* `size_type` (TEXT): `'MICRO'` or `'PREVIEW'`.
* `file_path` (TEXT): Cached thumbnail file path.
* `created_at` (TIMESTAMP)
* `last_accessed_at` (TIMESTAMP): Updated whenever thumbnail is resolved by the UI (for LRU eviction).
* Primary Key: `(photo_id, size_type)`

#### F. Table: `clusters`
* `id` (INTEGER, Primary Key)
* `name` (TEXT): Custom or auto-generated cluster name.
* `type` (TEXT): `'spatial'`, `'temporal'`, `'semantic'`.
* `radius_meters` (REAL): The slider parameter used to generate this cluster (e.g. 300).
* `center_latitude` (REAL, Nullable)
* `center_longitude` (REAL, Nullable)

#### G. Table: `photo_clusters`
* `photo_id` (INTEGER, Foreign Key referencing `photos.id` ON DELETE CASCADE)
* `cluster_id` (INTEGER, Foreign Key referencing `clusters.id` ON DELETE CASCADE)
* Primary Key: `(photo_id, cluster_id)`

#### H. Table: `timeline_rollups`
Materialized summary aggregates for fast decade/year/month timeline renders.
* `id` (INTEGER, Primary Key)
* `period_type` (TEXT): `'decade'`, `'year'`, `'month'`.
* `period_key` (TEXT): e.g., `'2020s'`, `'2026'`, `'2026-06'`.
* `photo_count` (INTEGER)
* `countries_list` (TEXT): JSON array of unique ISO country codes (e.g., `["FR","IT"]`).
* `camera_models_counts` (TEXT): JSON dictionary tracking camera usage count (e.g., `{"Canon EOS R5": 24, "iPhone 15": 102}`).
* Unique Key: `(period_type, period_key)`

### Database Index Definitions
```sql
CREATE UNIQUE INDEX idx_photos_file_path ON photos(file_path);
CREATE INDEX idx_photos_content_hash ON photos(content_hash);
CREATE INDEX idx_photos_timeline_keyset ON photos(date_taken DESC, id DESC);
CREATE INDEX idx_photos_coords ON photos(latitude, longitude) WHERE latitude IS NOT NULL;
CREATE INDEX idx_photo_tags_photo ON photo_tags(photo_id);
CREATE INDEX idx_photo_tags_tag ON photo_tags(tag_id);
CREATE INDEX idx_thumbnails_photo ON thumbnail_cache(photo_id);
CREATE INDEX idx_thumbnails_lru ON thumbnail_cache(last_accessed_at);
CREATE UNIQUE INDEX idx_rollups_key ON timeline_rollups(period_type, period_key);
```

---

## 4. Ingestion & Incremental Scan Engine

To accurately resolve renames and deletes without duplication, the scan engine enforces this ordering:

### Scanning Phases
1. **File System Discovery**: Collect paths, sizes, and modified times for all files in the directory.
   * **Rule**: Scanner must explicitly ignore `.tmp`, `.lock`, and `.bak` sibling files.
2. **Phase 1: Purge Pass (Run First)**:
   * Query database for all paths registered under the target directory.
   * Compare with current disk files list.
   * Any database path not found on disk is updated: set `status = 'missing'`.
3. **Phase 2: Change & Move Detection (Run Second)**:
   * Loop through files found on disk:
     * **Path exists in DB**: Compare file size and `mtime` against DB. If identical, skip. If changed, re-parse metadata and update.
     * **Path is new to DB**: Calculate the **Metadata-Invariant Hash** (see Section 5).
       * Query database for this hash where `status = 'missing'`.
       * **Match Found (Move/Rename)**: Update the matching database record's `file_path`, `mtime`, and `file_size` with the new file details. Set `status = 'active'`. (Bypasses thumbnail generation).
       * **No Match (New File)**: Process as a fresh file: parse metadata, create database record, and generate thumbnails.
4. **Phase 3: Rollup Update (Run Last)**:
   * When scan finishes, trigger a localized incremental rebuild of affected periods in the `timeline_rollups` table to cache summary metrics.

---

## 5. Metadata-Invariant Content Hashing

To ensure file tagging writes do not invalidate content hashes, we compute hashes that are invariant to EXIF metadata updates:

* **Supported Writable Formats** (JPEG, PNG, WebP):
  - Read image file format markers.
  - Parse and skip metadata segments:
    - **JPEG**: Skip APP segments (`0xFFE0` to `0xFFEF`). Hash only image stream starting from Start of Scan (SOS, `0xFFDA`).
    - **PNG**: Skip chunks `tEXt`, `zTXt`, `iTXt`, and `eXIf`. Hash core data chunks (`IDAT`).
    - **WebP**: Skip chunk headers `EXIF`, `ICCP`, and `XMP`. Hash only core frame chunks (`VP8` or `VP8L`).
  - **Fallback**: If markers are missing, truncated, or parsing fails, fall back to calculating standard SHA-256 on the entire file.
* **Read-Only Formats** (HEIC, RAW, Videos):
  - Hashing is computed as a standard **full-file SHA-256 hash**, as the application never writes metadata back to these files.

---

## 6. Timezone & Country Lookup Pipeline

During Phase 1 metadata extraction:

1. **Timezone Offset**:
   * Read EXIF `OffsetTimeOriginal` (`0x9011`) or `OffsetTime` (`0x9010`).
   * If missing, look up coordinates against a bundled offline timezone polygon boundary dataset (~5-10MB).
   * Query the timezone using the exact `date_taken` to resolve daylight saving time (DST) offsets at that point in history.
   * Store converted UTC in `date_taken` and offset string in `tz_offset`.
2. **Country Code Resolution**:
   * If coordinates are present, resolve them against a bundled simplified country boundary GeoJSON polygon dataset (~250KB) using point-in-polygon (ray-casting) checks.
   * Write the ISO 2-letter country code into `photos.country_code` (e.g. `'FR'`, `'US'`). This caches the geocoding step, preventing runtime overhead.

---

## 7. EXIF Dual-Write Safety Engine

Transactional safety protocol for metadata writes to physical JPEGs, PNGs, and WebPs:

### Protocol Steps
1. **Advisory OS Locking**: Lock the original file using system-level locks (`flock` on Unix, `LockFileEx` on Windows) to prevent racy scanner read conflicts.
2. **Temp Copy Write**: Create a temporary sibling file `photo.jpg.tmp` and write the updated EXIF/IPTC bytes.
3. **Integrity Check**: Read the temp file's binary header to ensure it parses successfully without corruption.
4. **Atomic Node Swap**: Rename `photo.jpg.tmp` to `photo.jpg` using atomic OS file swap calls (`fs.rename` or equivalent).
5. **Database Sync**: Update the DB record's `file_size` and `mtime` within the same transaction to match the newly written file. This prevents the scanner from registering it as an external change.
6. **Release Lock**: Remove advisory lock.

---

## 8. Spatial Clustering Optimizations (R-Tree & Stable IDs)

### A. R-Tree Lifecycle & Bounding Queries
* **Lifecycle**: The spatial R-Tree index is an **in-memory structure built at application startup** by querying all database rows with valid coordinates in `idx_photos_coords`. The R-Tree is kept up-to-date in memory by incrementally inserting new photo nodes during directory scans, and deleting nodes when files are purged.
* **Neighborhood Query**: Bounding coordinates use R-Tree box limits scaling longitude limits by $111320 \cdot \cos(\text{latitude})$. Wraps over $\pm 180^{\circ}$ split search boundaries into dual requests.

### B. Stable Cluster IDs (Fuzzy Re-association)
1. Recomputed clusters ($C_{new}$) are matched against existing database clusters ($C_{old}$) in the DB using Jaccard Overlap Indexing:
   $$J(C_{new}, C_{old}) = \frac{|C_{new} \cap C_{old}|}{|C_{new} \cup C_{old}|}$$
2. Re-association limits matching strictly to clusters created with the same target parameter:
   $$\text{clusters.radius\_meters} (C_{new}) == \text{clusters.radius\_meters} (C_{old})$$
3. If $J(C_{new}, C_{old}) > 0.5$, or if the centroid shift is $< 100$ meters and they share at least one photo, the new cluster inherits the durable surrogate `id` and custom name of $C_{old}$.
