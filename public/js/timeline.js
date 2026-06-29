'use strict';

/*
 * Timeline view — the unified zoomable spatiotemporal grouping (successor to the
 * old Moments + Clusters split). One chronological spine; a single granularity
 * slider scales the grouping from fine events out to whole years, and a Time /
 * Space+Time toggle decides whether location participates.
 *
 *   spine   — the ENTIRE project as one continuous timeline (oldest → newest),
 *             each group a banner you can dive into.
 *   cards   — a grid of group cards; click one to open it.
 *   detail  — a single group, start → finish, with a route map when it moves.
 *   grid    — the flat infinite-scroll grid (when a sidebar filter/tag is on).
 *
 * Groups come from /api/groups at the current (mode, step). Diving into a group
 * fetches its photos; the slider and mode are the primary controls.
 */

window.MomentsView = (function () {
  const $ = (s) => document.querySelector(s);
  const App = () => window.GalleryApp;
  const el = (tag, cls, html) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  };

  const WHOLE_MAX = 400;     // libraries this size or smaller default to the spine
  const STOP_MERGE_KM = 25;  // detail route: photos within this join one "stop"

  let mode = 'time';         // 'time' | 'spacetime'
  let step = 8;              // granularity slider position
  let steps = 24;            // slider max (from the API)
  let tiers = ['Event', 'Trip', 'Month', 'Year'];

  let groups = [];           // lightweight cards (cards rail + detail nav)
  let wholeGroups = [];      // groups with inlined photos (spine view)
  let total = 0;
  let tierName = '';
  let view = 'rail';         // 'rail' | 'whole' | 'detail' | 'grid'
  let display = null;        // null = auto; otherwise 'whole' | 'grouped'
  let curIndex = -1;
  let gridLoaded = false;
  let sdMap = null;
  let wired = false;
  let resizerWired = false;
  let loadSeq = 0;           // guards against out-of-order async loads while dragging
  const SIDE_W_KEY = 'sgt.sdSideWidth';

  let regionNames = null;
  try { regionNames = new Intl.DisplayNames(undefined, { type: 'region' }); } catch (_) { /* older browser */ }
  const countryName = (cc) => {
    if (!cc) return '';
    try { return (regionNames && regionNames.of(cc)) || cc; } catch (_) { return cc; }
  };

  /* -------------------------------- labels --------------------------------- */

  const flagsOf = (g) => (g.countries || []).map(COUNTRY_FLAG).join(' ');

  // Server picks the title (place in space+time, else the date range). The stats
  // line carries whatever the title didn't.
  function groupTitle(g) { return g.title || g.dateLabel || 'Group'; }

  function groupStats(g) {
    const bits = [];
    if (g.title !== g.dateLabel) bits.push(g.dateLabel);
    if (g.isGeo) {
      const days = Math.round((new Date(g.end) - new Date(g.start)) / 86400000) + 1;
      if (days > 1) bits.push(`${days} days`);
    }
    bits.push(`${g.photoCount} photo${g.photoCount !== 1 ? 's' : ''}`);
    if (g.km) bits.push(`${g.km} km`);
    return bits.join(' · ');
  }

  const titleHtml = (g) => `${flagsOf(g) ? `<span class="seg-flags">${flagsOf(g)}</span> ` : ''}${App().esc(groupTitle(g))}`;

  /* ----------------------- detail route: derive stops ---------------------- */

  const RAD = (d) => (d * Math.PI) / 180;
  function haversineKm(aLat, aLon, bLat, bLon) {
    const dLat = RAD(bLat - aLat), dLon = RAD(bLon - aLon);
    const x = Math.sin(dLat / 2) ** 2 + Math.cos(RAD(aLat)) * Math.cos(RAD(bLat)) * Math.sin(dLon / 2) ** 2;
    return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(x)));
  }

  // Collapse a group's GPS photos into ordered stops for the route map / grouping.
  function stopsFromPhotos(photos) {
    const stops = [];
    let cur = null;
    for (const p of photos) {
      if (p.latitude == null) { if (cur) cur.count++; continue; }
      if (cur && haversineKm(p.latitude, p.longitude, cur.sLat / cur.gps, cur.sLon / cur.gps) > STOP_MERGE_KM) cur = null;
      if (!cur) { cur = { sLat: 0, sLon: 0, gps: 0, count: 0, start: p.date_taken, end: p.date_taken, country: p.country_code, coverPhotoId: p.id }; stops.push(cur); }
      cur.sLat += p.latitude; cur.sLon += p.longitude; cur.gps++; cur.count++;
      cur.end = p.date_taken;
      if (p.country_code) cur.country = p.country_code;
    }
    return stops.map((s) => ({ lat: s.sLat / s.gps, lon: s.sLon / s.gps, start: s.start, end: s.end, count: s.count, country: s.country, coverPhotoId: s.coverPhotoId }));
  }

  /* ------------------------------ photo groups ----------------------------- */

  function stopGroups(stops, photos) {
    let si = 0;
    const buckets = stops.map((s) => ({ stop: s, photos: [] }));
    for (const p of photos) {
      while (si < stops.length - 1 && p.date_taken > stops[si].end) si++;
      buckets[si].photos.push(p);
    }
    return buckets.filter((b) => b.photos.length).map((b, i) => ({
      title: `Stop ${i + 1}${b.stop.country ? ' · ' + COUNTRY_FLAG(b.stop.country) : ''}`,
      meta: `${App().fmtDateRange(b.stop.start, b.stop.end)} · ${b.photos.length} photos`,
      photos: b.photos,
    }));
  }

  function dayGroups(photos) {
    const out = [];
    let key = null, cur = null;
    for (const p of photos) {
      const k = p.date_taken.slice(0, 10);
      if (k !== key) { key = k; cur = { day: p.date_taken, photos: [], cc: new Set() }; out.push(cur); }
      cur.photos.push(p);
      if (p.country_code) cur.cc.add(p.country_code);
    }
    return out.map((g) => ({
      title: App().fmtDate(g.day),
      meta: `${g.photos.length} photos${g.cc.size ? ' · ' + [...g.cc].map(COUNTRY_FLAG).join(' ') : ''}`,
      photos: g.photos,
    }));
  }

  // Space+time groups that actually moved split into stops; everything else by day.
  function groupsFor(g, photos) {
    if (mode === 'spacetime' && g.isGeo) {
      const stops = stopsFromPhotos(photos);
      if (stops.length > 1) return stopGroups(stops, photos);
    }
    return dayGroups(photos);
  }

  function groupEls(blocks) {
    return blocks.map((b) => {
      const grp = el('div', 'day-group');
      grp.appendChild(el('div', 'day-header', `<h2>${App().esc(b.title)}</h2><span class="day-meta">${App().esc(b.meta)}</span>`));
      const ph = el('div', 'day-photos');
      for (const p of b.photos) ph.appendChild(App().tile(p));
      grp.appendChild(ph);
      return grp;
    });
  }

  function renderBlocks(host, blocks) {
    host.innerHTML = '';
    for (const e of groupEls(blocks)) host.appendChild(e);
  }

  function bindLightboxList(photos) {
    const st = App().state;
    st.photos = photos;
    st.byId = new Map(photos.map((p) => [p.id, p]));
    st.done = true;
    st.cursor = null;
  }

  /* ----------------------------- cards (rail) ------------------------------ */

  function railCard(g, i) {
    const card = el('div', 'seg-card ' + (mode === 'spacetime' && g.isGeo ? 'seg-trip' : 'seg-period'));
    card.dataset.id = g.id;

    const cover = el('div', 'seg-cover');
    const img = el('img');
    img.loading = 'lazy';
    img.src = API.thumb(g.coverPhotoId, 'PREVIEW');
    img.addEventListener('load', () => img.classList.add('loaded'));
    cover.appendChild(img);
    if (g.isGeo && g.km) cover.appendChild(el('span', 'seg-kind', `${g.km} KM`));

    const body = el('div', 'seg-body');
    body.appendChild(el('h3', 'seg-title', titleHtml(g)));
    body.appendChild(el('div', 'seg-stats', App().esc(groupStats(g))));

    const strip = el('div', 'seg-strip');
    for (const id of (g.previewIds || [])) {
      const t = el('img'); t.loading = 'lazy'; t.src = API.thumb(id, 'MICRO');
      strip.appendChild(t);
    }
    body.appendChild(strip);

    card.appendChild(cover);
    card.appendChild(body);
    card.addEventListener('click', () => openGroup(i));
    return card;
  }

  function renderRail() {
    const host = $('#segRail');
    host.innerHTML = '';
    $('#segEmpty').classList.toggle('hidden', groups.length > 0);
    groups.forEach((g, i) => host.appendChild(railCard(g, i)));
  }

  /* ------------------------- spine (continuous) ---------------------------- */

  function renderWhole() {
    const host = $('#wholeBody');
    host.innerHTML = '';
    if (!wholeGroups.length) {
      host.appendChild(el('div', 'empty-state', '<p>No photos yet.</p><p class="muted">Use <strong>＋ Import photos</strong> to build your timeline.</p>'));
      return;
    }
    const asc = wholeGroups.slice().reverse(); // oldest → newest
    const all = [];
    asc.forEach((g) => g.photos.forEach((p) => all.push(p)));
    bindLightboxList(all);

    for (const g of asc) {
      const i = groups.findIndex((c) => c.id === g.id);
      const section = el('div', 'whole-seg' + (mode === 'spacetime' && g.isGeo ? ' is-trip' : ''));
      const banner = el('div', 'whole-banner');
      banner.appendChild(el('div', 'wb-info',
        `<h3 class="wb-title">${titleHtml(g)}</h3><div class="wb-stats">${App().esc(groupStats(g))}</div>`));
      const open = el('button', 'btn btn-sm wb-open', 'Open ›');
      open.addEventListener('click', (e) => { e.stopPropagation(); if (i >= 0) openGroup(i); });
      banner.appendChild(open);
      section.appendChild(banner);
      for (const e of groupEls(groupsFor(g, g.photos))) section.appendChild(e);
      host.appendChild(section);
    }
    host.scrollTop = 0;
  }

  /* -------------------------------- detail --------------------------------- */

  function renderHeader(g, i) {
    const head = $('#segDetailHeader');
    head.innerHTML = `
      <div class="sd-top">
        <button class="btn btn-sm" id="sdBack">‹ All groups</button>
        <div class="sd-nav">
          <button class="btn btn-sm" id="sdPrev" ${i <= 0 ? 'disabled' : ''}>‹ Newer</button>
          <button class="btn btn-sm" id="sdNext" ${i >= groups.length - 1 ? 'disabled' : ''}>Older ›</button>
        </div>
      </div>
      <div class="sd-headline">
        <h2><span class="sd-flags">${flagsOf(g)}</span> ${App().esc(groupTitle(g))}</h2>
        <div class="sd-sub">${App().esc(groupStats(g))}</div>
      </div>`;
    $('#sdBack').addEventListener('click', backToOverview);
    const prev = $('#sdPrev'), next = $('#sdNext');
    if (prev && !prev.disabled) prev.addEventListener('click', () => openGroup(i - 1));
    if (next && !next.disabled) next.addEventListener('click', () => openGroup(i + 1));
  }

  function renderMap(photos) {
    if (sdMap) { sdMap.remove(); sdMap = null; }
    const stops = (mode === 'spacetime' || photos.some((p) => p.latitude != null)) ? stopsFromPhotos(photos) : [];
    const side = $('#segDetailSide');
    const isRoute = !!(stops.length && window.L);
    side.classList.toggle('hidden', !isRoute);
    $('#sdResizer').classList.toggle('hidden', !isRoute);
    if (!isRoute) return;
    applySideWidth();
    const host = $('#sdMap');
    if (!host) return;
    sdMap = L.map(host, { attributionControl: false });
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', { maxZoom: 18 }).addTo(sdMap);
    const pts = stops.map((s) => [s.lat, s.lon]);
    if (pts.length >= 2) L.polyline(pts, { color: '#1a73e8', weight: 3, opacity: 0.85 }).addTo(sdMap);
    stops.forEach((s, idx) => {
      const icon = L.divIcon({ className: 'stop-marker', html: `<span>${idx + 1}</span>`, iconSize: [26, 26], iconAnchor: [13, 13] });
      const m = L.marker([s.lat, s.lon], { icon }).addTo(sdMap);
      m.bindTooltip(`Stop ${idx + 1} · ${App().fmtDateRange(s.start, s.end)} · ${s.count} photos`, { direction: 'top' });
      m.on('click', () => App().openLightbox(s.coverPhotoId));
    });
    setTimeout(() => {
      sdMap.invalidateSize();
      if (pts.length === 1) sdMap.setView(pts[0], 11);
      else sdMap.fitBounds(pts, { padding: [30, 30], maxZoom: 12 });
    }, 60);
  }

  async function openGroup(i) {
    if (i < 0 || i >= groups.length) return;
    const g = groups[i];
    curIndex = i;
    view = 'detail';
    let data;
    try { data = await API.groupPhotos(mode, step, g.id); } catch (e) { App().toast(e.message, true); return; }
    const photos = data.photos || [];
    bindLightboxList(photos);
    renderHeader(g, i);
    renderBlocks($('#segDetailBody'), groupsFor(g, photos));
    renderMap(photos);
    panes('detail');
    $('#segDetailBody').scrollTop = 0;
  }

  function backToOverview() {
    if (sdMap) { sdMap.remove(); sdMap = null; }
    curIndex = -1;
    enterOverview(false);
  }

  /* ------------------------------ pane control ----------------------------- */

  function panes(active) {
    $('#momentsRail').classList.toggle('hidden', active !== 'rail');
    $('#momentsWhole').classList.toggle('hidden', active !== 'whole');
    $('#momentsDetail').classList.toggle('hidden', active !== 'detail');
    $('#momentsGrid').classList.toggle('hidden', active !== 'grid');
    $('#momentsToolbar').classList.toggle('hidden', !(active === 'rail' || active === 'whole'));
  }

  function setDisplayToggle(active) {
    document.querySelectorAll('#viewToggle .seg-toggle-btn')
      .forEach((b) => b.classList.toggle('active', b.dataset.viewMode === active));
    const hint = $('#momentsHint');
    if (hint) hint.textContent = `${groups.length} group${groups.length !== 1 ? 's' : ''} · ${total} photos · ${tierName}`;
  }

  function setModeToggle() {
    document.querySelectorAll('#modeToggle .seg-toggle-btn')
      .forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  }

  /* ------------------------------ tier ticks ------------------------------- */

  function nearestTier(s) {
    const x = (s / steps) * (tiers.length - 1);
    return tiers[Math.round(x)];
  }

  function renderTicks() {
    const host = $('#granTicks');
    if (!host) return;
    host.innerHTML = '';
    tiers.forEach((name, idx) => {
      const t = el('span', 'gran-tick', App().esc(name));
      t.style.left = `${(idx / (tiers.length - 1)) * 100}%`;
      host.appendChild(t);
    });
  }

  function syncTierLabel() {
    tierName = nearestTier(step);
    const lbl = $('#granTier');
    if (lbl) lbl.textContent = tierName;
  }

  /* -------------------------------- wiring --------------------------------- */

  function wireToolbar() {
    if (wired) return;
    wired = true;

    document.querySelectorAll('#modeToggle .seg-toggle-btn').forEach((b) => {
      b.addEventListener('click', () => { if (mode !== b.dataset.mode) { mode = b.dataset.mode; setModeToggle(); reloadGroups(); } });
    });
    document.querySelectorAll('#viewToggle .seg-toggle-btn').forEach((b) => {
      b.addEventListener('click', () => { display = b.dataset.viewMode; enterOverview(false); });
    });

    const slider = $('#granSlider');
    if (slider) {
      slider.max = String(steps);
      slider.value = String(step);
      slider.addEventListener('input', () => { step = Number(slider.value); syncTierLabel(); });
      slider.addEventListener('change', () => { step = Number(slider.value); reloadGroups(); });
    }
    const kw = $('#kwBtn');
    if (kw) kw.addEventListener('click', () => { if (window.Keywords) window.Keywords.toggle(); });

    renderTicks();
    syncTierLabel();
  }

  function applySideWidth() {
    const side = $('#segDetailSide');
    const w = parseInt(localStorage.getItem(SIDE_W_KEY), 10);
    side.style.flexBasis = w >= 280 ? w + 'px' : '';
  }

  function wireResizer() {
    if (resizerWired) return;
    const rz = $('#sdResizer');
    const side = $('#segDetailSide');
    if (!rz || !side) return;
    resizerWired = true;
    let startX = 0, startW = 0, dragging = false;
    const onMove = (e) => {
      if (!dragging) return;
      const splitW = $('#segDetailSplit').getBoundingClientRect().width;
      const maxW = Math.max(320, splitW - 420);
      const w = Math.max(280, Math.min(maxW, startW - (e.clientX - startX)));
      side.style.flexBasis = w + 'px';
      if (sdMap) sdMap.invalidateSize({ animate: false });
    };
    const onUp = (e) => {
      if (!dragging) return;
      dragging = false;
      rz.classList.remove('dragging');
      document.body.style.userSelect = '';
      try { rz.releasePointerCapture(e.pointerId); } catch (_) { /* already released */ }
      localStorage.setItem(SIDE_W_KEY, String(parseInt(side.style.flexBasis, 10) || ''));
      if (sdMap) setTimeout(() => sdMap.invalidateSize(), 50);
    };
    rz.addEventListener('pointerdown', (e) => {
      dragging = true; startX = e.clientX; startW = side.getBoundingClientRect().width;
      rz.classList.add('dragging'); document.body.style.userSelect = 'none';
      rz.setPointerCapture(e.pointerId); e.preventDefault();
    });
    rz.addEventListener('pointermove', onMove);
    rz.addEventListener('pointerup', onUp);
    rz.addEventListener('dblclick', () => {
      localStorage.removeItem(SIDE_W_KEY);
      side.style.flexBasis = '';
      if (sdMap) setTimeout(() => sdMap.invalidateSize(), 50);
    });
  }

  /* -------------------------------- loaders -------------------------------- */

  async function loadCards() {
    const seq = ++loadSeq;
    try {
      const r = await API.groups(mode, step);
      if (seq !== loadSeq) return false; // a newer load superseded this one
      groups = r.groups || [];
      total = r.total || groups.reduce((a, g) => a + g.photoCount, 0);
      steps = r.steps || steps;
      tiers = (r.tiers && r.tiers.length) ? r.tiers : tiers;
      tierName = (r.scale && r.scale.tier) || nearestTier(step);
      const slider = $('#granSlider');
      if (slider) slider.max = String(steps);
      renderTicks();
      return true;
    } catch (e) { App().toast(e.message, true); return false; }
  }

  async function loadWhole() {
    const seq = loadSeq;
    try {
      const r = await API.groups(mode, step, null, true);
      if (seq !== loadSeq) return false;
      wholeGroups = r.groups || [];
      return true;
    } catch (e) { App().toast(e.message, true); return false; }
  }

  function enterGrid(reload) {
    view = 'grid';
    if (sdMap) { sdMap.remove(); sdMap = null; }
    panes('grid');
    if (reload || !gridLoaded) { App().resetTimeline(); gridLoaded = true; }
  }

  async function enterOverview(forceReload) {
    if (forceReload || !groups.length) { if (!await loadCards()) return; }
    const ov = display || (total <= WHOLE_MAX ? 'whole' : 'grouped');
    if (ov === 'whole') {
      if (!await loadWhole()) return;
      view = 'whole';
      renderWhole();
      setDisplayToggle('whole');
      panes('whole');
    } else {
      view = 'rail';
      renderRail();
      setDisplayToggle('grouped');
      panes('rail');
    }
    setModeToggle();
  }

  // Mode/scale changed: refetch cards (and the spine if shown) at the new setting.
  async function reloadGroups() {
    if (!await loadCards()) return;
    wholeGroups = [];
    await enterOverview(false);
  }

  /* -------------------------------- public --------------------------------- */

  function show() {
    wireToolbar();
    wireResizer();
    if (App().hasActiveFilter()) return enterGrid(false);
    if (view === 'detail' && curIndex >= 0) return panes('detail');
    enterOverview(false);
  }

  function invalidate() {
    wireToolbar();
    groups = [];
    wholeGroups = [];
    gridLoaded = false;
    curIndex = -1;
    if (App().state.view !== 'moments') return; // lazy — show() reloads on next visit
    if (App().hasActiveFilter()) enterGrid(true);
    else enterOverview(true);
  }

  return { show, invalidate };
})();
