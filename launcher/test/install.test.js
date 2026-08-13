'use strict';

// Real archives and a real filesystem: the failure modes here are all about
// what ends up on disk, so mocking the filesystem would test nothing.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const install = require('../src/lib/install');
const mo2 = require('../src/lib/mo2');

let fail = 0;
const check = (label, cond, extra) => {
  console.log((cond ? 'PASS: ' : 'FAIL: ') + label);
  if (!cond) {
    fail = 1;
    if (extra !== undefined) console.log('      ' + JSON.stringify(extra));
  }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-install-'));
const { path7za } = require('7zip-bin');

/** Build a 7z whose contents are laid out by `files`. */
function makeArchive(name, files) {
  const stage = path.join(tmp, 'stage', name);
  fs.rmSync(stage, { recursive: true, force: true });
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(stage, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
  const archive = path.join(tmp, `${name}.7z`);
  fs.rmSync(archive, { force: true });
  execFileSync(path7za, ['a', '-t7z', archive, path.join(stage, '*'), '-bso0', '-bse0'], { windowsHide: true });
  return archive;
}

const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

(async () => {
  // ── name sanitising ───────────────────────────────────────────────────────
  check('strips path separators from mod names',
    install.safeModName('evil/../name') === 'evil..name', install.safeModName('evil/../name'));
  check('strips characters Windows refuses',
    install.safeModName('a<b>c:d"e|f?g*h') === 'abcdefgh', install.safeModName('a<b>c:d"e|f?g*h'));
  check('falls back for an empty name', install.safeModName('   ') === 'Unnamed mod');
  check('caps absurd lengths', install.safeModName('x'.repeat(500)).length === 96);

  // A modpack is untrusted input and the name lands in a path this module
  // deletes. ".." survives separator stripping and resolves to the parent.
  check('a name of ".." cannot escape the mods directory',
    install.safeModName('..') === 'Unnamed mod', install.safeModName('..'));
  check('a name of "." is refused too', install.safeModName('.') === 'Unnamed mod');
  check('any all-dots name is refused', install.safeModName('.....') === 'Unnamed mod');
  check('a separator-only name is refused', install.safeModName('///') === 'Unnamed mod');
  check('reserved device names are escaped', install.safeModName('CON') === '_CON');
  check('a trailing dot is dropped, since Windows drops it silently',
    install.safeModName('Mod.') === 'Mod', install.safeModName('Mod.'));

  // Prove it: joining the sanitised name must stay inside the mods directory
  const escapeAttempt = path.join('/mods', install.safeModName('..'));
  check('...so the resolved path stays under the mods directory',
    path.resolve(escapeAttempt).includes('mods'), escapeAttempt);

  const modsDir = path.join(tmp, 'mods');
  const downloadsDir = path.join(tmp, 'downloads');

  // ── wrapper lifting ───────────────────────────────────────────────────────
  const wrapped = makeArchive('wrapped', {
    'SomeMod-1.2/Data/textures/a.dds': 'tex',
    'SomeMod-1.2/SomeMod.esp': 'plugin',
  });
  let res = await install.installArchive(wrapped, modsDir, 'Wrapped Mod', { sha256: 'x' });
  check('archive installs', res.ok, res);
  check('a single wrapper folder is lifted away',
    fs.existsSync(path.join(modsDir, 'Wrapped Mod', 'SomeMod.esp')),
    fs.readdirSync(path.join(modsDir, 'Wrapped Mod')));

  // A mod whose real layout starts with a data folder must NOT be lifted, or
  // its files end up one level too high and the game never sees them.
  const dataRoot = makeArchive('dataroot', { 'textures/b.dds': 'tex' });
  res = await install.installArchive(dataRoot, modsDir, 'Data Root Mod', { sha256: 'y' });
  check('a data folder at the root is left alone',
    fs.existsSync(path.join(modsDir, 'Data Root Mod', 'textures', 'b.dds')),
    fs.readdirSync(path.join(modsDir, 'Data Root Mod')));

  // ── stamping and re-runs ──────────────────────────────────────────────────
  check('a stamp is written', fs.existsSync(path.join(modsDir, 'Wrapped Mod', install.STAMP)));
  check('meta.ini is written for MO2', fs.existsSync(path.join(modsDir, 'Wrapped Mod', 'meta.ini')));
  check('isInstalled matches on hash', install.isInstalled(modsDir, 'Wrapped Mod', 'x'));
  check('isInstalled rejects a different hash', !install.isInstalled(modsDir, 'Wrapped Mod', 'other'));
  check('isInstalled is false for an absent mod', !install.isInstalled(modsDir, 'Never Installed', 'x'));

  // Reinstalling must replace, not merge: a leftover file from an old version
  // produces a state no release ever shipped.
  fs.writeFileSync(path.join(modsDir, 'Wrapped Mod', 'leftover.esp'), 'stale');
  await install.installArchive(wrapped, modsDir, 'Wrapped Mod', { sha256: 'x' });
  check('reinstalling clears leftovers from the previous version',
    !fs.existsSync(path.join(modsDir, 'Wrapped Mod', 'leftover.esp')));

  // ── whole-modpack install ─────────────────────────────────────────────────
  mo2.setRoot(path.join(tmp, 'instance'));

  const modA = makeArchive('modA', { 'ModA.esp': 'aaa' });
  const modB = makeArchive('modB', { 'ModB.esp': 'bbb' });

  const modpack = {
    version: 1,
    mods: [
      { name: 'Mod A', fileName: 'modA.7z', sha256: sha(modA), size: 1, plugins: ['ModA.esp'] },
      { name: 'Mod B', fileName: 'modB.7z', sha256: sha(modB), size: 1, plugins: ['ModB.esp'] },
    ],
    loadOrder: ['Skyrim.esm', 'ModA.esp', 'ModB.esp'],
  };

  const resolver = (mod) => ({ ok: true, path: mod.fileName === 'modA.7z' ? modA : modB });

  let out = await install.installModpack({ modpack, modsDir, downloadsDir, resolveDownload: resolver });
  check('a full modpack installs', out.ok, out);
  check('both mods installed', out.installed.length === 2, out);
  check('the profile load order is written',
    mo2.readActivePlugins().join(',') === 'Skyrim.esm,ModA.esp,ModB.esp', mo2.readActivePlugins());

  // Second run should do nothing
  out = await install.installModpack({ modpack, modsDir, downloadsDir, resolveDownload: resolver });
  check('a second run skips what is already correct', out.skipped.length === 2 && out.installed.length === 0, out);

  // ── hash mismatch must stop the install ───────────────────────────────────
  const tampered = {
    ...modpack,
    mods: [{ ...modpack.mods[0], name: 'Tampered', sha256: 'f'.repeat(64) }],
  };
  out = await install.installModpack({ modpack: tampered, modsDir, downloadsDir, resolveDownload: () => ({ ok: true, path: modA }) });
  check('a file that does not match the modpack is refused', !out.ok && out.failed.length === 1, out);
  check('...and says what it expected', /does not match the modpack/.test(out.failed[0].error), out.failed[0]);
  check('...and is not installed', !install.isInstalled(modsDir, 'Tampered', 'f'.repeat(64)));

  // ── the free-account path is not a failure ────────────────────────────────
  out = await install.installModpack({
    modpack,
    modsDir: path.join(tmp, 'mods2'),
    downloadsDir,
    resolveDownload: () => ({ ok: false, needsHandoff: true }),
  });
  check('a handoff requirement is reported as pending, not failed',
    out.pending.length === 2 && out.failed.length === 0, out);

  // ── a partial install must not write a load order ─────────────────────────
  const instance2 = path.join(tmp, 'instance2');
  mo2.setRoot(instance2);
  out = await install.installModpack({
    modpack,
    modsDir: path.join(tmp, 'mods3'),
    downloadsDir,
    resolveDownload: (mod) => (mod.name === 'Mod A' ? { ok: true, path: modA } : { ok: false, error: 'nope' }),
  });
  check('a partial install fails', !out.ok, out);
  check('...and writes no load order, since a partial one is rejected at connect time',
    !fs.existsSync(path.join(mo2.getProfileDir(), 'plugins.txt')));

  const empty = await install.installModpack({ modpack: { mods: [] }, modsDir, downloadsDir, resolveDownload: resolver });
  check('an empty modpack is refused', empty.ok === false, empty);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(fail ? '\nFAILURES' : '\nall checks passed');
  process.exit(fail);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
