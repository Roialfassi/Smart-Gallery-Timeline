'use strict';

/* Live Slideshow & MP4 Creator (Phase 4 — plan/features.md §5).
 * Advances through geotagged photos with crossfade transitions while the Leaflet
 * map glide-pans to each photo's GPS coordinates. Also drives the MP4 exporter. */

window.Slideshow = (function () {
  let map = null;
  let trackLayer = null;
  let cursorMarker = null;
  let photos = [];
  let idx = 0;
  let playing = false;
  let timer = null;
  let needsLoad = true;
  let activeImg = 'A';          // which of the two stacked <img> is showing
  let exporting = false;

  const $ = (s) => document.querySelector(s);

  const qs = (base, filters) => {
    const p = new URLSearchParams(Object.entries(filters).filter(([, v]) => v != null && v !== ''));
    const s = p.toString();
    return s ? `${base}?${s}` : base;
  };

  function ensureMap() {
    if (map) return;
    map = L.map('ssMap', { zoomControl: false, attributionControl: false, worldCopyJump: true })
      .setView([25, 10], 2);
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19 }).addTo(map);
    trackLayer = L.layerGroup().addTo(map);
  }

  async function load() {
    ensureMap();
    const filters = { ...GalleryApp.state.filters };
    let geo;
    try {
      geo = await API.get(qs('/api/geo', filters));
    } catch (e) { GalleryApp.toast(e.message, true); return; }

    photos = geo.photos || [];
    idx = 0;
    needsLoad = false;

    const empty = photos.length === 0;
    $('#slideshowEmpty').classList.toggle('hidden', !empty);
    $('#ssStage').classList.toggle('hidden', empty);
    drawTrack();
    if (!empty) showCurrent(true);
    updateCounter();
  }

  function drawTrack() {
    trackLayer.clearLayers();
    cursorMarker = null;
    if (!photos.length) return;
    const maxDist = 80 * 1000; // journey-break threshold (km → m), matches backend
    let seg = [];
    const flush = () => {
      if (seg.length >= 2) {
        L.polyline(seg, { color: '#1a73e8', weight: 3, opacity: 0.7 }).addTo(trackLayer);
      }
      seg = [];
    };
    for (let i = 0; i < photos.length; i++) {
      const p = photos[i];
      const ll = [p.latitude, p.longitude];
      if (i > 0) {
        const prev = photos[i - 1];
        if (haversine(prev.latitude, prev.longitude, p.latitude, p.longitude) > maxDist) flush();
      }
      seg.push(ll);
      L.circleMarker(ll, { radius: 3, color: '#1a73e8', weight: 0, fillColor: '#1a73e8', fillOpacity: 0.8 })
        .addTo(trackLayer);
    }
    flush();
    cursorMarker = L.circleMarker([photos[0].latitude, photos[0].longitude], {
      radius: 9, color: '#fff', weight: 2, fillColor: '#ea4335', fillOpacity: 1,
    }).addTo(trackLayer);
  }

  function haversine(la1, lo1, la2, lo2) {
    const R = 6371000, toRad = (d) => (d * Math.PI) / 180;
    const dLa = toRad(la2 - la1), dLo = toRad(lo2 - lo1);
    const a = Math.sin(dLa / 2) ** 2 + Math.cos(toRad(la1)) * Math.cos(toRad(la2)) * Math.sin(dLo / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  function showCurrent(immediate) {
    const p = photos[idx];
    if (!p) return;
    const crossfade = $('#ssTransition').checked && !immediate;

    const next = activeImg === 'A' ? 'B' : 'A';
    const cur = $('#ssImg' + activeImg);
    const incoming = $('#ssImg' + next);
    incoming.onload = () => {
      incoming.classList.add('active');
      cur.classList.remove('active');
      activeImg = next;
    };
    incoming.src = API.thumb(p.id, 'PREVIEW');
    if (immediate) {
      // first paint: no fade
      incoming.classList.add('active');
      cur.classList.remove('active');
      activeImg = next;
    }
    void crossfade; // CSS transition handles the fade when .active toggles

    // Caption
    const date = p.date_taken ? new Date(p.date_taken).toISOString().slice(0, 10) : '';
    $('#ssCaption').innerHTML =
      `<strong>${esc(p.file_name)}</strong><span>${date} · ${COUNTRY_FLAG(p.country_code)} ${esc(p.country_code || '')}</span>`;

    // Glide-pan the map to the photo location
    map.flyTo([p.latitude, p.longitude], Math.max(map.getZoom(), 8), {
      duration: immediate ? 0 : 1.1, easeLinearity: 0.25,
    });
    if (cursorMarker) cursorMarker.setLatLng([p.latitude, p.longitude]);
    updateCounter();
  }

  function updateCounter() {
    $('#ssCounter').textContent = photos.length ? `${idx + 1} / ${photos.length}` : '';
  }

  function next() {
    if (!photos.length) return;
    idx = (idx + 1) % photos.length;
    showCurrent(false);
  }
  function prev() {
    if (!photos.length) return;
    idx = (idx - 1 + photos.length) % photos.length;
    showCurrent(false);
  }

  function play() {
    if (!photos.length || playing) return;
    playing = true;
    $('#ssPlay').innerHTML = '❚❚ Pause';
    const tick = () => {
      const secs = Number($('#ssSpeed').value) || 2.5;
      timer = setTimeout(() => { next(); tick(); }, secs * 1000);
    };
    tick();
  }
  function pause() {
    playing = false;
    clearTimeout(timer);
    $('#ssPlay').innerHTML = '▶ Play';
  }
  function togglePlay() { playing ? pause() : play(); }

  /* ------------------------------ MP4 export ------------------------------ */

  function startExport() {
    if (exporting) return;
    exporting = true;
    const panel = $('#ssExportPanel');
    panel.classList.remove('hidden');
    panel.innerHTML = '<div class="ss-export-status">Starting export…</div><div class="bar"><span style="width:0%"></span></div>';
    $('#ssExport').disabled = true;

    const es = new EventSource('/api/export/stream');
    es.onmessage = (ev) => {
      const evt = JSON.parse(ev.data);
      renderExportProgress(panel, evt);
      if (evt.phase === 'complete' || evt.phase === 'fatal') {
        es.close();
        exporting = false;
        $('#ssExport').disabled = false;
      }
    };
    es.onerror = () => { es.close(); exporting = false; $('#ssExport').disabled = false; };

    const secondsPerPhoto = Number($('#ssSpeed').value) || 2.5;
    API.post('/api/export/mp4', { filters: GalleryApp.state.filters, secondsPerPhoto })
      .catch((e) => {
        GalleryApp.toast(e.message, true);
        es.close(); exporting = false; $('#ssExport').disabled = false;
        panel.innerHTML = `<div class="ss-export-status err">${esc(e.message)}</div>`;
      });
  }

  function renderExportProgress(panel, evt) {
    let pct = 0, label = evt.phase;
    if (evt.phase === 'frames') { pct = (evt.processed / Math.max(evt.total, 1)) * 100; label = `Rendering frames ${evt.processed}/${evt.total}`; }
    else if (evt.phase === 'encoding') { pct = 100; label = 'Encoding H.264 video…'; }
    else if (evt.phase === 'complete') {
      panel.innerHTML =
        `<div class="ss-export-status ok">✓ Export ready — ${evt.frames} frames</div>
         <a class="btn btn-primary" href="/api/export/download" download="journey.mp4">⬇ Download journey.mp4</a>
         <video class="ss-export-preview" src="/api/export/download" controls></video>`;
      GalleryApp.toast('MP4 export complete');
      return;
    } else if (evt.phase === 'fatal') {
      panel.innerHTML = `<div class="ss-export-status err">Export failed: ${esc(evt.message || '')}</div>`;
      return;
    }
    panel.innerHTML = `<div class="ss-export-status">${label}</div><div class="bar"><span style="width:${pct}%"></span></div>`;
  }

  /* --------------------------------- API ---------------------------------- */

  function show() {
    ensureMap();
    setTimeout(() => map.invalidateSize(), 60);
    if (needsLoad) load();
  }
  function invalidate() {
    needsLoad = true;
    pause();
    if (GalleryApp.state.view === 'slideshow') load();
  }

  document.addEventListener('DOMContentLoaded', () => {
    const speed = $('#ssSpeed');
    if (speed) speed.addEventListener('input', () => { $('#ssSpeedVal').textContent = speed.value + 's'; });
    const bind = (id, fn) => { const e = $(id); if (e) e.addEventListener('click', fn); };
    bind('#ssPlay', togglePlay);
    bind('#ssNext', () => { pause(); next(); });
    bind('#ssPrev', () => { pause(); prev(); });
    bind('#ssExport', startExport);
  });

  return { show, invalidate };
})();
