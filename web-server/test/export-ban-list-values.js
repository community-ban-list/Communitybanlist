import assert from 'assert';
import { readFile } from 'fs/promises';
import vm from 'vm';

import * as exportListLimits from '../../scbl-lib/export-list-limits.js';
import isDiscordWebhookUrl from '../../scbl-lib/utils/discord-webhook-url.js';
import logText from '../../scbl-lib/utils/log-text.js';
import Validators from '../../scbl-lib/validators.js';

// Checks that the server checks the values of changes to export ban lists and their configs, as
// the forms do, and keeps lists within the limits on export ban lists: the bounds on each value and
// the points rules. Changes go through mutation/index.js to the real resolvers, with stand-ins for
// the database, Discord and BattleMetrics. A refused change saves nothing, tests no webhook, makes
// no request to BattleMetrics, and does not count towards the limits on creating lists.

// Load a module in a context. The imports in `stubs` get those exports, and other relative imports
// load the real files.
async function load(path, stubs, context) {
  const create = async (url) =>
    new vm.SourceTextModule(await readFile(url, 'utf8'), { context, identifier: url.href });
  const linker = async (specifier, referencingModule) => {
    if (Object.hasOwn(stubs, specifier)) {
      const exports = stubs[specifier];
      return new vm.SyntheticModule(
        Object.keys(exports),
        function () {
          for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
        },
        { context }
      );
    }
    assert.ok(specifier.startsWith('.'), `Unexpected dependency: ${specifier}`);
    return create(new URL(specifier, referencingModule.identifier));
  };
  const module = await create(new URL(path, import.meta.url));
  await module.link(linker);
  await module.evaluate();
  return module.namespace;
}

// Stand-ins for the models, over rows kept here. Like Sequelize, lookups hand out copies of the
// rows that match the whole where clause, with the rows they include, and only save, create and
// destroy write back. Every write, webhook test and request to BattleMetrics is recorded.
function database() {
  const rows = {
    Organisation: [
      { id: 1, name: 'Partner Org 1' },
      { id: 2, name: 'Partner Org 2' }
    ],
    BanList: [
      { id: 1, name: 'Ban List 1', organisation: 1 },
      { id: 2, name: 'Ban List 2', organisation: 2 },
      { id: 3, name: 'Ban List 3', organisation: 2 },
      { id: 4, name: 'Ban List 4', organisation: 1 },
      { id: 5, name: 'Ban List 5', organisation: 1 }
    ],
    ExportBanList: [],
    ExportBanListConfig: []
  };
  const queries = [];
  const writes = [];
  const battlemetrics = [];
  let nextID = 100;

  const matches = (row, where) =>
    Object.entries(where).every(([field, value]) => {
      if (field !== '$ExportBanList.owner$') return row[field] === value;
      const list = rows.ExportBanList.find((list) => list.id === row.exportBanList);
      return list !== undefined && list.owner === value;
    });

  function copy(model, row) {
    const methods = {
      async save() {
        writes.push(`save ${model} ${this.id}`);
        const { ExportBanList, BanList, ...values } = this;
        Object.assign(row, values);
      },
      async destroy() {
        writes.push(`destroy ${model} ${this.id}`);
        rows[model].splice(rows[model].indexOf(row), 1);
      },
      async createBattlemetricsBanList() {
        battlemetrics.push(`create the ban list for ${this.id}`);
        this.battlemetricsID = `bm-${this.id}`;
        await this.save();
      },
      async createBattlemetricsInvite() {
        if (this.type !== 'battlemetrics' || !this.battlemetricsID || this.battlemetricsInvite)
          return;
        battlemetrics.push(`create the invite for ${this.id}`);
      }
    };
    return Object.assign(Object.create(methods), row);
  }

  // The rows a lookup includes, as Sequelize adds them.
  function withIncluded(model, found, include = []) {
    for (const included of include) {
      if (included === models.ExportBanList)
        found.ExportBanList = copy(
          'ExportBanList',
          rows.ExportBanList.find((list) => list.id === found.exportBanList)
        );
      else if (included === models.Organisation)
        found.Organisation = { ...rows.Organisation.find(({ id }) => id === found.organisation) };
      else if (included.model === models.BanList) {
        assert.ok(
          included.include.length === 1 && included.include[0] === models.Organisation,
          'Organisations are included.'
        );
        const banList = rows.BanList.find(({ id }) => id === found.banList);
        found.BanList = withIncluded('BanList', { ...banList }, included.include);
      } else assert.fail(`${model} is looked up with an unexpected include.`);
    }
    return found;
  }

  const model = (name) => ({
    async count({ where }) {
      queries.push(`${name}.count`);
      return rows[name].filter((row) => matches(row, where)).length;
    },
    async findOne({ where, include, lock }) {
      queries.push(`${name}.findOne${lock ? ' locked' : ''}`);
      if ('$ExportBanList.owner$' in where)
        assert.ok(include && include.includes(models.ExportBanList), 'The list is included.');
      const row = rows[name].find((row) => matches(row, where));
      return row ? withIncluded(name, copy(name, row), include) : null;
    },
    async findAll({ where, include, order }) {
      queries.push(`${name}.findAll`);
      // The order is copied out of the resolver's context to compare it.
      assert.deepStrictEqual(JSON.parse(JSON.stringify(order)), [['id', 'ASC']]);
      return rows[name]
        .filter((row) => matches(row, where))
        .map((row) => withIncluded(name, copy(name, row), include));
    },
    async create(values) {
      const row = { id: nextID++, ...values };
      rows[name].push(row);
      writes.push(`create ${name} ${row.id}`);
      return copy(name, row);
    }
  });
  const models = {
    BanList: model('BanList'),
    ExportBanList: model('ExportBanList'),
    ExportBanListConfig: model('ExportBanListConfig'),
    Organisation: model('Organisation')
  };
  // Changes are saved in transactions, with the rows they check locked, which these stand-ins only
  // record, as each list here has one user, and none is being deleted meanwhile.
  Object.assign(models.ExportBanList, {
    inTransaction: (work) => work({}),
    async lockListsOf(owner) {
      queries.push('ExportBanList.lockListsOf');
      return rows.ExportBanList.filter((row) => row.owner === owner).length;
    },
    whileDeleting: (id, deletion) => deletion(),
    isBeingDeleted: async () => false
  });
  return { rows, queries, writes, battlemetrics, models };
}

// Load the mutations, as mutation/index.js guards them, with these limits on export ban lists.
// There is no limit on the players a list can have, so no list's players are counted
// (export-ban-list-size.js checks that limit). Webhook tests are recorded, and all of them pass.
async function mutations(env) {
  const db = database();
  const tested = [];
  const logged = [];
  const noPlayerLimits = { EXPORT_BM_MAX_PLAYERS: '0', EXPORT_REMOTE_MAX_PLAYERS: '0' };
  const { resolver } = await load(
    '../src/graphql-api/mutation/index.js',
    {
      './typedef.js': { default: { kind: 'Document' } },
      'scbl-lib/config': {
        EXPORT_LIST_LIMITS: exportListLimits.readLimits({ ...noPlayerLimits, ...env }).limits
      },
      'scbl-lib/db/export-membership': {
        countMembers() {
          throw new Error('A list was counted with no limit on its players.');
        },
        countPlayersWithBans() {
          throw new Error('Players were counted with no limit on lists.');
        }
      },
      'scbl-lib/db/models': db.models,
      'scbl-lib/export-list-limits': exportListLimits,
      'scbl-lib/utils': {
        // The lines the resolvers post are checked in export-ban-list-audit.js.
        Logger: { verbose() {}, important() {} },
        logText,
        isDiscordWebhookUrl,
        async testDiscordWebhook(url) {
          tested.push(url);
        }
      },
      'scbl-lib/validators': { default: Validators }
    },
    vm.createContext({ console: { error: (...args) => logged.push(args) } })
  );
  return { db, tested, logged, Mutation: resolver.Mutation };
}

const as = (id) => ({ user: { id } });
const webhook = (id) => `https://discord.com/api/webhooks/${id}/token-${id}`;
const types = ['remote', 'battlemetrics'];
const typeName = (type) => (type === 'remote' ? 'remote' : 'BattleMetrics');
const MESSAGES = {
  name: 'A name between 1 and 40 characters long is required.',
  server: 'A community/server name between 1 and 40 characters long is required.',
  webhook: 'Invalid Discord Webhook',
  threshold: 'The threshold must be a whole number from 1 to 1,000.',
  points: 'Points must be whole numbers from 0 to 100.',
  maxBanAge:
    'The max ban age must be a whole number of days from 0 to 3,650. Use 0 to count bans of any age.',
  activePlusExpired: (total, active, expired, lowest) =>
    `One active ban plus one expired ban must not be enough to put a player on an export ban list. Here they can give ${total} points (${active}, plus ${expired}), so the threshold must be ${lowest} or more. Raise the threshold or lower the points.`,
  minimum: (type, minimum) =>
    `A ${typeName(type)} export ban list's threshold must be at least ${minimum}.`
};

const { db, tested, logged, Mutation } = await mutations({});
const { rows, writes, battlemetrics, queries } = db;
const stored = (model, id) => rows[model].find((row) => row.id === id);
const listOf = (owner, id, values) => ({
  id,
  owner,
  name: `List ${id}`,
  server: 'Server',
  type: 'remote',
  threshold: 9,
  defaultActivePoints: 3,
  defaultExpiredPoints: 1,
  maxBanAge: 0,
  discordWebhook: null,
  battlemetricsID: null,
  battlemetricsInvite: null,
  generated: true,
  ...values
});
let configIDs = 1000;
const configOf = (exportBanList, banList, activePoints, expiredPoints) => {
  const config = { id: configIDs++, exportBanList, banList, activePoints, expiredPoints };
  rows.ExportBanListConfig.push(config);
  return config;
};

// Check that a change is refused with a message, and that nothing was saved, no webhook was tested
// and BattleMetrics was asked for nothing.
async function refused(name, args, user, message) {
  const before = [writes.length, tested.length, battlemetrics.length];
  await assert.rejects(Mutation[name](null, args, as(user), {}), { message });
  assert.deepStrictEqual([writes.length, tested.length, battlemetrics.length], before, message);
}

// Creating a list. Each value it sets is checked, as the forms check them, then the bounds on each
// value, then the points rules. One active ban plus one expired ban must not be enough to put a
// player on a list, so 3/1 points need a threshold of at least 5, for both types.
const newList = (type, values) => ({
  name: 'New',
  server: 'Server',
  type,
  discordWebhook: webhook(1),
  ...values
});
for (const type of types) {
  await refused(
    'createExportBanList',
    newList(type, { threshold: 4, defaultActivePoints: 3, defaultExpiredPoints: 1 }),
    'creator',
    MESSAGES.activePlusExpired(4, '3 for an active ban', '1 for an expired ban', 5)
  );
  // With 1/1 points, a threshold of 1 lists every banned player, and 3 is still below the minimum
  // threshold of 4.
  await refused(
    'createExportBanList',
    newList(type, { threshold: 1, defaultActivePoints: 1, defaultExpiredPoints: 1 }),
    'creator',
    MESSAGES.minimum(type, 4)
  );
  await refused(
    'createExportBanList',
    newList(type, { threshold: 3, defaultActivePoints: 1, defaultExpiredPoints: 1 }),
    'creator',
    MESSAGES.minimum(type, 4)
  );
  // One active ban is enough with 5/1 points at threshold 5.
  await refused(
    'createExportBanList',
    newList(type, { threshold: 5, defaultActivePoints: 5, defaultExpiredPoints: 1 }),
    'creator',
    MESSAGES.activePlusExpired(6, '5 for an active ban', '1 for an expired ban', 7)
  );
}
// The values must be within their bounds, and any that are given must be set.
for (const [values, message] of [
  [{ threshold: 0 }, MESSAGES.threshold],
  [{ threshold: 1001 }, MESSAGES.threshold],
  [{ threshold: null }, MESSAGES.threshold],
  [{ defaultActivePoints: -1 }, MESSAGES.points],
  [{ defaultActivePoints: 101 }, MESSAGES.points],
  [{ defaultExpiredPoints: null }, MESSAGES.points],
  [{ threshold: 400, defaultExpiredPoints: 101 }, MESSAGES.points],
  [{ maxBanAge: -1 }, MESSAGES.maxBanAge],
  [{ maxBanAge: 3651 }, MESSAGES.maxBanAge],
  [{ maxBanAge: null }, MESSAGES.maxBanAge],
  // The forms' rules for the name, the server and the webhook come first.
  [{ name: '', threshold: 0 }, MESSAGES.name],
  [{ name: 'n'.repeat(41) }, MESSAGES.name],
  [{ server: '' }, MESSAGES.server],
  [{ server: 's'.repeat(41), maxBanAge: -1 }, MESSAGES.server],
  [{ discordWebhook: 'https://example.com/webhook', threshold: 0 }, MESSAGES.webhook]
])
  for (const type of types)
    await refused('createExportBanList', newList(type, values), 'creator', message);
// The checks before these still come first: the limit of 4 lists, and the list's type.
for (let id = 1; id <= 4; id++) rows.ExportBanList.push(listOf('full', 900 + id));
await refused(
  'createExportBanList',
  newList('remote', { threshold: 0 }),
  'full',
  'You are limited to 4 export ban lists.'
);
await refused(
  'createExportBanList',
  newList('remot', { threshold: 0 }),
  'creator',
  'Invalid export ban list type.'
);
assert.deepStrictEqual(writes, []);

// Lists within the rules are created, with every setting stored as it was checked, and the ones
// not given take the defaults the form starts with. Only then is the webhook tested and the
// BattleMetrics ban list created.
for (const type of types) {
  const created = await Mutation.createExportBanList(
    null,
    newList(type, { threshold: 5, defaultActivePoints: 3, defaultExpiredPoints: 1 }),
    as(`${type} creator`),
    {}
  );
  assert.deepStrictEqual(
    [
      created.threshold,
      created.defaultActivePoints,
      created.defaultExpiredPoints,
      created.maxBanAge
    ],
    [5, 3, 1, 0]
  );
  assert.strictEqual(stored('ExportBanList', created.id).maxBanAge, 0);
  const defaults = await Mutation.createExportBanList(
    null,
    { name: 'Defaults', server: 'Server', type },
    as(`${type} creator`),
    {}
  );
  assert.deepStrictEqual(
    [
      defaults.threshold,
      defaults.defaultActivePoints,
      defaults.defaultExpiredPoints,
      defaults.maxBanAge
    ],
    [9, 3, 1, 0]
  );
}
assert.deepStrictEqual(tested, [webhook(1), webhook(1)]);
assert.deepStrictEqual(battlemetrics, [
  'create the ban list for 102',
  'create the ban list for 103'
]);
assert.deepStrictEqual(logged, []);

// Creations refused by these checks do not count towards the limits on creating and deleting
// lists, so a user who corrects them can try again at once. This user is refused more often than
// the hourly limit allows changes, and can still create the minute's worth of lists.
const { CREATES_AND_DELETES_PER_MINUTE: PER_MINUTE, CREATES_AND_DELETES_PER_HOUR: PER_HOUR } =
  await load('../src/graphql-api/mutation/guard-changes.js', {}, vm.createContext({}));
const mistakes = [
  [
    { threshold: 4 },
    MESSAGES.activePlusExpired(4, '3 for an active ban', '1 for an expired ban', 5)
  ],
  [
    { threshold: 2, defaultActivePoints: 1, defaultExpiredPoints: 1 },
    MESSAGES.minimum('battlemetrics', 4)
  ],
  [{ threshold: 0 }, MESSAGES.threshold],
  [{ defaultActivePoints: 101 }, MESSAGES.points],
  [{ maxBanAge: 3651 }, MESSAGES.maxBanAge],
  [{ name: '' }, MESSAGES.name],
  [{ server: 's'.repeat(41) }, MESSAGES.server]
];
for (let i = 0; i <= PER_HOUR; i++)
  for (const [values, message] of mistakes)
    await refused('createExportBanList', newList('battlemetrics', values), 'mistaken', message);
for (let i = 0; i < PER_MINUTE; i++)
  await Mutation.createExportBanList(null, newList('battlemetrics', {}), as('mistaken'), {});
await assert.rejects(
  Mutation.createExportBanList(null, newList('battlemetrics', {}), as('mistaken'), {}),
  { message: /^Export ban lists can only be created or deleted \d+ times a minute\./ }
);
assert.strictEqual(
  rows.ExportBanList.filter(({ owner }) => owner === 'mistaken').length,
  PER_MINUTE
);

// Saving a list that was saved before these rules, and is outside them: one active ban is enough
// for it, with 3/3/1 and configs of 3/1 for two ban lists. The edit form sends every value on each
// save, so the values that are the same as before are not checked.
const older = listOf('owner', 1, {
  threshold: 3,
  discordWebhook: webhook(10),
  name: 'An older list with a name longer than forty characters'
});
rows.ExportBanList.push(older);
configOf(1, 1, 3, 1);
configOf(1, 2, 3, 1);
const form = (list, values) => ({
  id: list.id,
  name: list.name,
  server: list.server,
  threshold: list.threshold,
  defaultActivePoints: list.defaultActivePoints,
  defaultExpiredPoints: list.defaultExpiredPoints,
  maxBanAge: list.maxBanAge,
  discordWebhook: list.discordWebhook,
  ...values
});
const save = async (list, values, user = 'owner') => {
  const count = writes.length;
  const saved = await Mutation.updateExportBanList(null, form(list, values), as(user), {});
  assert.strictEqual(writes.length, count + 1);
  return saved;
};
const lookedUp = () => queries.splice(0);

// It can be saved as it is, renamed and given another webhook, and none of these looks up its
// configs or needs the list generating again. Each save looks the list up again with its row
// locked, as it is saved, to check the user still owns it.
lookedUp();
await save(older, {});
assert.deepStrictEqual(lookedUp(), ['ExportBanList.findOne', 'ExportBanList.findOne locked']);
await save(older, { name: 'Renamed' });
await save(older, { server: 'Another server', discordWebhook: webhook(11) });
assert.deepStrictEqual(lookedUp(), [
  'ExportBanList.findOne',
  'ExportBanList.findOne locked',
  'ExportBanList.findOne',
  'ExportBanList.findOne locked'
]);
assert.deepStrictEqual(tested.slice(-1), [webhook(11)]);
assert.deepStrictEqual(
  [older.name, older.server, older.discordWebhook, older.generated],
  ['Renamed', 'Another server', webhook(11), true]
);
// Changes that can only make it smaller are saved, though it is still outside the rules: a higher
// threshold, and lower default points. A change to the settings is checked with the list's
// configs, which are read again with its row locked, as it is saved, to check they have not
// changed since.
await save(older, { threshold: 4 });
assert.deepStrictEqual(lookedUp(), [
  'ExportBanList.findOne',
  'ExportBanListConfig.findAll',
  'ExportBanList.findOne locked',
  'ExportBanListConfig.findAll'
]);
assert.deepStrictEqual([older.threshold, older.generated], [4, false]);
await save(older, { defaultActivePoints: 2 });
// A change that could make it bigger must bring the whole list within the rules, configs included,
// so a lower threshold is refused, with or without a new webhook.
await refused(
  'updateExportBanList',
  form(older, { threshold: 3 }),
  'owner',
  MESSAGES.activePlusExpired(
    4,
    "3 for an active ban on Partner Org 1's Ban List 1",
    '1 for an expired ban',
    5
  )
);
await refused(
  'updateExportBanList',
  form(older, { defaultExpiredPoints: 2, discordWebhook: webhook(12) }),
  'owner',
  MESSAGES.activePlusExpired(
    5,
    "3 for an active ban on Partner Org 1's Ban List 1",
    '2 for an expired ban',
    6
  )
);
await save(older, { threshold: 6, defaultExpiredPoints: 2 });
assert.deepStrictEqual(
  [older.threshold, older.defaultActivePoints, older.defaultExpiredPoints],
  [6, 2, 2]
);

// Another list outside the rules, a BattleMetrics list with 5/5/1, lowers its expired points, and
// can only put them back with a threshold that brings it within the rules. Each save also creates
// its missing BattleMetrics invite, which a refused change does not.
const fiveFive = listOf('owner', 2, {
  type: 'battlemetrics',
  threshold: 5,
  defaultActivePoints: 5,
  battlemetricsID: 'bm-2'
});
rows.ExportBanList.push(fiveFive);
await save(fiveFive, { defaultExpiredPoints: 0 });
await refused(
  'updateExportBanList',
  form(fiveFive, { defaultExpiredPoints: 1 }),
  'owner',
  MESSAGES.activePlusExpired(6, '5 for an active ban', '1 for an expired ban', 7)
);
await save(fiveFive, { defaultExpiredPoints: 1, threshold: 7 });
assert.deepStrictEqual(battlemetrics.slice(-2), [
  'create the invite for 2',
  'create the invite for 2'
]);

// Only the values a change sets are checked against the bounds and the forms' rules, so a list
// with a value outside them can still be saved. The values it sets must be within them, and any
// value given must be set.
const outOfBounds = listOf('owner', 3, { maxBanAge: 5000, name: 'n'.repeat(50) });
rows.ExportBanList.push(outOfBounds);
await save(outOfBounds, {});
await save(outOfBounds, { threshold: 10 });
// These are refused before the list's configs are looked up.
lookedUp();
for (const [values, message] of [
  [{ maxBanAge: 4000 }, MESSAGES.maxBanAge],
  [{ maxBanAge: null }, MESSAGES.maxBanAge],
  [{ threshold: 1001 }, MESSAGES.threshold],
  [{ threshold: null }, MESSAGES.threshold],
  [{ defaultActivePoints: -1 }, MESSAGES.points],
  [{ name: 'n'.repeat(41) }, MESSAGES.name],
  [{ name: null }, MESSAGES.name],
  [{ server: '' }, MESSAGES.server],
  [{ discordWebhook: 'https://example.com/webhook' }, MESSAGES.webhook]
]) {
  await refused('updateExportBanList', form(outOfBounds, values), 'owner', message);
  assert.deepStrictEqual(lookedUp(), ['ExportBanList.findOne'], message);
}
// Only the values given are changed, and an empty webhook removes it.
await Mutation.updateExportBanList(null, { id: 3, threshold: 11 }, as('owner'), {});
assert.deepStrictEqual([outOfBounds.threshold, outOfBounds.maxBanAge], [11, 5000]);
await save(outOfBounds, { discordWebhook: '' });
assert.strictEqual(outOfBounds.discordWebhook, '');

// The rules count a list's configs, which are named in the messages.
const withConfig = listOf('owner', 4);
rows.ExportBanList.push(withConfig);
configOf(4, 3, 6, 3);
await refused(
  'updateExportBanList',
  form(withConfig, { threshold: 8 }),
  'owner',
  MESSAGES.activePlusExpired(
    9,
    "6 for an active ban on Partner Org 2's Ban List 3",
    "3 for an expired ban on Partner Org 2's Ban List 3",
    10
  )
);
await save(withConfig, { threshold: 10 });
// Another user's list is not found, whatever the values.
await refused(
  'updateExportBanList',
  form(withConfig, { threshold: 0 }),
  'someone else',
  'Export ban list does not exist!'
);

// Adding a config. Its points must be given and within their bounds, and points that could make
// the list bigger must leave the whole list within the rules.
rows.ExportBanList.push(listOf('adder', 10));
const add = (exportBanList, banList, points) =>
  Mutation.createExportBanListConfig(null, { exportBanList, banList, ...points }, as('adder'), {});
const configAdded = await add(10, 1, { activePoints: 5, expiredPoints: 2 });
assert.deepStrictEqual(
  { ...stored('ExportBanListConfig', configAdded.id) },
  { id: configAdded.id, exportBanList: 10, banList: 1, activePoints: 5, expiredPoints: 2 }
);
const addRefused = (exportBanList, banList, points, message) =>
  refused('createExportBanListConfig', { exportBanList, banList, ...points }, 'adder', message);
await addRefused(
  10,
  2,
  { activePoints: 6, expiredPoints: 3 },
  "With these points, an active ban on Partner Org 2's Ban List 2 plus an expired ban on Partner Org 2's Ban List 2 could give 9 points, which reaches this list's threshold of 9. Use fewer points, or raise the list's threshold to 10 or more first."
);
// Points outside their bounds are refused before the list's configs are looked up.
lookedUp();
for (const [points, message] of [
  [{ activePoints: 3 }, MESSAGES.points],
  [{ expiredPoints: 1 }, MESSAGES.points],
  [{ activePoints: null, expiredPoints: 1 }, MESSAGES.points],
  [{ activePoints: -1, expiredPoints: 1 }, MESSAGES.points],
  [{ activePoints: 3, expiredPoints: 101 }, MESSAGES.points]
]) {
  await addRefused(10, 2, points, message);
  assert.deepStrictEqual(lookedUp(), [
    'ExportBanList.findOne',
    'BanList.findOne',
    'ExportBanListConfig.findOne'
  ]);
}
// The checks before these come first: the list, the ban list and one config for each ban list.
await addRefused(
  10,
  1,
  { activePoints: 101 },
  'Export ban list config already exists for this ban list.'
);
await addRefused(10, 99, { activePoints: 101 }, 'Ban list does not exist!');
await addRefused(1, 3, { activePoints: 101 }, 'Export ban list does not exist!');
// A paused ban list, as the request read them, is given no new config until it is resumed, as its
// bans count for nothing and the website leaves it out of its lists. Configs it has are kept.
const paused = { ...as('adder'), paused: new Set([2]) };
const before = [writes.length, tested.length, battlemetrics.length];
lookedUp();
await assert.rejects(
  Mutation.createExportBanListConfig(
    null,
    { exportBanList: 10, banList: 2, activePoints: 3, expiredPoints: 1 },
    paused,
    {}
  ),
  { message: 'That ban list is paused, so no config can be added for it until it counts again.' }
);
assert.deepStrictEqual([writes.length, tested.length, battlemetrics.length], before);
// It is refused among the checks, before the config is saved with the list's row locked.
assert.deepStrictEqual(lookedUp(), ['ExportBanList.findOne', 'BanList.findOne']);
// A list outside the rules can be given a config with points of at most its defaults, but not one
// that could make it bigger.
rows.ExportBanList.push(listOf('adder', 11, { threshold: 3 }));
await add(11, 3, { activePoints: 3, expiredPoints: 1 });
await add(11, 4, { activePoints: 0, expiredPoints: 0 });
await addRefused(
  11,
  5,
  { activePoints: 4, expiredPoints: 1 },
  "With these points, an active ban on Partner Org 1's Ban List 5 plus an expired ban could give 5 points, which reaches this list's threshold of 3. Use fewer points, or raise the list's threshold to 6 or more first."
);
// When the list's other configs already put it outside the rules, the message says so and names
// them, rather than the config being added. Here two copies of a 2/2 config for Ban List 2 give
// an expired ban 4 points, at threshold 6.
rows.ExportBanList.push(listOf('adder', 14, { threshold: 6 }));
configOf(14, 2, 2, 2);
configOf(14, 2, 2, 2);
await addRefused(
  14,
  3,
  { activePoints: 3, expiredPoints: 2 },
  "This list's settings are outside today's limits. One active ban plus one expired ban can already give 7 points (3 for an active ban, plus 4 for an expired ban on Partner Org 2's Ban List 2), which reaches the list's threshold of 6. Use points no higher than the list's defaults (3 for an active ban, 1 for an expired ban), or raise the list's threshold to 8 or more first."
);
await add(14, 3, { activePoints: 3, expiredPoints: 1 });

// Deleting a config. Without it, its ban list gets the list's default points, which must then
// leave the whole list within the rules if they are higher. That is only refused for a list
// outside the rules already, which the message says.
rows.ExportBanList.push(listOf('deleter', 12, { defaultActivePoints: 9 }));
const low = configOf(12, 1, 1, 1);
const same = configOf(12, 2, 9, 1);
const remove = (config, user = 'deleter') =>
  Mutation.deleteExportBanListConfig(null, { id: config.id }, as(user), {});
await remove(same);
assert.strictEqual(stored('ExportBanListConfig', same.id), undefined);
await refused(
  'deleteExportBanListConfig',
  { id: low.id },
  'deleter',
  "This list's settings are outside today's limits. One active ban plus one expired ban can already give 10 points (9 for an active ban, plus 1 for an expired ban), which reaches the list's threshold of 9. Keep this points setting, or raise the list's threshold to 11 or more first."
);
assert.ok(stored('ExportBanListConfig', low.id));
await refused(
  'deleteExportBanListConfig',
  { id: low.id },
  'adder',
  'Export ban list config does not exist!'
);
// One of two configs for the same ban list, which older lists can have, only takes its expired
// points away.
rows.ExportBanList.push(listOf('deleter', 13, { threshold: 3 }));
const copies = [configOf(13, 1, 3, 1), configOf(13, 1, 3, 1)];
await remove(copies[1]);
assert.deepStrictEqual(
  rows.ExportBanListConfig.filter(({ exportBanList }) => exportBanList === 13),
  [copies[0]]
);
assert.deepStrictEqual(logged, []);

// The limits come from the settings. Here BattleMetrics lists need a threshold of at least 12, so
// new lists start at 12, and remote lists need only that one ban is not enough.
const custom = await mutations({
  EXPORT_BM_MIN_THRESHOLD: '12',
  EXPORT_REMOTE_MIN_THRESHOLD: '1',
  EXPORT_REMOTE_NEVER_ENOUGH: 'one-ban'
});
await assert.rejects(
  custom.Mutation.createExportBanList(
    null,
    newList('battlemetrics', { threshold: 11 }),
    as('creator'),
    {}
  ),
  { message: MESSAGES.minimum('battlemetrics', 12) }
);
assert.strictEqual(
  (
    await custom.Mutation.createExportBanList(
      null,
      newList('remote', { threshold: 4 }),
      as('creator'),
      {}
    )
  ).threshold,
  4
);
await assert.rejects(
  custom.Mutation.createExportBanList(null, newList('remote', { threshold: 3 }), as('creator'), {}),
  {
    message:
      'One ban must not be enough to put a player on an export ban list. Here one ban can give 3 points (an active ban), so the threshold must be 4 or more. Raise the threshold or lower the points.'
  }
);
for (const type of types)
  assert.strictEqual(
    (
      await custom.Mutation.createExportBanList(
        null,
        { name: 'N', server: 'S', type },
        as('starter'),
        {}
      )
    ).threshold,
    12
  );

// A config always has both its points: the model refuses to save one without them.
let attributes;
await load(
  '../../scbl-lib/db/models/export-ban-list-configs.js',
  {
    sequelize: { default: { DataTypes: { INTEGER: 'INTEGER' } } },
    '../sequelize.js': {
      default: {
        define(name, defined) {
          assert.strictEqual(name, 'ExportBanListConfig');
          attributes = defined;
        }
      }
    }
  },
  vm.createContext({})
);
for (const points of ['activePoints', 'expiredPoints'])
  assert.deepStrictEqual({ ...attributes[points] }, { type: 'INTEGER', allowNull: false });

console.log(
  'Export ban list value checks passed: creating and saving lists, adding and deleting configs, older lists, and refusals.'
);
