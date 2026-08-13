'use strict';

const path = require('path');

// Servers are considered offline once their last heartbeat is older than this.
// Three missed heartbeats at the game server's default interval.
const OFFLINE_AFTER_MS = 90_000;

module.exports = {
  port: parseInt(process.env.PORT || '8080', 10),
  dataDir: process.env.DATA_DIR || path.join(__dirname, '..', 'data'),

  // Shared secret a game server presents to POST /api/servers/register.
  // Unset means registration is refused outright rather than left open.
  registrationKey: process.env.REGISTRATION_KEY || '',

  // Shared secret for publishing modlists. Same reasoning.
  adminKey: process.env.ADMIN_KEY || '',

  offlineAfterMs: parseInt(process.env.OFFLINE_AFTER_MS || String(OFFLINE_AFTER_MS), 10),

  launcher: {
    version: process.env.LAUNCHER_VERSION || '0.0.0',
    downloadUrl: process.env.LAUNCHER_DOWNLOAD_URL || '',
  },
};
