'use strict';

// Verifies a prepared install against a server's manifest BEFORE the game is
// launched.
//
// The client performs this same comparison at connect time and refuses to join
// on any mismatch, but by then the player has launched Skyrim, waited through a
// load, and received an error that names an index rather than a cause. Doing it
// here turns that into a sentence naming the mod and both versions.
//
// The rules are the client's, not ours:
//   * the server's plugins must be a PREFIX of the player's load order, matched
//     index by index on filename, crc32 and size;
//   * the player may have extra plugins, but only sorted after every server one;
//   * fewer plugins than the server has is an immediate refusal.

const fs = require('fs');

// ── crc32 ────────────────────────────────────────────────────────────────────

// The server hashes with the crc-32 package, which returns a SIGNED 32-bit
// integer. Matching that exactly is the whole point, so this returns signed too.
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ -1) | 0;
}

/** {filename, crc32, size} for a plugin on disk, or null if unreadable. */
function hashPlugin(filePath, filename) {
  try {
    const buf = fs.readFileSync(filePath);
    return { filename, crc32: crc32(buf), size: buf.length };
  } catch {
    return null;
  }
}

// ── verification ─────────────────────────────────────────────────────────────

const sameName = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

/**
 * @param {Array<{filename,crc32,size}>} clientPlugins in load order
 * @param {{mods: Array<{filename,crc32,size}>}} manifest the server's manifest
 * @returns {{ok: boolean, problems: Array<object>}}
 */
function verify(clientPlugins, manifest) {
  const problems = [];
  const server = Array.isArray(manifest && manifest.mods) ? manifest.mods : [];
  const client = Array.isArray(clientPlugins) ? clientPlugins : [];

  if (!server.length) {
    return { ok: true, problems: [], note: 'server published no plugin manifest' };
  }

  if (client.length < server.length) {
    problems.push({
      kind: 'missing-plugins',
      message:
        `The server loads ${server.length} plugins and this install has ${client.length}. ` +
        `Install the server's modpack before joining.`,
    });
  }

  for (let i = 0; i < server.length; i++) {
    const want = server[i];
    const have = client[i];

    if (!have) {
      problems.push({
        kind: 'missing',
        index: i,
        expected: want.filename,
        message: `${want.filename} is missing from position ${i + 1} of the load order.`,
      });
      continue;
    }

    if (!sameName(have.filename, want.filename)) {
      // Distinguish "wrong thing here" from "right thing, wrong place",
      // because the fixes are completely different.
      const foundAt = client.findIndex((p) => sameName(p.filename, want.filename));
      problems.push({
        kind: foundAt === -1 ? 'absent' : 'misordered',
        index: i,
        expected: want.filename,
        actual: have.filename,
        foundAt: foundAt === -1 ? null : foundAt,
        message:
          foundAt === -1
            ? `${want.filename} should be at position ${i + 1} but is not installed. ` +
              `${have.filename} is there instead.`
            : `${want.filename} is at position ${foundAt + 1} but the server loads it at ` +
              `${i + 1}. Every mod the server does not load must sort after the ones it does.`,
      });
      continue;
    }

    // Same name, different bytes: almost always a version difference, and the
    // case a player is least likely to diagnose alone.
    if (have.crc32 !== want.crc32 || have.size !== want.size) {
      problems.push({
        kind: 'version-mismatch',
        index: i,
        expected: want.filename,
        message:
          `${want.filename} does not match the server's copy. ` +
          `Server: ${want.size} bytes, crc ${toHex(want.crc32)}. ` +
          `Yours: ${have.size} bytes, crc ${toHex(have.crc32)}. ` +
          `This is usually a different version of the same mod.`,
        want: { size: want.size, crc32: want.crc32 },
        have: { size: have.size, crc32: have.crc32 },
      });
    }
  }

  return { ok: problems.length === 0, problems };
}

function toHex(signed) {
  return '0x' + ((signed >>> 0).toString(16).padStart(8, '0'));
}

/** One line suitable for showing directly to a player. */
function summarise(result) {
  if (result.ok) return 'Ready to join.';
  const first = result.problems[0];
  const more = result.problems.length - 1;
  return more > 0 ? `${first.message} (+${more} more)` : first.message;
}

module.exports = { crc32, hashPlugin, verify, summarise, toHex };
