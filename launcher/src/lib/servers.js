'use strict';

// Server discovery and liveness.
//
// Two sources deliberately, because they fail independently:
//
//   * the backend, which knows which servers exist and holds their modpacks;
//   * each server's own http port, which answers /api/status whether or not it
//     is listed anywhere.
//
// A listed server whose backend entry is stale still shows the truth, and a
// server nobody listed is still joinable by address. Neither path is a
// fallback for the other; they answer different questions.

const http = require('http');
const https = require('https');
const { URL } = require('url');

const DEFAULT_TIMEOUT_MS = 6000;

/** GET a URL and parse JSON. Never throws; returns {ok, status, body, error}. */
function getJson(url, { timeoutMs = DEFAULT_TIMEOUT_MS, headers = {} } = {}) {
  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (err) {
      return resolve({ ok: false, status: 0, error: `bad url: ${url}` });
    }

    const transport = parsed.protocol === 'https:' ? https : http;
    const req = transport.get(
      parsed,
      { headers: { accept: 'application/json', ...headers } },
      (res) => {
        let data = '';
        // A server that answers with something enormous should not be able to
        // exhaust the launcher's memory.
        let tooBig = false;
        res.on('data', (chunk) => {
          if (data.length + chunk.length > 4 * 1024 * 1024) {
            tooBig = true;
            req.destroy();
            return;
          }
          data += chunk;
        });
        res.on('end', () => {
          if (tooBig) return resolve({ ok: false, status: res.statusCode, error: 'response too large' });
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return resolve({ ok: false, status: res.statusCode, error: `HTTP ${res.statusCode}` });
          }
          try {
            resolve({ ok: true, status: res.statusCode, body: JSON.parse(data) });
          } catch (err) {
            resolve({ ok: false, status: res.statusCode, error: `bad JSON: ${err.message}` });
          }
        });
      }
    );

    req.on('error', (err) => resolve({ ok: false, status: 0, error: err.message }));
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve({ ok: false, status: 0, error: 'timed out' });
    });
  });
}

/** Split "host:port" or a bare host. Returns null when unusable. */
function parseAddress(input, defaultPort = 7777) {
  if (typeof input !== 'string') return null;
  const text = input.trim().replace(/^\w+:\/\//, '').replace(/\/+$/, '');
  if (!text) return null;

  const match = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(text);
  if (!match) return null;

  const host = match[1].replace(/^\[|\]$/g, '');
  const port = match[2] === undefined ? defaultPort : parseInt(match[2], 10);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host, port };
}

/**
 * Ask a server directly how it is doing.
 *
 * The http endpoints share the game port: that one is UDP and this is TCP, so
 * one address covers both and there is no second port to discover.
 */
async function fetchStatus(host, port, opts = {}) {
  const started = Date.now();
  const res = await getJson(`http://${host}:${port}/api/status`, opts);
  const ping = Date.now() - started;

  if (!res.ok) {
    return { online: false, host, port, error: res.error, ping: null };
  }

  const body = res.body || {};
  return {
    online: true,
    host,
    port,
    ping,
    name: typeof body.name === 'string' ? body.name : `${host}:${port}`,
    players: Number.isInteger(body.players) ? body.players : 0,
    maxPlayers: Number.isInteger(body.maxPlayers) ? body.maxPlayers : 0,
  };
}

/** A server's modpack, straight from the server rather than the backend. */
async function fetchModpack(host, port, opts = {}) {
  const res = await getJson(`http://${host}:${port}/modpack.json`, opts);
  if (!res.ok) {
    // 404 is the normal answer for a server with no pack published
    return { ok: false, notPublished: res.status === 404, error: res.error };
  }
  return { ok: true, modpack: res.body };
}

/** The listed servers. */
async function fetchServerList(backendUrl, opts = {}) {
  const base = String(backendUrl || '').replace(/\/+$/, '');
  if (!base) return { ok: false, error: 'no backend configured', servers: [] };

  const res = await getJson(`${base}/api/servers`, opts);
  if (!res.ok) return { ok: false, error: res.error, servers: [] };

  const servers = Array.isArray(res.body && res.body.servers) ? res.body.servers : [];
  return { ok: true, servers };
}

/**
 * The list, with each entry's liveness confirmed against the server itself.
 *
 * The backend's own view can only ever be as fresh as the last heartbeat, so a
 * server that died seconds ago still reads online there. Asking each server
 * directly costs one request per row and makes the list honest.
 */
async function fetchServerListWithLiveStatus(backendUrl, opts = {}) {
  const listed = await fetchServerList(backendUrl, opts);
  if (!listed.ok) return listed;

  const servers = await Promise.all(
    listed.servers.map(async (server) => {
      if (!server.host || !server.port) return { ...server, live: null };
      const live = await fetchStatus(server.host, server.port, opts);
      return {
        ...server,
        online: live.online,
        players: live.online ? live.players : server.players,
        ping: live.ping,
        live,
      };
    })
  );

  return { ok: true, servers };
}

module.exports = {
  getJson,
  parseAddress,
  fetchStatus,
  fetchModpack,
  fetchServerList,
  fetchServerListWithLiveStatus,
};
