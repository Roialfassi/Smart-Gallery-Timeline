'use strict';

/*
 * Electron desktop shell for Smart Gallery Timeline.
 *
 * The existing Express catalog server is started in-process on a random free
 * loopback port, and a BrowserWindow is pointed at it — so all of the Phase 1-4
 * web code runs unchanged. When packaged (app.isPackaged), the writable cache
 * (SQLite DB + thumbnails) is redirected to the per-user appData directory,
 * because the install location under Program Files is read-only.
 */

const path = require('path');
const { app, BrowserWindow, shell, dialog, Menu, ipcMain } = require('electron');

// Redirect the writable cache out of the (read-only) install dir when installed.
if (app.isPackaged) {
  process.env.SGT_CACHE_DIR = path.join(app.getPath('userData'), 'cache');
}

let httpServer = null;
let mainWindow = null;

function startServer() {
  return new Promise((resolve, reject) => {
    let createApp;
    try {
      ({ createApp } = require(path.join(__dirname, '..', 'src', 'api', 'server')));
    } catch (e) {
      return reject(e);
    }
    try {
      // Start with no project open so the UI always lands on the project
      // launcher ("choose a project"). Recent projects are listed there for
      // one-click reopening; no catalog database is opened until then.
      const expressApp = createApp();
      const server = expressApp.listen(0, '127.0.0.1', () => {
        const { port } = server.address();
        resolve({ server, url: `http://127.0.0.1:${port}` });
      });
      server.on('error', reject);
    } catch (e) {
      reject(e);
    }
  });
}

async function createWindow() {
  let info;
  try {
    info = await startServer();
  } catch (e) {
    dialog.showErrorBox('Smart Gallery Timeline',
      'Failed to start the catalog engine:\n\n' + (e && e.stack ? e.stack : String(e)));
    app.quit();
    return;
  }
  httpServer = info.server;

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: '#0e1014',
    title: 'Smart Gallery Timeline',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  // Minimal native menu (keep accelerators like Ctrl+Q / devtools, hide the bar).
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'quit' },
      ],
    },
  ]));

  mainWindow.loadURL(info.url);

  // Open <a target="_blank"> and any window.open in the system browser instead.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

// Native folder/file pickers exposed to the renderer via preload (window.sgtNative).
const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif', 'cr2', 'cr3', 'nef', 'arw', 'dng', 'raf', 'orf', 'rw2'];

function registerIpc() {
  ipcMain.handle('pick-folders', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose folder(s) to import',
      properties: ['openDirectory', 'multiSelections'],
    });
    return r.canceled ? [] : r.filePaths;
  });

  ipcMain.handle('pick-files', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose photos to import',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Images', extensions: IMAGE_EXTS }, { name: 'All files', extensions: ['*'] }],
    });
    return r.canceled ? [] : r.filePaths;
  });

  ipcMain.handle('pick-project-dir', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: 'Open project folder',
      properties: ['openDirectory'],
    });
    return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
  });

  ipcMain.handle('new-project-dir', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose a base folder for the new project',
      buttonLabel: 'Create project here',
      properties: ['openDirectory', 'createDirectory'],
    });
    return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
  });
}

// Single-instance: focus the existing window instead of launching a second copy.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => { registerIpc(); createWindow(); });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}

app.on('window-all-closed', () => {
  if (httpServer) { try { httpServer.close(); } catch (_) { /* ignore */ } }
  app.quit();
});
