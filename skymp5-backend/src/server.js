'use strict';

const express = require('express');
const config = require('./config');
const serversRoute = require('./routes/servers');

const app = express();

app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));

app.get('/api/health', (_req, res) => res.json({ ok: true }));

// The launcher polls this to decide whether to prompt for an update.
app.get('/api/launcher/version', (_req, res) => {
  res.json({
    version: config.launcher.version,
    downloadUrl: config.launcher.downloadUrl,
  });
});

app.use('/api/servers', serversRoute);

app.use((_req, res) => res.status(404).json({ error: 'not found' }));

// A malformed body from express.json arrives here; without this it would
// surface as an HTML stack trace rather than the JSON every caller expects.
app.use((err, _req, res, _next) => {
  const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status === 400 ? 'malformed request body' : 'internal error' });
});

if (require.main === module) {
  app.listen(config.port, () => {
    console.log(`backend listening on ${config.port}`);
    console.log(`data dir: ${config.dataDir}`);
    if (!config.registrationKey) console.warn('REGISTRATION_KEY unset: server registration is disabled');
    if (!config.adminKey) console.warn('ADMIN_KEY unset: modlist publishing is disabled');
  });
}

module.exports = app;
