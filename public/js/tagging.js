'use strict';

/* Tag editor + recommendation chips (Phase 3), rendered inside the lightbox. */

window.Tagging = (function () {
  function isWritable(d) {
    return !!d.writable && ['jpg', 'jpeg'].includes((d.format || '').toLowerCase());
  }

  function render(detail, host) {
    const writable = isWritable(detail);
    const tip = writable ? '' :
      'Tag write-back to the file header is only supported for JPEG in this build. Tags for PNG, WebP, HEIC and RAW are stored in the app database only.';
    host.innerHTML = `
      <div class="tag-edit">
        <h3 style="font-size:13px;margin:0 0 6px">Tags</h3>
        <div class="tag-chips" id="curTags"></div>
        <div id="recos"></div>
        <div class="tag-input-row">
          <input id="tagInput" placeholder="Add a tag…" autocomplete="off" />
          <button class="btn btn-sm btn-primary" id="addTagBtn">Add</button>
        </div>
        <div class="writeback-row">
          <label><input type="checkbox" checked disabled /> Apply to database index (instant search &amp; clustering)</label>
          <label class="${writable ? '' : 'disabled'}" title="${tip}">
            <input type="checkbox" id="wbCheck" ${writable ? '' : 'disabled'} /> Write back to file header (EXIF/IPTC)
          </label>
        </div>
      </div>`;
    renderChips(detail, host);
    loadRecos(detail, host);
    host.querySelector('#addTagBtn').onclick = () => add(detail, host);
    host.querySelector('#tagInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') add(detail, host); });
  }

  function renderChips(detail, host) {
    const c = host.querySelector('#curTags');
    c.innerHTML = '';
    if (!(detail.tags || []).length) { c.innerHTML = '<span class="muted" style="font-size:12px">No tags yet.</span>'; return; }
    for (const t of detail.tags) {
      const chip = document.createElement('span');
      chip.className = 'tag-chip';
      chip.innerHTML = `${esc(t.name)}${t.type === 'automatic' ? ' <span class="muted" style="font-size:10px">auto</span>' : ''} <button title="Remove from index">✕</button>`;
      chip.querySelector('button').onclick = () => remove(detail, host, t.id);
      c.appendChild(chip);
    }
  }

  async function loadRecos(detail, host) {
    const box = host.querySelector('#recos');
    box.innerHTML = '';
    let data;
    try { data = await API.get(`/api/photos/${detail.id}/recommendations`); } catch (_) { return; }
    if (!data.recommendations || !data.recommendations.length) return;
    const wrap = document.createElement('div');
    wrap.style.margin = '8px 0';
    wrap.innerHTML = '<div class="muted" style="font-size:11px;margin-bottom:4px">Recommended (weighted spatial · temporal · folder)</div>';
    const chips = document.createElement('div');
    chips.className = 'tag-chips';
    for (const r of data.recommendations) {
      const c = document.createElement('span');
      c.className = 'rec-chip';
      c.textContent = `+ ${r.name}`;
      c.title = `score ${r.score} — spatial ${r.breakdown.spatial}, temporal ${r.breakdown.temporal}, folder ${r.breakdown.folder}`;
      c.onclick = () => add(detail, host, r.name);
      chips.appendChild(c);
    }
    wrap.appendChild(chips);
    box.appendChild(wrap);
  }

  async function add(detail, host, explicitName) {
    const input = host.querySelector('#tagInput');
    const name = (explicitName || input.value).trim();
    if (!name) return;
    const wb = host.querySelector('#wbCheck');
    const writeback = wb && !wb.disabled && wb.checked;
    try {
      const r = await API.post(`/api/photos/${detail.id}/tags`, { name, writeback });
      input.value = '';
      detail.tags = r.photo.tags;
      detail.file_size = r.photo.file_size;
      GalleryApp.toast(r.wroteBack ? `Added "${name}" and wrote to file header` : `Added "${name}" to database index`);
      renderChips(detail, host);
      loadRecos(detail, host);
    } catch (e) { GalleryApp.toast(e.message, true); }
  }

  async function remove(detail, host, tagId) {
    try {
      const r = await API.del(`/api/photos/${detail.id}/tags/${tagId}`);
      detail.tags = r.photo.tags;
      renderChips(detail, host);
      loadRecos(detail, host);
    } catch (e) { GalleryApp.toast(e.message, true); }
  }

  return { render };
})();
