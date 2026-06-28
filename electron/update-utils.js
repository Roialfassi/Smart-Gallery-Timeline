'use strict';

/**
 * Pure helpers for the updater — no Electron/Node-IO imports so they can be unit
 * tested in plain node. The Electron-facing side (network, dialogs, spawning the
 * installer) lives in updater.js and builds on these.
 */

// Compare two dotted versions. Returns 1 if a>b, -1 if a<b, 0 if equal.
// Tolerates a leading "v" and ignores any pre-release/build suffix (after - or +).
function compareVersions(a, b) {
  const norm = (v) =>
    String(v == null ? '' : v)
      .trim()
      .replace(/^v/i, '')
      .split(/[-+]/)[0]
      .split('.')
      .map((n) => parseInt(n, 10) || 0);
  const pa = norm(a);
  const pb = norm(b);
  const len = Math.max(pa.length, pb.length, 3);
  for (let i = 0; i < len; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

// True when `latest` is a strictly newer version than `current`.
function isNewer(latest, current) {
  return compareVersions(latest, current) > 0;
}

// Parse "owner/repo" from a package.json `repository` field (object or string,
// https or ssh GitHub URL). Returns `fallback` when it can't be parsed.
function parseRepo(repository, fallback) {
  const url = repository && (typeof repository === 'string' ? repository : repository.url);
  if (url) {
    const m = String(url).match(/github\.com[/:]+([^/]+)\/([^/.]+?)(?:\.git)?(?:[/#?].*)?$/i);
    if (m) return { owner: m[1], repo: m[2] };
  }
  return fallback || null;
}

// From a GitHub release's assets, pick the Windows installer: prefer a "*Setup*.exe",
// else any ".exe". Returns the asset object or null.
function pickInstallerAsset(assets) {
  const list = Array.isArray(assets) ? assets : [];
  return (
    list.find((a) => a && /setup.*\.exe$/i.test(a.name)) ||
    list.find((a) => a && /\.exe$/i.test(a.name)) ||
    null
  );
}

module.exports = { compareVersions, isNewer, parseRepo, pickInstallerAsset };
