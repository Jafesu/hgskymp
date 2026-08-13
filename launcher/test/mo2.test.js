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
