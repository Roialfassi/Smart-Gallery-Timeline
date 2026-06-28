# Resolved Planning Decisions & Configurations

This document logs the final technical decisions, scope constraints, configurations, and milestone plans for the **Smart Gallery Timeline** application.

---

## 1. Project Phases & Milestones
To manage risk and establish clear development boundaries, we have structured the implementation into four phases:
* **Phase 1 (MVP)**: Incremental directory scanning (purge run first, followed by move and change detection), metadata caching (caching country codes and timeline rollups), thumbnailing (LRU access-timestamp updates), and timeline grid (keyset cursor pagination).
* **Phase 2 (GIS & GIS Clustering)**: Leaflet map integrations, R-Tree spatial indexing (in-memory lifecycle), timezone offset calculation, and DBSCAN clustering with Jaccard overlap re-association and radius parameter tracking.
* **Phase 3 (Tagging & Safety)**: Detail tag editor, weighted tag suggestion formula, and OS-level Advisory locking atomic file write-back safety.
* **Phase 4 (Presentation)**: In-app slideshow syncing and the FFmpeg MP4 export engine (isolated as a high-risk spike).

---

## 2. Technical Decisions

### A. Technology-Agnostic Boundaries
* **Decision**: All architectural boundaries, schemas, and UI/Service APIs are written in a technology-agnostic layout.
* **Reasoning**: Ensures portability to other platforms (web, mobile, or alternative desktop wrappers) without lock-in.

### B. Formatting Matrix & UI Restrictions
* **Standard Images**: JPEG, PNG, WebP fully supported for reading, indexing, thumbnailing, and EXIF/metadata writing.
* **Modern Mobile & RAW**: HEIC/HEIF and RAW formats supported for reading, indexing, and thumbnailing (via JPEG preview extraction). Metadata modifications are saved to the **Database Cache Only** (no write-back to physical HEIC/RAW files). The UI tagging panel disables the "Write back to physical files" option for these formats.

### C. Map Tiles & Offline Capabilities
* **Online Mode**: Leaflet uses public OSM map tiles or Mapbox API.
* **Offline Cache**: Enables localized caching of map tiles in an LRU database cache directory (up to 500MB).
* **Country Stat**: Calculated using an offline country boundary GeoJSON polygon dataset (~250KB) and point-in-polygon checks. Resolved once during scan ingest and cached in the `country_code` database column.

### D. Timezone & DST Calculations
* Timezone offsets are resolved by searching for EXIF `OffsetTimeOriginal` (`0x9011`).
* If missing, the engine checks GPS coordinates against an offline geocoding coordinate-to-timezone boundaries map. If coordinate metadata is absent, it falls back to the host system offset. Lookup utilizes `date_taken` to resolve daylight saving time (DST) shifts.

### E. Atomic Metadata Write Safety & Locking
* Direct EXIF writing must be non-destructive. The service writes to a temporary sibling file (`.tmp`), validates the output file header, and swaps the file nodes atomically.
* Updates database `mtime` and `file_size` in the same transaction to avoid triggering duplicate scanning checks.
* Uses system-level advisory locks (`flock`/`LockFileEx`) to prevent collision. Sibling files (`.tmp`, `.lock`, `.bak`) are ignored by the scanning engine.

---

## 3. Algorithmic Constants

* **Journey segments**: Split when distance $> 80\text{ km}$ or time gap $> 8\text{ hours}$.
* **Clustering bounds**: Slider bounds range from $50\text{ meters}$ to $50\text{ kilometers}$. Default radius is $300\text{ meters}$. Uses R-Tree queries for $O(\log n)$ efficiency.
* **Stable IDs**: Matches clusters using Jaccard Index overlap threshold $> 0.5$ or centroid shift $< 100$ meters to preserve user renames. Re-associations are matched strictly within the same `radius_meters` parameter setting.
* **Content Hash**: 
  * *JPEG/PNG/WebP*: Calculated as SHA-256 of the metadata-invariant image data streams (SOS segment for JPEG, IDAT for PNG, VP8 for WebP). Full-file fallback is used if segments are missing or truncated.
  * *HEIC/RAW/Video*: Calculated as a standard **full-file SHA-256 hash** (since these formats are write-restricted).
* **Tag suggestion bounds**: Spatial search checks a radius of $200\text{ meters}$.
* **Min-Support Threshold**: Tag intersection charts ignore co-occurrences representing less than 5% (`0.05`) of the active gallery.
* **Recommendation Weights**:
  * Spatial Proximity weight: $0.5$
  * Temporal Proximity weight: $0.3$
  * Folder Proximity weight: $0.2$
