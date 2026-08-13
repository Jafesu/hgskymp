'use strict';

const $ = (id) => document.getElementById(id);

let settings = { refreshIntervalMs: 20000, favourites: [] };
let refreshTimer = null;
let current = null; // server shown in the sheet

// ── tabs ─────────────────────────────────────────────────────────────────────

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('is-active'));
    document.querySelectorAll('.view').forEach((v) => v.classList.remove('is-active'));
    tab.classList.add('is-active');
    $(`view-${tab.dataset.view}`).classList.add('is-active');
  });
});

// ── server list ──────────────────────────────────────────────────────────────

const addressOf = (s) => `${s.host}:${s.port}`;

function renderServers(list) {
  const ul = $('server-list');
  ul.textContent = '';

  if (!list.length) {
    $('list-empty').hidden = false;
    return;
  }
  $('list-empty').hidden = true;

  for (const server of list) {
    const li = document.createElement('li');
    li.className = 'server-row';

    const dot = document.createElement('span');
    dot.className = `dot${server.online ? ' is-online' : ''}`;

    const main = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'server-name';
    name.textContent = server.name || addressOf(server);
    main.appendChild(name);

    if (server.description) {
      const desc = document.createElement('div');
      desc.className = 'server-desc';
      desc.textContent = server.description;
      main.appendChild(desc);
    }

    const players = document.createElement('span');
    players.className = 'server-meta';
    players.textContent = server.online
      ? `${server.players ?? 0} / ${server.maxPlayers ?? '?'}`
      : 'offline';

    const ping = document.createElement('span');
    ping.className = 'server-meta';
    ping.textContent = server.online && typeof server.ping === 'number' ? `${server.ping} ms` : '';

    const flag = document.createElement('span');
    if (settings.favourites.includes(addressOf(server))) {
      flag.className = 'badge';
      flag.textContent = 'saved';
    }

    li.append(dot, main, players, ping, flag);
    li.addEventListener('click', () => openSheet(server));
    ul.appendChild(li);
  }
}

async function refresh() {
  $('list-status').textContent = 'refreshing...';
  const res = await window.hg.listServers();
  if (!res.ok) {
    // Not an error state worth shouting about: direct connect still works, and
    // a launcher that cannot reach the backend is still useful.
    $('list-status').textContent = 'server list unavailable';
    renderServers([]);
    $('list-empty').hidden = false;
    $('list-empty').textContent =
      'Could not reach the server list. You can still connect directly using the address box above.';
    return;
  }
  $('list-status').textContent = '';
  $('list-empty').textContent =
    'No servers listed yet. Use the address box above to connect directly.';
  renderServers(res.servers);
}

$('btn-refresh').addEventListener('click', refresh);

// ── direct connect ───────────────────────────────────────────────────────────

async function connectDirect() {
  const address = $('direct-address').value;
  const err = $('direct-error');
  err.hidden = true;

  $('btn-connect').disabled = true;
  try {
    const res = await window.hg.probeServer(address);
    if (!res.ok) {
      err.textContent = res.error;
      err.hidden = false;
      return;
    }
    openSheet(res.server);
  } finally {
    $('btn-connect').disabled = false;
  }
}

$('btn-connect').addEventListener('click', connectDirect);
$('direct-address').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') connectDirect();
});

// ── detail sheet ─────────────────────────────────────────────────────────────

async function openSheet(server) {
  current = server;
  $('sheet-name').textContent = server.name || addressOf(server);
  $('sheet-address').textContent = addressOf(server);
  $('sheet-status').textContent = server.online ? 'Online' : 'Offline';
  $('sheet-players').textContent = server.online
    ? `${server.players ?? 0} / ${server.maxPlayers ?? '?'}`
    : '-';
  $('sheet-ping').textContent =
    server.online && typeof server.ping === 'number' ? `${server.ping} ms` : '-';
  $('sheet-modpack').textContent = 'checking...';
  $('sheet-note').textContent = '';

  $('sheet-fav').textContent = settings.favourites.includes(addressOf(server))
    ? 'Remove from saved'
    : 'Save server';

  $('sheet').hidden = false;
  $('sheet-progress').hidden = true;
  $('sheet-install').hidden = true;
  showProblems([]);
  currentModpack = null;

  const pack = await window.hg.fetchModpack(server.host, server.port);
  if (pack.ok) {
    currentModpack = pack.modpack;
    const mods = (pack.modpack.mods || []).length;
    $('sheet-modpack').textContent = `${mods} mod${mods === 1 ? '' : 's'} (v${pack.modpack.version})`;
  } else if (pack.notPublished) {
    $('sheet-modpack').textContent = 'none published';
    $('sheet-note').textContent = 'This server has no modpack, so vanilla Skyrim is all you need.';
  } else {
    $('sheet-modpack').textContent = 'unavailable';
    $('sheet-note').textContent = `Could not read the modpack: ${pack.error}`;
  }

  await refreshPlayState();
}

function closeSheet() {
  $('sheet').hidden = true;
  current = null;
}

$('sheet-close').addEventListener('click', closeSheet);
$('sheet').addEventListener('click', (e) => {
  if (e.target === $('sheet')) closeSheet();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('sheet').hidden) closeSheet();
});

$('sheet-fav').addEventListener('click', async () => {
  if (!current) return;
  const res = await window.hg.toggleFavourite(addressOf(current));
  if (!res.ok) return;
  settings.favourites = res.favourites;
  $('sheet-fav').textContent = res.favourited ? 'Remove from saved' : 'Save server';
  refresh();
});

// ── settings ─────────────────────────────────────────────────────────────────

$('btn-save-settings').addEventListener('click', async () => {
  await window.hg.saveSettings({
    backendUrl: $('setting-backend').value,
    skyrimPath: $('setting-skyrim').value,
  });
  settings = { ...settings, ...(await window.hg.getSettings()) };
  const saved = $('settings-saved');
  saved.hidden = false;
  setTimeout(() => { saved.hidden = true; }, 2000);
  refresh();
});

// ── Nexus account ────────────────────────────────────────────────────────────

let account = { signedIn: false, account: null, apiKeyPage: '' };

function renderAccount() {
  $('nexus-signed-out').hidden = account.signedIn;
  $('nexus-signed-in').hidden = !account.signedIn;
  if (!account.signedIn || !account.account) return;

  $('nexus-name').textContent = account.account.name;
  $('nexus-tier').textContent = account.account.premium ? 'premium' : 'free';
  // The tier decides how much clicking a modpack install costs, so it is
  // stated plainly rather than left for the player to discover mid-install.
  $('nexus-tier-hint').textContent = account.account.premium
    ? 'Modpacks install automatically.'
    : 'Nexus only gives Premium accounts automatic downloads, so free accounts confirm each mod on the Nexus site. The launcher opens each page for you.';
}

$('btn-nexus-sso').addEventListener('click', async () => {
  const err = $('nexus-error');
  err.hidden = true;
  const btn = $('btn-nexus-sso');
  btn.disabled = true;
  btn.textContent = 'Waiting for Nexus...';
  try {
    const res = await window.hg.nexusSso();
    if (!res.ok) {
      // SSO needs an application slug Nexus recognises, so failure here is
      // plausible and must not be a dead end: point at the key instead.
      err.textContent = `${res.error} You can still sign in with an API key.`;
      err.hidden = false;
      $('nexus-manual').hidden = false;
      return;
    }
    account = await window.hg.nexusAccount();
    renderAccount();
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sign in with Nexus';
  }
});

$('btn-nexus-manual').addEventListener('click', () => {
  $('nexus-manual').hidden = !$('nexus-manual').hidden;
});

$('btn-nexus-signin').addEventListener('click', async () => {
  const err = $('nexus-error');
  err.hidden = true;
  $('btn-nexus-signin').disabled = true;
  try {
    const res = await window.hg.nexusSignIn($('nexus-key').value);
    if (!res.ok) {
      err.textContent = res.error;
      err.hidden = false;
      return;
    }
    $('nexus-key').value = '';
    account = await window.hg.nexusAccount();
    renderAccount();
  } finally {
    $('btn-nexus-signin').disabled = false;
  }
});

$('btn-nexus-signout').addEventListener('click', async () => {
  await window.hg.nexusSignOut();
  account = await window.hg.nexusAccount();
  renderAccount();
});

$('link-api-keys').addEventListener('click', (e) => {
  e.preventDefault();
  window.hg.openExternal(account.apiKeyPage);
});

// ── game folder ──────────────────────────────────────────────────────────────

function showSkyrim(pathValue, message, bad) {
  $('setting-skyrim').value = pathValue || '';
  const hint = $('skyrim-hint');
  hint.textContent = message || 'Used to install mods and launch the game.';
  hint.style.color = bad ? 'var(--accent-hot)' : '';
}

$('btn-skyrim-browse').addEventListener('click', async () => {
  const res = await window.hg.browseGameFolder();
  if (res.canceled) return;
  if (!res.ok) {
    // The folder is shown alongside the reason, so it is obvious which one
    // was rejected rather than leaving the player guessing.
    showSkyrim(res.path || $('setting-skyrim').value, res.error, true);
    return;
  }
  showSkyrim(res.path, 'Skyrim found here.');
});

$('btn-skyrim-detect').addEventListener('click', async () => {
  const btn = $('btn-skyrim-detect');
  btn.disabled = true;
  try {
    const res = await window.hg.detectGameFolder();
    if (!res.ok) {
      showSkyrim($('setting-skyrim').value, res.error, true);
      return;
    }
    showSkyrim(res.path, 'Found automatically.');
  } finally {
    btn.disabled = false;
  }
});

// ── Mod Organizer state ──────────────────────────────────────────────────────

async function renderMo2() {
  const status = await window.hg.installStatus();
  $('mo2-state').textContent = status.mo2Installed ? 'Ready' : 'Not set up yet';
  $('btn-mo2-install').hidden = status.mo2Installed;
  return status;
}

$('btn-mo2-install').addEventListener('click', async () => {
  $('btn-mo2-install').disabled = true;
  $('mo2-state').textContent = 'Setting up...';
  const res = await window.hg.ensureMo2();
  $('mo2-state').textContent = res.ok ? 'Ready' : `Failed: ${res.error}`;
  $('btn-mo2-install').disabled = false;
  renderMo2();
});

// ── install and play ─────────────────────────────────────────────────────────

let currentModpack = null;

window.hg.onInstallProgress((p) => {
  const bar = $('sheet-progress');
  const fill = $('sheet-progress-fill');
  const text = $('sheet-progress-text');
  bar.hidden = false;

  if (p.scope === 'mo2') {
    text.textContent = p.phase === 'download' ? 'Downloading Mod Organizer...' : 'Unpacking Mod Organizer...';
    fill.style.width = `${Math.round((p.progress || 0) * 100)}%`;
  } else if (p.scope === 'download') {
    text.textContent = `Downloading ${p.name}...`;
    fill.style.width = `${Math.round((p.progress || 0) * 100)}%`;
  } else if (p.scope === 'install' && p.phase === 'mod') {
    text.textContent = `Installing ${p.name} (${p.index + 1} of ${p.total})`;
    fill.style.width = `${Math.round(((p.index + 1) / p.total) * 100)}%`;
  } else if (p.phase === 'done') {
    text.textContent = 'Finishing up...';
  }
});

function showProblems(problems) {
  const ul = $('sheet-problems');
  ul.textContent = '';
  if (!problems || !problems.length) {
    ul.hidden = true;
    return;
  }
  for (const problem of problems) {
    const li = document.createElement('li');
    li.textContent = problem.message;
    ul.appendChild(li);
  }
  ul.hidden = false;
}

$('sheet-install').addEventListener('click', async () => {
  if (!currentModpack) return;
  $('sheet-install').disabled = true;
  showProblems([]);
  $('sheet-note').textContent = '';

  try {
    const res = await window.hg.installModpack(currentModpack);
    $('sheet-progress').hidden = true;

    if (res.ok) {
      $('sheet-note').textContent =
        `Installed ${res.installed.length} mod(s), ${res.skipped.length} already up to date.`;
      await refreshPlayState();
      return;
    }

    if (res.pending && res.pending.length) {
      // Not a failure: this is the free-account path beginning.
      $('sheet-note').textContent =
        `${res.pending.length} mod(s) need confirming on the Nexus site. ` +
        `Opening the first now; click "Mod Manager Download" and the launcher will take it from there.`;
      // Handing over more than one page at a time buries the browser
      window.hg.openExternal(
        `https://www.nexusmods.com/skyrimspecialedition/mods/${res.pending[0].mod.nexusModId}?tab=files&file_id=${res.pending[0].mod.nexusFileId}&nmm=1`
      );
    }

    showProblems((res.failed || []).map((f) => ({ message: `${f.name}: ${f.error}` })));
  } finally {
    $('sheet-install').disabled = false;
  }
});

/** Ask the main process whether this install satisfies the server. */
async function refreshPlayState() {
  if (!current || !current.online) {
    $('sheet-play').disabled = true;
    return;
  }

  $('sheet-play').disabled = true;
  $('sheet-play').textContent = 'Checking...';
  const res = await window.hg.verifyForPlay(current);
  $('sheet-play').textContent = 'Play';

  if (res.ok) {
    showProblems([]);
    $('sheet-play').disabled = false;
    $('sheet-install').hidden = true;
    $('sheet-note').textContent = 'This install matches the server.';
    return;
  }

  // Verifying before launch means a mismatch is explained here, rather than
  // becoming a refused connection after a full Skyrim load.
  showProblems(res.problems || [{ message: res.error }]);
  $('sheet-install').hidden = !currentModpack;
  $('sheet-note').textContent = currentModpack
    ? 'Install the modpack to fix this.'
    : '';
}

// ── boot ─────────────────────────────────────────────────────────────────────

// A protocol click can arrive before this window exists, so anything queued in
// the main process is drained on startup as well as listened for live.
async function handleNxm(parsed) {
  if (!currentModpack) return;
  const mod = (currentModpack.mods || []).find(
    (m) => m.nexusModId === parsed.modId && m.nexusFileId === parsed.fileId
  );
  if (!mod) return;

  $('sheet-note').textContent = `Downloading ${mod.name}...`;
  const res = await window.hg.installFromHandoff(mod, parsed);
  $('sheet-note').textContent = res.ok
    ? `${mod.name} installed.`
    : `${mod.name} failed: ${res.error}`;
  await refreshPlayState();
}

window.hg.onNxmDownload(handleNxm);

(async () => {
  settings = await window.hg.getSettings();
  $('setting-backend').value = settings.backendUrl || '';
  $('setting-skyrim').value = settings.skyrimPath || '';

  account = await window.hg.nexusAccount();
  renderAccount();
  renderMo2();

  for (const queued of await window.hg.drainNxm()) handleNxm(queued);

  await refresh();
  refreshTimer = setInterval(refresh, settings.refreshIntervalMs);
})();
