import assert from 'assert';
import { readFile } from 'fs/promises';
import vm from 'vm';

// Check the statements that decide who is on an export ban list, without a database: a stand-in
// for Sequelize records each statement with its options, and answers with what the test sets.

// Values made in the module's context are copied into this one before they are compared.
const copy = (value) => JSON.parse(JSON.stringify(value));
// A statement on one line, with no space after an opening bracket or before a closing one.
const tidy = (sql) => sql.replace(/\s+/g, ' ').replace(/\( /g, '(').replace(/ \)/g, ')').trim();
// How many times a piece of SQL is in a statement.
const times = (sql, piece) => tidy(sql).split(piece).length - 1;
// An error the module throws is made in its own context, so it is told by its name.
const typeError = (message) => (err) => err.name === 'TypeError' && message.test(err.message);

// How many replacements a statement takes. Sequelize only reads a ? as one after a space, an
// opening bracket, a comma, = or >, so every ? in the statement must be in such a place.
function placeholders(sql) {
  const marks = sql.match(/\?/g) || [];
  assert.strictEqual((sql.match(/[\s(,=>]\?/g) || []).length, marks.length);
  return marks.length;
}

const queries = [];
let answer = () => [];
const sequelize = {
  async query(sql, options) {
    queries.push({ sql, options });
    return answer();
  }
};

const context = vm.createContext({});
const module = new vm.SourceTextModule(
  await readFile(new URL('../db/export-membership.js', import.meta.url), 'utf8'),
  { context }
);
// Its other import, the piece that leaves out paused ban lists, has no imports, and is loaded as it
// is.
const excludedPiece = new vm.SourceTextModule(
  await readFile(new URL('../db/excluded-ban-lists.js', import.meta.url), 'utf8'),
  { context }
);
await module.link((specifier) => {
  if (specifier === './excluded-ban-lists.js') return excludedPiece;
  assert.strictEqual(specifier, './sequelize.js');
  return new vm.SyntheticModule(
    ['default', 'QueryTypes'],
    function () {
      this.setExport('default', sequelize);
      this.setExport('QueryTypes', { SELECT: 'SELECT' });
    },
    { context }
  );
});
await module.evaluate();
const { SCORING_FIELDS, countMembers, countPlayersWithBans, findMembers, membershipForPlayers } =
  module.namespace;

// The rule in pieces, which every statement must contain in the same way, so they always agree.
const PIECES = {
  EXPIRED: 'B.expired',
  COUNTED: '(EBL.maxBanAge = 0 OR EBL.maxBanAge >= DATEDIFF(NOW(), B.created))',
  ACTIVE_POINTS: 'MAX(IF(B.expired, 0, IFNULL(EBLC.activePoints, EBL.defaultActivePoints)))',
  EXPIRED_POINTS: 'SUM(IF(B.expired, IFNULL(EBLC.expiredPoints, EBL.defaultExpiredPoints), 0))',
  QUALIFIES: 'SUM(activePoints) + SUM(expiredPoints) >= MAX(threshold)'
};

// The statement the importer ran before it moved here. The move must not change what it does, so
// apart from spacing it is the same.
const IMPORTER_STATEMENT = `
  SELECT
    CONCAT(steamUser, ",", exportBanList) AS "id",
    "TO_BE_CREATED" AS "status",
    steamUser,
    exportBanList
  FROM (
    SELECT
      EBL.id AS "exportBanList",
      B.steamUser AS "steamUser",
      EBL.threshold AS "threshold",
      MAX(
        IF(
          B.expired,
          0,
          IFNULL(
            EBLC.activePoints,
            EBL.defaultActivePoints
          )
        )
      ) AS "activePoints",
      SUM(
        IF(
          B.expired,
          IFNULL(
            EBLC.expiredPoints,
            EBL.defaultExpiredPoints
          ),
          0
        )
      ) AS "expiredPoints"
    FROM Bans B
    CROSS JOIN ExportBanLists EBL
    LEFT JOIN ExportBanListConfigs EBLC ON EBL.id = EBLC.exportBanList AND B.banList = EBLC.banList
    WHERE (
      EBL.maxBanAge = 0 OR
      EBL.maxBanAge >= DATEDIFF(NOW(), B.created)
    ) AND B.steamUser IN (?)
    GROUP BY EBL.id, B.steamUser, B.banList
  ) A
  GROUP BY exportBanList, steamUser
  HAVING SUM(activePoints) + SUM(expiredPoints) >= MAX(threshold)
`;

// The columns of a list that decide who is on it.
assert.deepStrictEqual(copy(SCORING_FIELDS), [
  'threshold',
  'defaultActivePoints',
  'defaultExpiredPoints',
  'maxBanAge'
]);

// The importer's statement gives the export bans a batch of players qualifies for, on every list,
// in the transaction the importer gives it, and its rows are returned as Sequelize gives them.
const generated = [
  { id: '76561198000000001,7', status: 'TO_BE_CREATED', steamUser: '76561198000000001' }
];
answer = () => generated;
const transaction = { isolationLevel: 'SERIALIZABLE' };
assert.strictEqual(
  await membershipForPlayers(['76561198000000001', '76561198000000002'], {
    transaction,
    excludedBanLists: []
  }),
  generated
);
assert.strictEqual(queries.length, 1);
const [membership] = queries;
assert.strictEqual(tidy(membership.sql), tidy(IMPORTER_STATEMENT));
assert.match(tidy(membership.sql), /^SELECT CONCAT\(steamUser, ",", exportBanList\) AS "id"/);
assert.match(
  tidy(membership.sql),
  /AND B\.steamUser IN \(\?\) GROUP BY EBL\.id, B\.steamUser, B\.banList/
);
assert.deepStrictEqual(Object.keys(membership.options), ['type', 'transaction', 'replacements']);
assert.strictEqual(membership.options.type, 'SELECT');
assert.strictEqual(membership.options.transaction, transaction);
assert.deepStrictEqual(copy(membership.options.replacements), [
  ['76561198000000001', '76561198000000002']
]);
assert.strictEqual(placeholders(membership.sql), 1);

// No paused ban list is left out of any of these, which is given as [].
const NONE = { excludedBanLists: [] };

// A count takes the list's settings, whatever else the list holds, and every config as stored:
// here two copies of one config, and configs with NULL and 0 points. Each setting and config value
// is a replacement, in the order of the statement's placeholders.
const settings = {
  id: 7,
  name: 'A list',
  type: 'battlemetrics',
  threshold: 9,
  defaultActivePoints: 3,
  defaultExpiredPoints: 1,
  maxBanAge: 0
};
const configs = [
  { id: 1, exportBanList: 7, banList: 2, activePoints: 5, expiredPoints: null },
  { id: 2, exportBanList: 7, banList: 2, activePoints: 5, expiredPoints: null },
  { id: 3, exportBanList: 7, banList: 3, activePoints: null, expiredPoints: 0 },
  { id: 4, exportBanList: 7, banList: 4, activePoints: 0, expiredPoints: 0 }
];
queries.length = 0;
answer = () => [{ players: 1234 }];
assert.strictEqual(await countMembers(settings, configs, NONE), 1234);
const [count] = queries;
const replacements = copy(count.options.replacements);
assert.deepStrictEqual(replacements.slice(0, 4), [9, 3, 1, 0]);
assert.deepStrictEqual(
  [0, 1, 2, 3].map((config) => replacements.slice(4 + 3 * config, 7 + 3 * config)),
  [
    [2, 5, null],
    [2, 5, null],
    [3, null, 0],
    [4, 0, 0]
  ]
);
assert.strictEqual(placeholders(count.sql), replacements.length);
assert.strictEqual(replacements.length, 16);
// It is one statement outside any transaction, so it takes no locks, with the temporary table size
// and the time limit, 3 seconds unless given, as optimizer hints.
assert.deepStrictEqual(Object.keys(count.options), ['type', 'replacements']);
assert.strictEqual(count.options.type, 'SELECT');
assert.strictEqual(
  tidy(count.sql),
  tidy(`
    SELECT /*+ SET_VAR(tmp_table_size = 67108864) SET_VAR(max_heap_table_size = 67108864) MAX_EXECUTION_TIME(3000) */
           COUNT(*) AS players
    FROM (
      SELECT steamUser FROM (
        SELECT B.steamUser AS steamUser, MAX(EBL.threshold) AS threshold,
               MAX(IF(B.expired, 0, IFNULL(EBLC.activePoints, EBL.defaultActivePoints))) AS activePoints,
               SUM(IF(B.expired, IFNULL(EBLC.expiredPoints, EBL.defaultExpiredPoints), 0)) AS expiredPoints
        FROM Bans B
        CROSS JOIN (SELECT ? AS threshold, ? AS defaultActivePoints, ? AS defaultExpiredPoints, ? AS maxBanAge) EBL
        LEFT JOIN (SELECT ? AS banList, ? AS activePoints, ? AS expiredPoints UNION ALL SELECT ?, ?, ?
                   UNION ALL SELECT ?, ?, ? UNION ALL SELECT ?, ?, ?) EBLC
          ON B.banList = EBLC.banList
        WHERE (EBL.maxBanAge = 0 OR EBL.maxBanAge >= DATEDIFF(NOW(), B.created))
        GROUP BY B.steamUser, B.banList
      ) A
      GROUP BY steamUser
      HAVING SUM(activePoints) + SUM(expiredPoints) >= MAX(threshold)
    ) Q
  `)
);

// The importer's statement and the count are made of the same pieces, used the same way.
for (const [name, piece] of Object.entries(PIECES)) {
  assert.ok(times(membership.sql, piece) > 0, `The importer's statement has ${name}`);
  assert.strictEqual(times(count.sql, piece), times(membership.sql, piece), `The count's ${name}`);
}

// A list with no configs, such as a new one, joins an empty table of them. A NULL setting is sent
// as NULL, and a time limit given is used.
queries.length = 0;
answer = () => [{ players: 0 }];
assert.strictEqual(
  await countMembers(
    { threshold: null, defaultActivePoints: 1, defaultExpiredPoints: null, maxBanAge: 365 },
    [],
    { timeLimit: 1500, ...NONE }
  ),
  0
);
assert.deepStrictEqual(copy(queries[0].options.replacements), [null, 1, null, 365]);
assert.strictEqual(placeholders(queries[0].sql), 4);
assert.ok(
  tidy(queries[0].sql).includes(
    'LEFT JOIN (SELECT NULL AS banList, NULL AS activePoints, NULL AS expiredPoints FROM DUAL WHERE FALSE) EBLC ON B.banList = EBLC.banList'
  )
);
assert.match(
  tidy(queries[0].sql),
  /^SELECT \/\*\+ SET_VAR\(tmp_table_size = 67108864\) SET_VAR\(max_heap_table_size = 67108864\) MAX_EXECUTION_TIME\(1500\) \*\/ COUNT\(\*\) AS players FROM \(SELECT steamUser FROM/
);

// A setting left undefined means the caller did not merge in the stored ones, and so does a config
// without one of its values. A time limit is written into the statement, so it must be a whole
// number of milliseconds that MySQL takes, from 1 to 4294967295: it ignores a longer one. Each
// throws before anything is asked of the database.
queries.length = 0;
for (const field of SCORING_FIELDS) {
  const { [field]: left, ...without } = settings;
  await assert.rejects(countMembers(without, configs), typeError(new RegExp(field)));
  await assert.rejects(
    countMembers({ ...settings, [field]: undefined }, configs),
    typeError(new RegExp(field))
  );
}
await assert.rejects(countMembers(undefined, configs), typeError(/settings/));
await assert.rejects(countMembers(settings), typeError(/configs/));
await assert.rejects(
  countMembers(settings, [...configs, { banList: 5, activePoints: 2 }]),
  typeError(/expiredPoints of config 4/)
);
for (const timeLimit of [0, -1, 1.5, '3000', NaN, Infinity, null, 2 ** 32, 2 ** 53, 3000n])
  await assert.rejects(countMembers(settings, configs, { timeLimit }), typeError(/time limit/));
assert.strictEqual(queries.length, 0);
// The longest time limit MySQL takes is used as given.
await countMembers(settings, configs, { timeLimit: 2 ** 32 - 1, ...NONE });
assert.strictEqual(queries.length, 1);
assert.ok(tidy(queries[0].sql).includes('MAX_EXECUTION_TIME(4294967295) */ COUNT(*) AS players'));

// The database's errors are passed on as they are, e.g. MySQL's when the time limit is reached.
const timeout = Object.assign(new Error('Query execution was interrupted'), {
  name: 'SequelizeDatabaseError',
  original: { code: 'ER_QUERY_TIMEOUT', errno: 3024 }
});
answer = () => {
  throw timeout;
};
await assert.rejects(
  countMembers(settings, configs, { timeLimit: 1, ...NONE }),
  (err) => err === timeout
);

// The players a count counts are found by the same statement, giving their Steam IDs instead of
// their number.
queries.length = 0;
answer = () => [{ steamUser: '76561198000000001' }, { steamUser: '76561198000000002' }];
assert.deepStrictEqual(copy(await findMembers(settings, configs, NONE)), [
  '76561198000000001',
  '76561198000000002'
]);
assert.strictEqual(
  tidy(queries[0].sql),
  tidy(count.sql).replace('COUNT(*) AS players', 'steamUser')
);
assert.deepStrictEqual(Object.keys(queries[0].options), ['type', 'replacements']);
assert.deepStrictEqual(copy(queries[0].options.replacements), copy(count.options.replacements));
await assert.rejects(
  findMembers({ ...settings, maxBanAge: undefined }, configs),
  typeError(/maxBanAge/)
);
await assert.rejects(findMembers(settings, configs, { timeLimit: 0 }), typeError(/time limit/));
assert.strictEqual(queries.length, 1);

// The players with two or more bans are counted as a list with 1 point for each ban, threshold 2,
// any age and no configs.
queries.length = 0;
answer = () => [{ players: 13289 }];
assert.strictEqual(await countPlayersWithBans(2, NONE), 13289);
assert.deepStrictEqual(copy(queries[0].options.replacements), [2, 1, 1, 0]);
assert.ok(tidy(queries[0].sql).includes('FROM DUAL WHERE FALSE'));
assert.ok(tidy(queries[0].sql).includes('MAX_EXECUTION_TIME(3000)'));
await countPlayersWithBans(3, { timeLimit: 10000, ...NONE });
assert.deepStrictEqual(copy(queries[1].options.replacements), [3, 1, 1, 0]);
assert.ok(tidy(queries[1].sql).includes('MAX_EXECUTION_TIME(10000)'));
const threeBans = { threshold: 3, defaultActivePoints: 1, defaultExpiredPoints: 1, maxBanAge: 0 };
await countMembers(threeBans, [], { timeLimit: 10000, ...NONE });
assert.strictEqual(queries[1].sql, queries[2].sql);
await assert.rejects(countPlayersWithBans(), typeError(/threshold/));
assert.strictEqual(queries.length, 3);

// The bans of paused ban lists count for nothing. Each statement leaves them out by one condition
// on the bans, with their IDs in order, written into it, and is otherwise the statement with none
// left out: the same text and the same replacements. The importer's and the count's have it alike.
const PAUSED = 'B.banList NOT IN (7, 46)';
queries.length = 0;
answer = () => generated;
await membershipForPlayers(['76561198000000001'], { transaction, excludedBanLists: [46, 7] });
assert.strictEqual(
  tidy(queries[0].sql),
  tidy(IMPORTER_STATEMENT).replace('AND B.steamUser IN (?)', `AND B.steamUser IN (?) AND ${PAUSED}`)
);
assert.strictEqual(placeholders(queries[0].sql), 1);
answer = () => [{ players: 12 }];
assert.strictEqual(await countMembers(settings, configs, { excludedBanLists: [46, 7] }), 12);
assert.strictEqual(
  tidy(queries[1].sql),
  tidy(count.sql).replace(
    'DATEDIFF(NOW(), B.created))',
    `DATEDIFF(NOW(), B.created)) AND ${PAUSED}`
  )
);
assert.deepStrictEqual(copy(queries[1].options.replacements), replacements);
assert.strictEqual(times(queries[0].sql, PAUSED), 1);
assert.strictEqual(times(queries[1].sql, PAUSED), 1);
answer = () => [];
await findMembers(settings, configs, { excludedBanLists: [7, 46] });
assert.strictEqual(
  tidy(queries[2].sql),
  tidy(queries[1].sql).replace('COUNT(*) AS players', 'steamUser')
);
answer = () => [{ players: 3 }];
await countPlayersWithBans(2, { excludedBanLists: [46, 7] });
assert.strictEqual(times(queries[3].sql, PAUSED), 1);

// The importer's statement must be given the lists to leave out, [] for none, as an importer that
// forgot them would count the bans of paused lists. A count leaves out none unless it is given
// some, as the website's size check counts every list's bans, so the cap holds once paused lists
// count again. The lists must be positive whole IDs, each once, and are checked after the other
// arguments, before anything is asked of the database.
queries.length = 0;
assert.throws(
  () => membershipForPlayers(['76561198000000001'], { transaction }),
  typeError(/excluded ban lists are undefined/)
);
assert.strictEqual(queries.length, 0);
answer = () => [{ players: 1234 }];
await countMembers(settings, configs);
await countMembers(settings, configs, { timeLimit: 3000 });
answer = () => [];
await findMembers(settings, configs);
answer = () => [{ players: 13289 }];
await countPlayersWithBans(2);
assert.strictEqual(queries[0].sql, count.sql);
assert.strictEqual(queries[1].sql, count.sql);
assert.strictEqual(
  tidy(queries[2].sql),
  tidy(count.sql).replace('COUNT(*) AS players', 'steamUser')
);
assert.ok(queries.every(({ sql }) => !sql.includes('NOT IN')));
queries.length = 0;
for (const excludedBanLists of [null, '7', [0], [-7], [1.5], ['7'], [7, 7], [Number.NaN]])
  await assert.rejects(
    countMembers(settings, configs, { excludedBanLists }),
    typeError(/excluded ban list/),
    String(excludedBanLists)
  );
await assert.rejects(
  countMembers(settings, configs, { timeLimit: 0, excludedBanLists: [0] }),
  typeError(/time limit/)
);
assert.strictEqual(queries.length, 0);

console.log(
  "Export membership checks passed: the importer's statement unchanged, counts built from the same pieces, with every setting and config, and paused ban lists left out of each alike."
);
