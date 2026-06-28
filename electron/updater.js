'use strict';

/*
 * In-app updater for the packaged Windows desktop app.
 *
 * Because we ship a hand-rolled NSIS installer (see scripts/build-installer.js),
 * we don't use electron-updater's auto-update flow (which expects electron-
 * builder's own installer + latest.yml + blockmaps). Instead this checks the
 * GitHub Releases API, and — when a newer version exists — downloads that
 * release's "Setup .exe" and launches it, quitting so the installer can replace
 * files in place. Our installer is per-user (no admin) and relaunches the app on
 * finish, so this is a complete update path.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawn } = require('child_process');
const { app, dialog, shell } = require('electron');

const { isNewer, parseRepo, pickInstallerAsset } = require('./update-utils');

const pkg = require(path.join(__dirname, '..', 'package.json'));
const FALLBACK_REPO = { owner: 'Roialfassi', repo: 'Smart-Gallery-Timeline' };
const UA = 'SmartGalleryTimeline-Updater';

function repo() {
  return parseRepo(pkg.repository, FALLBACK_REPO);
}
function releasesPageUrl() {
  const { owner, repo: name } = repo();
  return `https://github.com/${owner}/${name}/releases`;
}

// GET a JSON document over https (follows one level of redirect). Rejects with an
// Error carrying `.statusCode` so callers can special-case 404 ("no releases yet").
function getJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'User-Agent': UA, Accept: 'application/vnd.github+json' } }, (res) => {
        const { statusCode, headers } = res;
        if (statusCode >= 300 && statusCode < 400 && headers.location) {
          res.resume();
          return resolve(getJson(headers.location));
        }
        if (statusCode !== 200) {
          res.resume();
          return reject(Object.assign(new Error('GitHub API HTTP ' + statusCode), { statusCode }));
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
        });
      })
      .on('error', reject);
  });
}

// Stream a URL to `dest` (follows redirects to the GitHub asset CDN), reporting
// fractional progress (0..1) when Content-Length is known.
function download(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': UA } }, (res) => {
      const { statusCode, headers } = res;
      if (statusCode >= 300 && statusCode < 400 && headers.location) {
        res.resume();
        return resolve(download(headers.location, dest, onProgress));
      }
      if (statusCode !== 200) {
        res.resume();
        return reject(new Error('Download failed (HTTP ' + statusCode + ')'));
      }
      const total = Number(headers['content-length'] || 0);
      let received = 0;
      const file = fs.createWriteStream(dest);
      res.on('data', (chunk) => {
        received += chunk.length;
        if (onProgress && total) onProgress(received / total);
      });
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve(dest)));
      file.on('error', (e) => { try { fs.unlinkSync(dest); } catch (_) {} reject(e); });
    });
    req.on('error', reject);
  });
}

/**
 * Check GitHub for a newer release and, with the user's consent, download + run
 * the installer. `silent` (used for the startup check) suppresses the
 * "up to date", "no releases", and error dialogs — it only speaks up when there
 * is actually an update to offer.
 */
async function checkForUpdates(win, { silent = false } = {}) {
  const { owner, repo: name } = repo();
  const current = app.getVersion();

  let release;
  try {
    release = await getJson(`https://api.github.com/repos/${owner}/${name}/releases/latest`);
  } catch (e) {
    if (!silent) {
      const noReleases = e.statusCode === 404;
      dialog.showMessageBox(win, {
        type: noReleases ? 'info' : 'error',
        title: 'Check for Updates',
        message: noReleases ? 'No updates available yet.' : 'Could not check for updates.',
        detail: noReleases ? 'No releases have been published for this app yet.' : e.message,
      });
    }
    return { status: 'error', error: e.message };
  }

  const latest = String(release.tag_name || '').replace(/^v/i, '');
  if (!latest || !isNewer(latest, current)) {
    if (!silent) {
      dialog.showMessageBox(win, {
        type: 'info',
        title: 'Check for Updates',
        message: 'You’re up to date.',
        detail: `Smart Gallery Timeline ${current} is the latest version.`,
      });
    }
    return { status: 'up-to-date', current, latest };
  }

  const asset = pickInstallerAsset(release.assets);
  if (!asset) {
    if (!silent) {
      const r = await dialog.showMessageBox(win, {
        type: 'info',
        buttons: ['Open Releases Page', 'Close'],
        defaultId: 0,
        cancelId: 1,
        title: 'Update Available',
        message: `Version ${latest} is available.`,
        detail: 'No Windows installer was attached to that release. Open the Releases page to download it manually.',
      });
      if (r.response === 0) shell.openExternal(releasesPageUrl());
    }
    return { status: 'update-no-asset', latest };
  }

  const choice = await dialog.showMessageBox(win, {
    type: 'info',
    buttons: ['Download & Install', 'Later'],
    defaultId: 0,
    cancelId: 1,
    title: 'Update Available',
    message: `Smart Gallery Timeline ${latest} is available.`,
    detail: `You have ${current}. Download and install it now? The app will close to run the installer, then reopen.`,
  });
  if (choice.response !== 0) return { status: 'declined', latest };

  // Only the installed build can be replaced by the installer.
  if (!app.isPackaged) {
    dialog.showMessageBox(win, {
      type: 'info',
      title: 'Update',
      message: 'Updates apply to the installed app only.',
      detail: `You're running from source. Latest published release is ${latest}; pull and rebuild to update.`,
    });
    return { status: 'dev', latest };
  }

  const dest = path.join(app.getPath('temp'), asset.name);
  try {
    if (win) win.setProgressBar(0);
    await download(asset.browser_download_url, dest, (frac) => { if (win) win.setProgressBar(frac); });
  } catch (e) {
    if (win) win.setProgressBar(-1);
    dialog.showMessageBox(win, { type: 'error', title: 'Update', message: 'Download failed.', detail: e.message });
    return { status: 'error', error: e.message };
  }
  if (win) win.setProgressBar(-1);

  // Launch the installer detached, then quit so it can overwrite the app files.
  // Our installer is interactive, so by the time the user reaches the copy step
  // this process has long exited — no file-lock race.
  try {
    spawn(dest, [], { detached: true, stdio: 'ignore' }).unref();
  } catch (e) {
    dialog.showMessageBox(win, { type: 'error', title: 'Update', message: 'Could not launch the installer.', detail: e.message });
    return { status: 'error', error: e.message };
  }
  setImmediate(() => app.quit());
  return { status: 'installing', latest };
}

module.exports = { checkForUpdates, releasesPageUrl };
