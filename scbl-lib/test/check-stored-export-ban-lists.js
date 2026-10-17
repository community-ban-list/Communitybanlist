import assert from 'assert';
import { readFile } from 'fs/promises';
import vm from 'vm';

import { checkRules, readLimits } from '../export-list-limits.js';

// Check stored export ban lists against today's limits with ExportBanList's checkLimits, as the
// Discord bot does before it removes the lists outside them, and list the BattleMetrics ban lists
// the API key can see with findVisibleBattlemetricsBanLists. The limits module and the BattleMetrics
// listing are the real ones; the database and BattleMetrics are stand-ins. The model runs in a
// context of its own, so what it gives is copied before it is compared.

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
  list(9, 'battlemetrics', 9, 3, 1, { battlemetricsID: null })
];
const configs = [
  { id: 1, exportBanList: 5, banList: 7, activePoints: 5, expiredPoints: 1 },
  { id: 2, exportBanList: 5, banList: 8, activePoints: 3, expiredPoints: 1 },
  { id: 3, exportBanList: 6, banList: 9, activePoints: 2, expiredPoints: 2 },
  { id: 4, exportBanList: 6, banList: 9, activePoints: 2, expiredPoints: 2 },
  { id: 5, exportBanList: 6, banList: 9, activePoints: 2, expiredPoints: 2 },
  // A config whose ban list is gone.
  { id: 6, exportBanList: 2, banList: 99, activePoints: 1, expiredPoints: 0 }
];
const exportBans = [
  [1, 'CREATED', 967],
  [3, 'CREATED', 28000],
  [3, 'TO_BE_CREATED', 337],
  [3, 'TO_BE_DELETED', 5000],
  [4, 'CREATED', 40001],
  [5, 'TO_BE_DELETED', 3]
];

// A stand-in for Sequelize's Model, whose findAll gives the matching rows as instances, with the
// owner's Steam user included as Sequelize includes it.
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
}
const dataType = () => dataType;

const models = {
  BanList: { name: 'BanList' },
  Organisation: { name: 'Organisation' },
  SteamUser: { name: 'SteamUser' },
  ExportBanListConfig: {
    async findAll(options) {
      queries.push(['ExportBanListConfig', structuredClone(options)]);
      return configs
        .filter((config) => options.where.exportBanList.includes(config.exportBanList))
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

const stubs = {
  sequelize: { default: { Model, DataTypes: new Proxy({}, { get: () => dataType }) } },
  '../sequelize.js': { default: { models } },
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
// What checkLimits gives for each list, copied.
const summary = (result) =>
  [...result.lists].map(({ exportBanList, configs, players, problems, checked }) => ({
    id: exportBanList.id,
    owner: exportBanList.SteamUser && { ...exportBanList.SteamUser },
    configs: [...configs].map((config) => ({ ...config })),
    players,
    problems: [...problems].map((problem) => ({ ...problem })),
    checked
  }));
const outside = (result) =>
  [...result.lists]
    .filter((check) => check.problems.length > 0)
    .map((check) => check.exportBanList.id);

// Every list is checked, in ID order, with its owner, its configs, its players and its problems
// under the default limits: the points rules' problems as checkRules gives them for the whole
// list, and one for more players than its type's cap. A list of a type the limits do not cover is
// not checked.
let result = await ExportBanList.checkLimits();
assert.strictEqual(result.limits, DEFAULT_LIMITS);
const expected = {
  1: { players: 967, problems: [] },
  2: { players: 0, problems: ruleProblems(2, 'remote') },
  3: {
    players: 28337,
    problems: [
      ...ruleProblems(3, 'battlemetrics'),
      capProblem(
        'It has 28,337 players, more than the 20,000 a BattleMetrics export ban list can have.'
      )
    ]
  },
  4: {
    players: 40001,
    problems: [
      capProblem('It has 40,001 players, more than the 40,000 a remote export ban list can have.')
    ]
  },
  5: { players: 0, problems: ruleProblems(5, 'battlemetrics') },
  6: { players: 0, problems: ruleProblems(6, 'remote') },
  7: { players: 0, problems: ruleProblems(7, 'remote') },
  8: { players: 0, problems: [], checked: false },
  9: { players: 0, problems: [] }
};
assert.deepStrictEqual(
  summary(result),
  lists.map((row) => ({
    id: row.id,
    owner: row.id === 9 ? null : { id: row.owner, name: `Owner of ${row.id}` },
    configs: configsOf(row.id),
    players: expected[row.id].players,
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
// be added or already added, which /export/:id serves.
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
  ]
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
    problems: expected[3].problems,
    checked: true
  }
]);
assert.deepStrictEqual(
  queries.map(([model, options]) => [model, options.where]),
  [
    ['ExportBanList', { id: [3] }],
    ['ExportBanListConfig', { exportBanList: [3] }],
    ['ExportBan', { exportBanList: [3], status: ['TO_BE_CREATED', 'CREATED'] }]
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

// Other limits can be given. Without caps no list is over one, and when only one ban must never be
// enough for a remote list, one active ban plus one expired ban may be.
const { limits: otherLimits } = readLimits({
  EXPORT_BM_MAX_PLAYERS: '0',
  EXPORT_REMOTE_MAX_PLAYERS: '0',
  EXPORT_REMOTE_NEVER_ENOUGH: 'one-ban'
});
result = await ExportBanList.checkLimits({ limits: otherLimits });
assert.strictEqual(result.limits, otherLimits);
assert.deepStrictEqual(outside(result), [3, 5, 6, 7]);
assert.deepStrictEqual(summary(result)[2].problems, ruleProblems(3, 'battlemetrics', otherLimits));

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
  'Stored export ban list checks passed: problems under the limits, players, configs with names, and the ban lists BattleMetrics shows.'
);
