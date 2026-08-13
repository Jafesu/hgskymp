'use strict';

// Exercises the discovery layer against real listeners: a stub backend and two
// stub game servers, one of which is deliberately dead.

const http = require('http');
const assert = require('assert');
const servers = require('../src/lib/servers');

let fail = 0;
const check = (label, cond, extra) => {
  console.log((cond ? 'PASS: ' : 'FAIL: ') + label);
  if (!cond) {
    fail = 1;
    if (extra !== undefined) console.log('      ' + JSON.stringify(extra));
  }
};

function listen(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

(async () => {
  // ── parseAddress, the direct-connect input ──────────────────────────────
  check('host:port', JSON.stringify(servers.parseAddress('play.example:7777')) === '{"host":"play.example","port":7777}');
  check('bare host takes the default port', JSON.stringify(servers.parseAddress('play.example')) === '{"host":"play.example","port":7777}');
  check('scheme is stripped', JSON.stringify(servers.parseAddress('http://play.example:40027')) === '{"host":"play.example","port":40027}');
  check('trailing slash is stripped', JSON.stringify(servers.parseAddress('play.example:40027/')) === '{"host":"play.example","port":40027}');
  check('whitespace is trimmed', JSON.stringify(servers.parseAddress('  play.example  ')) === '{"host":"play.example","port":7777}');
  check('ipv6 in brackets', JSON.stringify(servers.parseAddress('[::1]:7777')) === '{"host":"::1","port":7777}');
  check('port 0 rejected', servers.parseAddress('h:0') === null);
  check('port over range rejected', servers.parseAddress('h:70000') === null);
  check('empty rejected', servers.parseAddress('   ') === null);
  check('non-string rejected', servers.parseAddress(undefined) === null);

  // ── a live game server ──────────────────────────────────────────────────
  const alive = await listen((req, res) => {
    if (req.url === '/api/status') {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ name: 'Alive', players: 3, maxPlayers: 10 }));
    }
    if (req.url === '/modpack.json') {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ version: 2, mods: [], loadOrder: ['Skyrim.esm'] }));
    }
    res.statusCode = 404;
    res.end('{}');
  });
  const alivePort = alive.address().port;

  // A server with no pack published
  const bare = await listen((req, res) => {
    if (req.url === '/api/status') {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ name: 'Bare', players: 0, maxPlayers: 5 }));
    }
    res.statusCode = 404;
    res.end('not found');
  });
  const barePort = bare.address().port;

  const status = await servers.fetchStatus('127.0.0.1', alivePort);
  check('live server reports online', status.online === true, status);
  check('live server reports players', status.players === 3 && status.maxPlayers === 10, status);
  check('ping is measured', typeof status.ping === 'number' && status.ping >= 0, status);

  const dead = await servers.fetchStatus('127.0.0.1', 1, { timeoutMs: 1500 });
  check('unreachable server reports offline', dead.online === false, dead);
  check('offline entry carries a reason', typeof dead.error === 'string' && dead.error.length > 0, dead);

  const pack = await servers.fetchModpack('127.0.0.1', alivePort);
  check('modpack fetched from the server itself', pack.ok && pack.modpack.version === 2, pack);

  const noPack = await servers.fetchModpack('127.0.0.1', barePort);
  check('missing modpack is reported as not published, not as an error',
    noPack.ok === false && noPack.notPublished === true, noPack);

  // ── the backend ─────────────────────────────────────────────────────────
  const backend = await listen((req, res) => {
    if (req.url === '/api/servers') {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({
        servers: [
          // The backend still believes this one is up
          { id: 'gone', name: 'Gone', host: '127.0.0.1', port: 1, players: 9, online: true },
          { id: 'alive', name: 'Alive', host: '127.0.0.1', port: alivePort, players: 0, online: true },
        ],
      }));
    }
    res.statusCode = 500;
    res.end('boom');
  });
  const backendUrl = `http://127.0.0.1:${backend.address().port}`;

  const list = await servers.fetchServerList(backendUrl);
  check('server list fetched', list.ok && list.servers.length === 2, list);

  const live = await servers.fetchServerListWithLiveStatus(backendUrl, { timeoutMs: 1500 });
  const gone = live.servers.find((s) => s.id === 'gone');
  const up = live.servers.find((s) => s.id === 'alive');
  check('a stale backend entry is corrected to offline', gone.online === false, gone);
  check('a live entry keeps its real player count', up.online === true && up.players === 3, up);

  const noBackend = await servers.fetchServerList('');
  check('missing backend is handled, not thrown', noBackend.ok === false && noBackend.servers.length === 0, noBackend);

  const badBackend = await servers.fetchServerList('http://127.0.0.1:1', { timeoutMs: 1500 });
  check('unreachable backend is handled', badBackend.ok === false && Array.isArray(badBackend.servers), badBackend);

  const garbage = await servers.getJson('not a url');
  check('a malformed url does not throw', garbage.ok === false, garbage);

  alive.close();
  bare.close();
  backend.close();
  console.log(fail ? '\nFAILURES' : '\nall checks passed');
  process.exit(fail);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
