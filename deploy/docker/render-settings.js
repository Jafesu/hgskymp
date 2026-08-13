#!/usr/bin/env node
// Merges container environment variables into server-settings.json.
//
// Operator edits to the file are preserved. Any key whose environment variable
// is set and non-empty is overwritten on every boot, because on an orchestrator
// the allocation, not the file, is authoritative for things like ports.

'use strict';

const fs = require('fs');
const path = require('path');

const SETTINGS_PATH = process.argv[2] || 'server-settings.json';

const asInt = (raw, key) => {
  const value = parseInt(raw, 10);
  if (!Number.isInteger(value)) {
    throw new Error(`${key}: expected an integer, got ${JSON.stringify(raw)}`);
  }
  return value;
};

const asPort = (raw, key) => {
  const value = asInt(raw, key);
  if (value < 1 || value > 65535) {
    throw new Error(`${key}: port ${value} is out of range 1-65535`);
  }
  return value;
};

const asBool = (raw, key) => {
  const value = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  throw new Error(`${key}: expected a boolean, got ${JSON.stringify(raw)}`);
};

const asString = (raw) => raw;

// Comma or newline separated, so a load order can be given on one line
const asList = (raw) =>
  String(raw)
    .split(/[,\n]/)
    .map((entry) => entry.trim())
    .filter(Boolean);

const asJson = (raw, key) => {
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`${key}: not valid JSON (${err.message})`);
  }
};

// env var -> settings key
const MAPPINGS = [
  ['SERVER_PORT', 'port', asPort],
  ['UI_PORT', 'uiPort', asPort],
  ['SERVER_NAME', 'name', asString],
  ['MAX_PLAYERS', 'maxPlayers', asInt],
  ['OFFLINE_MODE', 'offlineMode', asBool],
  ['MASTER_URL', 'master', asString],
  ['MASTER_KEY', 'masterKey', asString],
  ['MASTER_API_AUTH_TOKEN', 'masterApiAuthToken', asString],
  ['DATA_DIR', 'dataDir', asString],
  ['GAMEMODE_PATH', 'gamemodePath', asString],
  ['LISTEN_HOST', 'listenHost', asString],
  ['UI_LISTEN_HOST', 'uiListenHost', asString],
  ['SERVER_LANG', 'lang', asString],
  ['DATABASE_DRIVER', 'databaseDriver', asString],
  ['DATABASE_NAME', 'databaseName', asString],
  ['DATABASE_URI', 'databaseUri', asString],
  ['LOAD_ORDER', 'loadOrder', asList],
  ['ARCHIVES', 'archives', asList],
  ['START_POINTS_JSON', 'startPoints', asJson],
  ['METRICS_AUTH_JSON', 'metricsAuth', asJson],
];

let settings = {};
if (fs.existsSync(SETTINGS_PATH)) {
  const raw = fs.readFileSync(SETTINGS_PATH, 'utf8');
  try {
    settings = JSON.parse(raw);
  } catch (err) {
    // Refusing here beats silently discarding a hand-edited config
    console.error(`[settings] ${SETTINGS_PATH} is not valid JSON: ${err.message}`);
    process.exit(1);
  }
}

const applied = [];
for (const [envKey, settingKey, coerce] of MAPPINGS) {
  const raw = process.env[envKey];
  if (raw === undefined || raw === '') continue;

  try {
    settings[settingKey] = coerce(raw, envKey);
  } catch (err) {
    console.error(`[settings] ${err.message}`);
    process.exit(1);
  }
  // Never echo credentials into the startup log
  const secret = /KEY|TOKEN|URI|AUTH/.test(envKey);
  applied.push(`${settingKey}=${secret ? '***' : JSON.stringify(settings[settingKey])}`);
}

// A non-default game port means something else is assigning ports, and an
// orchestrator only routes the allocations it handed out. Binding any other
// port succeeds inside the container and is unreachable from outside, which
// looks like a working server until the launcher cannot poll it.
if (settings.port !== undefined && settings.port !== 7777) {
  const uiPort = settings.uiPort === undefined ? settings.port + 1 : settings.uiPort;
  const derived = settings.uiPort === undefined;
  if (derived || uiPort === 3000) {
    console.warn(
      `[settings] WARNING: game port is ${settings.port} but the http port is ${uiPort}` +
        `${derived ? ' (derived, UI_PORT unset)' : ''}.\n` +
        `[settings]          If ${uiPort} is not an allocation assigned to this server, ` +
        `/api/status and the modpack will be unreachable.\n` +
        `[settings]          Set UI_PORT to a second allocation.`
    );
  }
}

// Platform registration is a nested object, so it is built separately rather
// than bent into the flat mapping above. Only keys whose variable is set are
// touched, so hand edits to the rest of the block survive.
const PLATFORM_MAPPINGS = [
  ['PLATFORM_URL', 'url', asString],
  ['PLATFORM_SERVER_ID', 'serverId', asString],
  ['PLATFORM_REGISTRATION_KEY', 'registrationKey', asString],
  ['PLATFORM_PUBLIC_HOST', 'publicHost', asString],
  ['PLATFORM_PUBLIC_PORT', 'publicPort', asPort],
  ['SERVER_DESCRIPTION', 'description', asString],
  ['PLATFORM_HEARTBEAT_MS', 'heartbeatIntervalMs', asInt],
];

const platformApplied = [];
for (const [envKey, settingKey, coerce] of PLATFORM_MAPPINGS) {
  const raw = process.env[envKey];
  if (raw === undefined || raw === '') continue;

  if (!settings.platform || typeof settings.platform !== 'object') settings.platform = {};
  try {
    settings.platform[settingKey] = coerce(raw, envKey);
  } catch (err) {
    console.error(`[settings] ${err.message}`);
    process.exit(1);
  }
  const secret = /KEY|TOKEN/.test(envKey);
  platformApplied.push(`platform.${settingKey}=${secret ? '***' : JSON.stringify(settings.platform[settingKey])}`);
}
if (platformApplied.length) applied.push(...platformApplied);

// A server that registers without a reachable address lists itself as
// unjoinable. It cannot infer this: it sees a bind address, not the NAT or DNS
// in front of it.
if (settings.platform && settings.platform.url && !settings.platform.publicHost) {
  console.error('[settings] PLATFORM_URL is set but PLATFORM_PUBLIC_HOST is not; the server would list an address nobody can reach');
  process.exit(1);
}

// Required by the addon, and there is no sensible way for it to guess
if (settings.dataDir === undefined) settings.dataDir = 'data';
if (settings.gamemodePath === undefined) settings.gamemodePath = 'gamemode.js';

if (settings.uiPort !== undefined && settings.uiPort === settings.port) {
  console.error(`[settings] uiPort ${settings.uiPort} collides with the game port`);
  process.exit(1);
}

fs.mkdirSync(path.dirname(path.resolve(SETTINGS_PATH)), { recursive: true });
fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n');

console.log(`[settings] wrote ${SETTINGS_PATH}${applied.length ? ': ' + applied.join(' ') : ' (no env overrides)'}`);
