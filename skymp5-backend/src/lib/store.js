'use strict';

// Flat JSON on disk, one file per server. There is no database until there is
// a reason for one: the working set is a handful of servers, and a file is
// trivially inspectable and backed up.
//
// Writes go through a temp file and a rename so a crash mid-write can never
// leave a half-written server record behind.

const fs = require('fs');
const path = require('path');
const config = require('../config');

const serversDir = () => path.join(config.dataDir, 'servers');

// Server ids land in file paths, so they must not be able to escape the
// directory or collide once the filesystem folds case.
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{1,63}$/;

function isValidId(id) {
  return typeof id === 'string' && ID_PATTERN.test(id);
}

function pathFor(id) {
  if (!isValidId(id)) throw new Error(`invalid server id: ${JSON.stringify(id)}`);
  return path.join(serversDir(), `${id}.json`);
}

function readServer(id) {
  try {
    return JSON.parse(fs.readFileSync(pathFor(id), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

function writeServer(id, record) {
  const dir = serversDir();
  fs.mkdirSync(dir, { recursive: true });
  const target = pathFor(id);
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2) + '\n');
  fs.renameSync(tmp, target);
  return record;
}

function listServers() {
  let names = [];
  try {
    names = fs.readdirSync(serversDir()).filter((f) => f.endsWith('.json'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    return [];
  }

  const out = [];
  for (const name of names) {
    const id = name.slice(0, -'.json'.length);
    if (!isValidId(id)) continue;
    const record = readServer(id);
    if (record) out.push(record);
  }
  return out;
}

function deleteServer(id) {
  try {
    fs.unlinkSync(pathFor(id));
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

module.exports = { isValidId, readServer, writeServer, listServers, deleteServer };
