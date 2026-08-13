'use strict';

// Portable Mod Organizer 2 instance, owned entirely by the launcher.
//
// Deliberately never the player's own MO2 or Vortex install. MO2 overlays mods
// through a virtual filesystem instead of copying them into the game's Data
// folder, so the active plugin set is exactly what we write into the profile
// and the player's own setup is untouched.
//
// This matters because the client compares the game's active plugin list
// against the server manifest index by index, on filename, crc32 and size. A
// single extra plugin, or the right plugin at the wrong version, is enough to
// be refused.

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const crypto = require('crypto');

// Pinned rather than "latest": an MO2 upgrade changes the instance layout, and
// that should be a deliberate change with a test behind it.
const MO2_VERSION = '2.5.2';
const MO2_URL = `https://github.com/ModOrganizer2/modorganizer/releases/download/v${MO2_VERSION}/Mod.Organizer-${MO2_VERSION}.7z`;

const PROFILE = 'HardGaming';

let logger = (...args) => console.log('[mo2]', ...args);
function setLogger(fn) {
  logger = (...args) => fn('[mo2]', ...args);
}

// ── paths ────────────────────────────────────────────────────────────────────

let rootOverride = null;
/** Point the instance somewhere else, mainly so tests never touch a real one. */
function setRoot(dir) {
  rootOverride = dir || null;
}

function getRoot() {
  if (rootOverride) return rootOverride;
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(local, 'HardGaming', 'MO2');
}

const getExe = () => path.join(getRoot(), 'ModOrganizer.exe');
const getModsDir = () => path.join(getRoot(), 'mods');
const getDownloadsDir = () => path.join(getRoot(), 'downloads');
const getProfileDir = () => path.join(getRoot(), 'profiles', PROFILE);

function isInstalled() {
  try {
    return fs.statSync(getExe()).size > 0;
  } catch {
    return false;
  }
}

// ── download ─────────────────────────────────────────────────────────────────

/** Download to a file, following redirects. Resolves {ok, error, sha256}. */
function download(url, dest, onProgress, redirectsLeft = 5) {
  return new Promise((resolve) => {
    // Refuse plain http: this payload gets extracted and executed, so a
    // downgrade would be a remote code execution vector.
    if (!/^https:/i.test(url)) {
      return resolve({ ok: false, error: `refusing a non-https download: ${url}` });
    }

    const req = https.get(url, { headers: { 'user-agent': 'HardGamingLauncher' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) return resolve({ ok: false, error: 'too many redirects' });
        return resolve(download(res.headers.location, dest, onProgress, redirectsLeft - 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return resolve({ ok: false, error: `HTTP ${res.statusCode}` });
      }

      const total = parseInt(res.headers['content-length'] || '0', 10);
      let received = 0;
      const hash = crypto.createHash('sha256');

      fs.mkdirSync(path.dirname(dest), { recursive: true });
      // Write to a temp name so an interrupted download is never mistaken for
      // a complete one on the next run.
      const tmp = `${dest}.part`;
      const out = fs.createWriteStream(tmp);

      res.on('data', (chunk) => {
        received += chunk.length;
        hash.update(chunk);
        if (onProgress && total) onProgress(received / total, received, total);
      });

      res.pipe(out);

      out.on('error', (err) => resolve({ ok: false, error: err.message }));
      out.on('finish', () => {
        out.close(() => {
          try {
            fs.renameSync(tmp, dest);
            resolve({ ok: true, sha256: hash.digest('hex'), bytes: received });
          } catch (err) {
            resolve({ ok: false, error: err.message });
          }
        });
      });
    });

    req.on('error', (err) => resolve({ ok: false, error: err.message }));
    req.setTimeout(120000, () => {
      req.destroy();
      resolve({ ok: false, error: 'download timed out' });
    });
  });
}

// ── instance configuration ───────────────────────────────────────────────────

/**
 * Portable-instance ModOrganizer.ini.
 *
 * Portable means MO2 keeps everything under its own directory rather than in
 * the user's roaming profile, so the launcher's instance cannot collide with
 * an MO2 the player installed themselves.
 */
function buildInstanceIni(gameDir, root = getRoot()) {
  const fwd = (p) => String(p).replace(/\\/g, '/');
  return [
    '[General]',
    'gameName=Skyrim Special Edition',
    `gamePath=${fwd(gameDir)}`,
    `selected_profile=@ByteArray(${PROFILE})`,
    'first_start=false',
    '',
    '[Settings]',
    `base_directory=${fwd(root)}`,
    `download_directory=${fwd(path.join(root, 'downloads'))}`,
    `mod_directory=${fwd(path.join(root, 'mods'))}`,
    `profiles_directory=${fwd(path.join(root, 'profiles'))}`,
    `overwrite_directory=${fwd(path.join(root, 'overwrite'))}`,
    '',
  ].join('\r\n');
}

/**
 * Write the profile's mod order.
 *
 * MO2 reads modlist.txt with the HIGHEST priority first, which is the reverse
 * of how a load order reads, so the caller passes install order and this
 * reverses it. Getting that backwards silently inverts conflict resolution.
 */
function writeModlist(order, profileDir = getProfileDir()) {
  fs.mkdirSync(profileDir, { recursive: true });
  const lines = [
    '# This file was automatically generated by Mod Organizer.',
    ...[...order].reverse().map((name) => `+${name}`),
  ];
  fs.writeFileSync(path.join(profileDir, 'modlist.txt'), lines.join('\r\n') + '\r\n');
}

/**
 * Write the profile's plugin load order.
 *
 * Every entry is marked active with a leading '*'. This is the file the game
 * actually loads from, and therefore what the server's manifest is compared
 * against at connect time.
 */
function writePlugins(loadOrder, profileDir = getProfileDir()) {
  fs.mkdirSync(profileDir, { recursive: true });
  const lines = [
    '# This file was automatically generated by Mod Organizer.',
    ...loadOrder.map((name) => `*${name}`),
  ];
  fs.writeFileSync(path.join(profileDir, 'plugins.txt'), lines.join('\r\n') + '\r\n');

  // MO2 keeps a parallel loadorder.txt without the activation markers
  fs.writeFileSync(
    path.join(profileDir, 'loadorder.txt'),
    ['# This file was automatically generated by Mod Organizer.', ...loadOrder].join('\r\n') + '\r\n'
  );
}

/** The plugin order currently written to the profile, active entries only. */
function readActivePlugins(profileDir = getProfileDir()) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(profileDir, 'plugins.txt'), 'utf8');
  } catch {
    return [];
  }
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('*'))
    .map((line) => line.slice(1).trim())
    .filter(Boolean);
}

module.exports = {
  MO2_VERSION,
  MO2_URL,
  PROFILE,
  setLogger,
  setRoot,
  getRoot,
  getExe,
  getModsDir,
  getDownloadsDir,
  getProfileDir,
  isInstalled,
  download,
  buildInstanceIni,
  writeModlist,
  writePlugins,
  readActivePlugins,
};
