'use strict';

// Building a modpack for publication.
//
// The backend refuses a modlist that does not carry a sha256 and the plugins
// each mod contributes, and it is right to: those are exactly what the client
// compares at connect time. Neither can be read from the Nexus API, so a mod
// has to be downloaded and looked inside before it can be published. That is
// the whole reason this is an admin tool rather than something the backend
// could assemble on its own.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const mo2 = require('./mo2');

const PLUGIN_EXT = /\.es[mpl]$/i;

/**
 * Read a Nexus reference from whatever an admin pasted.
 *
 * Accepts a full mod page url, a url with a file already selected, or a bare
 * mod id, because all three are things people have in their clipboard.
 */
function parseModRef(input) {
  if (typeof input !== 'string') return null;
  const text = input.trim();
  if (!text) return null;

  // A bare id
  if (/^\d+$/.test(text)) return { modId: parseInt(text, 10), fileId: null };

  let url;
  try {
    url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
  if (!/(^|\.)nexusmods\.com$/i.test(url.hostname)) return null;

  const match = /\/mods\/(\d+)/.exec(url.pathname);
  if (!match) return null;

  const fileParam = url.searchParams.get('file_id');
  const fileId = fileParam && /^\d+$/.test(fileParam) ? parseInt(fileParam, 10) : null;

  return { modId: parseInt(match[1], 10), fileId, game: (/\/([^/]+)\/mods\//.exec(url.pathname) || [])[1] || null };
}

function sha256File(filePath) {
  return new Promise((resolve) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (c) => hash.update(c));
    stream.on('error', () => resolve(null));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/** Every plugin inside a directory tree, relative paths flattened to names. */
function findPlugins(dir, found = [], depth = 0) {
  if (depth > 4) return found;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      findPlugins(full, found, depth + 1);
    } else if (PLUGIN_EXT.test(entry.name)) {
      found.push(entry.name);
    }
  }
  return found;
}

/**
 * Look inside an archive to find what it actually contributes.
 *
 * Extracted to a temporary directory and thrown away: this only needs to know
 * the plugin names, and unpacking into the real mods folder would install
 * something the admin has not decided to include yet.
 */
async function inspectArchive(archivePath) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-inspect-'));
  try {
    const res = await mo2.extract(archivePath, temp);
    if (!res.ok) return { ok: false, error: res.error };

    const plugins = [...new Set(findPlugins(temp))].sort((a, b) => a.localeCompare(b));
    const stat = fs.statSync(archivePath);
    const sha256 = await sha256File(archivePath);

    return { ok: true, plugins, size: stat.size, sha256 };
  } finally {
    try {
      fs.rmSync(temp, { recursive: true, force: true });
    } catch {}
  }
}

/** A modlist entry in the shape the backend validates. */
function buildEntry({ name, modId, fileId, fileName, inspection }) {
  return {
    name,
    nexusModId: modId,
    nexusFileId: fileId,
    fileName,
    sha256: inspection.sha256,
    size: inspection.size,
    plugins: inspection.plugins,
  };
}

/**
 * Assemble the publishable document from a list of entries.
 *
 * loadOrder is the client's full order and serverPlugins must be a prefix of
 * it, so the server's plugins are emitted first, in the admin's chosen order,
 * and the client-only ones follow. Building it this way means the backend's
 * prefix rule cannot be violated by accident.
 */
function assemble(entries, serverPluginNames = []) {
  const isServerPlugin = new Set(serverPluginNames.map((p) => String(p).toLowerCase()));

  const serverSide = [];
  const clientSide = [];
  for (const entry of entries) {
    for (const plugin of entry.plugins || []) {
      (isServerPlugin.has(plugin.toLowerCase()) ? serverSide : clientSide).push(plugin);
    }
  }

  return {
    mods: entries,
    loadOrder: [...serverSide, ...clientSide],
    serverPlugins: serverSide,
  };
}

/** Publish to the backend. Requires the admin key. */
function publish(backendUrl, serverId, adminKey, modpack) {
  return new Promise((resolve) => {
    const base = String(backendUrl || '').replace(/\/+$/, '');
    if (!base) return resolve({ ok: false, error: 'no backend configured' });
    if (!adminKey) return resolve({ ok: false, error: 'an admin key is required to publish' });

    let target;
    try {
      target = new URL(`${base}/api/servers/${encodeURIComponent(serverId)}/modlist`);
    } catch {
      return resolve({ ok: false, error: 'invalid backend url' });
    }

    const transport = target.protocol === 'https:' ? require('https') : require('http');
    const body = JSON.stringify(modpack);

    const req = transport.request(
      target,
      {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          authorization: `Bearer ${adminKey}`,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let parsed = null;
          try {
            parsed = JSON.parse(data);
          } catch {}
          if (res.statusCode >= 200 && res.statusCode < 300) {
            return resolve({ ok: true, version: parsed && parsed.version });
          }
          resolve({
            ok: false,
            status: res.statusCode,
            error: (parsed && parsed.error) || `HTTP ${res.statusCode}`,
            // The backend explains exactly which rule was broken; surfacing it
            // is the difference between a fixable message and a shrug.
            details: (parsed && parsed.details) || null,
          });
        });
      }
    );

    req.on('error', (err) => resolve({ ok: false, error: err.message }));
    req.setTimeout(20000, () => {
      req.destroy();
      resolve({ ok: false, error: 'publish timed out' });
    });
    req.write(body);
    req.end();
  });
}

module.exports = {
  PLUGIN_EXT,
  parseModRef,
  sha256File,
  findPlugins,
  inspectArchive,
  buildEntry,
  assemble,
  publish,
};
