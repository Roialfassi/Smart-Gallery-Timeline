'use strict';

/*
 * Bridges native OS file/folder pickers to the (sandboxed, contextIsolated)
 * renderer. The web UI feature-detects `window.sgtNative`: when present it uses
 * real dialogs; when absent (plain browser via `npm start`) it falls back to
 * typed-path inputs. Keep this surface tiny — only directory/file selection.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sgtNative', {
  isElectron: true,
  pickFolders: () => ipcRenderer.invoke('pick-folders'),
  pickFiles: () => ipcRenderer.invoke('pick-files'),
  pickProjectDir: () => ipcRenderer.invoke('pick-project-dir'),
  newProjectDir: () => ipcRenderer.invoke('new-project-dir'),
  appVersion: () => ipcRenderer.invoke('app-version'),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
});
