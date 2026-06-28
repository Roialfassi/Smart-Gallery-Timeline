'use strict';

/* Map & Journeys view (Phase 2). Plots geotagged photos + journey polylines.
 *
 * Map Focus mode: clicking a photo marker doesn't open the full-screen lightbox
 * (which would force a modal over the map). Instead the live map shrinks into the
 * right rail and the photo blows up beside it, with the map gliding (flyTo) between
 * markers as you page through — so the photo's location stays in view. The filter
 * sidebar collapses for the duration. "‹ Back to map" / Esc reverse it all. */

window.MapView = (function () {
  let map = null;
  let trackLayer = null;   // plain layer group: journey polylines
  let clusterLayer = null; // markercluster group: photo markers (co-located photos group + spiderfy)
  let photoIcon = null;
  let needsLoad = true;

  let geoPhotos = [];      // ordered geotagged photos (drives focus prev/next + flyTo)
  let focused = false;
  let curIndex = -1;
  let savedView = null;    // map center/zoom captured before focusing, restored on exit

  const $ = (s) => document.querySelector(s);

  const qs = (base, filters) => {
    const p = new URLSearchParams(Object.entries(filters).filter(([, v]) => v != null && v !== ''));
    const s = p.toString();
    return s ? `${base}?${s}` : base;
  };

  function ensure() {
    if (map) return;
    map = L.map('leafletMap', { worldCopyJump: true }).setView([25, 10], 2);
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 19, attribution: 'Tiles © Esri',
    }).addTo(map);
    // A divIcon (not circleMarker) so markercluster can group/spiderfy reliably. Anchored at
    // its centre so the dot sits exactly on the geo point.
    photoIcon = L.divIcon({
      className: 'photo-dot',
      html: '<span style="display:block;width:12px;height:12px;border-radius:50%;background:#1a73e8;border:1px solid #fff;box-shadow:0 0 2px rgba(0,0,0,.45)"></span>',
      iconSize: [12, 12],
      iconAnchor: [6, 6],
    });
    trackLayer = L.layerGroup().addTo(map);
    clusterLayer = L.markerClusterGroup({
      maxClusterRadius: 45,
      showCoverageOnHover: false,
      spiderfyOnMaxZoom: true,
    }).addTo(map);
  }

  async function refresh() {
    ensure();
    exitFocus(true); // a filter change resets out of focus and re-fits the markers
    trackLayer.clearLayers();
    clusterLayer.clearLayers();
    const filters = { ...GalleryApp.state.filters };
    let geo, jr;
    try {
      [geo, jr] = await Promise.all([
        API.get(qs('/api/geo', filters)),
        API.get(qs('/api/journeys', filters)),
      ]);
    } catch (e) { GalleryApp.toast(e.message, true); return; }

    geoPhotos = geo.photos || [];
    const showJourney = $('#journeyToggle').checked;
    const bounds = [];

    if (showJourney) {
      jr.tracks.forEach((t, i) => {
        const latlngs = t.points.map((p) => [p.lat, p.lon]);
        const hue = (i * 67) % 360;
        L.polyline(latlngs, { color: `hsl(${hue},85%,62%)`, weight: 3, opacity: 0.85 }).addTo(trackLayer);
      });
    }

    const markers = [];
    geoPhotos.forEach((p, i) => {
      bounds.push([p.latitude, p.longitude]);
      const m = L.marker([p.latitude, p.longitude], { icon: photoIcon });
      const date = new Date(p.date_taken).toISOString().slice(0, 10);
      m.bindTooltip(`${date} · ${p.country_code || ''}`, { direction: 'top' });
      m.on('click', () => enterFocus(i)); // open this photo in the side-by-side focus view
      markers.push(m);
    });
    clusterLayer.addLayers(markers);

    if (bounds.length) map.fitBounds(bounds, { padding: [40, 40], maxZoom: 12 });
    $('#mapInfo').textContent =
      `${jr.stats.photos} photos · ${jr.stats.segments} journeys · ${jr.stats.standalone} stops · ${jr.stats.totalKm} km tracked`;
    needsLoad = false;
  }

  /* ------------------------------- focus mode ------------------------------- */

  // Keep Leaflet's canvas in sync while the surrounding flex box animates. Calls
  // invalidateSize on each frame for `ms` so tiles fill the growing/shrinking pane
  // instead of snapping at the end of the CSS transition.
  function pumpResize(ms) {
    if (!map) return;
    const t0 = performance.now();
    (function tick() {
      if (!map) return;
      map.invalidateSize({ animate: false });
      if (performance.now() - t0 < ms) requestAnimationFrame(tick);
    })();
  }

  function enterFocus(i) {
    if (i < 0 || i >= geoPhotos.length) return;
    if (!focused) savedView = { center: map.getCenter(), zoom: map.getZoom() };
    focused = true;
    curIndex = i;
    $('#view-map').classList.add('focused');
    $('.layout').classList.add('map-focus');
    pumpResize(480);
    renderFocusPhoto(geoPhotos[i]);
  }

  function navFocus(delta) {
    if (!focused) return;
    const i = Math.max(0, Math.min(geoPhotos.length - 1, curIndex + delta));
    if (i === curIndex) return;
    curIndex = i;
    renderFocusPhoto(geoPhotos[i]);
  }

  function renderFocusPhoto(p) {
    const img = $('#mfImage');
    img.classList.remove('loaded');
    img.onload = () => img.classList.add('loaded');
    img.src = API.original(p.id);
    if (img.complete && img.naturalWidth) img.classList.add('loaded'); // already cached → onload won't refire

    const date = p.date_taken ? new Date(p.date_taken).toISOString().slice(0, 10) : '';
    $('#mfCaption').innerHTML =
      `<strong>${esc(p.file_name)}</strong><span>${date}${p.country_code ? ' · ' + COUNTRY_FLAG(p.country_code) + ' ' + esc(p.country_code) : ''}</span>`;
    $('#mfPrev').disabled = curIndex <= 0;
    $('#mfNext').disabled = curIndex >= geoPhotos.length - 1;

    // Glide the map to this photo's marker (same easing as the slideshow).
    map.flyTo([p.latitude, p.longitude], Math.max(map.getZoom(), 13), { duration: 1.0, easeLinearity: 0.25 });

    renderMeta(p);            // instant render from the geo row…
    loadMetaDetail(p.id);     // …then enrich with full EXIF once it arrives
  }

  function renderMeta(d) {
    const gps = d.latitude != null ? `${d.latitude.toFixed(5)}, ${d.longitude.toFixed(5)}` : '—';
    const camera = esc([d.camera_make, d.camera_model].filter(Boolean).join(' ')) || '—';
    const host = $('#mfMeta');
    host.innerHTML = `
      <h3>${esc(d.file_name)}</h3>
      <div class="mf-sub">${esc(d.folder_name || '')}</div>
      <div class="meta-row"><span class="k">Date taken</span><span class="v">${d.date_taken ? GalleryApp.fmtDate(d.date_taken) + ' · ' + GalleryApp.fmtTime(d.date_taken) : '—'}</span></div>
      <div class="meta-row"><span class="k">Country</span><span class="v">${d.country_code ? COUNTRY_FLAG(d.country_code) + ' ' + esc(d.country_code) : '—'}</span></div>
      <div class="meta-row"><span class="k">GPS</span><span class="v">${gps}</span></div>
      <div class="meta-row"><span class="k">Camera</span><span class="v">${camera}</span></div>
      <div class="meta-row"><span class="k">Dimensions</span><span class="v">${d.width || '?'} × ${d.height || '?'}</span></div>
      <div class="mf-open"><button class="btn btn-sm" id="mfOpenLb">Open full view ›</button></div>`;
    const open = $('#mfOpenLb');
    if (open) open.addEventListener('click', () => openInLightbox(d.id));
  }

  async function loadMetaDetail(id) {
    try {
      const d = await API.photo(id);
      // Ignore if the user paged on while this was in flight.
      if (focused && geoPhotos[curIndex] && geoPhotos[curIndex].id === id) renderMeta(d);
    } catch (_) { /* keep the geo-row render */ }
  }

  // Hand off to the full lightbox (tagging, recommendations) with prev/next bound
  // to the geo list so navigation there matches the map.
  function openInLightbox(id) {
    const st = GalleryApp.state;
    st.photos = geoPhotos.slice();
    st.byId = new Map(geoPhotos.map((x) => [x.id, x]));
    st.done = true; st.cursor = null;
    GalleryApp.openLightbox(id);
  }

  function exitFocus(immediate) {
    if (!focused && !$('#view-map').classList.contains('focused')) { if (immediate) pumpResize(0); return; }
    focused = false;
    curIndex = -1;
    $('#view-map').classList.remove('focused');
    $('.layout').classList.remove('map-focus');
    const img = $('#mfImage');
    if (img) { img.removeAttribute('src'); img.classList.remove('loaded'); }
    pumpResize(immediate ? 0 : 480);
    if (!immediate && savedView) map.flyTo(savedView.center, savedView.zoom, { duration: 0.8 });
  }

  /* --------------------------------- public -------------------------------- */

  function show() {
    ensure();
    setTimeout(() => map.invalidateSize(), 60);
    if (needsLoad) refresh();
  }
  function invalidate() {
    needsLoad = true;
    if (GalleryApp.state.view === 'map') refresh();
  }
  // Called when switching away from the map so the collapsed sidebar is restored.
  function blur() { exitFocus(true); }

  document.addEventListener('DOMContentLoaded', () => {
    const t = $('#journeyToggle');
    if (t) t.addEventListener('change', refresh);
    const back = $('#mapBack');
    if (back) back.addEventListener('click', () => exitFocus(false));
    const prev = $('#mfPrev');
    if (prev) prev.addEventListener('click', () => navFocus(-1));
    const next = $('#mfNext');
    if (next) next.addEventListener('click', () => navFocus(1));

    // Capture phase so we see the lightbox's true open/closed state before app.js's
    // (bubble-phase) handler can act on the same key — otherwise one Esc would both
    // close the lightbox and exit focus.
    document.addEventListener('keydown', (e) => {
      if (!focused || GalleryApp.state.view !== 'map') return;
      if (!$('#lightbox').classList.contains('hidden')) return; // lightbox owns keys when open
      if (e.key === 'Escape') exitFocus(false);
      else if (e.key === 'ArrowLeft') navFocus(-1);
      else if (e.key === 'ArrowRight') navFocus(1);
    }, true);
  });

  return { show, refresh, invalidate, blur };
})();
