'use strict';

const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const fs = require('fs');
const { execFileSync } = require('child_process');
const path = require('path');
const Store = require('electron-store');
const config = require('./config');
const servers = require('./lib/servers');
const nexus = require('./lib/nexus');
const mo2 = require('./lib/mo2');
const install = require('./lib/install');
const preflight = require('./lib/preflight');
const modpack = require('./lib/modpack');
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

// Single sign-on. The key never reaches the renderer: it arrives over the
// socket here, is validated, and only the account name and tier are returned.
ipcMain.handle('nexus:sso', async () => {
  const res = await nexus.ssoLogin(config.nexusAppSlug, (url) => shell.openExternal(url));
  if (!res.ok) return { ok: false, error: res.error };

  const who = await nexus.validate(res.apiKey);
  if (!who.ok) return { ok: false, error: who.error };

  store.set('nexusApiKey', res.apiKey);
  store.set('nexusAccount', { name: who.name, premium: who.premium, userId: who.userId });
  return { ok: true, account: { name: who.name, premium: who.premium } };
});

// ── game folder ──────────────────────────────────────────────────────────────

const SKYRIM_EXES = ['SkyrimSE.exe', 'SkyrimVR.exe'];

/** Does this look like a Skyrim install, rather than any folder at all. */
function inspectGameFolder(dir) {
  if (!dir) return { valid: false, reason: 'no folder chosen' };
  const exe = SKYRIM_EXES.find((name) => fs.existsSync(path.join(dir, name)));
  if (!exe) {
    return { valid: false, reason: 'No SkyrimSE.exe here. Pick the folder containing the game, not the Data folder.' };
  }
  // Data holds the master files the server's manifest is compared against
  if (!fs.existsSync(path.join(dir, 'Data', 'Skyrim.esm'))) {
    return { valid: false, reason: 'Found the game but not Data\\Skyrim.esm. This install looks incomplete.' };
  }
  return { valid: true, exe };
}

ipcMain.handle('game:browse', async () => {
  const picked = await dialog.showOpenDialog(win, {
    title: 'Select your Skyrim Special Edition folder',
    properties: ['openDirectory'],
    defaultPath: store.get('skyrimPath') || undefined,
  });
  if (picked.canceled || !picked.filePaths.length) return { ok: false, canceled: true };

  const dir = picked.filePaths[0];
  const check = inspectGameFolder(dir);
  // Reported rather than silently accepted: a wrong folder here surfaces much
  // later as mods that install cleanly and do nothing.
  if (!check.valid) return { ok: false, path: dir, error: check.reason };

  store.set('skyrimPath', dir);
  return { ok: true, path: dir };
});

/**
 * Guess where Skyrim is, so most players never open the picker.
 *
 * Registry first because it is authoritative, then the usual Steam library
 * locations, including the extra drives people move large games to.
 */
ipcMain.handle('game:detect', async () => {
  const candidates = [];

  for (const key of [
    'HKLM\\SOFTWARE\\WOW6432Node\\Bethesda Softworks\\Skyrim Special Edition',
    'HKLM\\SOFTWARE\\Bethesda Softworks\\Skyrim Special Edition',
  ]) {
    try {
      const out = execFileSync('reg', ['query', key, '/v', 'installed path'], {
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const match = /installed path\s+REG_SZ\s+(.+)/i.exec(out);
      if (match) candidates.push(match[1].trim());
    } catch {
      // key absent, which is normal
    }
  }

  const suffix = path.join('steamapps', 'common', 'Skyrim Special Edition');
  for (const root of [
    process.env['ProgramFiles(x86)'] ? path.join(process.env['ProgramFiles(x86)'], 'Steam') : null,
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'Steam') : null,
    ...'CDEFGH'.split('').map((d) => `${d}:\\SteamLibrary`),
    ...'CDEFGH'.split('').map((d) => `${d}:\\Steam`),
  ].filter(Boolean)) {
    candidates.push(path.join(root, suffix));
  }

  for (const dir of candidates) {
    if (inspectGameFolder(dir).valid) {
      store.set('skyrimPath', dir);
      return { ok: true, path: dir };
    }
  }
  return { ok: false, error: 'Could not find Skyrim Special Edition automatically. Use Browse to point at it.' };
});

ipcMain.handle('game:check', (_e, dir) => inspectGameFolder(dir || store.get('skyrimPath')));

/**
 * Start the game, but only once the install matches the server.
 *
 * Verifying here rather than letting the player find out at the connection is
 * the whole point: the client's rejection names an index, this names the mod.
 */
ipcMain.handle('play:launch', async (_e, server) => {
  const skyrimPath = store.get('skyrimPath');
  if (!skyrimPath) {
    return { ok: false, error: 'Set your Skyrim folder in Settings first.' };
  }
  if (!mo2.isInstalled()) {
    return { ok: false, error: 'Mod Organizer is not set up yet. Set it up in Settings.' };
  }

  const instance = mo2.ensureInstance(skyrimPath);

  // Launching plain Skyrim would start the game with no script extender, so no
  // SkyrimPlatform and no SkyMP: the player would reach the main menu wondering
  // why nothing happened.
  if (!instance.hasSkse) {
    return {
      ok: false,
      error:
        'SKSE was not found in your Skyrim folder. SkyMP runs as a SkyrimPlatform plugin, ' +
        'which needs the Script Extender. Install SKSE into the game folder and try again.',
    };
  }

  const launched = await mo2.launch('SKSE');
  if (!launched.ok) return launched;

  return { ok: true, server: server && `${server.host}:${server.port}` };
});

// ── admin: assembling and publishing a modpack ───────────────────────────────
//
// Gated on an admin key being present rather than on a role, because the key is
// what the backend actually checks. No key, no Admin tab.

ipcMain.handle('admin:status', () => ({
  enabled: !!store.get('adminKey'),
  backendUrl: backendUrl(),
}));

ipcMain.handle('admin:setKey', (_e, key) => {
  const value = typeof key === 'string' ? key.trim() : '';
  if (value) store.set('adminKey', value);
  else store.delete('adminKey');
  return { ok: true, enabled: !!value };
});

/** Resolve what an admin pasted into a mod and its downloadable files. */
ipcMain.handle('admin:resolveMod', async (_e, input) => {
  const ref = modpack.parseModRef(input);
  if (!ref) return { ok: false, error: 'Paste a Nexus mod link or a mod id.' };
  if (ref.game && ref.game !== nexus.GAME) {
    return { ok: false, error: `That link is for ${ref.game}, not Skyrim Special Edition.` };
  }

  const key = store.get('nexusApiKey');
  if (!key) return { ok: false, error: 'Sign in to Nexus first.' };

  const [mod, files] = await Promise.all([nexus.getMod(key, ref.modId), nexus.listFiles(key, ref.modId)]);
  if (!mod.ok) return { ok: false, error: mod.error };
  if (!files.ok) return { ok: false, error: files.error };

  // Old versions and archived uploads would install something no player is
  // expected to have, so only currently offered files are shown.
  const usable = files.files.filter((f) => f.category_name && f.category_name !== 'OLD_VERSION');

  return {
    ok: true,
    mod,
    suggestedFileId: ref.fileId,
    files: usable.map((f) => ({
      fileId: f.file_id,
      name: f.name,
      fileName: f.file_name,
      version: f.version,
      category: f.category_name,
      sizeKb: f.size_kb || f.size,
    })),
  };
});

/**
 * Download a file and read what it contributes.
 *
 * The archive has to be fetched and opened: its hash and plugin list are what
 * the backend requires, and neither is available from the API.
 */
ipcMain.handle('admin:addMod', async (_e, modId, fileId, displayName) => {
  const key = store.get('nexusApiKey');
  if (!key) return { ok: false, error: 'Sign in to Nexus first.' };

  const links = await nexus.getDownloadLinks(key, modId, fileId);
  if (!links.ok) {
    return {
      ok: false,
      error: links.needsHandoff
        ? 'Building a modpack needs direct downloads, which Nexus only gives Premium accounts. Sign in with a Premium account to assemble packs.'
        : links.error,
    };
  }

  const dest = path.join(mo2.getDownloadsDir(), `${modId}-${fileId}.archive`);
  fs.mkdirSync(mo2.getDownloadsDir(), { recursive: true });

  let fetched = null;
  for (const url of links.urls) {
    const res = await mo2.download(url, dest, (p) =>
      progress({ scope: 'admin', name: displayName, progress: p })
    );
    if (res.ok) {
      fetched = res;
      break;
    }
  }
  if (!fetched) return { ok: false, error: 'every download mirror failed' };

  progress({ scope: 'admin', name: displayName, phase: 'inspect' });
  const inspection = await modpack.inspectArchive(dest);
  if (!inspection.ok) return { ok: false, error: `could not read the archive: ${inspection.error}` };

  return {
    ok: true,
    entry: modpack.buildEntry({
      name: displayName,
      modId,
      fileId,
      fileName: path.basename(dest),
      inspection,
    }),
  };
});

/**
 * Load a server's published pack back into the builder.
 *
 * Editing an existing pack is the normal case: a pack gets one mod added or
 * one removed far more often than it is assembled from nothing. The published
 * entries already carry the hash and plugin list, so nothing needs
 * re-downloading to reopen a pack.
 */
ipcMain.handle('admin:loadPack', async (_e, serverId) => {
  if (!serverId) return { ok: false, error: 'no server chosen' };

  const base = backendUrl().replace(/\/+$/, '');
  const res = await servers.getJson(
    `${base}/api/servers/${encodeURIComponent(serverId)}/modlist`,
    reqOpts()
  );

  if (!res.ok) {
    // A server with nothing published yet is an empty pack, not an error
    if (res.status === 404) return { ok: true, empty: true, mods: [], serverPlugins: [], version: 0 };
    return { ok: false, error: res.error };
  }

  const body = res.body || {};
  return {
    ok: true,
    empty: false,
    version: body.version || 0,
    mods: Array.isArray(body.mods) ? body.mods : [],
    serverPlugins: Array.isArray(body.serverPlugins) ? body.serverPlugins : [],
  };
});

ipcMain.handle('admin:publish', async (_e, serverId, entries, serverPlugins) => {
  const key = store.get('adminKey');
  if (!key) return { ok: false, error: 'No admin key configured.' };
  if (!serverId) return { ok: false, error: 'Choose a server to publish to.' };

  const assembled = modpack.assemble(entries || [], serverPlugins || []);
  return modpack.publish(backendUrl(), serverId, key, assembled);
});

// ── install and play ─────────────────────────────────────────────────────────

const progress = (payload) => {
  if (win && !win.isDestroyed()) win.webContents.send('install:progress', payload);
};

ipcMain.handle('mo2:ensure', async () => {
  mo2.setLogger((...args) => console.log(...args));
  return mo2.ensureInstalled((p) => progress({ ...p, scope: 'mo2' }));
});

ipcMain.handle('install:status', () => ({
  mo2Installed: mo2.isInstalled(),
  mo2Root: mo2.getRoot(),
  skyrimPath: store.get('skyrimPath') || '',
  nxmRegistered: app.isDefaultProtocolClient('nxm'),
}));

/**
 * Fetch one file to the downloads directory.
 *
 * `nxm` carries the credential from a protocol handoff, which is what lets a
 * free account resolve a link at all.
 */
async function fetchMod(mod, nxm = null) {
  const key = store.get('nexusApiKey');
  if (!key) return { ok: false, error: 'Sign in to Nexus first.' };
  if (!mod.nexusModId || !mod.nexusFileId) {
    return { ok: false, error: `${mod.name} has no Nexus id, so it cannot be downloaded automatically.` };
  }

  const links = await nexus.getDownloadLinks(key, mod.nexusModId, mod.nexusFileId, nxm);
  if (!links.ok) return { ok: false, error: links.error, needsHandoff: links.needsHandoff };

  const dest = path.join(mo2.getDownloadsDir(), mod.fileName || `${mod.nexusModId}-${mod.nexusFileId}`);
  for (const url of links.urls) {
    const res = await mo2.download(url, dest, (p) =>
      progress({ scope: 'download', name: mod.name, progress: p })
    );
    // Nexus returns several mirrors; a dead one should not fail the install
    if (res.ok) return { ok: true, path: dest };
  }
  return { ok: false, error: `every download mirror failed for ${mod.name}` };
}

ipcMain.handle('install:modpack', async (_e, modpack) => {
  if (!mo2.isInstalled()) {
    const boot = await mo2.ensureInstalled((p) => progress({ ...p, scope: 'mo2' }));
    if (!boot.ok) return { ok: false, error: boot.error };
  }

  return install.installModpack({
    modpack,
    modsDir: mo2.getModsDir(),
    downloadsDir: mo2.getDownloadsDir(),
    resolveDownload: (mod) => fetchMod(mod),
    onProgress: (p) => progress({ ...p, scope: 'install' }),
  });
});

// Completes one mod after a free-account click-through
ipcMain.handle('install:fromHandoff', async (_e, mod, nxm) => {
  const fetched = await fetchMod(mod, nxm);
  if (!fetched.ok) return fetched;

  const actual = await install.sha256File(fetched.path);
  if (mod.sha256 && actual !== mod.sha256) {
    return { ok: false, error: `${mod.name} does not match the modpack and was not installed.` };
  }

  return install.installArchive(fetched.path, mo2.getModsDir(), mod.name || mod.fileName, {
    sha256: actual,
    fileName: mod.fileName,
    nexusModId: mod.nexusModId,
    nexusFileId: mod.nexusFileId,
    plugins: mod.plugins || [],
  });
});

/** Verify the prepared install against a server's manifest. */
ipcMain.handle('play:verify', async (_e, server) => {
  const manifestRes = await servers.getJson(
    `http://${server.host}:${server.port}/manifest.json`,
    reqOpts()
  );
  if (!manifestRes.ok) {
    return { ok: false, error: `Could not read the server's manifest: ${manifestRes.error}` };
  }

  const manifest = manifestRes.body || {};
  const skyrimPath = store.get('skyrimPath') || '';
  const dataDir = skyrimPath ? path.join(skyrimPath, 'Data') : null;

  const loadOrder = (manifest.mods || []).map((m) => m.filename);
  const installed = install.collectInstalledPlugins(loadOrder, mo2.getModsDir(), dataDir);

  const result = preflight.verify(installed, manifest);
  return { ok: result.ok, problems: result.problems, summary: preflight.summarise(result) };
});
