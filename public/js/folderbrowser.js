'use strict';

/*
 * In-app host folder explorer for the New / Open project flows. Replaces the old
 * typed-path prompts: browse quick-access + drives, drill into folders, create a
 * folder, and (new mode) name the project — all in one modal. `choose()` returns
 * a Promise that resolves to { baseDir, name? } or null when cancelled.
 */
(function () {
  const $ = (s) => document.querySelector(s);
  const App = () => window.GalleryApp;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }
  function basename(p) {
    const parts = String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/);
    return parts[parts.length - 1] || String(p || '');
  }

  let state = null; // { mode, cur, resolve } | null

  function close(result) {
    $('#folderModal').classList.add('hidden');
    const r = state && state.resolve;
    state = null;
    if (r) r(result || null);
  }

  function setConfirmEnabled() {
    const btn = $('#fbConfirm');
    if (!state || !state.cur || !state.cur.path) { btn.disabled = true; return; }
    // Opening requires an actual project folder; creating works anywhere.
    btn.disabled = state.mode === 'open' ? !state.cur.isProject : false;
  }

  function renderPlaces(places) {
    const host = $('#fbPlaces');
    host.innerHTML = '';
    for (const [label, kind] of [['Quick access', 'shortcut'], ['Drives', 'drive']]) {
      const items = (places || []).filter((p) => p.kind === kind);
      if (!items.length) continue;
      const h = document.createElement('div');
      h.className = 'fb-places-h';
      h.textContent = label;
      host.appendChild(h);
      for (const it of items) {
        const b = document.createElement('button');
        b.className = 'fb-place';
        b.textContent = it.name;
        b.title = it.path;
        b.addEventListener('click', () => navigate(it.path));
        host.appendChild(b);
      }
    }
  }

  function renderList(data) {
    const host = $('#fbList');
    host.innerHTML = '';
    if (data.path) {
      const up = document.createElement('button');
      up.className = 'fb-row fb-up';
      up.innerHTML = '<span class="fb-ic">⬆</span><span class="fb-name">..</span>';
      up.addEventListener('click', () => navigate(data.parent)); // null -> This PC
      host.appendChild(up);
    }
    if (!data.entries.length && data.path) {
      const empty = document.createElement('div');
      empty.className = 'fb-empty';
      empty.textContent = 'No sub-folders here.';
      host.appendChild(empty);
    }
    for (const ent of data.entries) {
      const row = document.createElement('button');
      row.className = 'fb-row';
      row.innerHTML =
        '<span class="fb-ic">📁</span><span class="fb-name">' + esc(ent.name) + '</span>' +
        (ent.isProject ? '<span class="fb-badge">Project</span>' : '');
      row.addEventListener('click', () => navigate(ent.path));
      host.appendChild(row);
    }
  }

  async function navigate(p) {
    if (!state) return;
    try {
      const data = await API.fsList(p || '');
      state.cur = data;
      $('#fbPath').value = data.path || '';
      renderPlaces(data.places);
      renderList(data);

      let sel;
      if (!data.path) sel = 'Pick a drive or quick-access folder to begin.';
      else if (state.mode === 'open' && !data.isProject) sel = 'Not a project — open the folder that contains its photos.';
      else sel = data.path;
      $('#fbSelected').textContent = sel;
      $('#fbSelected').classList.toggle('fb-warn', state.mode === 'open' && !!data.path && !data.isProject);

      if (state.mode === 'new' && data.path) {
        const nameInput = $('#fbProjName');
        if (!nameInput.dataset.touched) nameInput.value = basename(data.path);
      }
      setConfirmEnabled();
    } catch (e) {
      App().toast(e.message, true);
    }
  }

  async function mkdir() {
    if (!state || !state.cur || !state.cur.path) { App().toast('Pick a location first.', true); return; }
    const name = $('#fbNewFolder').value.trim();
    if (!name) { App().toast('Enter a folder name.', true); return; }
    try {
      const r = await API.fsMkdir(state.cur.path, name);
      $('#fbNewFolder').value = '';
      await navigate(r.path); // jump into the folder we just made
    } catch (e) { App().toast(e.message, true); }
  }

  function confirm() {
    if (!state || !state.cur || !state.cur.path) return;
    const baseDir = state.cur.path;
    if (state.mode === 'new') {
      const name = $('#fbProjName').value.trim() || basename(baseDir);
      close({ baseDir, name });
    } else {
      close({ baseDir });
    }
  }

  // Land somewhere useful: Home if present, else the first drive, else This PC.
  async function landSomewhereUseful() {
    try {
      const root = await API.fsList('');
      const home = (root.places || []).find((p) => p.name === 'Home') ||
                   (root.places || []).find((p) => p.kind === 'drive');
      return navigate(home ? home.path : '');
    } catch (_) {
      return navigate('');
    }
  }

  let wired = false;
  function wire() {
    if (wired) return; wired = true;
    $('#fbClose').addEventListener('click', () => close(null));
    $('#fbCancel').addEventListener('click', () => close(null));
    $('#fbConfirm').addEventListener('click', confirm);
    $('#fbGo').addEventListener('click', () => navigate($('#fbPath').value.trim()));
    $('#fbPath').addEventListener('keydown', (e) => { if (e.key === 'Enter') navigate($('#fbPath').value.trim()); });
    $('#fbMkdir').addEventListener('click', mkdir);
    $('#fbNewFolder').addEventListener('keydown', (e) => { if (e.key === 'Enter') mkdir(); });
    $('#fbProjName').addEventListener('input', (e) => { e.target.dataset.touched = '1'; });
    $('#folderModal').addEventListener('click', (e) => { if (e.target.id === 'folderModal') close(null); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !$('#folderModal').classList.contains('hidden')) close(null);
    });
  }

  /**
   * Open the folder explorer.
   *   opts = { mode: 'open' | 'new', title?, subtitle?, start? }
   * Resolves to { baseDir, name? } or null if cancelled.
   */
  function choose(opts = {}) {
    wire();
    const mode = opts.mode === 'new' ? 'new' : 'open';
    return new Promise((resolve) => {
      state = { mode, cur: null, resolve };
      $('#fbTitle').textContent = opts.title || (mode === 'new' ? 'New project' : 'Open project');
      $('#fbSubtitle').textContent = opts.subtitle || (mode === 'new'
        ? 'Choose where to create the project folder. Imported photos are copied inside it.'
        : 'Browse to an existing Smart Gallery project folder.');
      $('#fbNewRow').classList.toggle('hidden', mode !== 'new');
      $('#fbNameRow').classList.toggle('hidden', mode !== 'new');
      $('#fbConfirm').textContent = mode === 'new' ? 'Create project here' : 'Open this folder';
      const nameInput = $('#fbProjName');
      nameInput.value = ''; delete nameInput.dataset.touched;
      $('#fbNewFolder').value = '';
      $('#fbSelected').textContent = '';
      $('#folderModal').classList.remove('hidden');
      if (opts.start) navigate(opts.start);
      else landSomewhereUseful();
    });
  }

  window.FolderBrowser = { choose };
})();
