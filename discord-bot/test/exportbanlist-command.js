import assert from 'assert';
import { readFile } from 'fs/promises';
import vm from 'vm';

import * as discord from 'discord.js';

import * as scblUtils from '../../scbl-lib/utils/index.js';

// Run /exportbanlist without Discord, the database or BattleMetrics. Package imports are replaced
// by the stand-ins below, and relative imports load the real files, once each, as Node would, so
// the command, confirm(), audit() and the reply updater are the real ones. The modules run in this
// test's own context, so their errors and objects compare directly.
const loaded = new Map();
function moduleAt(url) {
  if (!loaded.has(url))
    loaded.set(
      url,
      readFile(new URL(url), 'utf8').then(
        (source) => new vm.SourceTextModule(source, { identifier: url })
      )
    );
  return loaded.get(url);
}
function linker(specifier, referencingModule) {
  if (specifier.startsWith('.'))
    return moduleAt(new URL(specifier, referencingModule.identifier).href);

  const exports = stubs[specifier];
  assert.ok(exports, `Unexpected dependency: ${specifier}`);
  return new vm.SyntheticModule(Object.keys(exports), function () {
    for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
  });
}
async function load(path) {
  const module = await moduleAt(new URL(path, import.meta.url).href);
  if (module.status === 'unlinked') await module.link(linker);
  if (module.status === 'linked') await module.evaluate();
  return module.namespace;
}

const LIMITS = {
  battlemetrics: { maxPlayers: 20000, minThreshold: 4, neverEnough: 'active-plus-expired' },
  remote: { maxPlayers: 40000, minThreshold: 4, neverEnough: 'active-plus-expired' }
};
const LIMITS_TEXT =
  "Limits used: BattleMetrics lists have at most 20,000 players and a threshold of at least 4, and one active ban plus one expired ban must never be enough; remote lists have at most 40,000 players and a threshold of at least 4, and one active ban plus one expired ban must never be enough. They come from the bot's EXPORT_* settings, which must match the website's.";
const RUNNING =
  'The ban importer is running, so nothing was changed. Try again once the run has finished.';
const PROGRESS_NOTE =
  'This reply can only be updated for 15 minutes after the command, so each result and the summary also go to the CBL log channel.';
// A message from the website's rules, as checkLimits gives them.
const RULE =
  'One active ban plus one expired ban must not be enough to put a player on an export ban list. Here they can give 6 points (5 for an active ban, plus 1 for an expired ban), so the threshold must be 7 or more. Raise the threshold or lower the points.';

// What the command did: lookups, run lock checks and deletions in order, the replies it made, what
// it logged, and anything that could tell a list's owner.
let calls;
let replies;
let audits;
let notifications;

// The database's export ban lists, by ID, each with what checkLimits gives for it. A deletion
// removes the list, unless the list's answer in `deletions` is an error.
let rows;
let deletions;
// The query that loaded each list deleted, in turn, e.g. 'find 12' for findByPk(12), as each query
// gives instances of its own, as Sequelize's do.
let deletedFrom;
// Answers to isRunLockHeld, in turn: whether a run holds the lock, or an error. Once they run out,
// no run holds it.
let lockAnswers;
// The BattleMetrics ban lists the API key can see, or an error for the listing.
let visible;
// How the admin answers the confirmation: 'confirm', 'cancel' or 'timeout'. Before they answer,
// whileConfirming runs, e.g. to change a list.
let answer;
let whileConfirming;
// How long each confirmation waited for an answer, in milliseconds.
let timeouts;

function reset() {
  calls = [];
  replies = [];
  audits = [];
  notifications = [];
  rows = new Map();
  deletions = new Map();
  deletedFrom = [];
  lockAnswers = [];
  visible = new Set();
  answer = 'confirm';
  whileConfirming = null;
  timeouts = [];
}

// Add a list to the database. Reading its Discord webhook, the only way to tell its owner anything,
// is recorded.
function addList(
  id,
  type,
  { battlemetricsID = null, players = 0, problems = [RULE], ...more } = {}
) {
  const exportBanList = {
    id,
    name: `List ${id}`,
    type,
    owner: `765611980000000${id}`,
    battlemetricsID,
    threshold: 5,
    defaultActivePoints: 5,
    defaultExpiredPoints: 1,
    maxBanAge: 0,
    SteamUser: { id: `765611980000000${id}`, name: `Owner ${id}` },
    get discordWebhook() {
      notifications.push(id);
      return 'https://discord.com/api/webhooks/1/token';
    },
    // Like the shared deletion, a list that is removed no longer records its BattleMetrics ban
    // list.
    async deleteExportBanList() {
      calls.push(['delete', id]);
      deletedFrom.push(this.loadedBy);
      const result = deletions.get(id);
      if (result instanceof Error) throw result;
      rows.delete(id);
      const outcome = result ?? (this.battlemetricsID ? 'deleted' : 'none');
      this.battlemetricsID = null;
      return outcome;
    },
    ...more
  };
  rows.set(id, {
    exportBanList,
    players,
    problems: problems.map((message) => ({ rule: 'never-enough', field: 'threshold', message })),
    checked: true
  });
  return exportBanList;
}

// A list as a query gives it: an instance of its own, which says which query loaded it. Its webhook
// stays a getter, so reading it is still recorded.
const instance = (exportBanList, query) =>
  Object.defineProperties(
    {},
    {
      ...Object.getOwnPropertyDescriptors(exportBanList),
      loadedBy: { value: query, enumerable: true }
    }
  );

const ExportBanList = {
  async checkLimits({ ids } = {}) {
    calls.push(['check', ids === undefined ? 'all' : [...ids]]);
    const query = `check ${ids === undefined ? 'all' : ids.join(',')}`;
    const lists = [...rows.values()]
      .filter((row) => ids === undefined || ids.includes(row.exportBanList.id))
      .sort((a, b) => a.exportBanList.id - b.exportBanList.id)
      .map((row) => ({
        ...row,
        exportBanList: instance(row.exportBanList, query),
        configs: [],
        problems: [...row.problems]
      }));
    return { limits: LIMITS, lists };
  },
  async findByPk(id) {
    calls.push(['find', id]);
    const row = rows.get(id);
    return row ? instance(row.exportBanList, `find ${id}`) : null;
  },
  // Only the lists whose columns equal the query's, in ID order. The BattleMetrics ban lists CBL's
  // lists record are read this way, so the query must load each list's type and ban list.
  async findAll({ attributes, where }) {
    calls.push(['find all', where]);
    assert.ok(attributes.includes('type') && attributes.includes('battlemetricsID'));
    return [...rows.values()]
      .map((row) => row.exportBanList)
      .filter((exportBanList) =>
        Object.entries(where).every(([column, value]) => exportBanList[column] === value)
      )
      .sort((a, b) => a.id - b.id)
      .map((exportBanList) => instance(exportBanList, 'find all'));
  },
  async findVisibleBattlemetricsBanLists() {
    calls.push(['visible']);
    if (visible instanceof Error) throw visible;
    return new Set(visible);
  }
};

const stubs = {
  'discord.js': discord,
  axios: { default: { create: () => ({}) } },
  'scbl-lib/config': { BATTLEMETRICS_API_KEY: 'test-key' },
  'scbl-lib/db': {
    sequelize: {},
    async isRunLockHeld() {
      calls.push(['lock']);
      const held = lockAnswers.shift() ?? false;
      if (held instanceof Error) throw held;
      return held;
    }
  },
  'scbl-lib/db/models': {
    Ban: {},
    BanList: {},
    ExportBanList,
    ExportBanListConfig: {},
    Organisation: {}
  },
  'scbl-lib/db/sequelize': { Op: {} },
  // The real utils, so the bot's other helpers find what they import, but a logger that records
  // what the command logs rather than sending it.
  'scbl-lib/utils': {
    ...scblUtils,
    Logger: {
      verbose: (module, level, line) => audits.push(line),
      important: (module, line) => audits.push(`[important] ${line}`)
    }
  }
};

const { default: commands } = await load('../src/commands/index.js');
const { UserError } = await load('../src/utils/index.js');
const command = commands.get('exportbanlist');

// The command's reply: every edit, and each button the confirmation shows. The reply can be edited
// until `expiresAt`, or until `failEditsAfter` more edits have been made.
let failEditsAfter;
function interaction(subcommand, options = {}, { createdTimestamp = Date.now() } = {}) {
  const user = { tag: 'admin', id: '1' };
  return {
    commandName: 'exportbanlist',
    user,
    createdTimestamp,
    options: {
      getSubcommand: () => subcommand,
      getInteger: (name, required) => {
        assert.strictEqual(required, true);
        return options[name] ?? null;
      },
      getSubcommandGroup: () => null
    },
    // Nothing is sent but edits to the admin's own reply.
    followUp: () => assert.fail('No follow-up message is sent.'),
    async editReply(payload) {
      if (failEditsAfter !== undefined && failEditsAfter-- <= 0)
        throw new Error('Invalid Webhook Token');
      replies.push(payload);
      return {
        async awaitMessageComponent({ filter, time }) {
          timeouts.push(time);
          if (whileConfirming) await whileConfirming();
          if (answer === 'timeout') throw new Error('Collector received no interactions');
          const button = {
            customId: answer,
            user,
            async update(update) {
              replies.push(update);
            }
          };
          assert.ok(filter(button));
          assert.ok(!filter({ ...button, user: { id: '2' } }));
          return button;
        }
      };
    }
  };
}
const run = (subcommand, options, settings) =>
  command.execute(interaction(subcommand, options, settings));

const contentOf = (reply) => (typeof reply === 'string' ? reply : reply.content);
const embedOf = (reply) => reply.embeds?.[0]?.toJSON();
const fieldsOf = (embed) => embed.fields.map(({ name, value }) => [name, value]);
const fileOf = (reply) => reply.files?.[0];
// The confirmation's question, its button, and what it shows.
function prompt() {
  const question = replies.find((reply) => reply.components?.length > 0);
  if (!question) return null;
  const [confirmButton] = question.components[0].toJSON().components;
  return { reply: question, label: confirmButton.label, embed: embedOf(question) };
}
const deleted = () => calls.filter(([call]) => call === 'delete').map(([, id]) => id);

// Only administrators see the command unless the server allows other roles, and the bot itself
// lets only its admin roles use it. It has a subcommand for one list and one for every list outside
// the limits.
const json = command.data.toJSON();
assert.strictEqual(json.name, 'exportbanlist');
assert.strictEqual(json.default_member_permissions, '0');
assert.deepStrictEqual(
  json.options.map((option) => option.name),
  ['remove', 'remove_outside_limits']
);
const [idOption] = json.options[0].options;
assert.deepStrictEqual(
  [idOption.type, idOption.name, idOption.required, idOption.min_value],
  [discord.ApplicationCommandOptionType.Integer, 'id', true, 1]
);
assert.strictEqual(json.options[0].options.length, 1);
assert.deepStrictEqual(json.options[1].options, []);

// The query that reads the BattleMetrics ban lists CBL's lists record.
const FIND_RECORDED = ['find all', { type: 'battlemetrics' }];

// Removing one list shows its name, type, owner, players, BattleMetrics ID, whether CBL's
// BattleMetrics key can see its ban list, and why it is outside today's limits, asks first, giving
// a minute to answer, and then deletes it as the website does, once no ban importer run is under
// way. The removal is logged, and the owner is not told.
reset();
addList(12, 'battlemetrics', { battlemetricsID: 'bm-12', players: 1234 });
visible = new Set(['bm-12', 'partner-list']);
await run('remove', { id: 12 });
let shown = prompt();
assert.strictEqual(
  contentOf(shown.reply),
  'Remove export ban list **List 12** (#12)? This deletes its BattleMetrics ban list, which the organisations subscribed to it lose, and then the list, with its export bans and configs. Its owner is not told.'
);
assert.strictEqual(shown.label, 'Remove export ban list');
assert.strictEqual(shown.embed.title, 'List 12');
assert.deepStrictEqual(fieldsOf(shown.embed), [
  ['ID', '12'],
  ['Type', 'BattleMetrics'],
  ['Players', '1,234'],
  ['Owner', '**Owner 12** (`76561198000000012`)'],
  ['BattleMetrics ID', "`bm-12`, which CBL's BattleMetrics key can see."],
  ["Today's limits", discord.escapeMarkdown(RULE)]
]);
assert.deepStrictEqual(timeouts, [60 * 1000]);
assert.deepStrictEqual(calls, [
  ['lock'],
  ['check', [12]],
  FIND_RECORDED,
  ['visible'],
  ['lock'],
  ['find', 12],
  ['delete', 12]
]);
// The list is deleted as it was read after the confirmation, not as the preview showed it.
assert.deepStrictEqual(deletedFrom, ['find 12']);
assert.strictEqual(
  contentOf(replies.at(-1)),
  'Removed export ban list **List 12** (#12) and its BattleMetrics ban list.'
);
assert.deepStrictEqual(audits, [
  'admin (1) removed export ban list "List 12" (ID: 12, BattleMetrics, BattleMetrics ID: bm-12) of Steam user "Owner 12" (ID: 76561198000000012), which had 1,234 players: its BattleMetrics ban list was deleted.'
]);
assert.deepStrictEqual(notifications, []);
assert.ok(!rows.has(12));

// A remote list is only deleted from the database. A BattleMetrics list without a ban list, and
// one whose ban list BattleMetrics no longer had, say so. A list within the limits can be removed
// too. BattleMetrics is only asked which ban lists CBL's key can see for a list with a ban list.
const askedBattlemetrics = () =>
  calls.some(([call]) => call === 'visible' || call === FIND_RECORDED[0]);

reset();
addList(13, 'remote', { players: 0, problems: [] });
await run('remove', { id: 13 });
shown = prompt();
assert.strictEqual(
  contentOf(shown.reply),
  'Remove export ban list **List 13** (#13)? This deletes the list, with its export bans and configs, so its address serves no players. Its owner is not told.'
);
assert.deepStrictEqual(fieldsOf(shown.embed), [
  ['ID', '13'],
  ['Type', 'Remote'],
  ['Players', '0'],
  ['Owner', '**Owner 13** (`76561198000000013`)'],
  ["Today's limits", 'Within them.']
]);
assert.strictEqual(contentOf(replies.at(-1)), 'Removed export ban list **List 13** (#13).');
assert.match(audits[0], /, which had 0 players: there was nothing to delete on BattleMetrics\.$/);
assert.ok(!askedBattlemetrics());

reset();
addList(14, 'battlemetrics', { SteamUser: null });
await run('remove', { id: 14 });
shown = prompt();
assert.match(
  contentOf(shown.reply),
  / It has no BattleMetrics ban list, so this deletes only the list,/
);
assert.deepStrictEqual(fieldsOf(shown.embed).slice(3, 5), [
  ['Owner', '`76561198000000014`'],
  ['BattleMetrics ID', 'None']
]);
assert.strictEqual(
  contentOf(replies.at(-1)),
  'Removed export ban list **List 14** (#14). It had no BattleMetrics ban list.'
);
assert.match(audits[0], /of Steam user 76561198000000014, which had 0 players:/);
assert.ok(!askedBattlemetrics());

// BattleMetrics not knowing a ban list CBL's key could see before the removal means it is gone.
reset();
addList(15, 'battlemetrics', { battlemetricsID: 'bm-15' });
visible = new Set(['bm-15']);
deletions.set(15, 'gone');
await run('remove', { id: 15 });
assert.strictEqual(
  contentOf(replies.at(-1)),
  'Removed export ban list **List 15** (#15). BattleMetrics no longer had its ban list, so there was nothing to delete there.'
);
assert.match(audits[0], /: BattleMetrics no longer had its ban list\.$/);

// A key that cannot see a ban list gets the answer BattleMetrics gives for one it does not have, so
// the removal would take the ban list to be gone and leave it on BattleMetrics. So the confirmation
// says when CBL's key cannot see the list's ban list, or sees none of the ban lists CBL's lists
// record, or BattleMetrics could not be asked, and the list can still be removed. Then BattleMetrics
// not knowing the ban list is reported as something to check on BattleMetrics, not as its being
// gone. Remote lists, and BattleMetrics lists without a ban list, are not counted as recording one.
const UNSEEN =
  'the removal takes it to be gone already: it deletes only the list, with its export bans and configs, and the ban list stays on BattleMetrics with its subscribers.';
for (const { case: name, key, content, field, gone } of [
  {
    case: 'the key cannot see the ban list',
    key: new Set(['bm-22', 'partner-list']),
    content: `**CBL's BattleMetrics key cannot see its BattleMetrics ban list**, though it can see 1 of the 2 BattleMetrics ban lists CBL's export ban lists record, so BattleMetrics may have deleted it already. If it has not, ${UNSEEN} Check it on BattleMetrics first.`,
    field: "`bm-21`, which CBL's BattleMetrics key cannot see.",
    gone: "CBL's BattleMetrics key could not see it before the removal"
  },
  {
    case: "the key sees none of CBL's ban lists",
    key: new Set(['partner-list']),
    content: `**CBL's BattleMetrics key can see 0 of the 2 BattleMetrics ban lists CBL's export ban lists record**, so it may belong to an account outside CBL's organisation: check BATTLEMETRICS_API_KEY. If BattleMetrics still has this list's ban list, ${UNSEEN}`,
    field: "`bm-21`, which CBL's BattleMetrics key cannot see.",
    gone: "CBL's BattleMetrics key could not see it before the removal"
  },
  {
    case: 'BattleMetrics cannot be asked',
    key: new Error('BattleMetrics GET ban-lists failed: HTTP 503'),
    content: `This deletes its BattleMetrics ban list, which the organisations subscribed to it lose, and then the list, with its export bans and configs. **BattleMetrics could not be asked whether CBL's BattleMetrics key can see the ban list** (BattleMetrics GET ban-lists failed: HTTP 503). If the key cannot see it, ${UNSEEN}`,
    field:
      "`bm-21`. Whether CBL's BattleMetrics key can see it was not checked, as BattleMetrics could not be asked.",
    gone: "BattleMetrics could not be asked whether CBL's BattleMetrics key could see it"
  }
]) {
  for (const outcome of ['gone', 'deleted']) {
    reset();
    addList(21, 'battlemetrics', { battlemetricsID: 'bm-21', players: 3 });
    addList(22, 'battlemetrics', { battlemetricsID: 'bm-22' });
    addList(23, 'remote');
    addList(24, 'battlemetrics');
    visible = key;
    deletions.set(21, outcome);
    await run('remove', { id: 21 });
    shown = prompt();
    assert.strictEqual(
      contentOf(shown.reply),
      `Remove export ban list **List 21** (#21)? ${content} Its owner is not told.`,
      name
    );
    assert.deepStrictEqual(fieldsOf(shown.embed)[4], ['BattleMetrics ID', field], name);
    assert.deepStrictEqual(
      calls,
      [
        ['lock'],
        ['check', [21]],
        FIND_RECORDED,
        ['visible'],
        ['lock'],
        ['find', 21],
        ['delete', 21]
      ],
      name
    );
    const removed =
      'admin (1) removed export ban list "List 21" (ID: 21, BattleMetrics, BattleMetrics ID: bm-21) of Steam user "Owner 21" (ID: 76561198000000021), which had 3 players';
    if (outcome === 'gone') {
      assert.strictEqual(
        contentOf(replies.at(-1)),
        `Removed export ban list **List 21** (#21), but BattleMetrics did not know its ban list, and ${gone}, so it may still be on BattleMetrics with its subscribers: check it there.`,
        name
      );
      assert.deepStrictEqual(
        audits,
        [
          `${removed}: BattleMetrics did not know its ban list, and ${gone}, so it may still be on BattleMetrics: check it there.`
        ],
        name
      );
    } else {
      // BattleMetrics deleted it after all, e.g. as the key was given its access meanwhile.
      assert.strictEqual(
        contentOf(replies.at(-1)),
        'Removed export ban list **List 21** (#21) and its BattleMetrics ban list.',
        name
      );
      assert.deepStrictEqual(audits, [`${removed}: its BattleMetrics ban list was deleted.`], name);
    }
    assert.deepStrictEqual([...rows.keys()], [22, 23, 24], name);
    assert.deepStrictEqual(notifications, [], name);
  }
}

// A list given a ban list after the confirmation, as one still being made is, had no check of the
// key, so BattleMetrics not knowing that ban list is reported as something to check too, and the
// log names the ban list the removal took.
reset();
addList(25, 'battlemetrics');
whileConfirming = async () => {
  rows.get(25).exportBanList.battlemetricsID = 'bm-25';
};
deletions.set(25, 'gone');
await run('remove', { id: 25 });
assert.ok(!askedBattlemetrics());
assert.strictEqual(
  contentOf(replies.at(-1)),
  "Removed export ban list **List 25** (#25), but BattleMetrics did not know its ban list, and whether CBL's BattleMetrics key could see it was not checked, so it may still be on BattleMetrics with its subscribers: check it there."
);
assert.match(
  audits[0],
  /^admin \(1\) removed export ban list "List 25" \(ID: 25, BattleMetrics, BattleMetrics ID: bm-25\) of .*: BattleMetrics did not know its ban list, and whether CBL's BattleMetrics key could see it was not checked, so it may still be on BattleMetrics: check it there\.$/
);

// When the deletion fails, the reply and the log say which step failed, and the list is kept.
reset();
addList(16, 'battlemetrics', { battlemetricsID: 'bm-16' });
deletions.set(
  16,
  Object.assign(
    new Error(
      'BattleMetrics deletion failed while removing invites: HTTP 500. The local list was retained; any invites or subscriptions already removed remain removed.'
    ),
    { stage: 'battlemetrics' }
  )
);
await run('remove', { id: 16 });
assert.strictEqual(
  contentOf(replies.at(-1)),
  'Could not remove export ban list **List 16** (#16). BattleMetrics deletion failed while removing invites: HTTP 500. The local list was retained; any invites or subscriptions already removed remain removed.'
);
assert.match(
  audits[0],
  /^admin \(1\) could not remove export ban list "List 16" .*: BattleMetrics deletion failed while removing invites/
);
assert.ok(rows.has(16));

reset();
addList(17, 'remote');
deletions.set(
  17,
  Object.assign(new Error('Lock wait timeout exceeded'), { stage: 'database deletion' })
);
await run('remove', { id: 17 });
assert.strictEqual(
  contentOf(replies.at(-1)),
  'Could not remove export ban list **List 17** (#17). Deleting it from the database failed: Lock wait timeout exceeded'
);

// A list that does not exist is refused, and one deleted while the removal was confirmed is left.
reset();
await assert.rejects(run('remove', { id: 404 }), (err) => {
  assert.ok(err instanceof UserError);
  assert.strictEqual(err.message, 'There is no export ban list with ID 404.');
  return true;
});
assert.strictEqual(prompt(), null);

reset();
addList(18, 'remote');
whileConfirming = async () => rows.delete(18);
await run('remove', { id: 18 });
assert.strictEqual(
  contentOf(replies.at(-1)),
  'Export ban list **List 18** (#18) no longer exists, so nothing was changed.'
);
assert.deepStrictEqual(deleted(), []);
assert.deepStrictEqual(audits, []);

// Cancelling, or not answering in time, changes nothing.
for (const [choice, reply] of [
  ['cancel', 'Cancelled. Nothing was changed.'],
  ['timeout', 'Timed out. Nothing was changed.']
]) {
  reset();
  addList(19, 'battlemetrics', { battlemetricsID: 'bm-19' });
  visible = new Set(['bm-19']);
  answer = choice;
  await run('remove', { id: 19 });
  assert.strictEqual(contentOf(replies.at(-1)), reply);
  assert.deepStrictEqual(calls, [['lock'], ['check', [19]], FIND_RECORDED, ['visible']]);
  assert.deepStrictEqual(audits, []);
  assert.ok(rows.has(19));
}

// While a ban importer run holds its lock, nothing is removed: it is checked before the list is
// shown, and again once the removal is confirmed.
reset();
addList(20, 'remote');
lockAnswers = [true];
await assert.rejects(run('remove', { id: 20 }), { message: RUNNING });
assert.deepStrictEqual(calls, [['lock']]);
assert.strictEqual(prompt(), null);

reset();
addList(20, 'remote');
lockAnswers = [false, true];
await assert.rejects(run('remove', { id: 20 }), (err) => {
  assert.ok(err instanceof UserError);
  assert.strictEqual(err.message, RUNNING);
  return true;
});
assert.deepStrictEqual(calls, [['lock'], ['check', [20]], ['lock']]);
assert.ok(prompt());
assert.ok(rows.has(20));
assert.deepStrictEqual(audits, []);

console.log('Removing one export ban list: checks passed.');

// Removing every list outside today's limits previews each, with its type, owner, players and why,
// and the limits used, then removes them after one confirmation, in ID order, logging each. The
// admin has five minutes to read the preview and answer. Lists within the limits are left alone,
// and no owner is told.
reset();
addList(30, 'battlemetrics', { battlemetricsID: 'bm-30', players: 25000 });
addList(31, 'remote', { players: 4206 });
addList(32, 'battlemetrics', { battlemetricsID: 'bm-32', problems: [] });
addList(33, 'battlemetrics', {
  problems: ["A BattleMetrics export ban list's threshold must be at least 4."]
});
visible = new Set(['bm-30', 'bm-32', 'partner-list']);
await run('remove_outside_limits');
shown = prompt();
assert.strictEqual(
  contentOf(shown.reply),
  `**3 export ban lists are outside today's limits.** Remove them? This deletes each list with its export bans and configs, and a BattleMetrics list's ban list on BattleMetrics, which the organisations subscribed to it lose. Their owners are not told.\nCBL's BattleMetrics key can see 2 of the 2 BattleMetrics ban lists CBL's export ban lists record.\n${LIMITS_TEXT}`
);
assert.strictEqual(shown.label, 'Remove 3 export ban lists');
assert.strictEqual(shown.embed.title, "Export ban lists outside today's limits (3)");
const escapedRule = discord.escapeMarkdown(RULE);
assert.strictEqual(
  shown.embed.description,
  [
    `**List 30** (#30) · BattleMetrics · owner **Owner 30** (\`76561198000000030\`) · 25,000 players\n↳ ${escapedRule}`,
    `**List 31** (#31) · Remote · owner **Owner 31** (\`76561198000000031\`) · 4,206 players\n↳ ${escapedRule}`,
    "**List 33** (#33) · BattleMetrics · owner **Owner 33** (`76561198000000033`) · 0 players\n↳ A BattleMetrics export ban list's threshold must be at least 4."
  ].join('\n')
);
assert.strictEqual(fileOf(shown.reply), undefined);
assert.deepStrictEqual(timeouts, [5 * 60 * 1000]);
assert.deepStrictEqual(calls, [
  ['lock'],
  ['check', 'all'],
  ['visible'],
  ['lock'],
  ['lock'],
  ['check', [30]],
  ['delete', 30],
  ['lock'],
  ['check', [31]],
  ['delete', 31],
  ['lock'],
  ['check', [33]],
  ['delete', 33]
]);
// Each list is deleted as it was read again just before, not as the preview showed it.
assert.deepStrictEqual(deletedFrom, ['check 30', 'check 31', 'check 33']);
assert.deepStrictEqual([...rows.keys()], [32]);
// Every line is important, the results as well as the start and the summary. Lines of the same
// importance reach the log channel in the order they were logged, so there the summary comes after
// every result, even when results are still waiting to be sent as the removal ends.
assert.deepStrictEqual(audits, [
  "[important] admin (1) started removing 3 export ban lists outside today's limits.",
  '[important] admin (1) removed export ban list "List 30" (ID: 30, BattleMetrics, BattleMetrics ID: bm-30) of Steam user "Owner 30" (ID: 76561198000000030), outside today\'s limits with 25,000 players: its BattleMetrics ban list was deleted.',
  '[important] admin (1) removed export ban list "List 31" (ID: 31, Remote) of Steam user "Owner 31" (ID: 76561198000000031), outside today\'s limits with 4,206 players: there was nothing to delete on BattleMetrics.',
  '[important] admin (1) removed export ban list "List 33" (ID: 33, BattleMetrics) of Steam user "Owner 33" (ID: 76561198000000033), outside today\'s limits with 0 players: there was nothing to delete on BattleMetrics.',
  "[important] admin (1) removed 3 of the 3 export ban lists outside today's limits: 1 with its BattleMetrics ban list and 2 with nothing to delete on BattleMetrics."
]);
let summary = replies.at(-1);
assert.strictEqual(
  summary.content,
  "Removed 3 of the 3 export ban lists outside today's limits: 1 with its BattleMetrics ban list and 2 with nothing to delete on BattleMetrics."
);
assert.strictEqual(
  embedOf(summary).description,
  [
    '**List 30** (#30): removed, with its BattleMetrics ban list',
    '**List 31** (#31): removed; there was nothing to delete on BattleMetrics',
    '**List 33** (#33): removed; there was nothing to delete on BattleMetrics'
  ].join('\n')
);
// The summary replaces the preview's attachments.
assert.deepStrictEqual(summary.attachments, []);
assert.deepStrictEqual(summary.files, []);
// Progress was shown while the lists were removed.
assert.ok(
  replies.some(
    (reply) =>
      contentOf(reply) ===
      `Removing 3 export ban lists outside today's limits: 0 done.\n${PROGRESS_NOTE}`
  )
);
assert.deepStrictEqual(notifications, []);

// When nothing is outside the limits, nothing is asked or changed, and BattleMetrics is not asked.
reset();
addList(34, 'battlemetrics', { battlemetricsID: 'bm-34', problems: [] });
await run('remove_outside_limits');
assert.deepStrictEqual(replies, [
  `No export ban list is outside today's limits, so nothing was changed.\n${LIMITS_TEXT}`
]);
assert.deepStrictEqual(calls, [['lock'], ['check', 'all']]);

// Lists whose type the limits do not cover are named as not checked.
reset();
addList(35, 'remote');
addList(36, null, { problems: [] });
rows.get(36).checked = false;
answer = 'cancel';
await run('remove_outside_limits');
assert.match(
  contentOf(prompt().reply),
  /^\*\*1 export ban list is outside today's limits\.\*\* Remove it\? .* Their owners are not told\. 1 was not checked, as the limits do not cover its type: #36\.\n/
);

// Cancelling, or not answering in time, changes nothing.
for (const choice of ['cancel', 'timeout']) {
  reset();
  addList(37, 'remote');
  answer = choice;
  await run('remove_outside_limits');
  assert.deepStrictEqual(calls, [['lock'], ['check', 'all']]);
  assert.deepStrictEqual(deleted(), []);
  assert.deepStrictEqual(audits, []);
  assert.ok(rows.has(37));
}

// While a ban importer run holds its lock, nothing is removed: it is checked before the preview,
// once the removal is confirmed, and before each list. A run that starts part-way stops the
// removal, which says how many were removed and how many are left.
reset();
addList(38, 'remote');
lockAnswers = [true];
await assert.rejects(run('remove_outside_limits'), { message: RUNNING });
assert.deepStrictEqual(calls, [['lock']]);

reset();
addList(38, 'remote');
lockAnswers = [false, true];
await run('remove_outside_limits');
assert.deepStrictEqual(calls, [['lock'], ['check', 'all'], ['lock']]);
assert.deepStrictEqual(replies.at(-1), { content: RUNNING, embeds: [], attachments: [] });
assert.deepStrictEqual(audits, []);
assert.ok(rows.has(38));

reset();
for (const id of [40, 41, 42, 43]) addList(id, 'remote');
lockAnswers = [false, false, false, false, true];
await run('remove_outside_limits');
assert.deepStrictEqual(deleted(), [40, 41]);
assert.deepStrictEqual([...rows.keys()], [42, 43]);
summary = replies.at(-1);
assert.strictEqual(
  summary.content,
  "Removed 2 of the 4 export ban lists outside today's limits: 2 with nothing to delete on BattleMetrics. 2 were not tried, as the removal stopped.\nStopped, as the ban importer started a run. Run the command again once it has finished."
);
assert.deepStrictEqual(embedOf(summary).description.split('\n').slice(2), [
  '**List 42** (#42): not tried, as the removal stopped',
  '**List 43** (#43): not tried, as the removal stopped'
]);
assert.strictEqual(
  audits.at(-1),
  "[important] admin (1) removed 2 of the 4 export ban lists outside today's limits: 2 with nothing to delete on BattleMetrics. 2 were not tried, as the removal stopped. Stopped, as the ban importer started a run. Run the command again once it has finished."
);

// When the run lock cannot be checked, the removal stops too.
reset();
for (const id of [44, 45]) addList(id, 'remote');
lockAnswers = [false, false, false, new Error('Connection lost')];
await run('remove_outside_limits');
assert.deepStrictEqual(deleted(), [44]);
assert.match(
  replies.at(-1).content,
  /\nStopped, as the bot could not check whether the ban importer is running: Connection lost$/
);

// A failed removal does not stop the others. Each result is reported, and the log has each
// removal, the failure and the summary.
reset();
addList(50, 'battlemetrics', { battlemetricsID: 'bm-50' });
addList(51, 'battlemetrics', { battlemetricsID: 'bm-51' });
addList(52, 'remote');
visible = new Set(['bm-50', 'bm-51']);
deletions.set(
  51,
  Object.assign(
    new Error(
      'BattleMetrics deletion failed while removing owner: HTTP 503. The local list was retained; any invites or subscriptions already removed remain removed.'
    ),
    { stage: 'battlemetrics' }
  )
);
await run('remove_outside_limits');
assert.deepStrictEqual(deleted(), [50, 51, 52]);
assert.deepStrictEqual([...rows.keys()], [51]);
summary = replies.at(-1);
assert.strictEqual(
  summary.content,
  "Removed 2 of the 3 export ban lists outside today's limits: 1 with its BattleMetrics ban list and 1 with nothing to delete on BattleMetrics. 1 failed."
);
assert.strictEqual(
  embedOf(summary).description.split('\n')[1],
  '**List 51** (#51): failed: BattleMetrics deletion failed while removing owner: HTTP 503. The local list was retained; any invites or subscriptions already removed remain removed.'
);
assert.deepStrictEqual(
  audits.map((line) =>
    line
      .replace(/^\[important\] admin \(1\) /, '')
      .split(' ')
      .slice(0, 2)
      .join(' ')
  ),
  ['started removing', 'removed export', 'could not', 'removed export', 'removed 2']
);
// The failure is important too, so it keeps its place before the summary in the log channel.
assert.ok(audits.every((line) => line.startsWith('[important] admin (1) ')));
assert.match(audits[2], /: BattleMetrics deletion failed while removing owner: HTTP 503\./);

// BattleMetrics lists are only removed once BattleMetrics shows that CBL's API key can see CBL's
// ban lists: a list whose own ban list it cannot see is left, and when it can see none of them, or
// cannot be asked, every list with a ban list is left. Lists with nothing on BattleMetrics are
// removed either way.
reset();
addList(60, 'battlemetrics', { battlemetricsID: 'bm-60' });
addList(61, 'battlemetrics', { battlemetricsID: 'bm-61' });
addList(62, 'remote');
addList(63, 'battlemetrics', { battlemetricsID: 'bm-63', problems: [] });
visible = new Set(['bm-60', 'bm-63']);
await run('remove_outside_limits');
shown = prompt();
assert.match(
  contentOf(shown.reply),
  /^\*\*3 export ban lists are outside today's limits\.\*\* Remove 2 of them\? .*\nCBL's BattleMetrics key can see 2 of the 3 BattleMetrics ban lists CBL's export ban lists record\. The list whose ban list it cannot see is left: check it on BattleMetrics, then remove it with `\/exportbanlist remove`\.\n/
);
assert.strictEqual(shown.label, 'Remove 2 export ban lists');
assert.match(
  shown.embed.description,
  /\*\*List 61\*\* \(#61\) .*\n↳ .* \*\*Left:\*\* its BattleMetrics ban list is not among those CBL's BattleMetrics key can see\./
);
assert.deepStrictEqual(deleted(), [60, 62]);
assert.deepStrictEqual([...rows.keys()].sort(), [61, 63]);
assert.match(
  replies.at(-1).content,
  /^Removed 2 of the 3 export ban lists outside today's limits: .* 1 was left from the start\.$/
);
assert.match(
  embedOf(replies.at(-1)).description,
  /\*\*List 61\*\* \(#61\): left: its BattleMetrics ban list is not among those CBL's BattleMetrics key can see$/
);

for (const [access, note, why] of [
  [
    new Set(['partner-list']),
    "CBL's BattleMetrics key can see 0 of the 2 BattleMetrics ban lists CBL's export ban lists record. It may belong to an account outside CBL's organisation, so the lists with BattleMetrics ban lists are left. Check BATTLEMETRICS_API_KEY.",
    "CBL's BattleMetrics key can see none of CBL's ban lists"
  ],
  [
    new Error('BattleMetrics GET ban-lists failed: HTTP 401'),
    "BattleMetrics could not be asked which ban lists CBL's BattleMetrics key can see (BattleMetrics GET ban-lists failed: HTTP 401), so the lists with BattleMetrics ban lists are left. Try again later.",
    'BattleMetrics could not be asked about its ban list'
  ]
]) {
  reset();
  addList(64, 'battlemetrics', { battlemetricsID: 'bm-64' });
  addList(65, 'battlemetrics', { battlemetricsID: 'bm-65' });
  addList(66, 'battlemetrics');
  visible = access;
  await run('remove_outside_limits');
  shown = prompt();
  assert.ok(contentOf(shown.reply).includes(`\n${note}\n`));
  // The preview says why each list with a ban list is left.
  assert.deepStrictEqual(
    shown.embed.description.split('\n').filter((line) => line.startsWith('↳')),
    [`↳ ${escapedRule} **Left:** ${why}.`, `↳ ${escapedRule} **Left:** ${why}.`, `↳ ${escapedRule}`]
  );
  assert.deepStrictEqual(deleted(), [66]);
}

// A list given a ban list after the preview, as one still being made is, when no list in the
// preview had one and so BattleMetrics was not asked which ban lists CBL's key can see, is left, and
// the removal goes on to the next list and its summary.
reset();
addList(68, 'battlemetrics');
addList(69, 'remote');
whileConfirming = async () => {
  rows.get(68).exportBanList.battlemetricsID = 'bm-68';
};
await run('remove_outside_limits');
assert.ok(!calls.some(([call]) => call === 'visible'));
assert.deepStrictEqual(deleted(), [69]);
assert.deepStrictEqual([...rows.keys()], [68]);
summary = replies.at(-1);
assert.strictEqual(
  summary.content,
  "Removed 1 of the 2 export ban lists outside today's limits: 1 with nothing to delete on BattleMetrics. 1 was not removed, as it had changed."
);
assert.deepStrictEqual(embedOf(summary).description.split('\n'), [
  '**List 68** (#68): not removed, as its BattleMetrics ban list was not checked',
  '**List 69** (#69): removed; there was nothing to delete on BattleMetrics'
]);
assert.strictEqual(
  audits.at(-1),
  "[important] admin (1) removed 1 of the 2 export ban lists outside today's limits: 1 with nothing to delete on BattleMetrics. 1 was not removed, as it had changed."
);

// When nothing can be removed, the preview is shown without asking.
reset();
addList(67, 'battlemetrics', { battlemetricsID: 'bm-67' });
visible = new Set();
await run('remove_outside_limits');
assert.strictEqual(prompt(), null);
assert.match(
  contentOf(replies.at(-1)),
  /^\*\*1 export ban list is outside today's limits\.\*\* None can be removed now, so nothing was changed\.\n/
);
assert.deepStrictEqual(deleted(), []);

// A list whose ban list BattleMetrics listed, but which is gone when the list is removed, stops the
// removal there, as the key may have lost its access.
reset();
for (const id of [70, 71, 72]) addList(id, 'battlemetrics', { battlemetricsID: `bm-${id}` });
visible = new Set(['bm-70', 'bm-71', 'bm-72']);
deletions.set(71, 'gone');
await run('remove_outside_limits');
assert.deepStrictEqual(deleted(), [70, 71]);
assert.deepStrictEqual([...rows.keys()], [72]);
assert.strictEqual(
  replies.at(-1).content,
  "Removed 2 of the 3 export ban lists outside today's limits: 1 with its BattleMetrics ban list and 1 whose BattleMetrics ban list was already gone. 1 was not tried, as the removal stopped.\nStopped after #71, as BattleMetrics no longer had its ban list, which it listed when the removal started. CBL's BattleMetrics key may have lost its access, so check BATTLEMETRICS_API_KEY and BATTLEMETRICS_ORGANIZATION before running the command again."
);

// Each list is read and checked again just before it is removed, so one whose owner has brought it
// within the limits, or deleted it, since the preview is left.
reset();
for (const id of [80, 81, 82]) addList(id, 'remote');
whileConfirming = async () => {
  rows.get(80).problems = [];
  rows.delete(81);
};
await run('remove_outside_limits');
assert.deepStrictEqual(deleted(), [82]);
assert.strictEqual(
  replies.at(-1).content,
  "Removed 1 of the 3 export ban lists outside today's limits: 1 with nothing to delete on BattleMetrics. 2 were not removed, as they had changed."
);
assert.deepStrictEqual(embedOf(replies.at(-1)).description.split('\n').slice(0, 2), [
  "**List 80** (#80): not removed, as it is now within today's limits",
  '**List 81** (#81): not removed, as it no longer exists'
]);

// The summary says how many lists ended each way, and the log has each BattleMetrics list's ban
// list as it was before the list was removed.
reset();
addList(83, 'battlemetrics', { battlemetricsID: 'bm-83' });
addList(84, 'battlemetrics', { battlemetricsID: 'bm-84' });
addList(85, 'remote');
addList(86, 'battlemetrics', { battlemetricsID: 'bm-86' });
addList(87, 'remote');
visible = new Set(['bm-83', 'bm-84']);
deletions.set(
  84,
  Object.assign(new Error('Removing the owner failed.'), { stage: 'battlemetrics' })
);
whileConfirming = async () => {
  rows.get(85).problems = [];
};
await run('remove_outside_limits');
assert.deepStrictEqual(deleted(), [83, 84, 87]);
assert.strictEqual(
  replies.at(-1).content,
  "Removed 2 of the 5 export ban lists outside today's limits: 1 with its BattleMetrics ban list and 1 with nothing to delete on BattleMetrics. 1 failed. 1 was not removed, as it had changed. 1 was left from the start."
);
assert.match(
  audits[1],
  /^\[important\] admin \(1\) removed export ban list "List 83" \(ID: 83, BattleMetrics, BattleMetrics ID: bm-83\) of /
);
assert.match(
  audits[2],
  /^\[important\] admin \(1\) could not remove export ban list "List 84" \(ID: 84, BattleMetrics, BattleMetrics ID: bm-84\) .*: Removing the owner failed\.$/
);

// Lists that do not fit in the preview are in an attached file, with every detail, as are the
// results that do not fit in the summary.
reset();
const long = 'A reason that is long. '.repeat(40);
for (let id = 100; id < 130; id++) addList(id, 'remote', { problems: [long] });
answer = 'cancel';
await run('remove_outside_limits');
shown = prompt();
const description = shown.embed.description;
assert.ok(description.length <= 4096);
assert.match(description, /\n…and \d+ more, all in the attached file\.$/);
const file = fileOf(shown.reply);
assert.strictEqual(file.name, 'export-ban-lists-outside-limits.txt');
const text = file.attachment.toString('utf8');
assert.match(
  text,
  /^Export ban lists outside today's limits, checked \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ: 30\n/
);
assert.ok(text.includes(`\n${LIMITS_TEXT}\n`));
assert.ok(
  text.includes(
    `\n#129 Remote list "List 129"\n  Owner: Owner 129 (Steam ID 765611980000000129)\n  Players: 0\n  Settings: threshold 5, 5 points for an active ban and 1 for an expired ban, max ban age 0 days (0 for any), 0 configs\n  Outside the limits: ${long}\n  To be removed.`
  )
);
// Each reason is cut short in the embed, and in full in the file.
assert.ok(!description.includes(long.trim()));

answer = 'confirm';
replies = [];
const failure = Object.assign(new Error(long), { stage: 'database deletion' });
for (let id = 100; id < 130; id++) deletions.set(id, failure);
await run('remove_outside_limits');
summary = replies.at(-1);
assert.strictEqual(
  summary.content,
  "Removed 0 of the 30 export ban lists outside today's limits. 30 failed."
);
assert.ok(embedOf(summary).description.length <= 4096);
assert.strictEqual(summary.files[0].name, 'export-ban-list-removals.txt');
const results = summary.files[0].attachment.toString('utf8').split('\n');
assert.strictEqual(results.length, 30);
assert.strictEqual(
  results[0],
  `#100 "List 100": failed: Deleting it from the database failed: ${long}`
);
assert.deepStrictEqual(summary.attachments, []);

// Discord lets the reply be edited for 15 minutes. A removal that runs past them carries on, and
// its results and summary are only logged; nor does a reply that can no longer be edited stop it.
reset();
for (const id of [90, 91]) addList(id, 'remote');
const late = interaction(
  'remove_outside_limits',
  {},
  { createdTimestamp: Date.now() - 14.5 * 60 * 1000 - 1 }
);
await command.execute(late);
assert.deepStrictEqual(deleted(), [90, 91]);
// The confirmation's own edits were the last.
assert.strictEqual(contentOf(replies.at(-1)), 'Working on it...');
assert.strictEqual(
  audits.at(-1),
  "[important] admin (1) removed 2 of the 2 export ban lists outside today's limits: 2 with nothing to delete on BattleMetrics."
);

reset();
for (const id of [92, 93]) addList(id, 'remote');
failEditsAfter = 1;
const warnings = [];
const { warn } = console;
console.warn = (line) => warnings.push(line);
try {
  await run('remove_outside_limits');
} finally {
  console.warn = warn;
  failEditsAfter = undefined;
}
assert.deepStrictEqual(deleted(), [92, 93]);
assert.deepStrictEqual(warnings, [
  'Could not update the reply to /exportbanlist, so it is no longer updated: Invalid Webhook Token'
]);
assert.match(audits.at(-1), /^\[important\] admin \(1\) removed 2 of the 2 export ban lists/);

// Only one removal of the lists outside the limits runs at a time.
reset();
addList(95, 'remote');
// The first removal waits for the admin's answer, which comes once the second has been refused. A
// second removal that went ahead would be answered at once.
let answerNow;
let asked;
const asking = new Promise((resolve) => (asked = resolve));
whileConfirming = () => {
  whileConfirming = null;
  asked();
  return new Promise((resolve) => (answerNow = resolve));
};
const first = run('remove_outside_limits');
await asking;
await assert.rejects(run('remove_outside_limits'), {
  message:
    'The export ban lists outside the limits are already being removed. Try again once that has finished.'
});
answerNow();
await first;
assert.deepStrictEqual(deleted(), [95]);
// Once it has finished, the next can run.
addList(96, 'remote');
await run('remove_outside_limits');
assert.deepStrictEqual(deleted(), [95, 96]);
assert.deepStrictEqual(notifications, []);

console.log(
  'Export ban list command checks passed: admin only, previews, confirmations, the run lock, BattleMetrics access, failures and long removals.'
);
