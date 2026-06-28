# Comprehensive Functional Features Specification

This document details the functional specifications, visual states, and logical rules for the **Smart Gallery Timeline** application.

---

## 1. Timeline Grid & Rollup Summaries

The gallery timeline renders photographs in a responsive grid grouped by date and location.

### UI Scopes & Zoom Levels
1. **Decade Scope**: Displays summaries of 10-year intervals (e.g. "2020–2029"). Displays total photos, and camera models.
   * **Country Cache Optimization**: During ingest, the GPS coordinates are geocoded using an offline country boundaries GeoJSON polygon dataset (~250KB) and saved in the `country_code` database column.
   * **Rollup summaries**: Large scale queries for Decade, Year, and Month stats do not run raw `GROUP BY` aggregates on the `photos` table. They read pre-calculated metrics cached in the `timeline_rollups` table.
2. **Year Scope**: Renders 12 months with a 3-photo collage representing major events of that month.
3. **Month Scope**: Bins photos by day. Displays a map preview outlining the geographic bounding box of coordinates for that month.
4. **Day Scope**: Shows a timeline grid grouped by hour. Displays a scroll-slider at the bottom representing hours of the day.
5. **Hour Scope (Lightbox view)**: Full-resolution image render, side panel displaying complete EXIF data, timezone offset, and map coordinates.

### Navigation and Keyset Pagination
Instead of limit/offset pagination, the timeline grid uses **Keyset/Cursor Pagination**:
* Queries request the next page using the cursor tuple `(date_taken, id)`.
* Virtual scrolling dynamically measures screen viewport height and requests chunks of photos matching the cursor index. This prevents UI lagging during rapid scrolling.

---

## 2. Map View, Journey Tracks, & Offline Mode

The map tracks geographical travel movements chronologically.

### Bounding & Journey Segment Trajectories
* Photos with valid coordinates are grouped by day.
* Lines (polylines) connect photos chronologically: `Photo[1] -> Photo[2] -> ... -> Photo[N]`.
* **Segment Breaks**: A path line breaks into a separate segment if:
  * Spatial distance between sequential photos exceeds **80 kilometers** (e.g., flight, fast transit).
  * Temporal gap exceeds **8 hours** (e.g., overnight sleep).
  * This matches the centralized parameters defined in `architecture.md`.

### Map Tiles & Caching (Offline Strategy)
To support offline capability while maintaining privacy (no third-party reverse-geocoding calls):
* **Default Mode**: Online map loading using standard OpenStreetMap (OSM) public CDN or Google Maps.
* **Offline Caching**: If user switches to "Offline Mode", the app queries local cached tiles stored as standard directory structures or as database structures. The app caches loaded tiles on-the-fly inside the local Application Directory Cache up to a maximum size threshold (e.g. 500MB) using an LRU eviction policy.

---

## 3. Spatial & Keyword Clustering Dashboard

Automated grouping dashboards based on location and keywords.

### A. Geo-Spatial Clustering
* Coordinates are clustered using DBSCAN optimized with an R-Tree index.
* **R-Tree Index Lifecycle**: The spatial index is created in memory on application startup from coordinates in `idx_photos_coords` and is incrementally updated as new files are scanned or deleted.
* **Proximity Scale**: A slider lets the user change cluster bounds from **50 meters** to **50 kilometers**. Default radius is **300 meters**.
* **Radius Param Tracking**: Generated clusters are stored in the database with their generating `radius_meters` parameters. During recalculations, Jaccard overlap re-associations are evaluated only against historical clusters generated with matching radius settings.
* Bounding zones are drawn as translucent circles centered on the calculated geographic centroid.

### B. Word Clustering & Intersection Matrix
* **Folder Name Keywords**: Extracts keywords from folders. To prevent garbage words, it:
  * Filters out dates, numbers, and system strings (e.g. `2026-06-27`, `100CANON`, `DCIM`, `IMG_01`).
  * Filters words against a default English and user-defined stopword dictionary (`canon`, `apple`, `dsc`, etc.).
* **Tag Intersection Matrix**: Renders groups of photos sharing multiple keywords using an Apriori association algorithm:
  * Minimum support threshold: **0.05** (only display intersections representing more than 5% of the active gallery).
  * Clicking intersections (e.g. "Nature" + "Forest") shows matching items.

---

## 4. Metadata Tagging & Recommendation Engine

Allows cataloging and metadata writing with safety features.

### Weighted Recommendation Formula
When a photo `P` is selected for tagging, the UI suggests keywords ranked by a weighted relevance score $R(T)$ for each tag $T$ in the database:

$$R(T) = w_{spatial} \cdot S(T) + w_{temporal} \cdot T_{score}(T) + w_{folder} \cdot F(T)$$

Where:
* **Spatial Score** $S(T)$: Count of tag $T$ occurrences in photos within **200 meters** of `P` (via R-Tree and Haversine), divided by total photos in that radius. Weight $w_{spatial} = 0.5$.
* **Temporal Score** $T_{score}(T)$: Count of tag $T$ occurrences in photos taken within **12 hours** of `P`, divided by total photos in that time window. Weight $w_{temporal} = 0.3$.
* **Folder Score** $F(T)$: Binary 1.0/0.0 indicating if tag $T$ is present in other photos within the same folder. Weight $w_{folder} = 0.2$.

Recommendations exceeding a score threshold (e.g. $> 0.15$) are presented as quick-click recommendation chips.

### Dual-Write Tagging UI & Format Restrictions
* Tagging actions provide a checkbox option:
  - `[x] Apply to database index (instant search & clustering)`
  - `[ ] Write back to file headers (EXIF/IPTC tags)`
* **Format Restrictions**:
  * If the active photo selection contains any **HEIC, HEIF, or RAW** formats, the "Write back to file headers" checkbox is disabled (greyed out).
  * A tooltip is displayed: *"Metadata write-back is only supported for JPEG, PNG, and WebP formats. Tags for HEIC and RAW will be cached in the app database only."*
* If file write-back is enabled, the backend applies the atomic temporary-write file system transaction specified in the architecture document.

---

## 5. Live Slideshow & MP4 Creator

Allows viewing and exporting slideshows.

### A. In-App Slideshow Sync
* **Interactive Map Tracking**: As the slideshow advances, the map transitions to the current photo's GPS coordinates using a smooth glide pan animation.
* **Transition Effects**: Crossfade and slide transitions with CSS duration controls.

### B. MP4 Export Panel (Phase 4 Spike)
Due to rendering complexity, the MP4 exporter is a designated development spike:
* **Frame Assembly**: A background canvas draws the photo on the left pane and the Leaflet path track on the right pane.
* **Video Encoding**: Canvas buffers are piped into `ffmpeg` to build H.264 video. Supports conditional mixing of music files when background audio is chosen.

---

## 6. Thumbnail Generation Pipeline

* **Size Tiers**:
  - `MICRO` (150px width, JPG, 75% quality): Used for rapid scrolling timeline grid.
  - `PREVIEW` (800px width, JPG, 80% quality): Used for timeline lightboxes and slideshow previews.
* **Eviction Policy**: Cached thumbnails are saved in the app's cache directory under file hashes. If cache size exceeds 1GB, files are removed using an **Least Recently Used (LRU)** eviction policy based on access timestamps recorded in the `thumbnail_cache.last_accessed_at` database column. This column is updated with a system timestamp query on every thumbnail retrieval request.

---

## 7. Error Handling Contracts

When services fail, operations return standard structured error payloads:

```json
{
  "errorCode": "PERMISSION_DENIED",
  "message": "Cannot read folder: Access to C:/Users/Protected is denied.",
  "details": {
    "path": "C:/Users/Protected",
    "systemCode": "EACCES"
  }
}
```

Standard Error Codes:
* `PATH_NOT_FOUND`: The source directory or photo file does not exist on disk.
* `PERMISSION_DENIED`: System-level file read/write access is restricted.
* `INVALID_IMAGE_FORMAT`: The image bytes are corrupt or the extension is unsupported.
* `WRITE_LOCK_FAILED`: Another thread is writing to the EXIF file.
* `DISK_FULL`: Cannot write temp files or generate thumbnails due to space limits.
