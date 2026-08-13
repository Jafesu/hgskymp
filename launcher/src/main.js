'use strict';

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const Store = require('electron-store');
const config = require('./config');
const servers = require('./lib/servers');

const store = new Store({
  defaults: {
    backendUrl: config.backendUrl,
    favourites: [],
    skyrimPath: '',
  },
});

let win = null;

const backendUrl = () => store.get('backendUrl') || config.backendUrl;
const reqOpts = () => ({ timeoutMs: config.requestTimeoutMs });

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#12100f',
    show: false,
    autoHideMenuBar: true,
    icon: path.join(__dirname, '..', 'assets', 'logo.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.once('ready-to-show', () => win.show());
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Anything trying to open a new window goes to the real browser instead
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => app.quit());

// ── IPC ──────────────────────────────────────────────────────────────────────

ipcMain.handle('servers:list', async () => {
  return servers.fetchServerListWithLiveStatus(backendUrl(), reqOpts());
});

// Direct connect. Talks only to the address given, so an unlisted server works
// with no backend involved at all.
ipcMain.handle('servers:probe', async (_e, address) => {
  const parsed = servers.parseAddress(address);
  if (!parsed) return { ok: false, error: 'Enter an address like play.example.com or play.example.com:40027' };

  const status = await servers.fetchStatus(parsed.host, parsed.port, reqOpts());
  if (!status.online) {
    return { ok: false, error: `No server answered at ${parsed.host}:${parsed.port} (${status.error})` };
  }
  return { ok: true, server: { id: null, ...status, host: parsed.host, port: parsed.port } };
});

ipcMain.handle('servers:modpack', async (_e, host, port) => {
  return servers.fetchModpack(host, port, reqOpts());
});

ipcMain.handle('settings:get', () => ({
  backendUrl: backendUrl(),
  favourites: store.get('favourites'),
  skyrimPath: store.get('skyrimPath'),
  brand: config.brand,
  refreshIntervalMs: config.refreshIntervalMs,
}));

ipcMain.handle('settings:set', (_e, patch) => {
  if (!patch || typeof patch !== 'object') return { ok: false };
  for (const key of ['backendUrl', 'skyrimPath']) {
    if (typeof patch[key] === 'string') store.set(key, patch[key].trim());
  }
  if (Array.isArray(patch.favourites)) store.set('favourites', patch.favourites);
  return { ok: true };
});

ipcMain.handle('favourites:toggle', (_e, address) => {
  const parsed = servers.parseAddress(address);
  if (!parsed) return { ok: false, error: 'invalid address' };
  const key = `${parsed.host}:${parsed.port}`;

  const current = store.get('favourites') || [];
  const next = current.includes(key) ? current.filter((f) => f !== key) : [...current, key];
  store.set('favourites', next);
  return { ok: true, favourites: next, favourited: next.includes(key) };
});

ipcMain.on('open:external', (_e, url) => {
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) shell.openExternal(url);
});
