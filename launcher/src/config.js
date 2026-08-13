'use strict';

// Build-time defaults. Everything here is overridable at runtime from the
// settings store, so a rebuild is never needed to point the launcher at a
// different backend.
module.exports = {
  backendUrl: process.env.HG_BACKEND_URL || 'https://api.hardgaming.tech',
  brand: {
    name: 'HardGaming SkyMP Launcher',
    site: 'https://hardgaming.tech/',
  },
  // How often the server list refreshes while it is on screen
  refreshIntervalMs: 20000,
  requestTimeoutMs: 6000,
};
