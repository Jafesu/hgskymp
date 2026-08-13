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

  // nxm:// handoff, the free-account download path
  onNxmDownload: (cb) => ipcRenderer.on('nxm:download', (_e, parsed) => cb(parsed)),
  drainNxm: () => ipcRenderer.invoke('nxm:drain'),
  isNxmRegistered: () => ipcRenderer.invoke('nxm:isRegistered'),

  // Nexus account
  nexusSignIn: (apiKey) => ipcRenderer.invoke('nexus:signIn', apiKey),
  nexusAccount: () => ipcRenderer.invoke('nexus:account'),
  nexusSignOut: () => ipcRenderer.invoke('nexus:signOut'),
  nexusSso: () => ipcRenderer.invoke('nexus:sso'),

  // Modpack building (admin)
  adminStatus: () => ipcRenderer.invoke('admin:status'),
  adminSetKey: (key) => ipcRenderer.invoke('admin:setKey', key),
  adminResolveMod: (ref) => ipcRenderer.invoke('admin:resolveMod', ref),
  adminAddMod: (modId, fileId, name) => ipcRenderer.invoke('admin:addMod', modId, fileId, name),
  adminPublish: (serverId, entries, serverPlugins) =>
    ipcRenderer.invoke('admin:publish', serverId, entries, serverPlugins),

  // Game folder
  browseGameFolder: () => ipcRenderer.invoke('game:browse'),
  detectGameFolder: () => ipcRenderer.invoke('game:detect'),
  checkGameFolder: (dir) => ipcRenderer.invoke('game:check', dir),

  // Install and play
  installStatus: () => ipcRenderer.invoke('install:status'),
  ensureMo2: () => ipcRenderer.invoke('mo2:ensure'),
  installModpack: (modpack) => ipcRenderer.invoke('install:modpack', modpack),
  installFromHandoff: (mod, nxm) => ipcRenderer.invoke('install:fromHandoff', mod, nxm),
  verifyForPlay: (server) => ipcRenderer.invoke('play:verify', server),
  launchGame: (server) => ipcRenderer.invoke('play:launch', server),
  onInstallProgress: (cb) => ipcRenderer.on('install:progress', (_e, p) => cb(p)),
});
