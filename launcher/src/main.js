'use strict';

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const Store = require('electron-store');
const config = require('./config');
const servers = require('./lib/servers');
const nexus = require('./lib/nexus');
const pkg = require('../package.json');

nexus.setAppIdentity('HardGamingSkyMPLauncher', pkg.version);

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

// ── nxm:// protocol ──────────────────────────────────────────────────────────
//
// Clicking "Mod Manager Download" on Nexus hands the browser an nxm:// url.
// Windows answers it by launching this app again with the url in argv, so a
// single-instance lock is not an optimisation here: without it every click
// would start a second copy that the running one never hears about.

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // A copy is already running; it has been handed our argv and will deal with it
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    handleProtocolArgs(argv);
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  // macOS delivers protocol urls through an event rather than argv
  app.on('open-url', (event, url) => {
    event.preventDefault();
    deliverNxm(url);
  });

  app.whenReady().then(() => {
    registerProtocol();
    createWindow();
    // A url that launched the app is already sitting in argv
    handleProtocolArgs(process.argv);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => app.quit());
}

function registerProtocol() {
  // In development the executable is electron itself, so the registration has
  // to name the script too or Windows would relaunch a bare Electron.
  const registered = process.defaultApp && process.argv.length >= 2
    ? app.setAsDefaultProtocolClient('nxm', process.execPath, [path.resolve(process.argv[1])])
    : app.setAsDefaultProtocolClient('nxm');

  if (!registered) {
    console.warn('could not register as the nxm:// handler; free-account downloads will not hand off');
  }
  return registered;
}

function handleProtocolArgs(argv) {
  const url = (argv || []).find((arg) => typeof arg === 'string' && arg.startsWith('nxm://'));
  if (url) deliverNxm(url);
}

// Queued rather than dropped: a click can arrive before the window exists.
let pendingNxm = [];

function deliverNxm(url) {
  const parsed = nexus.parseNxmUrl(url);
  if (!parsed) {
    console.warn('ignoring a malformed nxm url');
    return;
  }
  if (!parsed.isOurGame) {
    console.warn(`ignoring an nxm url for ${parsed.game}`);
    return;
  }

  if (win && !win.webContents.isLoading()) {
    win.webContents.send('nxm:download', parsed);
  } else {
    pendingNxm.push(parsed);
  }
}

ipcMain.handle('nxm:drain', () => {
  const queued = pendingNxm;
  pendingNxm = [];
  return queued;
});

ipcMain.handle('nxm:isRegistered', () => app.isDefaultProtocolClient('nxm'));

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

// ── Nexus account ────────────────────────────────────────────────────────────
//
// The key is validated before it is stored, so a typo is reported at sign-in
// rather than surfacing much later as a failed download.

ipcMain.handle('nexus:signIn', async (_e, apiKey) => {
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  if (!key) return { ok: false, error: 'Paste your Nexus API key first.' };

  const who = await nexus.validate(key);
  if (!who.ok) return { ok: false, error: who.error };

  store.set('nexusApiKey', key);
  store.set('nexusAccount', { name: who.name, premium: who.premium, userId: who.userId });
  return { ok: true, account: { name: who.name, premium: who.premium } };
});

ipcMain.handle('nexus:account', () => {
  const account = store.get('nexusAccount') || null;
  return {
    signedIn: !!store.get('nexusApiKey'),
    account,
    apiKeyPage: nexus.API_KEY_PAGE,
  };
});

ipcMain.handle('nexus:signOut', () => {
  store.delete('nexusApiKey');
  store.delete('nexusAccount');
  return { ok: true };
});
