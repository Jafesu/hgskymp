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

  // Play needs an install pipeline that does not exist yet
  $('sheet-play').disabled = true;
  $('sheet-play').title = 'Mod installation is not implemented yet';

  const pack = await window.hg.fetchModpack(server.host, server.port);
  if (pack.ok) {
    const mods = (pack.modpack.mods || []).length;
    const version = pack.modpack.version;
    $('sheet-modpack').textContent = `${mods} mod${mods === 1 ? '' : 's'} (v${version})`;
  } else if (pack.notPublished) {
    $('sheet-modpack').textContent = 'none published';
    $('sheet-note').textContent = 'This server has no modpack, so vanilla Skyrim is all you need.';
  } else {
    $('sheet-modpack').textContent = 'unavailable';
    $('sheet-note').textContent = `Could not read the modpack: ${pack.error}`;
  }
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

// ── boot ─────────────────────────────────────────────────────────────────────

(async () => {
  settings = await window.hg.getSettings();
  $('setting-backend').value = settings.backendUrl || '';
  $('setting-skyrim').value = settings.skyrimPath || '';

  await refresh();
  refreshTimer = setInterval(refresh, settings.refreshIntervalMs);
})();
