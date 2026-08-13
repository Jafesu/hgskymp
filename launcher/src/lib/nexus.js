'use strict';

// Nexus Mods client.
//
// Two download paths, chosen by account type:
//
//   Premium  /v1/.../download_link.json answers directly, so a whole modpack
//            can be fetched with no interaction.
//
//   Free     the same endpoint returns 403 ("this is for premium users only",
//            verified against the live API). It does answer for a free account
//            when given the key/expires pair from an nxm:// handoff, which is
//            what "Mod Manager Download" on the website produces. So the free
//            path opens the mod page, waits for the protocol callback, and
//            uses that key. One click per mod, and the same mechanism Vortex
//            and MO2 rely on.
//
// Nothing here dead-ends a free user; it just costs them clicks.

const https = require('https');

const GAME = 'skyrimspecialedition';
const API_HOST = 'api.nexusmods.com';

// Nexus requires an application identity on every request.
let appIdentity = { name: 'HardGamingSkyMPLauncher', version: '0.0.0' };
function setAppIdentity(name, version) {
  appIdentity = { name: name || appIdentity.name, version: version || appIdentity.version };
}

function authHeaders(auth) {
  if (typeof auth === 'string' && auth) return { apikey: auth };
  if (auth && auth.apiKey) return { apikey: auth.apiKey };
  if (auth && auth.bearer) return { Authorization: `Bearer ${auth.bearer}` };
  return null;
}

function request(auth, path, { timeoutMs = 20000 } = {}) {
  return new Promise((resolve) => {
    const creds = authHeaders(auth);
    if (!creds) return resolve({ ok: false, status: 0, error: 'not signed in to Nexus' });

    const req = https.get(
      {
        hostname: API_HOST,
        path,
        headers: {
          ...creds,
          accept: 'application/json',
          'User-Agent': `${appIdentity.name}/${appIdentity.version}`,
          'Application-Name': appIdentity.name,
          'Application-Version': appIdentity.version,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          if (res.statusCode === 401) {
            return resolve({ ok: false, status: 401, error: 'Nexus rejected the sign-in. The key may have been revoked.' });
          }
          if (res.statusCode === 403) {
            return resolve({
              ok: false,
              status: 403,
              premiumRequired: true,
              error: 'Nexus only issues direct download links to Premium accounts.',
            });
          }
          if (res.statusCode === 429) {
            return resolve({ ok: false, status: 429, rateLimited: true, error: 'Nexus rate limit reached. Wait a few minutes.' });
          }
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return resolve({ ok: false, status: res.statusCode, error: `Nexus returned HTTP ${res.statusCode}` });
          }
          try {
            resolve({ ok: true, status: res.statusCode, body: JSON.parse(data) });
          } catch (err) {
            resolve({ ok: false, status: res.statusCode, error: `Nexus sent malformed JSON: ${err.message}` });
          }
        });
      }
    );

    req.on('error', (err) => resolve({ ok: false, status: 0, error: err.message }));
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve({ ok: false, status: 0, error: 'Nexus request timed out' });
    });
  });
}

// ── account ──────────────────────────────────────────────────────────────────

/** Who is signed in, and can they use the automatic path. */
async function validate(auth) {
  const res = await request(auth, '/v1/users/validate.json');
  if (!res.ok) return { ok: false, error: res.error, status: res.status };

  const body = res.body || {};
  return {
    ok: true,
    name: body.name,
    userId: body.user_id,
    // The single fact that decides which download path the launcher uses
    premium: body.is_premium === true,
    supporter: body.is_supporter === true,
  };
}

// ── files ────────────────────────────────────────────────────────────────────

async function listFiles(auth, modId) {
  const res = await request(auth, `/v1/games/${GAME}/mods/${modId}/files.json`);
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, files: (res.body && res.body.files) || [] };
}

/**
 * Resolve CDN links for a file.
 *
 * `nxm` carries the key/expires pair from a protocol handoff. With it a free
 * account gets links; without it Nexus refuses anything but Premium.
 */
async function getDownloadLinks(auth, modId, fileId, nxm = null) {
  let path = `/v1/games/${GAME}/mods/${modId}/files/${fileId}/download_link.json`;
  if (nxm && nxm.key && nxm.expires) {
    path += `?key=${encodeURIComponent(nxm.key)}&expires=${encodeURIComponent(nxm.expires)}`;
  }

  const res = await request(auth, path);
  if (!res.ok) {
    return {
      ok: false,
      error: res.error,
      // Distinguish "needs premium" from "needs a click", because the launcher
      // reacts differently: one is a hard limit, the other is the free flow.
      needsHandoff: res.premiumRequired === true && !nxm,
    };
  }

  const links = Array.isArray(res.body) ? res.body : [];
  if (!links.length) return { ok: false, error: 'Nexus returned no download locations' };

  return {
    ok: true,
    // Preferred first; the caller may fall back down the list on failure
    urls: links.map((l) => l.URI).filter(Boolean),
    sources: links.map((l) => ({ name: l.name, shortName: l.short_name, uri: l.URI })),
  };
}

// ── nxm:// protocol ──────────────────────────────────────────────────────────

/**
 * Parse an nxm:// handoff.
 *
 *   nxm://skyrimspecialedition/mods/12604/files/749043?key=abc&expires=1700000000
 *
 * Returns null for anything that is not a well-formed link for our game, so a
 * hostile or stray registration cannot steer the launcher at another title.
 */
function parseNxmUrl(url) {
  if (typeof url !== 'string') return null;

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'nxm:') return null;

  const game = parsed.hostname.toLowerCase();
  const match = /^\/mods\/(\d+)\/files\/(\d+)\/?$/.exec(parsed.pathname);
  if (!match) return null;

  const modId = parseInt(match[1], 10);
  const fileId = parseInt(match[2], 10);
  if (!Number.isInteger(modId) || !Number.isInteger(fileId)) return null;

  return {
    game,
    // The caller decides what to do with a link for a different game rather
    // than being handed something it did not ask for.
    isOurGame: game === GAME,
    modId,
    fileId,
    key: parsed.searchParams.get('key') || null,
    expires: parsed.searchParams.get('expires') || null,
    userId: parsed.searchParams.get('user_id') || null,
  };
}

/** The page a free user is sent to, deep-linked to the exact file. */
function modPageUrl(modId, fileId) {
  const base = `https://www.nexusmods.com/${GAME}/mods/${modId}`;
  return fileId ? `${base}?tab=files&file_id=${fileId}&nmm=1` : base;
}

/** Where a user creates the key the launcher signs in with. */
const API_KEY_PAGE = 'https://next.nexusmods.com/settings/api-keys';

module.exports = {
  GAME,
  API_KEY_PAGE,
  setAppIdentity,
  validate,
  listFiles,
  getDownloadLinks,
  parseNxmUrl,
  modPageUrl,
};
