'use strict';

// Turns a published modpack into an MO2 install.
//
// Download resolution is injected rather than done here, because it differs by
// account type: a Premium account resolves links straight from the API, while a
// free one needs the player to click through an nxm:// handoff. Keeping that
// out of this module means the install logic is the same either way, and is
// testable without a Nexus account.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mo2 = require('./mo2');

// Written into each installed mod folder so a re-run can tell what is already
// correct. Keyed by hash, not version, because the hash is what the server
// actually checks.
const STAMP = '.hardgaming-install.json';

function sha256File(filePath) {
  return new Promise((resolve) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', () => resolve(null));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * A mod folder name that is safe on disk and recognisable in MO2.
 *
 * The name comes from a published modpack, so it is untrusted input that ends
 * up in a path this module deletes and recreates. Stripping separators is not
 * enough on its own: a name of ".." survives that and still resolves to the
 * parent directory, which would point the pre-install rmSync at the mods
 * folder's parent.
 */
function safeModName(name) {
  const cleaned = String(name || '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 96);

  // Anything that is only dots is a relative path segment, never a folder name
  if (!cleaned || /^\.+$/.test(cleaned)) return 'Unnamed mod';

  // Windows refuses these regardless of extension
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(cleaned)) return `_${cleaned}`;

  // A trailing dot or space is silently dropped by Windows, so two mods could
  // collapse onto one folder
  return cleaned.replace(/[. ]+$/, '') || 'Unnamed mod';
}

function readStamp(modDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(modDir, STAMP), 'utf8'));
  } catch {
    return null;
  }
}

/** Already present and byte-identical to what the modpack asks for. */
function isInstalled(modsDir, modName, sha256) {
  const stamp = readStamp(path.join(modsDir, safeModName(modName)));
  return !!stamp && stamp.sha256 === sha256;
}

/**
 * Unpack one archive into its own MO2 mod folder.
 *
 * The folder is replaced rather than merged: leaving files from a previous
 * version behind is how a mod ends up in a state no version ever shipped.
 */
async function installArchive(archivePath, modsDir, modName, meta = {}) {
  const dir = path.join(modsDir, safeModName(modName));

  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
  fs.mkdirSync(dir, { recursive: true });

  const res = await mo2.extract(archivePath, dir);
  if (!res.ok) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
    return { ok: false, error: res.error };
  }

  // MO2 expects the mod's files at the folder root. Many archives wrap
  // everything in one directory, so lift that level if it is the only thing
  // there and it is not itself a game data folder.
  liftSingleWrapper(dir);

  fs.writeFileSync(
    path.join(dir, STAMP),
    JSON.stringify({ ...meta, installedAt: new Date().toISOString() }, null, 2) + '\n'
  );

  // MO2 reads this to show the mod's name properly rather than the folder name
  fs.writeFileSync(
    path.join(dir, 'meta.ini'),
    ['[General]', 'gameName=SkyrimSE', `modid=${meta.nexusModId || 0}`, `name=${modName}`, 'hardGamingManaged=true', ''].join('\r\n')
  );

  return { ok: true, dir };
}

const DATA_FOLDERS = new Set([
  'meshes', 'textures', 'scripts', 'sound', 'interface', 'seq', 'grass',
  'lodsettings', 'music', 'shadersfx', 'strings', 'video', 'skse', 'source',
]);

/** If the archive wrapped everything in one folder, move its contents up. */
function liftSingleWrapper(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.name !== STAMP);
  } catch {
    return;
  }

  if (entries.length !== 1 || !entries[0].isDirectory()) return;

  const inner = entries[0].name;
  // A single folder that is itself game data is the mod's real layout
  if (DATA_FOLDERS.has(inner.toLowerCase())) return;

  const innerPath = path.join(dir, inner);
  let innerEntries;
  try {
    innerEntries = fs.readdirSync(innerPath);
  } catch {
    return;
  }

  for (const entry of innerEntries) {
    fs.renameSync(path.join(innerPath, entry), path.join(dir, entry));
  }
  try {
    fs.rmdirSync(innerPath);
  } catch {}
}

/**
 * Install a whole modpack.
 *
 * @param {object} opts
 * @param {object} opts.modpack           as published by the backend
 * @param {string} opts.modsDir           MO2 mods directory
 * @param {string} opts.downloadsDir      where archives are cached
 * @param {(mod) => Promise<{ok, path, error, needsHandoff}>} opts.resolveDownload
 * @param {(update) => void} [opts.onProgress]
 */
async function installModpack({ modpack, modsDir, downloadsDir, resolveDownload, onProgress = () => {} }) {
  const mods = Array.isArray(modpack && modpack.mods) ? modpack.mods : [];
  if (!mods.length) return { ok: false, error: 'the modpack lists no mods' };

  fs.mkdirSync(modsDir, { recursive: true });
  fs.mkdirSync(downloadsDir, { recursive: true });

  const installed = [];
  const skipped = [];
  const pending = [];
  const failed = [];

  for (let i = 0; i < mods.length; i++) {
    const mod = mods[i];
    const label = mod.name || mod.fileName;
    onProgress({ phase: 'mod', index: i, total: mods.length, name: label });

    if (isInstalled(modsDir, label, mod.sha256)) {
      skipped.push(label);
      continue;
    }

    const resolved = await resolveDownload(mod);
    if (!resolved || !resolved.ok) {
      // A free account needing a click is not a failure, it is the other path
      if (resolved && resolved.needsHandoff) {
        pending.push({ name: label, mod });
      } else {
        failed.push({ name: label, error: (resolved && resolved.error) || 'could not resolve a download' });
      }
      continue;
    }

    // The hash is the whole point of publishing one: a mirror serving a
    // different build would otherwise be installed and only rejected later, at
    // connect time, with an error naming an index.
    const actual = await sha256File(resolved.path);
    if (mod.sha256 && actual !== mod.sha256) {
      failed.push({
        name: label,
        error: `downloaded file does not match the modpack (expected ${mod.sha256.slice(0, 12)}…, got ${String(actual).slice(0, 12)}…)`,
      });
      continue;
    }

    const res = await installArchive(resolved.path, modsDir, label, {
      sha256: actual,
      fileName: mod.fileName,
      nexusModId: mod.nexusModId,
      nexusFileId: mod.nexusFileId,
      plugins: mod.plugins || [],
    });
    if (!res.ok) {
      failed.push({ name: label, error: res.error });
      continue;
    }
    installed.push(label);
  }

  // Only write the profile when the set is complete: a partial load order is
  // worse than none, because the client would reject it with an index error
  // rather than the launcher explaining what is missing.
  const complete = failed.length === 0 && pending.length === 0;
  if (complete) {
    const order = mods.map((m) => safeModName(m.name || m.fileName));
    mo2.writeModlist(order);
    mo2.writePlugins(modpack.loadOrder || []);
  }

  onProgress({ phase: 'done' });
  return { ok: complete, installed, skipped, pending, failed };
}

/**
 * Where a plugin actually lives on disk.
 *
 * MO2's virtual filesystem only exists while the game is running, so outside it
 * a plugin is either inside one of the mod folders or in the game's own Data
 * directory. Mods win, because that is what the overlay does at runtime.
 */
function resolvePluginPath(modsDir, gameDataDir, filename) {
  let mods = [];
  try {
    mods = fs.readdirSync(modsDir, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch {
    // no instance yet
  }

  for (const mod of mods) {
    const candidate = path.join(modsDir, mod.name, filename);
    if (fs.existsSync(candidate)) return candidate;
  }

  if (gameDataDir) {
    const vanilla = path.join(gameDataDir, filename);
    if (fs.existsSync(vanilla)) return vanilla;
  }
  return null;
}

/**
 * Hash every plugin in a load order, in order, ready for verification.
 *
 * A plugin that cannot be found is kept in place with nulls rather than
 * dropped, so the indices still line up and the mismatch is reported against
 * the right position instead of shifting everything after it.
 */
function collectInstalledPlugins(loadOrder, modsDir, gameDataDir) {
  const preflight = require('./preflight');
  return (loadOrder || []).map((filename) => {
    const full = resolvePluginPath(modsDir, gameDataDir, filename);
    if (!full) return { filename, crc32: null, size: null, missing: true };
    return preflight.hashPlugin(full, filename) || { filename, crc32: null, size: null, missing: true };
  });
}

module.exports = {
  STAMP,
  sha256File,
  resolvePluginPath,
  collectInstalledPlugins,
  safeModName,
  isInstalled,
  installArchive,
  liftSingleWrapper,
  installModpack,
};
