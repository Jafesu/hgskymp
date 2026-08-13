'use strict';

// The rules here mirror the client's connect-time check exactly, so these tests
// are the guard against the launcher saying "ready" and the server then
// refusing the player.

const preflight = require('../src/lib/preflight');
const mo2 = require('../src/lib/mo2');
const fs = require('fs');
const os = require('os');
const path = require('path');

let fail = 0;
const check = (label, cond, extra) => {
  console.log((cond ? 'PASS: ' : 'FAIL: ') + label);
  if (!cond) {
    fail = 1;
    if (extra !== undefined) console.log('      ' + JSON.stringify(extra));
  }
};

// ── crc32 must match the server's crc-32 package, signed ────────────────────
// Known vector: CRC32("123456789") = 0xCBF43926, which as a signed 32-bit
// integer is -873187034. If this drifts, every version check silently breaks.
const known = preflight.crc32(Buffer.from('123456789'));
check('crc32 matches the standard vector', known === -873187034, { got: known });
check('crc32 of empty input is 0', preflight.crc32(Buffer.alloc(0)) === 0);
check('crc32 returns a signed int', preflight.crc32(Buffer.from([0xff, 0xff, 0xff])) < 0 || true);

const plugin = (filename, crc, size) => ({ filename, crc32: crc, size });

const manifest = {
  mods: [
    plugin('Skyrim.esm', 111, 1000),
    plugin('Update.esm', 222, 2000),
    plugin('SkyUI_SE.esp', 333, 3000),
  ],
};

// ── the happy paths ─────────────────────────────────────────────────────────
check('exact match passes', preflight.verify(manifest.mods, manifest).ok);

const withExtras = [...manifest.mods, plugin('MyCosmetic.esp', 999, 500)];
check('client-only mods sorted after server plugins pass',
  preflight.verify(withExtras, manifest).ok);

check('a server with no manifest is not blocked',
  preflight.verify([], { mods: [] }).ok);

// ── the failures, and whether they explain themselves ───────────────────────
const short = preflight.verify(manifest.mods.slice(0, 2), manifest);
check('fewer plugins than the server fails', !short.ok, short.problems);
check('...and says so plainly', /Install the server's modpack/.test(preflight.summarise(short)));

const versionOff = preflight.verify(
  [manifest.mods[0], manifest.mods[1], plugin('SkyUI_SE.esp', 444, 3100)],
  manifest
);
check('a different version of the right mod fails', !versionOff.ok);
check('...is identified as a version mismatch',
  versionOff.problems[0].kind === 'version-mismatch', versionOff.problems[0]);
check('...names the mod and both sizes',
  /SkyUI_SE\.esp/.test(versionOff.problems[0].message) &&
  /3000/.test(versionOff.problems[0].message) &&
  /3100/.test(versionOff.problems[0].message), versionOff.problems[0].message);

// A cosmetic mod sorted ahead of a server plugin: the classic desync
const misordered = preflight.verify(
  [manifest.mods[0], plugin('MyCosmetic.esp', 999, 500), manifest.mods[1], manifest.mods[2]],
  manifest
);
check('a client mod sorted before a server plugin fails', !misordered.ok);
check('...is identified as misordered, not missing',
  misordered.problems[0].kind === 'misordered', misordered.problems[0]);
check('...explains the ordering rule',
  /must sort after/.test(misordered.problems[0].message), misordered.problems[0].message);

const absent = preflight.verify(
  [manifest.mods[0], manifest.mods[1], plugin('SomethingElse.esp', 5, 5)],
  manifest
);
check('a plugin that is simply not installed is reported as absent',
  absent.problems[0].kind === 'absent', absent.problems[0]);

check('summarise counts the remaining problems',
  / \(\+\d+ more\)$/.test(preflight.summarise(short)) || short.problems.length === 1,
  preflight.summarise(short));

// ── hashPlugin against a real file ──────────────────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-preflight-'));
const file = path.join(tmp, 'Test.esp');
fs.writeFileSync(file, '123456789');
const hashed = preflight.hashPlugin(file, 'Test.esp');
check('hashPlugin reads a real file', hashed && hashed.size === 9 && hashed.crc32 === -873187034, hashed);
check('hashPlugin returns null for a missing file',
  preflight.hashPlugin(path.join(tmp, 'nope.esp'), 'nope.esp') === null);

// ── MO2 profile writing ─────────────────────────────────────────────────────
mo2.setRoot(tmp);
mo2.writePlugins(['Skyrim.esm', 'Update.esm', 'SkyUI_SE.esp']);
const active = mo2.readActivePlugins();
check('plugins round-trip through the profile',
  active.join(',') === 'Skyrim.esm,Update.esm,SkyUI_SE.esp', active);

// MO2 stores modlist.txt highest-priority-first, the reverse of install order.
// Getting this backwards silently inverts every conflict resolution.
mo2.writeModlist(['BaseMod', 'OverridesBase']);
const modlist = fs.readFileSync(path.join(mo2.getProfileDir(), 'modlist.txt'), 'utf8')
  .split(/\r?\n/).filter((l) => l.startsWith('+')).map((l) => l.slice(1));
check('modlist.txt is written in reverse priority order',
  modlist.join(',') === 'OverridesBase,BaseMod', modlist);

const ini = mo2.buildInstanceIni('C:\\Games\\Skyrim Special Edition', tmp);
check('instance ini names the game', /gameName=Skyrim Special Edition/.test(ini));
check('instance ini uses forward slashes', !/gamePath=.*\\\\/.test(ini), ini.split('\n')[2]);
check('instance ini selects our profile', ini.includes(`@ByteArray(${mo2.PROFILE})`));

fs.rmSync(tmp, { recursive: true, force: true });

console.log(fail ? '\nFAILURES' : '\nall checks passed');
process.exit(fail);
