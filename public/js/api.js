// Thin fetch wrapper around the catalog API.
const API = {
  async get(path) {
    const res = await fetch(path);
    if (!res.ok) {
      let body = {};
      try { body = await res.json(); } catch (_) {}
      throw new Error(body.message || `Request failed: ${res.status}`);
    }
    return res.json();
  },
  async post(path, data) {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data || {}),
    });
    if (!res.ok) {
      let body = {};
      try { body = await res.json(); } catch (_) {}
      throw new Error(body.message || `Request failed: ${res.status}`);
    }
    return res.json();
  },
  async del(path) {
    const res = await fetch(path, { method: 'DELETE' });
    if (!res.ok) {
      let body = {};
      try { body = await res.json(); } catch (_) {}
      throw new Error(body.message || `Request failed: ${res.status}`);
    }
    return res.json();
  },
  stats: () => API.get('/api/stats'),
  rollups: (type) => API.get(`/api/rollups?type=${type}`),
  timeline: (params) => {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== ''));
    return API.get(`/api/timeline?${qs.toString()}`);
  },
  photo: (id) => API.get(`/api/photos/${id}`),
  thumb: (id, size) => `/api/thumb/${id}?size=${size || 'MICRO'}`,
  original: (id) => `/api/original/${id}`,

  // Unified zoomable Timeline (spatiotemporal groups). `extra` carries the active
  // sidebar filters so groups respect them.
  groups: (mode, step, extra, withPhotos) => {
    const qs = new URLSearchParams({ mode, step, ...(extra || {}) });
    if (withPhotos) qs.set('withPhotos', '1');
    return API.get(`/api/groups?${qs.toString()}`);
  },
  groupPhotos: (mode, step, id, extra) => {
    const qs = new URLSearchParams({ mode, step, id, ...(extra || {}) });
    return API.get(`/api/groups/photos?${qs.toString()}`);
  },

  // Keyword intersections (Apriori itemsets) — now surfaced inside the Timeline view.
  words: (extra) => {
    const qs = new URLSearchParams(Object.entries(extra || {}).filter(([, v]) => v != null && v !== ''));
    const s = qs.toString();
    return API.get('/api/clusters/words' + (s ? `?${s}` : ''));
  },

  // Host folder browser (New/Open project picker)
  fsList: (path) => API.get('/api/fs/list' + (path ? '?path=' + encodeURIComponent(path) : '')),
  fsMkdir: (parent, name) => API.post('/api/fs/mkdir', { parent, name }),

  // Projects
  projectsActive: () => API.get('/api/projects/active'),
  projectsRecent: () => API.get('/api/projects/recent'),
  newProject: (baseDir, name) => API.post('/api/projects/new', { baseDir, name }),
  openProject: (baseDir) => API.post('/api/projects/open', { baseDir }),
  demoProject: () => API.post('/api/projects/demo', {}),

  // Import / scan
  importFolders: (sources) => API.post('/api/import/folders', { sources }),
  importFiles: (files, subdir) => API.post('/api/import/files', { files, subdir }),
  rescan: () => API.post('/api/scan', {}),

  // Calendar
  calendar: (year, month) => {
    const qs = new URLSearchParams();
    if (year) qs.set('year', year);
    if (month) qs.set('month', month);
    return API.get('/api/calendar' + (qs.toString() ? '?' + qs.toString() : ''));
  },
};

const COUNTRY_FLAG = (cc) => {
  if (!cc || cc.length !== 2) return '🏳️';
  return String.fromCodePoint(...[...cc.toUpperCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
};
