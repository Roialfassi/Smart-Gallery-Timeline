'use strict';

/*
 * Project launcher + import flows. A project is a base folder holding copied
 * photos plus its own catalog. Native folder/file pickers are used when running
 * in Electron (window.sgtNative); in a plain browser we fall back to typed paths.
 */

(function () {
  const $ = (sel) => document.querySelector(sel);
  const native = () => (window.sgtNative && window.sgtNative.isElectron ? window.sgtNative : null);
  const App = () => window.GalleryApp;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }
  function basename(p) {
    const parts = String(p).replace(/[\\/]+$/, '').split(/[\\/]/);
    return parts[parts.length - 1] || 'Project';
  }

  /* ------------------------------- Active UI ------------------------------- */

  function setActiveUI(project) {
    hideLauncher();
    $('#projectName').textContent = project && project.name ? project.name : 'Project';
    $('#projectChip').classList.remove('hidden');
    $('#importBtn').classList.remove('hidden');
    $('#refreshBtn').classList.remove('hidden');
  }

  function hideActiveChrome() {
    $('#projectChip').classList.add('hidden');
    $('#importBtn').classList.add('hidden');
    $('#refreshBtn').classList.add('hidden');
  }

  /* ------------------------------- Launcher -------------------------------- */

  // Version + "Check for updates" in the launcher footer (desktop app only —
  // a plain browser can't self-update). The native menu also has the action,
  // but the menu bar is auto-hidden, so this is the visible entry point.
  async function renderFooter() {
    const foot = $('#launcherFoot');
    if (!foot) return;
    const n = native();
    if (!n || !n.checkForUpdates) { foot.innerHTML = ''; return; }
    let ver = '';
    try { ver = n.appVersion ? await n.appVersion() : ''; } catch (_) { /* ignore */ }
    foot.innerHTML = '';
    if (ver) {
      const v = document.createElement('span');
      v.className = 'lf-ver';
      v.textContent = 'v' + ver;
      foot.appendChild(v);
      foot.appendChild(document.createTextNode(' · '));
    }
    const btn = document.createElement('button');
    btn.className = 'lf-link';
    btn.textContent = 'Check for updates';
    btn.addEventListener('click', () => { try { n.checkForUpdates(); } catch (_) { /* ignore */ } });
    foot.appendChild(btn);
  }

  async function showLauncher() {
    hideActiveChrome();
    renderFooter();
    const host = $('#lcRecent');
    host.innerHTML = '<span class="muted">Loading…</span>';
    try {
      const { projects } = await API.projectsRecent();
      if (!projects.length) {
        host.innerHTML = '<span class="muted">No recent projects yet.</span>';
      } else {
        host.innerHTML = '';
        for (const p of projects) {
          const card = document.createElement('button');
          card.className = 'recent-card';
          card.innerHTML = `<span class="rc-name">${esc(p.name)}</span><span class="rc-path">${esc(p.baseDir)}</span>`;
          card.addEventListener('click', () => openProjectAt(p.baseDir));
          host.appendChild(card);
        }
      }
    } catch (e) {
      host.innerHTML = '<span class="muted">Could not load recent projects.</span>';
    }
    $('#projectLauncher').classList.remove('hidden');
  }

  function hideLauncher() {
    $('#projectLauncher').classList.add('hidden');
  }

  function activate(project) {
    setActiveUI(project);
    App().refreshAll();
    App().switchView('moments');
  }

  async function newProject() {
    const choice = await window.FolderBrowser.choose({ mode: 'new' });
    if (!choice || !choice.baseDir) return;
    try {
      const r = await API.newProject(choice.baseDir, choice.name || basename(choice.baseDir));
      activate(r.project);
    } catch (e) { App().toast(e.message, true); }
  }

  async function openProject() {
    const choice = await window.FolderBrowser.choose({ mode: 'open' });
    if (!choice || !choice.baseDir) return;
    openProjectAt(choice.baseDir);
  }

  async function openProjectAt(baseDir) {
    try {
      const r = await API.openProject(baseDir);
      activate(r.project);
    } catch (e) { App().toast(e.message, true); }
  }

  async function demo() {
    try {
      const r = await API.demoProject();
      setActiveUI(r.project);
      App().switchView('moments');
      if (r.importing) App().runScanUI(() => Promise.resolve({ started: true }));
      else App().refreshAll();
    } catch (e) { App().toast(e.message, true); }
  }

  /* -------------------------------- Import --------------------------------- */

  function openImportDialog() {
    const hasNative = !!native();
    $('#impFolders').classList.toggle('hidden', !hasNative);
    $('#impFiles').classList.toggle('hidden', !hasNative);
    $('#impFallback').classList.toggle('hidden', hasNative);
    $('#impPaths').value = '';
    $('#importDialog').classList.remove('hidden');
  }
  function closeImportDialog() { $('#importDialog').classList.add('hidden'); }

  async function importFoldersNative() {
    const dirs = await native().pickFolders();
    if (dirs && dirs.length) { closeImportDialog(); App().runScanUI(() => API.importFolders(dirs)); }
  }
  async function importFilesNative() {
    const files = await native().pickFiles();
    if (files && files.length) { closeImportDialog(); App().runScanUI(() => API.importFiles(files)); }
  }
  function importFoldersTyped() {
    const sources = $('#impPaths').value.split('\n').map((s) => s.trim()).filter(Boolean);
    if (!sources.length) { App().toast('Enter at least one folder path.', true); return; }
    closeImportDialog();
    App().runScanUI(() => API.importFolders(sources));
  }

  /* --------------------------------- Wiring -------------------------------- */

  let wired = false;
  function init() {
    if (wired) return; wired = true;
    $('#lcNew').addEventListener('click', newProject);
    $('#lcOpen').addEventListener('click', openProject);
    $('#lcDemo').addEventListener('click', demo);
    $('#switchProjectBtn').addEventListener('click', showLauncher);
    $('#importBtn').addEventListener('click', openImportDialog);
    $('#impClose').addEventListener('click', closeImportDialog);
    $('#impFolders').addEventListener('click', importFoldersNative);
    $('#impFiles').addEventListener('click', importFilesNative);
    $('#impFallbackGo').addEventListener('click', importFoldersTyped);
    $('#importDialog').addEventListener('click', (e) => { if (e.target.id === 'importDialog') closeImportDialog(); });
  }

  window.Projects = { init, showLauncher, hideLauncher, setActiveUI };
})();
