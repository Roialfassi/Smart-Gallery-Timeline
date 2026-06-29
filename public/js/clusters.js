'use strict';

/*
 * Keyword intersections panel (Apriori itemsets mined from folder tags).
 *
 * Formerly the right half of the standalone Clusters tab; now a collapsible
 * panel folded into the Timeline view (its spatial-cluster role was absorbed by
 * the Space+Time grouping). Clicking an itemset filters the catalog by those tags.
 */

window.Keywords = (function () {
  let open = false;
  let loaded = false;

  async function load() {
    const host = document.querySelector('#tagMatrix');
    if (!host) return;
    host.innerHTML = '<div class="muted">Mining itemsets…</div>';
    let data;
    try { data = await API.words(GalleryApp.state.filters); }
    catch (e) { host.innerHTML = `<div class="muted">${esc(e.message)}</div>`; return; }

    host.innerHTML = '';
    const sub = document.createElement('div');
    sub.className = 'muted kw-sub';
    sub.textContent = `min support ${(data.minSupport * 100).toFixed(0)}% (≥${data.minSupportCount} photos) · ${data.itemsets.length} intersections`;
    host.appendChild(sub);

    if (data.itemsets.length === 0) {
      host.appendChild(Object.assign(document.createElement('div'), { className: 'muted', textContent: 'No keyword intersections above threshold.' }));
      loaded = true;
      return;
    }
    for (const s of data.itemsets) {
      const row = document.createElement('div');
      row.className = 'tag-itemset';
      const keys = s.items.map((k) => `<span class="kw">${esc(k)}</span>`).join('');
      row.innerHTML = `<span class="keys">${keys}</span><span class="sup">${s.count} · ${(s.support * 100).toFixed(0)}%</span>`;
      row.addEventListener('click', () => GalleryApp.filterByTags(s.items));
      host.appendChild(row);
    }
    loaded = true;
  }

  function setOpen(next) {
    open = next;
    const panel = document.querySelector('#kwPanel');
    const btn = document.querySelector('#kwBtn');
    if (panel) panel.classList.toggle('hidden', !open);
    if (btn) btn.classList.toggle('active', open);
    if (open && !loaded) load();
  }

  function toggle() { setOpen(!open); }

  // Catalog changed: refresh if currently visible, else reload lazily next open.
  function invalidate() { loaded = false; if (open) load(); }

  return { toggle, invalidate, load };
})();
