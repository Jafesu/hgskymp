'use strict';

const express = require('express');
const config = require('../config');
const store = require('../lib/store');
const modlist = require('../lib/modlist');
const { requireRegistration, requireAdmin } = require('../lib/auth');

const router = express.Router();

const isOnline = (record) =>
  !!record.lastSeen && Date.now() - Date.parse(record.lastSeen) < config.offlineAfterMs;

// The registration payload is operator-controlled, so nothing from it reaches
// the public list without being clamped to a known shape and length.
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const int = (v, min, max, fallback) => {
  const n = typeof v === 'number' ? v : parseInt(v, 10);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
};

// What a launcher needs to render a row and connect. Deliberately omits the
// registration key and anything else operational.
function publicView(record) {
  return {
    id: record.id,
    name: record.name,
    description: record.description,
    host: record.host,
    port: record.port,
    maxPlayers: record.maxPlayers,
    players: record.players,
    online: isOnline(record),
    lastSeen: record.lastSeen,
    modlistVersion: record.modlist ? record.modlist.version : null,
    modCount: record.modlist ? (record.modlist.mods || []).length : 0,
  };
}

router.get('/', (_req, res) => {
  const servers = store
    .listServers()
    .map(publicView)
    // Online first, then busiest, then by name so the order is stable
    .sort((a, b) =>
      Number(b.online) - Number(a.online) ||
      b.players - a.players ||
      a.name.localeCompare(b.name)
    );
  res.json({ servers });
});

router.get('/:id', (req, res) => {
  if (!store.isValidId(req.params.id)) {
    return res.status(400).json({ error: 'invalid server id' });
  }
  const record = store.readServer(req.params.id);
  if (!record) return res.status(404).json({ error: 'unknown server' });
  res.json(publicView(record));
});

// Game server heartbeat. Creates the record on first call and refreshes the
// liveness fields thereafter; the modlist is never touched from here, because
// publishing is an admin action with a different key.
router.post('/register', requireRegistration, (req, res) => {
  const body = req.body || {};
  const id = String(body.id || '').toLowerCase();

  if (!store.isValidId(id)) {
    return res.status(400).json({
      error: 'id must be 2-64 chars of lowercase letters, digits, dash or underscore',
    });
  }

  const host = str(body.host, 255);
  const port = int(body.port, 1, 65535, 0);
  if (!host) return res.status(400).json({ error: 'host is required' });
  if (!port) return res.status(400).json({ error: 'port must be 1-65535' });

  const existing = store.readServer(id) || {};
  const record = {
    ...existing,
    id,
    name: str(body.name, 64) || existing.name || id,
    description: str(body.description, 280) || existing.description || '',
    host,
    port,
    maxPlayers: int(body.maxPlayers, 1, 1000, existing.maxPlayers || 100),
    players: int(body.players, 0, 1000, 0),
    lastSeen: new Date().toISOString(),
    firstSeen: existing.firstSeen || new Date().toISOString(),
  };

  store.writeServer(id, record);
  res.json({ ok: true, server: publicView(record) });
});

router.get('/:id/modlist', (req, res) => {
  if (!store.isValidId(req.params.id)) {
    return res.status(400).json({ error: 'invalid server id' });
  }
  const record = store.readServer(req.params.id);
  if (!record) return res.status(404).json({ error: 'unknown server' });
  if (!record.modlist) return res.status(404).json({ error: 'no modlist published' });
  res.json(record.modlist);
});

// Admin publishes a modpack. Validation is strict on purpose: a modlist that
// breaks the prefix rule produces a connect-time failure that is very hard to
// trace back here, so it is refused at publish time instead.
router.put('/:id/modlist', requireAdmin, (req, res) => {
  const id = req.params.id;
  if (!store.isValidId(id)) {
    return res.status(400).json({ error: 'invalid server id' });
  }

  const record = store.readServer(id);
  if (!record) {
    return res.status(404).json({ error: 'unknown server, it must register first' });
  }

  const incoming = req.body || {};
  const { ok, errors } = modlist.validate(incoming);
  if (!ok) return res.status(400).json({ error: 'invalid modlist', details: errors });

  const unlisted = modlist.unlistedPlugins(incoming);
  if (unlisted.length) {
    return res.status(400).json({
      error: 'invalid modlist',
      details: [
        `these plugins are provided by a mod but missing from loadOrder: ${unlisted.join(', ')}`,
      ],
    });
  }

  const previous = record.modlist;
  record.modlist = {
    version: (previous ? previous.version : 0) + 1,
    updatedAt: new Date().toISOString(),
    mods: incoming.mods,
    loadOrder: incoming.loadOrder,
    serverPlugins: incoming.serverPlugins,
  };
  store.writeServer(id, record);

  res.json({ ok: true, version: record.modlist.version, mods: record.modlist.mods.length });
});

module.exports = router;
