'use strict';

// Ends by publishing to the real backend, because the thing most worth proving
// is that what this module assembles is something the backend will actually
// accept. Its validation rules are the client's connect-time rules, so a
// modpack that fails there would have become a player who cannot join.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const modpack = require('../src/lib/modpack');

let fail = 0;
const check = (label, cond, extra) => {
  console.log((cond ? 'PASS: ' : 'FAIL: ') + label);
  if (!cond) {
    fail = 1;
    if (extra !== undefined) console.log('      ' + JSON.stringify(extra));
  }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-modpack-'));

(async () => {
  // ── parsing what an admin pastes ──────────────────────────────────────────
  check('bare mod id', JSON.stringify(modpack.parseModRef('12604')) === '{"modId":12604,"fileId":null}');

  const withFile = modpack.parseModRef(
    'https://www.nexusmods.com/skyrimspecialedition/mods/12604?tab=files&file_id=749043'
  );
  check('full url with a selected file',
    withFile.modId === 12604 && withFile.fileId === 749043, withFile);
  check('...and reports the game', withFile.game === 'skyrimspecialedition', withFile);

  check('url without a scheme',
    modpack.parseModRef('nexusmods.com/skyrimspecialedition/mods/12604').modId === 12604);
  check('plain mod page has no file id',
    modpack.parseModRef('https://www.nexusmods.com/skyrimspecialedition/mods/12604').fileId === null);

  // A url from somewhere else must not be treated as a Nexus mod
  check('a non-Nexus host is refused',
    modpack.parseModRef('https://evil.example.com/skyrimspecialedition/mods/1') === null);
  check('a lookalike host is refused',
    modpack.parseModRef('https://nexusmods.com.evil.example/mods/1') === null);
  check('garbage is refused', modpack.parseModRef('hello') === null);
  check('empty is refused', modpack.parseModRef('  ') === null);

  // ── inspecting an archive ─────────────────────────────────────────────────
  const stage = path.join(tmp, 'stage');
  fs.mkdirSync(path.join(stage, 'Data', 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(stage, 'Data', 'CoolMod.esp'), 'plugin one');
  fs.writeFileSync(path.join(stage, 'Data', 'CoolMod - Patch.esl'), 'plugin two');
  fs.writeFileSync(path.join(stage, 'Data', 'scripts', 'thing.pex'), 'script');
  fs.writeFileSync(path.join(stage, 'readme.txt'), 'not a plugin');

  const archive = path.join(tmp, 'CoolMod.7z');
  const { path7za } = require('7zip-bin');
  execFileSync(path7za, ['a', '-t7z', archive, path.join(stage, '*'), '-bso0', '-bse0'], { windowsHide: true });

  const inspection = await modpack.inspectArchive(archive);
  check('archive inspected', inspection.ok, inspection);
  check('finds plugins nested inside the archive',
    inspection.plugins.join(',') === 'CoolMod - Patch.esl,CoolMod.esp', inspection.plugins);
  check('ignores non-plugin files', !inspection.plugins.some((p) => /pex|txt/.test(p)));
  check('hashes the archive', /^[a-f0-9]{64}$/.test(inspection.sha256), inspection.sha256);
  check('records the size', inspection.size > 0);

  const badArchive = await modpack.inspectArchive(path.join(tmp, 'nope.7z'));
  check('a missing archive fails rather than throwing', badArchive.ok === false);

  // ── assembling ────────────────────────────────────────────────────────────
  const entryA = modpack.buildEntry({
    name: 'Cool Mod', modId: 1, fileId: 2, fileName: 'CoolMod.7z', inspection,
  });
  check('entry carries everything the backend requires',
    entryA.name && entryA.sha256 && entryA.size && Array.isArray(entryA.plugins), entryA);

  const entryB = {
    name: 'Pretty Trees', nexusModId: 3, nexusFileId: 4, fileName: 'Trees.7z',
    sha256: 'b'.repeat(64), size: 10, plugins: ['PrettyTrees.esp'],
  };

  // Server plugins must come first: the client compares index by index and a
  // client-only mod ahead of a server one breaks every later index.
  const assembled = modpack.assemble([entryA, entryB], ['CoolMod.esp']);
  check('server plugins are emitted first',
    assembled.loadOrder[0] === 'CoolMod.esp', assembled.loadOrder);
  check('serverPlugins is a prefix of loadOrder',
    assembled.serverPlugins.every((p, i) => assembled.loadOrder[i] === p), assembled);
  check('every plugin appears in the load order',
    assembled.loadOrder.length === 3, assembled.loadOrder);

  // ── publishing to the real backend ────────────────────────────────────────
  const BACKEND = process.env.HG_TEST_BACKEND || 'http://127.0.0.1:8099';

  // Plain http rather than fetch: undici keeps sockets alive, and tearing
  // those down with process.exit trips a libuv assertion that would fail the
  // run even when every check passed.
  const httpJson = (url, method = 'GET', body = null, token = null) =>
    new Promise((resolve) => {
      const target = new URL(url);
      const payload = body ? JSON.stringify(body) : null;
      const req = require('http').request(
        target,
        {
          method,
          agent: false,
          headers: {
            ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          },
        },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => resolve({ status: res.statusCode, data }));
        }
      );
      req.on('error', () => resolve({ status: 0 }));
      req.setTimeout(3000, () => { req.destroy(); resolve({ status: 0 }); });
      if (payload) req.write(payload);
      req.end();
    });

  const health = await httpJson(`${BACKEND}/api/health`);
  const reachable = health.status === 200;

  if (!reachable) {
    console.log('SKIP: backend not running, publish checks skipped');
  } else {
    await httpJson(`${BACKEND}/api/servers/register`, 'POST', {
      id: 'modpack-test', name: 'Modpack Test', host: '127.0.0.1', port: 7777,
    }, 'demo-reg');

    const noKey = await modpack.publish(BACKEND, 'modpack-test', '', assembled);
    check('publishing without an admin key is refused', noKey.ok === false, noKey);

    const wrongKey = await modpack.publish(BACKEND, 'modpack-test', 'nope', assembled);
    check('publishing with a wrong key is refused', wrongKey.ok === false, wrongKey);

    const good = await modpack.publish(BACKEND, 'modpack-test', 'demo-admin', assembled);
    check('a well-formed modpack is accepted by the real backend', good.ok, good);
    check('...and comes back with a version', typeof good.version === 'number', good);

    // Prove the prefix rule is actually enforced end to end
    const broken = {
      ...assembled,
      loadOrder: ['PrettyTrees.esp', 'CoolMod.esp', 'CoolMod - Patch.esl'],
      serverPlugins: ['CoolMod.esp'],
    };
    const rejected = await modpack.publish(BACKEND, 'modpack-test', 'demo-admin', broken);
    check('a modpack breaking the prefix rule is rejected', rejected.ok === false, rejected);
    check('...with the reason surfaced for the admin',
      JSON.stringify(rejected.details || '').includes('prefix'), rejected.details);
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(fail ? '\nFAILURES' : '\nall checks passed');
  process.exit(fail);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
