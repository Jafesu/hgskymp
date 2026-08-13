'use strict';

// End-to-end smoke test against a real listening server, using a throwaway
// data directory so it never touches a live registry.

const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'skymp-backend-test-'));
process.env.DATA_DIR = DATA;
process.env.REGISTRATION_KEY = 'reg-secret';
process.env.ADMIN_KEY = 'admin-secret';
process.env.PORT = '0';
process.env.LAUNCHER_VERSION = '1.2.3';

const app = require('../src/server');

let fail = 0;
const check = (label, cond, extra) => {
  console.log((cond ? 'PASS: ' : 'FAIL: ') + label);
  if (!cond) {
    fail = 1;
    if (extra !== undefined) console.log('      ' + JSON.stringify(extra));
  }
};

const MODS = [
  {
    name: 'SkyUI',
    nexusModId: 12604,
    nexusFileId: 749043,
    fileName: 'SkyUI.zip',
    sha256: 'a'.repeat(64),
    size: 1234,
    plugins: ['SkyUI_SE.esp'],
  },
  {
    name: 'PrettyTrees',
    fileName: 'PrettyTrees.7z',
    sha256: 'b'.repeat(64),
    size: 999,
    plugins: ['PrettyTrees.esp'],
  },
];

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const call = async (method, url, body, token) => {
    const res = await fetch(base + url, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = null;
    try { json = await res.json(); } catch {}
    return { status: res.status, json };
  };

  // ── health and launcher feed ────────────────────────────────────────────
  check('health responds', (await call('GET', '/api/health')).status === 200);
  const ver = await call('GET', '/api/launcher/version');
  check('launcher feed serves the version', ver.json && ver.json.version === '1.2.3', ver.json);

  // ── registration auth ───────────────────────────────────────────────────
  const noAuth = await call('POST', '/api/servers/register', { id: 'x', host: 'h', port: 1 });
  check('registration rejects a missing key', noAuth.status === 401, noAuth);

  const badAuth = await call('POST', '/api/servers/register', { id: 'x', host: 'h', port: 1 }, 'wrong');
  check('registration rejects a wrong key', badAuth.status === 401, badAuth);

  // ── registration validation ─────────────────────────────────────────────
  const badId = await call('POST', '/api/servers/register',
    { id: '../escape', host: 'h', port: 1 }, 'reg-secret');
  check('registration rejects a path-traversing id', badId.status === 400, badId);

  const badPort = await call('POST', '/api/servers/register',
    { id: 'hg-one', host: 'play.example', port: 99999 }, 'reg-secret');
  check('registration rejects an out-of-range port', badPort.status === 400, badPort);

  // ── happy path registration ─────────────────────────────────────────────
  const reg = await call('POST', '/api/servers/register', {
    id: 'hg-one',
    name: 'HardGaming One',
    description: 'test',
    host: 'play.example',
    port: 7777,
    maxPlayers: 50,
    players: 3,
  }, 'reg-secret');
  check('server registers', reg.status === 200 && reg.json.ok, reg.json);
  check('registered server reports online', reg.json && reg.json.server.online === true, reg.json);

  const list = await call('GET', '/api/servers');
  check('server appears in the list', list.json.servers.length === 1, list.json);
  check('list omits secrets',
    list.json.servers[0].registrationKey === undefined, list.json.servers[0]);

  // ── modlist publishing ──────────────────────────────────────────────────
  const goodModlist = {
    mods: MODS,
    // server plugins first, then the cosmetic one
    loadOrder: ['Skyrim.esm', 'SkyUI_SE.esp', 'PrettyTrees.esp'],
    serverPlugins: ['Skyrim.esm', 'SkyUI_SE.esp'],
  };

  const noKey = await call('PUT', '/api/servers/hg-one/modlist', goodModlist);
  check('publishing rejects a missing key', noKey.status === 401, noKey);

  const pub = await call('PUT', '/api/servers/hg-one/modlist', goodModlist, 'admin-secret');
  check('valid modlist publishes', pub.status === 200 && pub.json.version === 1, pub.json);

  const pub2 = await call('PUT', '/api/servers/hg-one/modlist', goodModlist, 'admin-secret');
  check('republish bumps the version', pub2.json && pub2.json.version === 2, pub2.json);

  // ── the invariant that matters ──────────────────────────────────────────
  const prefixViolation = await call('PUT', '/api/servers/hg-one/modlist', {
    mods: MODS,
    // cosmetic mod sorted BEFORE a server plugin: this is the desync bug
    loadOrder: ['Skyrim.esm', 'PrettyTrees.esp', 'SkyUI_SE.esp'],
    serverPlugins: ['Skyrim.esm', 'SkyUI_SE.esp'],
  }, 'admin-secret');
  check('prefix violation is refused', prefixViolation.status === 400, prefixViolation);
  check('prefix error explains itself',
    /prefix of loadOrder/.test(JSON.stringify(prefixViolation.json)), prefixViolation.json);

  const bsa = await call('PUT', '/api/servers/hg-one/modlist', {
    mods: MODS,
    loadOrder: ['Skyrim.esm', 'SkyUI_SE.esp', 'SkyUI.bsa'],
    serverPlugins: ['Skyrim.esm'],
  }, 'admin-secret');
  check('an archive in loadOrder is refused', bsa.status === 400, bsa);

  const unlisted = await call('PUT', '/api/servers/hg-one/modlist', {
    mods: MODS,
    loadOrder: ['Skyrim.esm', 'SkyUI_SE.esp'],
    serverPlugins: ['Skyrim.esm'],
  }, 'admin-secret');
  check('a plugin missing from loadOrder is refused', unlisted.status === 400, unlisted);
  check('unlisted error names the plugin',
    /PrettyTrees\.esp/.test(JSON.stringify(unlisted.json)), unlisted.json);

  const badHash = await call('PUT', '/api/servers/hg-one/modlist', {
    mods: [{ ...MODS[0], sha256: 'nope' }],
    loadOrder: ['SkyUI_SE.esp'],
    serverPlugins: [],
  }, 'admin-secret');
  check('a bad sha256 is refused', badHash.status === 400, badHash);

  // ── reads ───────────────────────────────────────────────────────────────
  const got = await call('GET', '/api/servers/hg-one/modlist');
  check('modlist reads back', got.status === 200 && got.json.mods.length === 2, got.json);
  check('rejected publishes did not clobber the good one',
    got.json.loadOrder.join(',') === 'Skyrim.esm,SkyUI_SE.esp,PrettyTrees.esp', got.json);

  const missing = await call('GET', '/api/servers/nope/modlist');
  check('unknown server 404s', missing.status === 404, missing);

  server.close();
  fs.rmSync(DATA, { recursive: true, force: true });
  console.log(fail ? '\nFAILURES' : '\nall checks passed');
  process.exit(fail);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
