import assert from 'assert';

import isSameBattlemetricsID, { normaliseBattlemetricsID } from '../utils/battlemetrics-id.js';

// The bot and the ban importer compare BattleMetrics ban list IDs with this, ignoring case, hyphens
// and spaces, so a partner list's source matches one of CBL's own export ban lists however either
// is written.

const ID = 'c0ffee00-cb1e-4a00-b000-0000000000aa';

for (const written of [
  ID,
  ID.toUpperCase(),
  ID.replace(/-/g, ''),
  ` ${ID}\n`,
  `\t${ID.toUpperCase().replace(/-/g, ' ')} `,
  'C0FFEE00CB1E4A00B0000000000000AA'
]) {
  assert.strictEqual(
    normaliseBattlemetricsID(written),
    'c0ffee00cb1e4a00b0000000000000aa',
    written
  );
  assert.ok(isSameBattlemetricsID(written, ID), written);
  assert.ok(isSameBattlemetricsID(ID, written), written);
}

// Other IDs, part of an ID, and anything without an ID never match, not even each other.
for (const other of [
  'c0ffee00-cb1e-4a00-b000-0000000000ab',
  ID.slice(0, 8),
  `${ID}0`,
  'c0ffee00_cb1e_4a00_b000_0000000000aa'
])
  assert.ok(!isSameBattlemetricsID(other, ID), other);
for (const empty of ['', ' ', ' - ', '\n', null, undefined, 12, {}]) {
  assert.strictEqual(normaliseBattlemetricsID(empty), '');
  assert.ok(!isSameBattlemetricsID(empty, empty), String(empty));
  assert.ok(!isSameBattlemetricsID(empty, ID), String(empty));
  assert.ok(!isSameBattlemetricsID(ID, empty), String(empty));
}

console.log(
  'BattleMetrics ID checks passed: case, hyphens and spaces are ignored, and other or empty IDs never match.'
);
