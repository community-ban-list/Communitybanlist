import assert from 'assert';

import ReplyUpdater from '../src/utils/reply-updater.js';

// Keep a command's reply up to date during a long job: one edit at a time, at most every interval,
// with the latest progress; the final payload after any edit under way; and nothing once an edit
// fails or Discord's 15 minutes for editing the reply are nearly up.

const MINUTE = 60 * 1000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A reply whose edits finish when the test says so, or at once with `instant`.
function reply({ createdTimestamp = Date.now(), instant = false } = {}) {
  const edits = [];
  return {
    edits,
    commandName: 'exportbanlist',
    createdTimestamp,
    editReply(payload) {
      return new Promise((resolve, reject) => {
        edits.push({ payload, resolve, reject });
        if (instant) resolve();
      });
    }
  };
}
const payloads = (interaction) => interaction.edits.map(({ payload }) => payload);

// Progress is shown at once, and while an edit is under way only the latest progress waits, to be
// shown once the edit is done and the interval has passed since.
let interaction = reply();
let updater = new ReplyUpdater(interaction, { interval: 40 });
updater.update('1 done');
assert.deepStrictEqual(payloads(interaction), ['1 done']);
updater.update('2 done');
updater.update('3 done');
await sleep(60);
assert.deepStrictEqual(payloads(interaction), ['1 done']);
interaction.edits[0].resolve();
await sleep(10);
assert.deepStrictEqual(payloads(interaction), ['1 done']);
await sleep(60);
assert.deepStrictEqual(payloads(interaction), ['1 done', '3 done']);

// The final payload waits for the edit under way and replaces any progress still waiting, which is
// never shown.
updater.update('4 done');
const finished = updater.finish('All done');
await sleep(10);
assert.deepStrictEqual(payloads(interaction), ['1 done', '3 done']);
interaction.edits[1].resolve();
await sleep(10);
assert.deepStrictEqual(payloads(interaction), ['1 done', '3 done', 'All done']);
interaction.edits[2].resolve();
assert.strictEqual(await finished, true);
await sleep(60);
assert.deepStrictEqual(payloads(interaction), ['1 done', '3 done', 'All done']);

// Discord accepts edits for 15 minutes after the command, so they stop 30 seconds before then.
let clock = 0;
interaction = reply({ createdTimestamp: 0, instant: true });
updater = new ReplyUpdater(interaction, { now: () => clock, interval: 0 });
clock = 14.5 * MINUTE - 1;
updater.update('Still going');
await sleep(10);
assert.deepStrictEqual(payloads(interaction), ['Still going']);
clock = 14.5 * MINUTE;
updater.update('Too late');
assert.strictEqual(await updater.finish('Done'), false);
assert.deepStrictEqual(payloads(interaction), ['Still going']);

// An edit that fails, e.g. as the reply can no longer be edited, is reported once, and no more
// edits are made.
const warnings = [];
const { warn } = console;
console.warn = (line) => warnings.push(line);
try {
  interaction = reply();
  updater = new ReplyUpdater(interaction, { interval: 0 });
  updater.update('1 done');
  interaction.edits[0].reject(new Error('Invalid Webhook Token'));
  await sleep(10);
  updater.update('2 done');
  assert.strictEqual(await updater.finish('Done'), false);
  assert.deepStrictEqual(payloads(interaction), ['1 done']);
} finally {
  console.warn = warn;
}
assert.deepStrictEqual(warnings, [
  'Could not update the reply to /exportbanlist, so it is no longer updated: Invalid Webhook Token'
]);

console.log(
  'Reply updater checks passed: one edit at a time, the latest progress, the final payload, the 15 minutes and failed edits.'
);
