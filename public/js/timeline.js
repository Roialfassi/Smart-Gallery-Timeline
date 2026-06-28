'use strict';

/*
 * Moments view — the primary tab. Groups the library into server-detected
 * segments (trips + everyday period buckets) and offers two overview modes plus
 * a per-segment detail:
 *
 *   whole   — the ENTIRE project as one continuous timeline (oldest → newest),
 *             each segment a banner you can dive into. Auto-chosen when the
 *             library is small enough to "fit" (<= WHOLE_MAX photos).
 *   grouped — a rail of trip/period cards; click one to open it.
 *   detail  — a single segment, start → finish, with a route map for trips.
 *   grid    — the flat infinite-scroll grid (when a filter/cluster/tag is on).
 *
 * Whole vs grouped is a toggle in the toolbar; segmentation is a divisible
 * drill-down, not a mandatory split.
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

  const WHOLE_MAX = 400; // libraries this size or smaller default to one continuous timeline

  let segments = [];      // lightweight cards (rail + detail nav)
  let wholeSegments = []; // segments with inlined photos (whole view)
  let home = null;
  let total = 0;
  let loaded = false;
  let wholeLoaded = false;
  let gridLoaded = false;
  let overview = null;    // null = auto-decide; otherwise 'whole' | 'grouped'
  let mode = 'rail';      // 'rail' | 'whole' | 'detail' | 'grid'
  let curIndex = -1;
  let sdMap = null;
  let wired = false;

  let regionNames = null;
  try { regionNames = new Intl.DisplayNames(undefined, { type: 'region' }); } catch (_) { /* older browser */ }
  const countryName = (cc) => {
    if (!cc) return '';
    try { return (regionNames && regionNames.of(cc)) || cc; } catch (_) { return cc; }
  };

  /* -------------------------------- labels --------------------------------- */

  function segTitle(seg) {
    if (seg.kind === 'trip') {
      const names = seg.countries.map(countryName).filter(Boolean);
      if (!names.length) return 'Trip';
      if (names.length <= 3) return names.join(' · ');
      return `${names.slice(0, 2).join(' · ')} +${names.length - 2}`;
    }
    const d = new Date(seg.start);
    if (seg.periodKind === 'week') {
      return 'Week of ' + d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
    }
    return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' });
  }

  function segStats(seg) {
    const range = App().fmtDateRange(seg.start, seg.end);
    if (seg.kind !== 'trip') return `${range} · ${seg.photoCount} photos`;
    const days = Math.round((new Date(seg.end) - new Date(seg.start)) / 86400000) + 1;
    const bits = [range, `${days} day${days > 1 ? 's' : ''}`, `${seg.stops.length} stop${seg.stops.length !== 1 ? 's' : ''}`, `${seg.photoCount} photos`];
    if (seg.km) bits.push(`${seg.km} km`);
    return bits.join(' · ');
  }

  const flagsOf = (seg) => seg.countries.map(COUNTRY_FLAG).join(' ');
  const titleHtml = (seg) => `${flagsOf(seg) ? `<span class="seg-flags">${flagsOf(seg)}</span> ` : ''}${segTitle(seg)}`;

  /* ------------------------------ photo groups ----------------------------- */

  // A trip splits into its ordered stops; everything else splits by day.
  function stopGroups(seg, photos) {
    const stops = seg.stops;
    let si = 0;
    const buckets = stops.map((s) => ({ stop: s, photos: [] }));
    for (const p of photos) {
      while (si < stops.length - 1 && p.date_taken > stops[si].end) si++;
      buckets[si].photos.push(p);
    }
    return buckets.filter((b) => b.photos.length).map((b, i) => ({
      title: `Stop ${i + 1}`,
      meta: `${b.stop.country ? COUNTRY_FLAG(b.stop.country) + ' ' : ''}${App().fmtDateRange(b.stop.start, b.stop.end)} · ${b.photos.length} photos`,
      photos: b.photos,
    }));
  }

  function dayGroups(photos) {
    const out = [];
    let key = null;
    let cur = null;
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

  const groupsFor = (seg, photos) => (seg.kind === 'trip' && seg.stops.length) ? stopGroups(seg, photos) : dayGroups(photos);

  function groupEls(groups) {
    return groups.map((g) => {
      const grp = el('div', 'day-group');
      grp.appendChild(el('div', 'day-header', `<h2>${g.title}</h2><span class="day-meta">${g.meta}</span>`));
      const ph = el('div', 'day-photos');
      for (const p of g.photos) ph.appendChild(App().tile(p));
      grp.appendChild(ph);
      return grp;
    });
  }

  function renderGroups(host, groups) {
    host.innerHTML = '';
    for (const e of groupEls(groups)) host.appendChild(e);
  }

  // Point the lightbox's prev/next at a fixed photo list (no infinite scroll).
  function bindLightboxList(photos) {
    const st = App().state;
    st.photos = photos;
    st.byId = new Map(photos.map((p) => [p.id, p]));
    st.done = true;
    st.cursor = null;
  }

  /* ----------------------------- grouped (rail) ---------------------------- */

  function railCard(seg, i) {
    const card = el('div', 'seg-card ' + (seg.kind === 'trip' ? 'seg-trip' : 'seg-period'));
    card.dataset.id = seg.id;

    const cover = el('div', 'seg-cover');
    const img = el('img');
    img.loading = 'lazy';
    img.src = API.thumb(seg.coverPhotoId, 'PREVIEW');
    img.addEventListener('load', () => img.classList.add('loaded'));
    cover.appendChild(img);
    if (seg.kind === 'trip') cover.appendChild(el('span', 'seg-kind', 'TRIP'));

    const body = el('div', 'seg-body');
    body.appendChild(el('h3', 'seg-title', titleHtml(seg)));
    body.appendChild(el('div', 'seg-stats', segStats(seg)));

    const strip = el('div', 'seg-strip');
    for (const id of seg.previewIds) {
      const t = el('img');
      t.loading = 'lazy';
      t.src = API.thumb(id, 'MICRO');
      strip.appendChild(t);
    }
    body.appendChild(strip);

    card.appendChild(cover);
    card.appendChild(body);
    card.addEventListener('click', () => openSegment(i));
    return card;
  }

  function renderRail() {
    const host = $('#segRail');
    host.innerHTML = '';
    $('#segEmpty').classList.toggle('hidden', segments.length > 0);
    segments.forEach((seg, i) => host.appendChild(railCard(seg, i)));
  }

  /* ------------------------- whole (continuous spine) ---------------------- */

  function renderWhole() {
    const host = $('#wholeBody');
    host.innerHTML = '';
    if (!wholeSegments.length) {
      host.appendChild(el('div', 'empty-state', '<p>No photos yet.</p><p class="muted">Use <strong>＋ Import photos</strong> to build your timeline.</p>'));
      return;
    }
    const asc = wholeSegments.slice().reverse(); // oldest → newest
    const all = [];
    asc.forEach((s) => s.photos.forEach((p) => all.push(p)));
    bindLightboxList(all);

    for (const seg of asc) {
      const i = segments.findIndex((c) => c.id === seg.id); // canonical index for dive-in
      const section = el('div', 'whole-seg' + (seg.kind === 'trip' ? ' is-trip' : ''));
      const banner = el('div', 'whole-banner');
      banner.appendChild(el('div', 'wb-info',
        `<h3 class="wb-title">${seg.kind === 'trip' ? '<span class="seg-kind">TRIP</span> ' : ''}${titleHtml(seg)}</h3>` +
        `<div class="wb-stats">${segStats(seg)}</div>`));
      const open = el('button', 'btn btn-sm wb-open', seg.kind === 'trip' ? 'Open trip ›' : 'Open ›');
      open.addEventListener('click', (e) => { e.stopPropagation(); openSegment(i); });
      banner.appendChild(open);
      section.appendChild(banner);
      for (const g of groupEls(groupsFor(seg, seg.photos))) section.appendChild(g);
      host.appendChild(section);
    }
    host.scrollTop = 0;
  }

  /* -------------------------------- detail --------------------------------- */

  function renderHeader(seg, i) {
    const head = $('#segDetailHeader');
    head.innerHTML = `
      <div class="sd-top">
        <button class="btn btn-sm" id="sdBack">‹ All moments</button>
        <div class="sd-nav">
          <button class="btn btn-sm" id="sdPrev" ${i <= 0 ? 'disabled' : ''}>‹ Newer</button>
          <button class="btn btn-sm" id="sdNext" ${i >= segments.length - 1 ? 'disabled' : ''}>Older ›</button>
        </div>
      </div>
      <div class="sd-headline">
        ${seg.kind === 'trip' ? '<span class="seg-kind">TRIP</span>' : ''}
        <h2><span class="sd-flags">${flagsOf(seg)}</span> ${segTitle(seg)}</h2>
        <div class="sd-sub">${segStats(seg)}</div>
      </div>
      ${seg.kind === 'trip' && seg.stops.length ? '<div id="sdMap" class="sd-map"></div>' : ''}`;
    $('#sdBack').addEventListener('click', backToOverview);
    const prev = $('#sdPrev');
    const next = $('#sdNext');
    if (prev && !prev.disabled) prev.addEventListener('click', () => openSegment(i - 1));
    if (next && !next.disabled) next.addEventListener('click', () => openSegment(i + 1));
  }

  function renderMap(seg) {
    if (sdMap) { sdMap.remove(); sdMap = null; }
    if (!(seg.kind === 'trip' && seg.stops.length && window.L)) return;
    const host = $('#sdMap');
    if (!host) return;
    sdMap = L.map(host, { attributionControl: false });
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', { maxZoom: 18 }).addTo(sdMap);
    const pts = seg.stops.map((s) => [s.lat, s.lon]);
    if (pts.length >= 2) L.polyline(pts, { color: '#1a73e8', weight: 3, opacity: 0.85 }).addTo(sdMap);
    seg.stops.forEach((s, idx) => {
      const icon = L.divIcon({ className: 'stop-marker', html: `<span>${idx + 1}</span>`, iconSize: [26, 26] });
      const m = L.marker([s.lat, s.lon], { icon }).addTo(sdMap);
      m.bindTooltip(`Stop ${idx + 1} · ${App().fmtDateRange(s.start, s.end)} · ${s.count} photos`, { direction: 'top' });
      m.on('click', () => App().openLightbox(s.coverPhotoId));
    });
    setTimeout(() => {
      sdMap.invalidateSize();
      if (pts.length === 1) sdMap.setView(pts[0], 12);
      else sdMap.fitBounds(pts, { padding: [34, 34], maxZoom: 12 });
    }, 60);
  }

  async function openSegment(i) {
    if (i < 0 || i >= segments.length) return;
    const seg = segments[i];
    curIndex = i;
    mode = 'detail';
    let data;
    try { data = await API.segmentPhotos(seg.id); } catch (e) { App().toast(e.message, true); return; }
    const photos = data.photos || [];
    bindLightboxList(photos);
    renderHeader(seg, i);
    renderGroups($('#segDetailBody'), groupsFor(seg, photos));
    renderMap(seg);
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

  function setToggle(active) {
    document.querySelectorAll('#segToggle .seg-toggle-btn')
      .forEach((b) => b.classList.toggle('active', b.dataset.mode === active));
    const hint = $('#momentsHint');
    if (hint) hint.textContent = active === 'whole'
      ? `Whole project · ${total} photos`
      : `${segments.length} moment${segments.length !== 1 ? 's' : ''} · ${total} photos`;
  }

  function wireToggle() {
    if (wired) return;
    wired = true;
    document.querySelectorAll('#segToggle .seg-toggle-btn').forEach((b) => {
      b.addEventListener('click', () => { overview = b.dataset.mode; enterOverview(false); });
    });
  }

  /* -------------------------------- loaders -------------------------------- */

  async function loadSegments() {
    try {
      const r = await API.segments();
      segments = r.segments || [];
      home = r.home || null;
      total = segments.reduce((a, s) => a + s.photoCount, 0);
      loaded = true;
    } catch (e) { App().toast(e.message, true); }
  }

  async function loadWhole() {
    try {
      const r = await API.segmentsFull();
      wholeSegments = r.segments || [];
      wholeLoaded = true;
    } catch (e) { App().toast(e.message, true); }
  }

  function enterGrid(reload) {
    mode = 'grid';
    if (sdMap) { sdMap.remove(); sdMap = null; }
    panes('grid');
    if (reload || !gridLoaded) { App().resetTimeline(); gridLoaded = true; }
  }

  async function enterOverview(reload) {
    if (reload || !loaded) await loadSegments();
    const ov = overview || (total <= WHOLE_MAX ? 'whole' : 'grouped');
    if (ov === 'whole') {
      if (reload || !wholeLoaded) await loadWhole();
      mode = 'whole';
      renderWhole();
      setToggle('whole');
      panes('whole');
    } else {
      mode = 'rail';
      renderRail();
      setToggle('grouped');
      panes('rail');
    }
  }

  /* -------------------------------- public --------------------------------- */

  function show() {
    wireToggle();
    if (App().hasActiveFilter()) return enterGrid(false);
    if (mode === 'detail' && curIndex >= 0) return panes('detail');
    enterOverview(false);
  }

  function invalidate() {
    wireToggle();
    loaded = false;
    wholeLoaded = false;
    gridLoaded = false;
    curIndex = -1;
    if (App().state.view !== 'moments') return; // lazy — show() loads on next visit
    if (App().hasActiveFilter()) enterGrid(true);
    else enterOverview(true);
  }

  return { show, invalidate };
})();
