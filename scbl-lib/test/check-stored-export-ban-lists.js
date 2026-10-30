import assert from 'assert';
import { readFile } from 'fs/promises';
import vm from 'vm';

import { checkRules, readLimits } from '../export-list-limits.js';

// Check stored export ban lists against today's limits with ExportBanList's checkLimits, as the
// Discord bot does before it removes the lists outside them, and list the BattleMetrics ban lists
// the API key can see with findVisibleBattlemetricsBanLists. The limits module and the BattleMetrics
// listing are the real ones; the database, its count of the players a list's settings give
// (countMembers) and BattleMetrics are stand-ins. The model runs in a context of its own, so what
// it gives is copied before it is compared.

const OWNER = '42';
const { limits: DEFAULT_LIMITS } = readLimits({});

// Every query, as the model and a copy of its options.
const queries = [];

// The database's rows: lists, the ban lists and organisations their configs name, the configs, and
// each list's export bans by status.
const organisations = [
  { id: 1, name: 'Partner Org' },
  { id: 2, name: 'Other Org' }
];
const banLists = [
  { id: 7, name: 'Main', organisation: 1 },
  { id: 8, name: 'Second', organisation: 2 },
  { id: 9, name: 'Third', organisation: 2 }
];
const list = (id, type, threshold, defaultActivePoints, defaultExpiredPoints, extra = {}) => ({
  id,
  name: `List ${id}`,
  type,
  threshold,
  defaultActivePoints,
  defaultExpiredPoints,
  maxBanAge: 0,
  owner: `7656119800000000${id}`,
  battlemetricsID: type === 'battlemetrics' ? `bm-${id}` : null,
  ...extra
});
const lists = [
  // Within the limits: the defaults.
  list(1, 'battlemetrics', 9, 3, 1),
  // One active ban plus one expired ban gives 4 points, enough at threshold 4.
  list(2, 'remote', 4, 3, 1),
  // One active ban is enough, and it has more players than a BattleMetrics list can have.
  list(3, 'battlemetrics', 5, 5, 1),
  // Within the points rules, with more players than a remote list can have.
  list(4, 'remote', 9, 3, 1),
  // Its configs give 5 points for an active ban on Partner Org's Main, so 6 with an expired ban.
  list(5, 'battlemetrics', 6, 3, 1),
  // Three configs for one ban list add up their expired points: 6 for an expired ban on Third.
  list(6, 'remote', 4, 0, 0),
  // Below the lowest threshold of 4, though one active ban plus one expired ban is not enough.
  list(7, 'remote', 3, 1, 1),
  // A type the limits do not cover.
  list(8, null, 1, 1, 1),
  // A list whose owner has no Steam user row.
  list(9, 'battlemetrics', 9, 3, 1, { battlemetricsID: null }),
  // Exactly as many players as a BattleMetrics list, and then a remote list, can have.
  list(10, 'battlemetrics', 9, 3, 1),
  list(11, 'remote', 9, 3, 1),
  // Made smaller by its owner, whose threshold of 7 the importer has not applied to its export
  // bans yet, which are those of its old threshold of 5.
  list(12, 'battlemetrics', 7, 5, 1),
  // More export bans than a remote list can have, but by its settings now exactly as many.
  list(13, 'remote', 10, 3, 1)
];
const configs = [
  { id: 1, exportBanList: 5, banList: 7, activePoints: 5, expiredPoints: 1 },
  { id: 2, exportBanList: 5, banList: 8, activePoints: 3, expiredPoints: 1 },
  { id: 3, exportBanList: 6, banList: 9, activePoints: 2, expiredPoints: 2 },
  { id: 4, exportBanList: 6, banList: 9, activePoints: 2, expiredPoints: 2 },
  { id: 5, exportBanList: 6, banList: 9, activePoints: 2, expiredPoints: 2 },
  // A config whose ban list is gone.
  { id: 6, exportBanList: 2, banList: 99, activePoints: 1, expiredPoints: 0 },
  // One whose expired points are the list's default.
  { id: 7, exportBanList: 12, banList: 7, activePoints: 2, expiredPoints: null }
];
const exportBans = [
  [1, 'CREATED', 967],
  [3, 'CREATED', 28000],
  [3, 'TO_BE_CREATED', 337],
  [3, 'TO_BE_DELETED', 5000],
  [4, 'CREATED', 40001],
  [5, 'TO_BE_DELETED', 3],
  [10, 'CREATED', 19000],
  [10, 'TO_BE_CREATED', 1000],
  [10, 'TO_BE_DELETED', 50],
  [11, 'CREATED', 40000],
  [12, 'CREATED', 28000],
  [12, 'TO_BE_CREATED', 337],
  [13, 'CREATED', 45000]
];

// The players the database counts for a list's settings and configs as they are now, as the website
// counts them (countMembers), by the list's threshold: an error fails the count. Each count is
// recorded among the queries. Like the website's size check, a count leaves out no ban list, so the
// bans of paused ones count too, though the importer leaves them out of export bans.
const membersByThreshold = new Map([
  // List 3, whose export bans are up to date.
  [5, 28337],
  // List 12 after its owner's change.
  [7, 1554],
  // List 4, which has gained players since the importer last updated it.
  [9, 40500],
  // List 13.
  [10, 40000]
]);
async function countMembers(settings, listConfigs, options) {
  queries.push(['countMembers', structuredClone({ settings, configs: listConfigs })]);
  assert.ok(!options?.excludedBanLists?.length, 'The count leaves out no ban list.');
  const players = membersByThreshold.get(settings.threshold);
  assert.ok(players !== undefined, `Unexpected count for threshold ${settings.threshold}`);
  if (players instanceof Error) throw players;
  return players;
}

// A stand-in for Sequelize's Model, whose findAll gives the matching rows as instances, with the
// owner's Steam user included as Sequelize includes it, and whose findByPk gives one row.
class Model {
  static init() {}

  static async findAll(options) {
    queries.push(['ExportBanList', structuredClone(options)]);
    const ids = options.where?.id;
    return lists
      .filter((row) => ids === undefined || ids.includes(row.id))
      .map((row) =>
        Object.assign(new this(), row, {
          SteamUser: row.id === 9 ? null : { id: row.owner, name: `Owner of ${row.id}` }
        })
      );
  }

  static async findByPk(id, options) {
    queries.push(['ExportBanList.findByPk', id, structuredClone(options)]);
    const row = lists.find((listRow) => listRow.id === id);
    return row ? Object.assign(new this(), row) : null;
  }
}
const dataType = () => dataType;

const models = {
  BanList: { name: 'BanList' },
  Organisation: { name: 'Organisation' },
  SteamUser: { name: 'SteamUser' },
  ExportBanListConfig: {
    // The configs of the lists with the IDs given, or of the list with the ID given.
    async findAll(options) {
      queries.push(['ExportBanListConfig', structuredClone(options)]);
      const ids = [options.where.exportBanList].flat();
      return configs
        .filter((config) => ids.includes(config.exportBanList))
        .map((config) => {
          const banList = banLists.find(({ id }) => id === config.banList);
          return {
            ...config,
            BanList: banList && {
              ...banList,
              Organisation: organisations.find(({ id }) => id === banList.organisation)
            }
          };
        });
    }
  },
  ExportBan: {
    async count(options) {
      queries.push(['ExportBan', structuredClone(options)]);
      const counts = new Map();
      for (const [exportBanList, status, players] of exportBans)
        if (
          options.where.exportBanList.includes(exportBanList) &&
          options.where.status.includes(status)
        )
          counts.set(exportBanList, (counts.get(exportBanList) ?? 0) + players);
      // MySQL's COUNT can come back as text.
      return [...counts].map(([exportBanList, count]) => ({ exportBanList, count: String(count) }));
    }
  }
};

// BattleMetrics' list of ban lists, as its pages. The second page is reached through the first's
// next link.
let banListPages;
const requests = [];
async function battlemetrics(method, endpoint, params) {
  requests.push([method, endpoint, { ...params }]);
  const page = params['page[key]'] === 'two' ? banListPages[1] : banListPages[0];
  if (page instanceof Error) throw page;
  return { data: page };
}

// The transaction the Discord bot's last read of a list before its removal runs in (changeSince),
// which only runs its work. Each transaction is recorded among the queries.
const LAST_READ = { name: 'last read' };
async function transaction(work) {
  queries.push(['transaction']);
  return work(LAST_READ);
}

const stubs = {
  sequelize: { default: { Model, DataTypes: new Proxy({}, { get: () => dataType }) } },
  '../sequelize.js': { default: { models, transaction } },
  // Deleting a list holds a lock on a connection of its own, which these checks never need.
  '../open-connection.js': { default: () => assert.fail('A connection was opened.') },
  '../export-membership.js': { countMembers },
  '../../apis/index.js': { battlemetrics },
  '../../utils/index.js': { Logger: { verbose() {} } },
  '../../config.js': { BATTLEMETRICS_ORGANIZATION: OWNER, EXPORT_LIST_LIMITS: DEFAULT_LIMITS },
  // The BattleMetrics steps' own imports.
  './battlemetrics.js': { default: battlemetrics },
  '../config.js': { BATTLEMETRICS_ORGANIZATION: OWNER }
};
const context = vm.createContext({ URL });
const load = async (url) =>
  new vm.SourceTextModule(await readFile(url, 'utf8'), { context, identifier: url.href });
const module = await load(new URL('../db/models/export-ban-list.js', import.meta.url));
await module.link(async (specifier, referencingModule) => {
  const exports = stubs[specifier];
  // The other relative imports, the limits, the deletion steps and the page reader, are the real
  // files.
  if (!exports) return load(new URL(specifier, referencingModule.identifier));
  return new vm.SyntheticModule(
    Object.keys(exports),
    function () {
      for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
    },
    { context }
  );
});
await module.evaluate();
const ExportBanList = module.namespace.default;

const settingsOf = (id) => {
  const row = lists.find((listRow) => listRow.id === id);
  return {
    threshold: row.threshold,
    defaultActivePoints: row.defaultActivePoints,
    defaultExpiredPoints: row.defaultExpiredPoints,
    maxBanAge: row.maxBanAge
  };
};
// A list's configs as checkLimits gives them and the rules take them, with the names of the ban
// lists and organisations they are for.
const configsOf = (id) =>
  configs
    .filter((config) => config.exportBanList === id)
    .map(({ id: configID, banList, activePoints, expiredPoints }) => {
      const banListRow = banLists.find((row) => row.id === banList);
      return {
        id: configID,
        banList,
        activePoints,
        expiredPoints,
        banListName: banListRow?.name,
        organisationName: organisations.find((row) => row.id === banListRow?.organisation)?.name
      };
    });
// The problems the points rules give a whole list, which checkLimits must give unchanged.
const ruleProblems = (id, type, limits = DEFAULT_LIMITS) =>
  checkRules(type, { settings: settingsOf(id), configs: configsOf(id) }, limits);
const capProblem = (message) => ({ rule: 'max-players', field: 'players', message });
// What checkLimits gives for each list, copied, with a failed count's error as its message.
const summary = (result) =>
  [...result.lists].map(
    ({ exportBanList, configs, players, recount, recountError, problems, checked }) => ({
      id: exportBanList.id,
      owner: exportBanList.SteamUser && { ...exportBanList.SteamUser },
      configs: [...configs].map((config) => ({ ...config })),
      players,
      recount,
      recountError: recountError?.message ?? recountError,
      problems: [...problems].map((problem) => ({ ...problem })),
      checked
    })
  );
const outside = (result) =>
  [...result.lists]
    .filter((check) => check.problems.length > 0)
    .map((check) => check.exportBanList.id);
// The count of the players a list's settings and configs give now, as the queries record it.
const recounted = (id) => ['countMembers', { settings: settingsOf(id), configs: configsOf(id) }];

// Every list is checked, in ID order, with its owner, its configs, its players and its problems
// under the default limits: the points rules' problems as checkRules gives them for the whole
// list, and one for more players than its type's cap. A list with more players than its type's cap
// is counted again by its settings and configs now, as its export bans may be from before its
// owner's last change, and it is only over the cap when that count is too. A list of a type the
// limits do not cover is not checked.
let result = await ExportBanList.checkLimits();
assert.strictEqual(result.limits, DEFAULT_LIMITS);
const expected = {
  1: { players: 967, problems: [] },
  2: { players: 0, problems: ruleProblems(2, 'remote') },
  // When the two counts are the same, the message gives one.
  3: {
    players: 28337,
    recount: 28337,
    problems: [
      ...ruleProblems(3, 'battlemetrics'),
      capProblem(
        'It has 28,337 players, more than the 20,000 a BattleMetrics export ban list can have.'
      )
    ]
  },
  4: {
    players: 40001,
    recount: 40500,
    problems: [
      capProblem(
        'It has 40,001 players by its export bans and 40,500 by its settings now, both more than the 40,000 a remote export ban list can have.'
      )
    ]
  },
  5: { players: 0, problems: ruleProblems(5, 'battlemetrics') },
  6: { players: 0, problems: ruleProblems(6, 'remote') },
  7: { players: 0, problems: ruleProblems(7, 'remote') },
  8: { players: 0, problems: [], checked: false },
  9: { players: 0, problems: [] },
  // A list may have as many players as its type's cap, but no more.
  10: { players: 20000, problems: [] },
  11: { players: 40000, problems: [] },
  // Over the cap by its export bans, but not by its settings now.
  12: { players: 28337, recount: 1554, problems: [] },
  13: { players: 45000, recount: 40000, problems: [] }
};
assert.deepStrictEqual(
  summary(result),
  lists.map((row) => ({
    id: row.id,
    owner: row.id === 9 ? null : { id: row.owner, name: `Owner of ${row.id}` },
    configs: configsOf(row.id),
    players: expected[row.id].players,
    recount: expected[row.id].recount ?? null,
    recountError: null,
    problems: expected[row.id].problems,
    checked: expected[row.id].checked ?? true
  }))
);
assert.ok(result.lists[0].exportBanList instanceof ExportBanList);
assert.deepStrictEqual(outside(result), [2, 3, 4, 5, 6, 7]);

// The messages say why, naming the ban lists whose configs give the points.
assert.strictEqual(
  result.lists[1].problems[0].message,
  'One active ban plus one expired ban must not be enough to put a player on an export ban list. Here they can give 4 points (3 for an active ban, plus 1 for an expired ban), so the threshold must be 5 or more. Raise the threshold or lower the points.'
);
assert.match(result.lists[4].problems[0].message, /5 for an active ban on Partner Org's Main,/);
assert.match(result.lists[5].problems[0].message, /6 for an expired ban on Other Org's Third\)/);
assert.strictEqual(
  result.lists[6].problems[0].message,
  "A remote export ban list's threshold must be at least 4."
);

// One query of each: the lists with their owners' Steam IDs and names, the lists' configs with the
// ban lists and organisations that name them, and the lists' players: their export bans waiting to
// be added or already added, which /export/:id serves. Then only the lists over their type's cap
// are counted again, one at a time, in ID order, each with its settings and configs as stored.
const allIDs = lists.map((row) => row.id);
assert.deepStrictEqual(queries, [
  [
    'ExportBanList',
    { include: [{ model: models.SteamUser, attributes: ['id', 'name'] }], order: [['id', 'ASC']] }
  ],
  [
    'ExportBanListConfig',
    {
      where: { exportBanList: allIDs },
      include: [{ model: models.BanList, include: [models.Organisation] }],
      order: [['id', 'ASC']]
    }
  ],
  [
    'ExportBan',
    {
      where: { exportBanList: allIDs, status: ['TO_BE_CREATED', 'CREATED'] },
      group: ['exportBanList']
    }
  ],
  recounted(3),
  recounted(4),
  recounted(12),
  recounted(13)
]);

// Lists can be checked by ID, and only those are read. IDs of no list give no lists, and no IDs
// read nothing.
queries.length = 0;
result = await ExportBanList.checkLimits({ ids: [3] });
assert.deepStrictEqual(summary(result), [
  {
    id: 3,
    owner: { id: lists[2].owner, name: 'Owner of 3' },
    configs: [],
    players: 28337,
    recount: 28337,
    recountError: null,
    problems: expected[3].problems,
    checked: true
  }
]);
assert.deepStrictEqual(
  queries.map(([model, options]) => [model, options.where ?? options.settings]),
  [
    ['ExportBanList', { id: [3] }],
    ['ExportBanListConfig', { exportBanList: [3] }],
    ['ExportBan', { exportBanList: [3], status: ['TO_BE_CREATED', 'CREATED'] }],
    ['countMembers', settingsOf(3)]
  ]
);

queries.length = 0;
result = await ExportBanList.checkLimits({ ids: [404] });
assert.strictEqual(result.lists.length, 0);
assert.deepStrictEqual(
  queries.map(([model]) => model),
  ['ExportBanList']
);
queries.length = 0;
result = await ExportBanList.checkLimits({ ids: [] });
assert.strictEqual(result.limits, DEFAULT_LIMITS);
assert.strictEqual(result.lists.length, 0);
assert.deepStrictEqual(queries, []);

// Other limits can be given. Without caps no list is over one, so none is counted again, and when
// only one ban must never be enough for a remote list, one active ban plus one expired ban may be.
const { limits: otherLimits } = readLimits({
  EXPORT_BM_MAX_PLAYERS: '0',
  EXPORT_REMOTE_MAX_PLAYERS: '0',
  EXPORT_REMOTE_NEVER_ENOUGH: 'one-ban'
});
queries.length = 0;
result = await ExportBanList.checkLimits({ limits: otherLimits });
assert.strictEqual(result.limits, otherLimits);
assert.deepStrictEqual(outside(result), [3, 5, 6, 7]);
assert.deepStrictEqual(summary(result)[2].problems, ruleProblems(3, 'battlemetrics', otherLimits));
assert.ok(result.lists.every((check) => check.recount === null));
assert.ok(!queries.some(([model]) => model === 'countMembers'));

// An owner who makes their list smaller on the website, e.g. by raising its threshold, which the
// website saves without counting, brings it within the cap at once, though its export bans stay as
// they were until the importer updates them. List 12 had a threshold of 5, which let one active ban
// plus one expired ban put a player on it, and as many players as its export bans still hold.
lists[11].threshold = 5;
result = await ExportBanList.checkLimits({ ids: [12] });
assert.deepStrictEqual(summary(result)[0].problems, [
  ...ruleProblems(12, 'battlemetrics'),
  capProblem(
    'It has 28,337 players, more than the 20,000 a BattleMetrics export ban list can have.'
  )
]);
// Its owner raises the threshold to 7, and its export bans stay the same.
lists[11].threshold = 7;
queries.length = 0;
result = await ExportBanList.checkLimits({ ids: [12] });
assert.deepStrictEqual(
  summary(result).map(({ players, recount, problems }) => ({ players, recount, problems })),
  [{ players: 28337, recount: 1554, problems: [] }]
);
assert.deepStrictEqual(queries.at(-1), recounted(12));

// A count that fails fails the check, as whether the list is over the cap is not known then, so
// it is never taken to be over the cap by its export bans alone.
const interrupted = new Error('Query execution was interrupted');
membersByThreshold.set(7, interrupted);
await assert.rejects(ExportBanList.checkLimits({ ids: [12] }), {
  message: 'Query execution was interrupted'
});
await assert.rejects(ExportBanList.checkLimits(), { message: 'Query execution was interrupted' });
// A list within its cap is not counted, so it is checked as before.
result = await ExportBanList.checkLimits({ ids: [1] });
assert.deepStrictEqual(summary(result)[0].problems, []);

// A caller that deals with such a list itself can keep the error instead: the list whose count
// failed comes with it, no count and no problem for the cap, as whether it is over the cap is not
// known, and its points rules are still checked. The other lists are checked and counted as before.
queries.length = 0;
result = await ExportBanList.checkLimits({ ids: [12], keepRecountErrors: true });
assert.strictEqual(result.lists[0].recountError, interrupted);
assert.deepStrictEqual(
  summary(result).map(({ players, recount, recountError, problems, checked }) => ({
    players,
    recount,
    recountError,
    problems,
    checked
  })),
  [
    {
      players: 28337,
      recount: null,
      recountError: 'Query execution was interrupted',
      problems: [],
      checked: true
    }
  ]
);
assert.deepStrictEqual(queries.at(-1), recounted(12));
lists[11].defaultExpiredPoints = 2;
result = await ExportBanList.checkLimits({ ids: [12], keepRecountErrors: true });
assert.deepStrictEqual(summary(result)[0].problems, ruleProblems(12, 'battlemetrics'));
assert.ok(result.lists[0].problems.length > 0);
lists[11].defaultExpiredPoints = 1;
result = await ExportBanList.checkLimits({ keepRecountErrors: true });
assert.deepStrictEqual(
  summary(result).map(({ id, recount, recountError, problems }) => ({
    id,
    recount,
    recountError,
    problems
  })),
  lists.map((row) => ({
    id: row.id,
    recount: row.id === 12 ? null : (expected[row.id].recount ?? null),
    recountError: row.id === 12 ? 'Query execution was interrupted' : null,
    problems: expected[row.id].problems
  }))
);
membersByThreshold.set(7, 1554);

// Checking a list takes a moment, longer when it is counted again, and its owner may change it on
// the website meanwhile. So just before the Discord bot removes a list, once it holds the list's
// deletion lock, it asks what has changed since the check: nothing here. The list is read again,
// with its settings and BattleMetrics ban list, with its row locked, in a transaction, so a change
// the website is saving to it, which holds the row, is saved first and seen. Its configs are read
// in the same transaction, in ID order, as checkLimits loads them.
const [checked12] = (await ExportBanList.checkLimits({ ids: [12] })).lists;
queries.length = 0;
assert.strictEqual(await ExportBanList.changeSince(checked12), null);
assert.deepStrictEqual(queries, [
  ['transaction'],
  [
    'ExportBanList.findByPk',
    12,
    {
      attributes: [
        'id',
        'battlemetricsID',
        'threshold',
        'defaultActivePoints',
        'defaultExpiredPoints',
        'maxBanAge'
      ],
      lock: true,
      transaction: LAST_READ
    }
  ],
  [
    'ExportBanListConfig',
    {
      attributes: ['id', 'banList', 'activePoints', 'expiredPoints'],
      where: { exportBanList: 12 },
      order: [['id', 'ASC']],
      transaction: LAST_READ
    }
  ]
]);
// A new value of any setting, a BattleMetrics ban list made or deleted meanwhile, and a config
// changed, added or deleted are each a change.
const changes = [
  ...[
    ['threshold', 9],
    ['defaultActivePoints', 4],
    ['defaultExpiredPoints', 0],
    ['maxBanAge', 30],
    ['battlemetricsID', null]
  ].map(([column, value]) => [column, lists[11], column, value]),
  ...[
    ['banList', 8],
    ['activePoints', 3],
    ['expiredPoints', 1]
  ].map(([field, value]) => [`config's ${field}`, configs[6], field, value])
];
for (const [what, row, field, value] of changes) {
  const before = row[field];
  row[field] = value;
  assert.strictEqual(await ExportBanList.changeSince(checked12), 'changed', what);
  row[field] = before;
}
configs.push({ id: 8, exportBanList: 12, banList: 8, activePoints: 1, expiredPoints: 1 });
assert.strictEqual(await ExportBanList.changeSince(checked12), 'changed', 'a config added');
configs.pop();
const [config7] = configs.splice(6, 1);
assert.strictEqual(await ExportBanList.changeSince(checked12), 'changed', 'a config deleted');
configs.splice(6, 0, config7);
// What does not decide who is on the list or whether it is within the limits is no change, such as
// its name.
lists[11].name = 'Renamed';
assert.strictEqual(await ExportBanList.changeSince(checked12), null);
lists[11].name = 'List 12';
// A list deleted meanwhile is gone.
const [list12] = lists.splice(11, 1);
assert.strictEqual(await ExportBanList.changeSince(checked12), 'deleted');
lists.splice(11, 0, list12);
assert.strictEqual(await ExportBanList.changeSince(checked12), null);

// The BattleMetrics ban lists the API key can see are read from BattleMetrics' list of ban lists,
// every page of it, 100 at a time.
const banListRecord = (id) => ({ type: 'banList', id, attributes: { name: `Ban list ${id}` } });
banListPages = [
  {
    data: [banListRecord('bm-1'), banListRecord('bm-3')],
    links: { next: 'https://api.battlemetrics.com/ban-lists?page[key]=two&page[size]=100' }
  },
  { data: [banListRecord('bm-5')], links: {} }
];
assert.deepStrictEqual(
  [...(await ExportBanList.findVisibleBattlemetricsBanLists())],
  ['bm-1', 'bm-3', 'bm-5']
);
assert.deepStrictEqual(requests, [
  ['get', 'ban-lists', { 'page[size]': '100' }],
  ['get', 'ban-lists', { 'page[key]': 'two', 'page[size]': '100' }]
]);

// An answer that is not a list of ban lists, or a failed request, fails the listing, so a ban list
// missing from it is never taken to be gone.
banListPages = [{ data: [banListRecord('bm-1'), { type: 'ban', id: '5' }], links: {} }];
await assert.rejects(ExportBanList.findVisibleBattlemetricsBanLists(), {
  message: 'Invalid BattleMetrics ban list response.'
});
const failure = new Error('BattleMetrics GET ban-lists failed: HTTP 401');
banListPages = [failure];
await assert.rejects(
  ExportBanList.findVisibleBattlemetricsBanLists(),
  (error) => error === failure
);

console.log(
  'Stored export ban list checks passed: problems under the limits, players, lists over the cap counted again by their settings now, configs with names, and the ban lists BattleMetrics shows.'
);
