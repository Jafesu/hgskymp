'use strict';

// Round-trips a real archive through the extractor rather than mocking it,
// because the parts that break are the ones touching the filesystem: the
// nesting inside the release, and lifting its contents up a level.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const mo2 = require('../src/lib/mo2');

let fail = 0;
const check = (label, cond, extra) => {
  console.log((cond ? 'PASS: ' : 'FAIL: ') + label);
  if (!cond) {
    fail = 1;
    if (extra !== undefined) console.log('      ' + JSON.stringify(extra));
  }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-mo2-'));

(async () => {
  // Build an archive shaped like the real release: everything under one folder
  const src = path.join(tmp, 'src', 'Mod.Organizer-2.5.2');
  fs.mkdirSync(path.join(src, 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(src, 'ModOrganizer.exe'), 'not really an exe');
  fs.writeFileSync(path.join(src, 'plugins', 'thing.dll'), 'plugin');

  const archive = path.join(tmp, 'release.7z');
  const { path7za } = require('7zip-bin');
  execFileSync(path7za, ['a', '-t7z', archive, path.join(tmp, 'src', '*'), '-bso0', '-bse0'], {
    windowsHide: true,
  });
  check('built a test archive', fs.existsSync(archive));

  // ── extraction ────────────────────────────────────────────────────────────
  const dest = path.join(tmp, 'unpacked');
  const res = await mo2.extract(archive, dest);
  check('extract succeeds', res.ok, res);

  const found = mo2.findExeDir(dest);
  check('finds the exe inside the nested folder', found !== null, { dest, found });
  check('...at the right level',
    found && fs.existsSync(path.join(found, 'ModOrganizer.exe')), found);
  check('...bringing subdirectories along',
    found && fs.existsSync(path.join(found, 'plugins', 'thing.dll')));

  const missing = await mo2.extract(path.join(tmp, 'does-not-exist.7z'), path.join(tmp, 'nope'));
  check('a missing archive fails rather than throwing', missing.ok === false, missing);
  check('...and says why, rather than echoing the command line',
    !/^Command failed/.test(missing.error), missing.error);

  // ── archive identification ────────────────────────────────────────────────
  // Nexus filenames are unreliable and downloads are stored under an id, so
  // the content is the only trustworthy signal. Getting this wrong sends a RAR
  // to 7za, which has no RAR codec and fails with nothing useful.
  check('7z identified by content', mo2.archiveKind(archive) === '7z', mo2.archiveKind(archive));

  const zip = path.join(tmp, 'plain.zip');
  execFileSync(path7za, ['a', '-tzip', zip, path.join(src, 'ModOrganizer.exe'), '-bso0', '-bse0'], { windowsHide: true });
  check('zip identified by content', mo2.archiveKind(zip) === 'zip', mo2.archiveKind(zip));

  const fakeRar = path.join(tmp, 'fake.bin');
  fs.writeFileSync(fakeRar, Buffer.concat([Buffer.from('Rar!\x1a\x07\x01\x00', 'binary'), Buffer.alloc(8)]));
  check('rar identified by content, whatever the extension', mo2.archiveKind(fakeRar) === 'rar');

  fs.writeFileSync(path.join(tmp, 'junk.bin'), 'not an archive at all');
  check('unrecognised content reports unknown', mo2.archiveKind(path.join(tmp, 'junk.bin')) === 'unknown');
  check('a missing file reports unknown', mo2.archiveKind(path.join(tmp, 'absent')) === 'unknown');

  check('findExeDir returns null when there is no exe',
    mo2.findExeDir(path.join(tmp, 'src', 'Mod.Organizer-2.5.2', 'plugins')) === null);

  // ── isInstalled reflects reality ──────────────────────────────────────────
  const instance = path.join(tmp, 'instance');
  mo2.setRoot(instance);
  check('a bare directory does not count as installed', mo2.isInstalled() === false);

  fs.mkdirSync(instance, { recursive: true });
  fs.writeFileSync(mo2.getExe(), 'x');
  check('an exe present counts as installed', mo2.isInstalled() === true);

  fs.writeFileSync(mo2.getExe(), '');
  check('a zero-byte exe does not count, so a failed download is not mistaken for success',
    mo2.isInstalled() === false);

  // ── ensureInstalled short-circuits ────────────────────────────────────────
  fs.writeFileSync(mo2.getExe(), 'x');
  const already = await mo2.ensureInstalled();
  check('ensureInstalled does nothing when already installed',
    already.ok && already.alreadyInstalled === true, already);

  // ── instance configuration for launching ──────────────────────────────────
  const game = path.join(tmp, 'Skyrim Special Edition');
  fs.mkdirSync(path.join(game, 'Data'), { recursive: true });
  fs.writeFileSync(path.join(game, 'SkyrimSE.exe'), 'game');
  fs.writeFileSync(path.join(game, 'Data', 'Skyrim.esm'), 'master');

  // Without SKSE the game starts with no script extender, so no SkyrimPlatform
  // and no SkyMP: the caller has to be able to tell.
  let exes = mo2.buildExecutablesIni(game);
  check('a game folder without SKSE is reported as such', exes.hasSkse === false, exes.titles);
  check('...but the vanilla executable is still registered',
    exes.titles.includes('Skyrim Special Edition'), exes.titles);

  fs.writeFileSync(path.join(game, 'skse64_loader.exe'), 'skse');
  exes = mo2.buildExecutablesIni(game);
  check('SKSE is found once present', exes.hasSkse === true, exes.titles);
  check('...and registered first, since it is what must be launched',
    exes.titles[0] === 'SKSE', exes.titles);
  check('the executables block is well formed',
    /\[customExecutables\]/.test(exes.ini) && /1\\title=SKSE/.test(exes.ini), exes.ini.slice(0, 120));

  mo2.setRoot(path.join(tmp, 'launchinst'));
  const inst = mo2.ensureInstance(game);
  check('instance written', inst.ok && inst.hasSkse, inst);
  check('ModOrganizer.ini created', fs.existsSync(path.join(mo2.getRoot(), 'ModOrganizer.ini')));
  check('profile settings created, which MO2 requires',
    fs.existsSync(path.join(mo2.getProfileDir(), 'settings.ini')));

  const iniText = fs.readFileSync(path.join(mo2.getRoot(), 'ModOrganizer.ini'), 'utf8');
  check('the instance points at the chosen game folder',
    iniText.includes(game.replace(/\\/g, '/')), iniText.split('\n')[2]);

  // Launching without MO2 present must fail rather than silently do nothing
  mo2.setRoot(path.join(tmp, 'no-mo2'));
  const noMo2 = await mo2.launch('SKSE');
  check('launching without Mod Organizer fails clearly',
    noMo2.ok === false && /not set up/i.test(noMo2.error), noMo2);

  // ── downloads refuse plain http ───────────────────────────────────────────
  const insecure = await mo2.download('http://example.com/x.7z', path.join(tmp, 'x.7z'));
  check('plain http download is refused', insecure.ok === false && /non-https/i.test(insecure.error), insecure);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(fail ? '\nFAILURES' : '\nall checks passed');
  process.exit(fail);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
