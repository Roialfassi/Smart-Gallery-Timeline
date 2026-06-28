'use strict';

/* Map & Journeys view (Phase 2). Plots geotagged photos + journey polylines. */

window.MapView = (function () {
  let map = null;
  let trackLayer = null;   // plain layer group: journey polylines
  let clusterLayer = null; // markercluster group: photo markers (co-located photos group + spiderfy)
  let photoIcon = null;
  let needsLoad = true;

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

    const showJourney = document.querySelector('#journeyToggle').checked;
    const bounds = [];

    if (showJourney) {
      jr.tracks.forEach((t, i) => {
        const latlngs = t.points.map((p) => [p.lat, p.lon]);
        const hue = (i * 67) % 360;
        L.polyline(latlngs, { color: `hsl(${hue},85%,62%)`, weight: 3, opacity: 0.85 }).addTo(trackLayer);
      });
    }

    const markers = [];
    geo.photos.forEach((p) => {
      bounds.push([p.latitude, p.longitude]);
      const m = L.marker([p.latitude, p.longitude], { icon: photoIcon });
      const date = new Date(p.date_taken).toISOString().slice(0, 10);
      m.bindTooltip(`${date} · ${p.country_code || ''}`, { direction: 'top' });
      m.on('click', () => GalleryApp.openLightbox(p.id));
      markers.push(m);
    });
    clusterLayer.addLayers(markers);

    if (bounds.length) map.fitBounds(bounds, { padding: [40, 40], maxZoom: 12 });
    document.querySelector('#mapInfo').textContent =
      `${jr.stats.photos} photos · ${jr.stats.segments} journeys · ${jr.stats.standalone} stops · ${jr.stats.totalKm} km tracked`;
    needsLoad = false;
  }

  function show() {
    ensure();
    setTimeout(() => map.invalidateSize(), 60);
    if (needsLoad) refresh();
  }
  function invalidate() {
    needsLoad = true;
    if (GalleryApp.state.view === 'map') refresh();
  }

  document.addEventListener('DOMContentLoaded', () => {
    const t = document.querySelector('#journeyToggle');
    if (t) t.addEventListener('change', refresh);
  });

  return { show, refresh, invalidate };
})();
