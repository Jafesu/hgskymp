'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// The renderer gets this and nothing else: no node, no fs, no arbitrary IPC.
contextBridge.exposeInMainWorld('hg', {
  listServers: () => ipcRenderer.invoke('servers:list'),
  probeServer: (address) => ipcRenderer.invoke('servers:probe', address),
  fetchModpack: (host, port) => ipcRenderer.invoke('servers:modpack', host, port),

  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:set', patch),

  toggleFavourite: (address) => ipcRenderer.invoke('favourites:toggle', address),

  openExternal: (url) => ipcRenderer.send('open:external', url),
});
