'use strict';

// No live Nexus calls here: these cover the parsing and URL construction that
// the download flow depends on, plus the branch that decides between the
// premium and click-through paths.

const nexus = require('../src/lib/nexus');

let fail = 0;
const check = (label, cond, extra) => {
  console.log((cond ? 'PASS: ' : 'FAIL: ') + label);
  if (!cond) {
    fail = 1;
    if (extra !== undefined) console.log('      ' + JSON.stringify(extra));
  }
};

// ── nxm:// parsing ──────────────────────────────────────────────────────────
// This is what the browser hands back after "Mod Manager Download", and it
// carries the credential that lets a free account fetch the file at all.

const good = nexus.parseNxmUrl(
  'nxm://skyrimspecialedition/mods/12604/files/749043?key=abc123&expires=1700000000&user_id=42'
);
check('parses a well-formed handoff', good !== null, good);
check('extracts mod and file ids', good.modId === 12604 && good.fileId === 749043, good);
check('extracts the credential', good.key === 'abc123' && good.expires === '1700000000', good);
check('recognises our game', good.isOurGame === true, good);

const otherGame = nexus.parseNxmUrl('nxm://fallout4/mods/1/files/2?key=k&expires=1');
check('a link for another game still parses', otherGame !== null);
check('...but is flagged as not ours', otherGame.isOurGame === false, otherGame);

const noCreds = nexus.parseNxmUrl('nxm://skyrimspecialedition/mods/1/files/2');
check('a handoff without a key parses with nulls',
  noCreds !== null && noCreds.key === null && noCreds.expires === null, noCreds);

check('trailing slash tolerated',
  nexus.parseNxmUrl('nxm://skyrimspecialedition/mods/1/files/2/') !== null);

// Malformed or hostile input must not steer the launcher anywhere
check('http is rejected', nexus.parseNxmUrl('http://skyrimspecialedition/mods/1/files/2') === null);
check('wrong path shape is rejected', nexus.parseNxmUrl('nxm://skyrimspecialedition/collections/1') === null);
check('non-numeric ids are rejected', nexus.parseNxmUrl('nxm://skyrimspecialedition/mods/abc/files/2') === null);
check('missing file segment is rejected', nexus.parseNxmUrl('nxm://skyrimspecialedition/mods/12604') === null);
check('garbage is rejected', nexus.parseNxmUrl('not a url') === null);
check('undefined is rejected', nexus.parseNxmUrl(undefined) === null);
check('empty string is rejected', nexus.parseNxmUrl('') === null);

// ── page urls ───────────────────────────────────────────────────────────────

const page = nexus.modPageUrl(12604, 749043);
check('mod page deep-links the exact file', /mods\/12604\?tab=files&file_id=749043/.test(page), page);
check('mod page asks for the mod-manager flow', /nmm=1/.test(page), page);
check('mod page without a file id still works',
  nexus.modPageUrl(12604) === 'https://www.nexusmods.com/skyrimspecialedition/mods/12604');
check('api key page is https', /^https:\/\//.test(nexus.API_KEY_PAGE));

// ── unauthenticated calls fail closed ───────────────────────────────────────

(async () => {
  const noAuth = await nexus.validate(null);
  check('validate without credentials fails rather than throwing',
    noAuth.ok === false && /not signed in/i.test(noAuth.error), noAuth);

  const noAuthLinks = await nexus.getDownloadLinks(null, 1, 2);
  check('download links without credentials fail closed', noAuthLinks.ok === false, noAuthLinks);

  console.log(fail ? '\nFAILURES' : '\nall checks passed');
  process.exit(fail);
})();
