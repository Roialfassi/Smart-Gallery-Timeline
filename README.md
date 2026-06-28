# Smart Gallery Timeline

A local-first, chronological photo catalog organized into **projects**, with a calendar
date browser, maps, journeys, spatial clustering, safe metadata tagging, and a journey
slideshow + MP4 exporter. No cloud, no build step — a Node + Express backend and a
vanilla-JS frontend over a SQLite catalog.

## Quick start

```bash
npm install          # native deps: better-sqlite3, sharp, ffmpeg-static
npm run seed         # generate 56 demo photos across 5 trips (Paris, Rome, Tokyo, California, London)
npm start            # serve http://127.0.0.1:4173
```

Open **http://127.0.0.1:4173**. You'll land on the **project launcher** — click
**Try the demo library** for a one-click tour, or **New project** to start your own and
**＋ Import photos** to copy folders/files into it. The five tabs are **Date · Map ·
Timeline · Cluster · Slideshow**.

> First `npm install` compiles native modules and downloads an ffmpeg binary; allow a minute.

> **Network use:** your photos, catalog, and all processing stay on your machine, and the
> reverse-geocoder is fully offline. The **map views are the one exception** — base map
> tiles are fetched from a public tile server (ArcGIS) at runtime, so Map, Slideshow, and
> the in-photo mini-map render blank tiles when you're offline. Leaflet itself is vendored
> under `public/vendor/`, so the app shell and every non-map view work with no network.

## Projects

A **project is a folder.** It holds the photos you import plus a `.smartgallery/`
subfolder containing that project's own SQLite catalog + thumbnails, so a project is
self-contained and portable — copy the folder and the catalog goes with it.

- **New / Open** a project from the launcher (native folder pickers in the desktop app;
  typed paths in a plain browser). The most recent project re-opens automatically on launch.
- **Import** copies the chosen folder(s)/file(s) into the project's base folder, then
  indexes them (incremental scan → thumbnails → rollups). **⟳ Refresh** re-scans the base
  folder to pick up external edits.
- **Date tab**: a calendar drill-down — pick a year → month → day to jump straight to a
  day's photos. **Timeline** remains the continuous infinite-scroll grid.

## Desktop app / Windows installer

The app also ships as a installable Windows desktop application (Electron shell around
the same server + UI). To build the installer:

```bash
npm install
npm run seed        # bundle the demo library into the installer (optional)
npm run dist        # -> dist-installer/Smart Gallery Timeline Setup <ver>.exe
```

`npm run dist` produces a per-user NSIS installer (no admin required) that creates Start-menu
and desktop shortcuts and registers an uninstaller. Running the installed app launches a
native window with the project launcher; the catalog engine runs in-process on a random
loopback port. Each project's database/thumbnails live in its own base folder under
`.smartgallery/`, while the recent-projects registry lives under
`%AppData%\smart-gallery-timeline\cache\`. Click **Try the demo library** for a one-click
demo project, or **New project** to pick your own base folder.

- `npm run pack` builds just the unpacked app under `dist-installer/win-unpacked/` (no installer).
- `npm run electron` runs the desktop shell against your dev catalog without packaging.
- The build auto-applies a winCodeSign cache workaround (see `scripts/build-installer.js`) so
  it succeeds on a stock Windows user account without Developer Mode or admin rights.

## What it does (by phase)

### Phase 1 — Core catalog engine
- **Metadata-invariant content hashing** — a JPEG/PNG/WebP keeps its identity even after
  its EXIF header is rewritten, so re-tagging never creates a duplicate. (SHA-256 fallback
  for HEIC/RAW.)
- **EXIF extraction** (date, GPS, camera) with UTC normalization and timezone resolution
  (EXIF offset → longitude estimate → host offset).
- **Offline reverse-geocoding** — point-in-polygon against a simplified Natural Earth
  country set bundled in `data/countries.json`. No network calls.
- **Keyset-paginated timeline** grouped by day, with materialized decade/year/month rollups.
- **Incremental scan**: purge → move/change detection (mtime+size skip, hash re-association)
  → rollup rebuild. Two-tier thumbnails (MICRO 150px, PREVIEW 800px) with LRU cache eviction.

### Phase 2 — Map & journeys
- Leaflet map of every geotagged photo, **journey tracks** segmented on >80 km / >8 h breaks.
- **DBSCAN spatial clustering** with a grid spatial index and **stable cluster IDs**
  (Jaccard re-association across recomputes), auto-named from folder keywords, renamable.
- **Apriori keyword-intersection itemsets** surfaced as a clickable tag matrix.

### Phase 3 — Tagging & safe write-back
- Per-photo tag editor with **weighted recommendations**
  `R = 0.5·spatial(200m) + 0.3·temporal(12h) + 0.2·folder`.
- **Atomic EXIF write-back** to JPEG headers: advisory `.lock` → temp write → integrity
  check → atomic rename → DB mtime/size sync. The content hash is preserved, so the
  scanner never mistakes a tag edit for a new file. Write-back is JPEG-only in this build;
  PNG/WebP/HEIC/RAW tags stay in the DB index only.

### Phase 4 — Slideshow & MP4 export
- **In-app slideshow** that crossfades through geotagged photos while the map glide-pans
  to each location.
- **MP4 exporter** — composes 1280×720 frames (photo pane + journey-track panel) with
  `sharp`, encodes H.264 via bundled `ffmpeg-static`, streamed progress over SSE, then a
  downloadable `journey.mp4`. Optional background-music mixing.

## Architecture

```
src/
  config.js              centralized tunables (radii, weights, thresholds, ports)
  runtime-paths.js       active project's writable paths (DB/thumbnails), switchable at runtime
  db/                    schema.sql + better-sqlite3 (WAL) wrapper (opens the active project DB)
  services/
    project.js           project lifecycle: new/open/active + recent registry
    importer.js          copy folders/files into the project base, then scan
    hashing.js           metadata-invariant content hashing
    metadata.js          EXIF + dimensions + tz normalization
    geocode.js           offline point-in-polygon country lookup
    thumbnails.js        sharp pipeline + LRU eviction
    scanner.js           incremental scan orchestration
    rollups.js           decade/year/month materialization
    spatial.js           grid index, DBSCAN, haversine
    journeys.js          track segmentation
    clustering.js        stable clusters + Apriori itemsets
    keywords.js          folder-name keyword extraction
    recommend.js         weighted tag recommendation
    exifwriter.js        atomic JPEG header write-back
    exportvideo.js       frame composition + ffmpeg encoding
  api/
    queries.js           keyset pagination, filters, calendar, stats
    server.js            Express routes + SSE buses (scan/import, export) + project guard
  index.js               entrypoint (auto-opens the most recent project)
electron/                desktop shell: main.js (+ native pickers) + preload.js
public/                  vanilla-JS SPA (launcher, date calendar, timeline, map, clusters, slideshow)
scripts/                 seed-demo.js, scan-cli.js, build-countries.js,
                         build-installer.js, rebuild-native.js (ABI switch)
```

## Scripts

| Command | Action |
|---|---|
| `npm start` | Run the server on `127.0.0.1:4173`. |
| `npm run seed` | Regenerate the demo photo library. |
| `npm run scan -- <path>` | Scan a folder from the CLI. |

## Configuration

All tunables live in `src/config.js` — cluster radii, journey break thresholds,
recommendation weights/threshold, thumbnail sizes/qualities, stopwords, server host/port.
Each project stores its SQLite DB + thumbnails under its own `<base>/.smartgallery/`
(`gallery.db`, `thumbnails/`); the recent-projects registry is `cache/projects.json`.

> **Native module ABI:** Electron 33 and Node 20 use different ABIs for `better-sqlite3`.
> `npm start`/`scan` and `npm run electron`/`pack`/`dist` each run `scripts/rebuild-native.js`
> first to flip the binary to the right ABI (a no-op once built, tracked by a marker file).
