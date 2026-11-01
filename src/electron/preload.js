// SPDX-License-Identifier: GPL-3.0-only
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopPlayer', {
  setMiniMode: enabled => ipcRenderer.invoke('set-mini-mode', enabled),
  onMiniModeRestored: callback => {
    const handler = () => callback();
    ipcRenderer.on('mini-mode-restored', handler);
    return () => ipcRenderer.removeListener('mini-mode-restored', handler);
  }
});
