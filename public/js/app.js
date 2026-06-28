'use strict';

/* Smart Gallery Timeline — frontend app (Phase 1: timeline, filters, lightbox, scan). */

const state = {
  view: 'moments',
  filters: { year: null, country: null, camera: null, cluster: null, tagsAll: null },
  filterLabels: {},
  cursor: null,
  loading: false,
  done: false,
  photos: [],          // all loaded photos in order (for lightbox nav)
  byId: new Map(),
  lastDayKey: null,
  lastDayEl: null,
  lbIndex: -1,
};

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
};

// Escape untrusted text (filenames, EXIF fields, folder/tag/cluster names) before
// it is interpolated into any innerHTML template. Declared at the top level of this
// classic script so every view module (loaded after app.js) can use the same `esc`.
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function toast(msg, isErr) {
  let t = $('#toast');
  if (!t) { t = el('div'); t.id = 'toast'; document.body.appendChild(t); }
  t.textContent = msg;
  t.className = isErr ? 'show err' : 'show';
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.className = ''; }, 3000);
}

function fmtDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { weekday: 'short', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}
function fmtTime(iso) {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
}
const dayKey = (iso) => iso.slice(0, 10);

/** Compact span like "Aug 5, 2024", "Aug 5–11, 2024", or "Dec 28, 2024 – Jan 3, 2025". */
function fmtDateRange(startIso, endIso) {
  const s = new Date(startIso); const e = new Date(endIso);
  const full = { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' };
  const md = { month: 'short', day: 'numeric', timeZone: 'UTC' };
  if (startIso.slice(0, 10) === endIso.slice(0, 10)) return s.toLocaleDateString(undefined, full);
  const sameYear = s.getUTCFullYear() === e.getUTCFullYear();
  if (sameYear && s.getUTCMonth() === e.getUTCMonth()) {
    return `${s.toLocaleDateString(undefined, md)}–${e.getUTCDate()}, ${e.getUTCFullYear()}`;
  }
  if (sameYear) {
    return `${s.toLocaleDateString(undefined, md)} – ${e.toLocaleDateString(undefined, md)}, ${e.getUTCFullYear()}`;
  }
  return `${s.toLocaleDateString(undefined, full)} – ${e.toLocaleDateString(undefined, full)}`;
}

/* ----------------------------- Stats & filters ----------------------------- */

async function loadStats() {
  try {
    const s = await API.stats();
    $('#statTotal').textContent = s.total ?? 0;
    $('#statGeo').textContent = s.geotagged ?? 0;
    $('#statCountries').textContent = (s.countries || []).length;

    renderChips('#filterYears', (s.years || []).map((y) => ({ key: y.year, label: y.year, count: y.n })), 'year');
    renderChips('#filterCountries', (s.countries || []).map((c) => ({ key: c.code, label: `${COUNTRY_FLAG(c.code)} ${c.code}`, count: c.n })), 'country');
    renderChips('#filterCameras', (s.cameras || []).map((c) => ({ key: c.model, label: c.model, count: c.n })), 'camera');
    window.__stats = s;
  } catch (e) { /* server may be empty */ }
}

function renderChips(sel, items, dim) {
  const host = $(sel);
  host.innerHTML = '';
  for (const it of items) {
    const c = el('div', 'chip', `<span>${esc(it.label)}</span><span class="count">${it.count}</span>`);
    if (state.filters[dim] === it.key) c.classList.add('active');
    c.addEventListener('click', () => toggleFilter(dim, it.key));
    host.appendChild(c);
  }
}

function toggleFilter(dim, key) {
  state.filters[dim] = state.filters[dim] === key ? null : key;
  reflectFilters();
  if (window.MomentsView) window.MomentsView.invalidate();
  if (window.MapView) window.MapView.refresh();
  if (window.Slideshow) window.Slideshow.invalidate();
}

/** True when any sidebar/cluster/tag filter is narrowing the catalog. */
function hasActiveFilter() {
  return Object.values(state.filters).some((v) => v != null && v !== '');
}

function reflectFilters() {
  // re-mark chips
  loadStatsChipsActive();
  const active = Object.entries(state.filters).filter(([, v]) => v);
  const host = $('#activeFilters');
  host.innerHTML = '';
  for (const [dim, val] of active) {
    let label = state.filterLabels[dim] || val;
    if (dim === 'country') label = `${COUNTRY_FLAG(val)} ${val}`;
    const chip = el('span', 'chip active', `${esc(dim)}: ${esc(label)} ✕`);
    chip.addEventListener('click', () => { state.filters[dim] = null; reflectFilters(); if (window.MomentsView) window.MomentsView.invalidate(); if (window.MapView) window.MapView.refresh(); if (window.Slideshow) window.Slideshow.invalidate(); });
    host.appendChild(chip);
  }
  $('#clearFilters').classList.toggle('hidden', active.length === 0);
}

function loadStatsChipsActive() {
  document.querySelectorAll('.chip-list .chip').forEach((c) => c.classList.remove('active'));
  if (window.__stats) {
    const s = window.__stats;
    renderChips('#filterYears', (s.years || []).map((y) => ({ key: y.year, label: y.year, count: y.n })), 'year');
    renderChips('#filterCountries', (s.countries || []).map((c) => ({ key: c.code, label: `${COUNTRY_FLAG(c.code)} ${c.code}`, count: c.n })), 'country');
    renderChips('#filterCameras', (s.cameras || []).map((c) => ({ key: c.model, label: c.model, count: c.n })), 'camera');
  }
}

/* ------------------------------- Rollups strip ------------------------------ */

async function loadRollups() {
  try {
    const { rollups } = await API.rollups('year');
    const strip = $('#rollupStrip');
    strip.innerHTML = '';
    for (const r of rollups) {
      const flags = r.countries.map(COUNTRY_FLAG).join(' ');
      const card = el('div', 'rollup-card', `
        <div class="rc-key">${r.period_key}</div>
        <div class="rc-count">${r.photo_count} photos</div>
        <div class="rc-flags">${flags}</div>`);
      if (state.filters.year === r.period_key) card.classList.add('active');
      card.addEventListener('click', () => toggleFilter('year', r.period_key));
      strip.appendChild(card);
    }
  } catch (e) { /* ignore */ }
}

/* ------------------------------- Timeline grid ------------------------------ */

function resetTimeline() {
  state.cursor = null; state.done = false; state.loading = false;
  state.photos = []; state.byId.clear(); state.lastDayKey = null; state.lastDayEl = null;
  $('#timelineGrid').innerHTML = '';
  loadRollups();
  reflectFilters();
  loadMore();
}

async function loadMore() {
  if (state.loading || state.done) return;
  state.loading = true;
  try {
    const params = { ...state.filters, limit: 120 };
    if (state.cursor) params.cursor = state.cursor;
    const { photos, nextCursor } = await API.timeline(params);
    appendPhotos(photos);
    state.cursor = nextCursor;
    if (!nextCursor || photos.length === 0) state.done = true;
    const empty = state.photos.length === 0;
    $('#timelineEmpty').classList.toggle('hidden', !empty);
  } catch (e) {
    toast(e.message, true);
    state.done = true;
  } finally {
    state.loading = false;
  }
}

function appendPhotos(photos) {
  const grid = $('#timelineGrid');
  for (const p of photos) {
    state.photos.push(p);
    state.byId.set(p.id, p);
    const key = dayKey(p.date_taken);
    if (key !== state.lastDayKey) {
      const group = el('div', 'day-group');
      const header = el('div', 'day-header', `<h2>${fmtDate(p.date_taken)}</h2><span class="day-meta"></span>`);
      const photosEl = el('div', 'day-photos');
      group.appendChild(header); group.appendChild(photosEl);
      grid.appendChild(group);
      state.lastDayKey = key;
      state.lastDayEl = photosEl;
      state.lastDayEl._countries = new Set();
      state.lastDayEl._count = 0;
      state.lastDayEl._header = header.querySelector('.day-meta');
    }
    state.lastDayEl.appendChild(tile(p));
    state.lastDayEl._count++;
    if (p.country_code) state.lastDayEl._countries.add(p.country_code);
    state.lastDayEl._header.textContent =
      `${state.lastDayEl._count} photos · ${[...state.lastDayEl._countries].map(COUNTRY_FLAG).join(' ')}`;
  }
}

// Target row height for the justified photo grid (Google Photos style). Each
// tile flexes to fill its row; flex-basis/grow are set from the photo's real
// aspect ratio so heights stay uniform per row with no cropping.
const TILE_ROW_H = 180;
function tileAspect(p) {
  const w = Number(p.width), h = Number(p.height);
  if (!(w > 0 && h > 0)) return 1.5; // default to 3:2 when dimensions are unknown
  return Math.min(Math.max(w / h, 0.5), 3); // clamp extreme panoramas / very-tall shots
}

function tile(p) {
  const t = el('div', 'photo-tile');
  t.dataset.id = p.id;
  const ar = tileAspect(p);
  t.style.flexGrow = ar.toFixed(4);
  t.style.flexBasis = (ar * TILE_ROW_H).toFixed(1) + 'px';
  t.style.maxWidth = (ar * TILE_ROW_H * 2).toFixed(1) + 'px'; // tame a lone last-row tile
  t.style.aspectRatio = ar.toFixed(4);
  const img = el('img');
  img.loading = 'lazy';
  img.src = API.thumb(p.id, 'PREVIEW'); // PREVIEW (800px) stays crisp at justified-row sizes
  img.addEventListener('load', () => img.classList.add('loaded'));
  t.appendChild(img);
  if (p.latitude != null) t.appendChild(el('span', 'tile-pin', '📍'));
  t.appendChild(el('div', 'tile-badge', `<span>${fmtTime(p.date_taken)}</span><span>${p.country_code ? COUNTRY_FLAG(p.country_code) : ''}</span>`));
  t.addEventListener('click', () => openLightbox(p.id));
  return t;
}

/* --------------------------------- Lightbox -------------------------------- */

let lbMap = null;

async function openLightbox(id) {
  state.lbIndex = state.photos.findIndex((p) => p.id === id);
  $('#lightbox').classList.remove('hidden');
  await renderLightbox(id);
}

async function renderLightbox(id) {
  const img = $('#lbImage');
  img.src = API.original(id);
  let detail;
  try { detail = await API.photo(id); } catch (e) { toast(e.message, true); return; }
  const panel = $('#lbPanel');
  const gps = detail.latitude != null ? `${detail.latitude.toFixed(5)}, ${detail.longitude.toFixed(5)}` : '—';
  panel.innerHTML = `
    <h2>${esc(detail.file_name)}</h2>
    <div class="lb-sub">${esc(detail.folder_name || '')}</div>
    <div class="meta-row"><span class="k">Date taken</span><span class="v">${detail.date_taken ? fmtDate(detail.date_taken) + ' ' + fmtTime(detail.date_taken) : '—'}</span></div>
    <div class="meta-row"><span class="k">Timezone</span><span class="v">${esc(detail.tz_offset || '—')}</span></div>
    <div class="meta-row"><span class="k">Country</span><span class="v">${detail.country_code ? COUNTRY_FLAG(detail.country_code) + ' ' + esc(detail.country_code) : '—'}</span></div>
    <div class="meta-row"><span class="k">GPS</span><span class="v">${gps}</span></div>
    <div class="meta-row"><span class="k">Camera</span><span class="v">${esc([detail.camera_make, detail.camera_model].filter(Boolean).join(' ')) || '—'}</span></div>
    <div class="meta-row"><span class="k">Dimensions</span><span class="v">${detail.width || '?'} × ${detail.height || '?'}</span></div>
    <div class="meta-row"><span class="k">Format</span><span class="v">${esc((detail.format || '').toUpperCase())} ${['jpg', 'jpeg'].includes((detail.format || '').toLowerCase()) ? '· tags write to file' : '· tags in database'}</span></div>
    ${detail.latitude != null ? '<div id="lbMap" class="lb-map"></div>' : ''}
    <div id="lbTagHost"></div>`;

  if (window.Tagging) window.Tagging.render(detail, $('#lbTagHost'));

  if (detail.latitude != null && window.L) {
    setTimeout(() => {
      if (lbMap) { lbMap.remove(); lbMap = null; }
      lbMap = L.map('lbMap', { attributionControl: false, zoomControl: false }).setView([detail.latitude, detail.longitude], 11);
      L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', { maxZoom: 18 }).addTo(lbMap);
      L.marker([detail.latitude, detail.longitude]).addTo(lbMap);
    }, 30);
  }
}

function closeLightbox() {
  $('#lightbox').classList.add('hidden');
  if (lbMap) { lbMap.remove(); lbMap = null; }
}
function lbNav(delta) {
  let i = state.lbIndex + delta;
  if (i < 0) i = 0;
  if (i >= state.photos.length) { if (!state.done) loadMore(); i = state.photos.length - 1; }
  state.lbIndex = i;
  renderLightbox(state.photos[i].id);
}

/* ------------------------------- View routing ------------------------------ */

function switchView(name) {
  state.view = name;
  if (location.hash !== `#${name}`) location.hash = name;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === name));
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  // Leaving the map clears any Map Focus state (restores the collapsed sidebar).
  if (name !== 'map' && window.MapView && window.MapView.blur) window.MapView.blur();
  if (name === 'moments' && window.MomentsView) window.MomentsView.show();
  if (name === 'map' && window.MapView) window.MapView.show();
  if (name === 'clusters' && window.Clusters) window.Clusters.show();
  if (name === 'slideshow' && window.Slideshow) window.Slideshow.show();
}

/* --------------------------------- Scanning -------------------------------- */

/**
 * Run a scan/import: open the shared SSE progress stream, drive the status bar,
 * and refresh every view on completion. `startRequest` is the API call that
 * kicks off the job (re-scan, import folders, import files). Shared by the
 * Refresh button and the import dialog (projects.js).
 */
async function runScanUI(startRequest) {
  const bar = $('#scanStatus');
  bar.classList.remove('hidden');
  bar.innerHTML = '<span>Starting…</span>';
  const importBtn = $('#importBtn'); const refreshBtn = $('#refreshBtn');
  if (importBtn) importBtn.disabled = true;
  if (refreshBtn) refreshBtn.disabled = true;
  const done = () => { if (importBtn) importBtn.disabled = false; if (refreshBtn) refreshBtn.disabled = false; };

  // Start the job FIRST so the server is already 'running' (with a cleared
  // terminal) before we subscribe. This avoids a fast job finishing in the gap
  // before the stream attaches, and avoids reacting to a previous job's state.
  try {
    await startRequest();
  } catch (e) {
    toast(e.message, true); done(); bar.classList.add('hidden');
    return;
  }

  const es = new EventSource('/api/scan/stream');
  let finished = false;
  const finish = (evt) => {
    if (finished) return;
    finished = true;
    es.close(); done();
    setTimeout(() => bar.classList.add('hidden'), 2500);
    if (evt && evt.phase === 'complete') refreshAll();
  };
  es.onmessage = (ev) => {
    const evt = JSON.parse(ev.data);
    if (evt.phase === 'connected') {
      // Job already finished before we attached -> finalize from the snapshot.
      const st = evt.scanState;
      if (st && !st.running && st.terminal) { updateScanBar(st.terminal); finish(st.terminal); }
      return;
    }
    updateScanBar(evt);
    if (evt.phase === 'complete' || evt.phase === 'fatal') finish(evt);
  };
  es.onerror = () => { es.close(); done(); };
}

/** Reload stats + every view after the catalog changes. */
function refreshAll() {
  loadStats();
  if (window.MomentsView) window.MomentsView.invalidate();
  if (window.MapView) window.MapView.invalidate();
  if (window.Clusters) window.Clusters.invalidate();
  if (window.Slideshow) window.Slideshow.invalidate();
}

function updateScanBar(evt) {
  const bar = $('#scanStatus');
  let pct = 0, label = evt.phase;
  if (evt.phase === 'copy') { pct = (evt.processed / Math.max(evt.total, 1)) * 100; label = `Copying ${evt.processed}/${evt.total}`; }
  else if (evt.phase === 'ingest') { pct = (evt.processed / Math.max(evt.total, 1)) * 100; label = `Indexing ${evt.processed}/${evt.total}`; }
  else if (evt.phase === 'thumbnails') { pct = (evt.processed / Math.max(evt.total,1)) * 100; label = `Thumbnails ${evt.processed}/${evt.total}`; }
  else if (evt.phase === 'discovery') label = 'Scanning filesystem…';
  else if (evt.phase === 'purge') label = 'Detecting removed files…';
  else if (evt.phase === 'rollups') { pct = 100; label = 'Building summaries…'; }
  else if (evt.phase === 'complete') {
    const s = evt.summary || {};
    pct = 100; label = `Done — +${s.added||0} new, ${s.moved||0} moved, ${s.skipped||0} unchanged`;
    toast(label);
  } else if (evt.phase === 'fatal') { label = 'Scan failed: ' + (evt.message || ''); }
  bar.innerHTML = `<span>${esc(label)}</span><div class="bar"><span style="width:${pct}%"></span></div>`;
}

/* ---------------------------------- Init ----------------------------------- */

function init() {
  $('#tabs').addEventListener('click', (e) => {
    if (e.target.dataset.view) switchView(e.target.dataset.view);
  });
  $('#refreshBtn').addEventListener('click', () => runScanUI(() => API.rescan()));
  $('#clearFilters').addEventListener('click', () => {
    state.filters = { year: null, country: null, camera: null, cluster: null, tagsAll: null };
    state.filterLabels = {};
    reflectFilters();
    if (window.MomentsView) window.MomentsView.invalidate();
    if (window.MapView) window.MapView.refresh();
    if (window.Slideshow) window.Slideshow.invalidate();
  });

  $('#lbClose').addEventListener('click', closeLightbox);
  $('#lbPrev').addEventListener('click', () => lbNav(-1));
  $('#lbNext').addEventListener('click', () => lbNav(1));
  document.addEventListener('keydown', (e) => {
    if ($('#lightbox').classList.contains('hidden')) return;
    if (e.key === 'Escape') closeLightbox();
    if (e.key === 'ArrowLeft') lbNav(-1);
    if (e.key === 'ArrowRight') lbNav(1);
  });

  // Infinite scroll
  const sentinel = $('#timelineSentinel');
  new IntersectionObserver((entries) => {
    if (entries[0].isIntersecting) loadMore();
  }, { root: $('#timelineScroll'), rootMargin: '600px' }).observe(sentinel);

  if (window.Projects) window.Projects.init();
  boot();
}

/** Gate startup on an open project; otherwise show the launcher. */
async function boot() {
  let active = null;
  try { const r = await API.projectsActive(); active = r.project; } catch (e) { /* show launcher */ }
  if (!active) {
    if (window.Projects) window.Projects.showLauncher();
    return;
  }
  if (window.Projects) window.Projects.setActiveUI(active);
  loadStats();
  const initial = (location.hash || '').replace('#', '');
  const views = ['moments', 'map', 'clusters', 'slideshow'];
  switchView(views.includes(initial) ? initial : 'moments');

  const photoParam = new URLSearchParams(location.search).get('photo');
  if (photoParam) setTimeout(() => openLightbox(Number(photoParam)), 400);
}

function filterByCluster(id, name) {
  state.filters.cluster = id;
  state.filterLabels.cluster = name;
  reflectFilters(); switchView('moments');
  if (window.MomentsView) window.MomentsView.invalidate();
}
function filterByTags(items) {
  state.filters.tagsAll = items.join(',');
  state.filterLabels.tagsAll = items.join(' + ');
  reflectFilters(); switchView('moments');
  if (window.MomentsView) window.MomentsView.invalidate();
}

window.GalleryApp = {
  state, resetTimeline, openLightbox, switchView, toast, fmtDate, fmtTime,
  fmtDateRange, filterByCluster, filterByTags, hasActiveFilter,
  runScanUI, refreshAll, boot, loadStats, tile, el, esc,
};
document.addEventListener('DOMContentLoaded', init);
