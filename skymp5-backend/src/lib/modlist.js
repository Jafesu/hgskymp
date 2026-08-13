'use strict';

// Validation for a published modlist.
//
// The rules here are not style preferences, they encode how the client checks
// a server at connect time. loadOrderVerificationService compares the player's
// plugin list against the server's manifest **index by index from zero**, on
// filename, crc32 and size. Consequences:
//
//   * the server's plugins must be a PREFIX of the client's load order, so
//     every cosmetic mod has to sort after all of them;
//   * a client with fewer plugins than the server cannot connect at all;
//   * archives must never appear, because the client enumerates plugins only
//     and one stray .bsa shifts every index after it.
//
// Rejecting a bad modlist here turns a mystifying connect failure into a clear
// error at publish time.

const PLUGIN_EXT = /\.es[mpl]$/i;
const SHA256 = /^[a-f0-9]{64}$/i;

function fail(errors, message) {
  errors.push(message);
}

function validateMod(mod, index, errors) {
  const at = `mods[${index}]`;

  if (!mod || typeof mod !== 'object') {
    return fail(errors, `${at}: expected an object`);
  }
  if (typeof mod.name !== 'string' || !mod.name.trim()) {
    fail(errors, `${at}.name: required`);
  }
  if (typeof mod.fileName !== 'string' || !mod.fileName.trim()) {
    fail(errors, `${at}.fileName: required`);
  }
  if (!SHA256.test(String(mod.sha256 || ''))) {
    fail(errors, `${at}.sha256: expected a 64 character hex digest`);
  }
  if (!Number.isInteger(mod.size) || mod.size <= 0) {
    fail(errors, `${at}.size: expected a positive integer`);
  }
  if (!Array.isArray(mod.plugins)) {
    fail(errors, `${at}.plugins: expected an array, use [] for an asset-only mod`);
  } else {
    for (const p of mod.plugins) {
      if (typeof p !== 'string' || !PLUGIN_EXT.test(p)) {
        fail(errors, `${at}.plugins: ${JSON.stringify(p)} is not an .esp/.esm/.esl`);
      }
    }
  }
  // Nexus ids are optional so a hand-supplied archive can still be listed,
  // but a partial pair cannot be resolved and is always a mistake.
  const hasMod = mod.nexusModId !== undefined && mod.nexusModId !== null;
  const hasFile = mod.nexusFileId !== undefined && mod.nexusFileId !== null;
  if (hasMod !== hasFile) {
    fail(errors, `${at}: nexusModId and nexusFileId must be given together`);
  }
}

function validate(modlist) {
  const errors = [];

  if (!modlist || typeof modlist !== 'object') {
    return { ok: false, errors: ['expected a JSON object'] };
  }

  const { mods, loadOrder, serverPlugins } = modlist;

  if (!Array.isArray(mods)) {
    fail(errors, 'mods: expected an array');
  } else {
    mods.forEach((mod, i) => validateMod(mod, i, errors));
  }

  if (!Array.isArray(loadOrder) || loadOrder.length === 0) {
    fail(errors, 'loadOrder: expected a non-empty array');
  } else {
    loadOrder.forEach((p, i) => {
      if (typeof p !== 'string' || !PLUGIN_EXT.test(p)) {
        fail(errors, `loadOrder[${i}]: ${JSON.stringify(p)} is not an .esp/.esm/.esl`);
      }
    });
    const seen = new Set();
    for (const p of loadOrder) {
      const key = String(p).toLowerCase();
      if (seen.has(key)) fail(errors, `loadOrder: ${p} appears more than once`);
      seen.add(key);
    }
  }

  if (!Array.isArray(serverPlugins)) {
    fail(errors, 'serverPlugins: expected an array');
  } else if (Array.isArray(loadOrder)) {
    if (serverPlugins.length > loadOrder.length) {
      fail(errors, 'serverPlugins: cannot be longer than loadOrder');
    } else {
      // The prefix rule. This is the whole point of the check.
      for (let i = 0; i < serverPlugins.length; ++i) {
        const a = String(serverPlugins[i] || '').toLowerCase();
        const b = String(loadOrder[i] || '').toLowerCase();
        if (a !== b) {
          fail(
            errors,
            `serverPlugins must be a prefix of loadOrder: position ${i} is ` +
              `${JSON.stringify(serverPlugins[i])} but loadOrder has ` +
              `${JSON.stringify(loadOrder[i])}. Every client-only mod must sort ` +
              `after all server plugins.`
          );
          break;
        }
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

// Everything a mod contributes should appear in the order, or the launcher
// installs a plugin the server never expects to see.
function unlistedPlugins(modlist) {
  const inOrder = new Set((modlist.loadOrder || []).map((p) => String(p).toLowerCase()));
  const missing = [];
  for (const mod of modlist.mods || []) {
    for (const p of mod.plugins || []) {
      if (!inOrder.has(String(p).toLowerCase())) missing.push(p);
    }
  }
  return missing;
}

module.exports = { validate, unlistedPlugins, PLUGIN_EXT };
