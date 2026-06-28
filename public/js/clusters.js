'use strict';

/* Clusters view (Phase 2): spatial DBSCAN clusters + keyword intersection matrix. */

window.Clusters = (function () {
  let needsLoad = true;
  let circlesLayer = null;

  const qs = (base, extra) => {
    const filters = { ...GalleryApp.state.filters, ...extra };
    const p = new URLSearchParams(Object.entries(filters).filter(([, v]) => v != null && v !== ''));
    const s = p.toString();
    return s ? `${base}?${s}` : base;
  };

  function radius() { return Number(document.querySelector('#radiusSlider').value); }
  function fmtRadius(m) { return m >= 1000 ? (m / 1000).toFixed(m % 1000 ? 1 : 0) + ' km' : m + ' m'; }

  async function loadClusters() {
    const host = document.querySelector('#clusterList');
    host.innerHTML = '<div class="muted">Computing clusters…</div>';
    let data;
    // POST: computing clusters persists stable IDs server-side (a mutating op).
    try { data = await API.post('/api/clusters', { ...GalleryApp.state.filters, radius: radius() }); }
    catch (e) { host.innerHTML = `<div class="muted">${esc(e.message)}</div>`; return; }

    host.innerHTML = '';
    if (data.clusters.length === 0) { host.innerHTML = '<div class="muted">No clusters at this radius.</div>'; return; }
    for (const c of data.clusters) {
      const card = document.createElement('div');
      card.className = 'cluster-card';
      const flags = c.countries.map(COUNTRY_FLAG).join(' ');
      const thumbs = c.sampleIds.map((id) => `<img loading="lazy" src="${API.thumb(id, 'MICRO')}">`).join('');
      card.innerHTML = `
        <h4>${esc(c.name)} <span class="muted">${flags}</span></h4>
        <div class="cc-meta">${c.photoCount} photos · ${c.center.lat.toFixed(3)}, ${c.center.lon.toFixed(3)}</div>
        <div class="cluster-thumbs">${thumbs}</div>`;
      card.addEventListener('click', (e) => {
        if (e.shiftKey) return renameCluster(c);
        GalleryApp.filterByCluster(c.id, c.name);
      });
      card.title = 'Click to view photos · Shift+click to rename';
      host.appendChild(card);
    }
  }

  async function renameCluster(c) {
    const name = prompt('Rename cluster:', c.name);
    if (!name || name === c.name) return;
    try {
      await API.post(`/api/clusters/${c.id}/name`, { name });
      GalleryApp.toast(`Renamed to "${name}" (preserved across recompute)`);
      loadClusters();
    } catch (e) { GalleryApp.toast(e.message, true); }
  }

  async function loadWords() {
    const host = document.querySelector('#tagMatrix');
    host.innerHTML = '<div class="muted">Mining itemsets…</div>';
    let data;
    try { data = await API.get(qs('/api/clusters/words', {})); }
    catch (e) { host.innerHTML = `<div class="muted">${esc(e.message)}</div>`; return; }

    host.innerHTML = '';
    const sub = document.createElement('div');
    sub.className = 'muted';
    sub.style.marginBottom = '8px';
    sub.style.fontSize = '12px';
    sub.textContent = `min support ${(data.minSupport * 100).toFixed(0)}% (≥${data.minSupportCount} photos) · ${data.itemsets.length} intersections`;
    host.appendChild(sub);

    if (data.itemsets.length === 0) { host.appendChild(Object.assign(document.createElement('div'), { className: 'muted', textContent: 'No keyword intersections above threshold.' })); return; }
    for (const s of data.itemsets) {
      const row = document.createElement('div');
      row.className = 'tag-itemset';
      const keys = s.items.map((k) => `<span class="kw">${esc(k)}</span>`).join('');
      row.innerHTML = `<span class="keys">${keys}</span><span class="sup">${s.count} · ${(s.support * 100).toFixed(0)}%</span>`;
      row.addEventListener('click', () => GalleryApp.filterByTags(s.items));
      host.appendChild(row);
    }
  }

  function show() {
    if (needsLoad) { loadClusters(); loadWords(); needsLoad = false; }
  }
  function invalidate() {
    needsLoad = true;
    if (GalleryApp.state.view === 'clusters') { loadClusters(); loadWords(); needsLoad = false; }
  }

  document.addEventListener('DOMContentLoaded', () => {
    const slider = document.querySelector('#radiusSlider');
    const label = document.querySelector('#radiusValue');
    if (slider) {
      slider.addEventListener('input', () => { label.textContent = fmtRadius(radius()); });
      slider.addEventListener('change', loadClusters);
    }
    const btn = document.querySelector('#recomputeClusters');
    if (btn) btn.addEventListener('click', loadClusters);
  });

  return { show, invalidate };
})();
