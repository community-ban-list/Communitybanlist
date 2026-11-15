import assert from 'assert';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

// Run the statements that decide who is on an export ban list on a real MySQL, which the other
// export membership test, with its stand-in for Sequelize, cannot: it checks their text, not what
// MySQL makes of it. This one seeds made-up bans, ban lists, export ban lists and configs, with the
// edge cases the rule has, and checks the players each statement finds against the players worked
// out by hand below. It then runs scripts/compare-export-membership.js on the same rows.
//
// It needs an empty MySQL 8.0 database, given in TEST_DATABASE_URI as
// mysql://<user>:<password>@<host>:3306/<database>, which the pull request checks start for it. It
// makes the tables there, and drops them when it ends. It refuses a database that already has
// tables, so it can never change one that holds anything. Without TEST_DATABASE_URI it does nothing
// and passes, as in the image builds, which have no database.
const TEST_DATABASE_URI = process.env.TEST_DATABASE_URI;
if (!TEST_DATABASE_URI) {
  console.log('Skipped the export membership checks on MySQL, as TEST_DATABASE_URI is not set.');
  process.exit(0);
}

// The modules read these when they load. The database is the test's own, and the API keys are
// placeholders, as the models need one to load and the test sends nothing to any API. Logging to
// Discord is off.
process.env.DATABASE_URI = TEST_DATABASE_URI;
process.env.BATTLEMETRICS_API_KEY = 'not-used-by-this-test';
process.env.STEAM_API_KEY = 'not-used-by-this-test';
delete process.env.DISCORD_LOG_WEBHOOK;

const { default: sequelize, QueryTypes } = await import('../db/sequelize.js');
const { Organisation, BanList, SteamUser, Ban, ExportBanList, ExportBanListConfig, ExportBan } =
  await import('../db/models/index.js');
const { SCORING_FIELDS, countMembers, countPlayersWithBans, findMembers, membershipForPlayers } =
  await import('../db/export-membership.js');

const select = (sql, replacements = []) =>
  sequelize.query(sql, { type: QueryTypes.SELECT, replacements });
const run = (sql, replacements = []) => sequelize.query(sql, { replacements });

// The players, by letter. Each is a SteamID64, which can be on a list: O has the lowest there is,
// and P the highest.
const PLAYERS = {
  ...Object.fromEntries(
    [...'ABCDEFGHIJKLMNQR'].map((letter, index) => [
      letter,
      `765611980000000${String(index + 1).padStart(2, '0')}`
    ])
  ),
  O: '76561197960265729',
  P: '76561202255233023'
};
// Players whose IDs are not SteamID64s, which can never be on a list however many bans they have:
// an EOS ID, the IDs just outside the SteamID64 range, 17 characters that are not all digits, 16
// digits, and 17 digits in the range followed by a line break. MySQL's regular expression takes
// that last one, as its $ also matches before a final line break, so only the length check keeps
// it off.
const NOT_EXPORTABLE = [
  '0123456789abcdef0123456789abcdef',
  '76561197960265728',
  '76561202255233024',
  '7656119800000000a',
  '7656119800000001',
  '76561198000000077\n'
];
// The owner of the export ban lists, who has no bans.
const OWNER = '76561198000000099';
const steamUsers = [...Object.values(PLAYERS), ...NOT_EXPORTABLE];

// Ban list 4 is the one paused in the checks that leave out paused ban lists.
const BAN_LISTS = [1, 2, 3, 4];
const PAUSED = 4;

// Each player's bans, as [ban list, age, expired, expiry]. The age is in UTC days, as the rule
// counts it: a ban of age 2 was created at noon two days ago. 'null' is a ban with no created
// time, 'day 30 start' one created at midnight 30 days ago, 'day 31 end' one created a second
// before that, and 'future' one created tomorrow. Expired may be NULL, which counts as not
// expired. The expiry is NULL unless it is given: 'passed', an hour ago, or 'to come', in 30 days.
//
// The rule goes by the expired flag alone, so Q's ban counts as active although its expiry has
// passed, as a ban's does until the importer marks it expired, and so does R's, whose expiry is to
// come. A rule that went by the expiry as well would take Q off lists 1, 2 and 9, and one that read
// it the wrong way round would take R off them. So a change to how expiry is decided (EXPIRED in
// export-membership.js) must change what Q and R are expected on.
const BANS = {
  A: [
    [1, 1, false],
    [1, 2, false],
    [2, 3, false]
  ],
  B: [
    [1, 5, true],
    [1, 5, true],
    [1, 5, true]
  ],
  C: [[1, 1, null]],
  D: [[2, 'null', false]],
  E: [[1, 'day 30 start', false]],
  F: [[1, 'day 31 end', false]],
  G: [[1, 'future', false]],
  H: [
    [4, 2, false],
    [1, 1, true]
  ],
  I: [[3, 400, false]],
  J: [
    [2, 10, true],
    [3, 10, true]
  ],
  K: [],
  L: [
    [1, 1, false],
    [1, 1, false]
  ],
  M: [
    [1, 1, false],
    [1, 1, true]
  ],
  N: [
    [1, 20, true],
    [2, 20, false],
    [4, 20, false]
  ],
  O: [[1, 1, false]],
  P: [[1, 1, false]],
  Q: [[1, 1, false, 'passed']],
  R: [[1, 1, false, 'to come']]
};

// When a ban of each age was created, in SQL, from the UTC day the bans are seeded on.
function createdSQL(age) {
  if (age === 'null') return 'NULL';
  if (age === 'day 30 start') return 'UTC_DATE() - INTERVAL 30 DAY';
  if (age === 'day 31 end') return 'UTC_DATE() - INTERVAL 30 DAY - INTERVAL 1 SECOND';
  if (age === 'future') return 'UTC_DATE() + INTERVAL 1 DAY + INTERVAL 1 HOUR';
  return `UTC_DATE() - INTERVAL ${Number(age)} DAY + INTERVAL 12 HOUR`;
}

// When a ban expires, in SQL, from the UTC time the bans are seeded at.
function expiresSQL(expiry) {
  if (expiry === 'passed') return 'UTC_TIMESTAMP() - INTERVAL 1 HOUR';
  if (expiry === 'to come') return 'UTC_TIMESTAMP() + INTERVAL 30 DAY';
  assert.strictEqual(expiry, undefined, `Unknown expiry ${expiry}`);
  return 'NULL';
}

// The export ban lists, each with its settings as [threshold, default active points, default
// expired points, maxBanAge], its configs as [ban list, active points, expired points], and the
// players on it: with every ban counted, and with the bans of ban list 4 left out (paused), where
// that differs. Some settings and configs are ones the website refuses now, such as negative
// points, but the columns can hold them. The players were worked out by hand from the rule in
// export-membership.js, not by running it.
const EXPORT_BAN_LISTS = [
  {
    // Any age, the default points and no configs. A ban whose expired is NULL counts as not
    // expired (C), one with no created time counts at any age (D), and each expired ban scores
    // (B). The players whose IDs are not SteamID64s are on no list.
    settings: [3, 3, 1, 0],
    configs: [],
    members: 'ABCDEFGHILMNOPQR',
    paused: 'ABCDEFGILMNOPQR'
  },
  {
    // Bans up to 30 days old: a ban created at the start of the 30th day back counts (E), one a
    // second older does not (F), nor does one with no created time (D) or one 400 days old (I). A
    // ban created tomorrow counts (G).
    settings: [3, 3, 1, 30],
    configs: [],
    members: 'ABCEGHLMNOPQR',
    paused: 'ABCEGLMNOPQR'
  },
  {
    // Active points count once for each ban list (L has two active bans on one, 3 points), and
    // expired points for each expired ban, also next to an active ban on the same list (M).
    settings: [4, 3, 1, 0],
    configs: [],
    members: 'AHMN',
    paused: 'AMN'
  },
  {
    // Configs: of several for one ban list, the largest active points count and every one's
    // expired points add up, duplicates too (ban list 1: 4 active and 3 expired points). A config
    // whose active points are NULL takes the list's default (ban list 2, which A and N need), and
    // ban list 4 has no config, so it takes the defaults (which N needs). Ban list 3's 0/0 config
    // decides no place here; list 11 has one that does, and a config with NULL expired points.
    settings: [5, 1, 0, 0],
    configs: [
      [1, 2, 1],
      [1, 2, 1],
      [1, 4, 1],
      [2, null, null],
      [3, 0, 0]
    ],
    members: 'ABMN',
    paused: 'ABM'
  },
  {
    // With no threshold, no one qualifies.
    settings: [null, 3, 1, 0],
    configs: [],
    members: ''
  },
  {
    // With no default points, a ban list without a config scores NULL, which counts as nothing next
    // to the points of other ban lists, but alone leaves the player off the list.
    settings: [1, null, null, 0],
    configs: [[2, 5, 5]],
    members: 'ADJN'
  },
  {
    // A threshold of 0, and negative points. Points can add up to less than nothing, which keeps
    // A, B and H off it.
    settings: [0, 3, 1, 0],
    configs: [[1, -5, -5]],
    members: 'DIJN',
    paused: 'DIJ'
  },
  {
    // The largest threshold and points MySQL's INT columns hold.
    settings: [2147483647, 3, 1, 0],
    configs: [[3, 2147483647, 1]],
    members: 'I'
  },
  {
    // Bans up to 1 day old: of A's bans 1, 2 and 3 days old, only the first counts.
    settings: [3, 3, 1, 1],
    configs: [],
    members: 'ACGLMOPQR'
  },
  {
    // With no maxBanAge, no ban counts.
    settings: [1, 3, 1, null],
    configs: [],
    members: ''
  },
  {
    // Configs with NULL and 0 points. Ban list 1's config has active points and NULL expired
    // points, and takes the list's default for those only: 2 active points, which keep C, E, F, G,
    // L, O, P, Q and R off it, and 3 expired points, which B and M need. Ban list 3's 0/0 config
    // scores nothing rather than the defaults, which keeps I off it.
    settings: [3, 3, 3, 0],
    configs: [
      [1, 2, null],
      [3, 0, 0]
    ],
    members: 'ABDHJMN'
  },
  {
    // An expired ban scores 0 active points, which beat negative ones. M has an active and an
    // expired ban on ban list 1, so scores 0 active points there rather than -5, and is on it with
    // the expired ban's 2 points.
    settings: [0, 3, 1, 0],
    configs: [[1, -5, 2]],
    members: 'BDHIJMN'
  },
  {
    // A maxBanAge of -1 counts only bans created on a later day than today (G), not bans of any
    // age, as 0 does.
    settings: [3, 3, 1, -1],
    configs: [],
    members: 'G'
  },
  {
    // A negative threshold, which players whose points add up to less than nothing can reach: C,
    // E, F, G, L, M, O, P, Q and R have -2 points, while B, with -6, is off it. K has no bans, so
    // is on no list whatever its threshold.
    settings: [-3, 3, 1, 0],
    configs: [[1, -2, -2]],
    members: 'ACDEFGHIJLMNOPQR'
  }
].map((list, index) => ({ id: index + 1, ...list }));

// The players with two or more bans as countPlayersWithBans counts them: one for each ban list
// with a ban that has not expired, and one for each expired ban.
const TWO_BANS = { members: 'ABHJMN', paused: 'ABJMN' };

// The players of a list as Steam IDs, in order, with the bans of paused lists left out or not.
const expected = ({ members, paused = members }, leaveOutPaused) =>
  [...(leaveOutPaused ? paused : members)].map((letter) => PLAYERS[letter]).sort();
const sorted = (steamUserIDs) => [...steamUserIDs].sort();

// The tables the test makes, in the order they are made, and dropped in the reverse order, as the
// later ones have foreign keys to the earlier ones.
const MODELS = [
  Organisation,
  BanList,
  SteamUser,
  Ban,
  ExportBanList,
  ExportBanListConfig,
  ExportBan
];

// Make the tables as the services make them (scbl-lib/db/connect.js), and add the rows.
async function seed() {
  for (const model of MODELS) await model.sync();
  // Configs made before they had to have both points can hold NULLs, as sync() does not change a
  // table it finds, and the rule gives such a config the list's defaults. So the test's table
  // takes NULLs too.
  await run(
    'ALTER TABLE ExportBanListConfigs MODIFY activePoints INT NULL, MODIFY expiredPoints INT NULL'
  );
  // The paused ban lists, which the importer's migration 004 keeps, as the comparison script reads
  // them.
  await run(`
    CREATE TABLE BanListSuspensions (
      banList INTEGER NOT NULL PRIMARY KEY,
      suspendedAt DATETIME(3) NOT NULL,
      suspendedBy VARCHAR(100) NOT NULL,
      reason VARCHAR(500) NULL,
      resumedAt DATETIME(3) NULL,
      FOREIGN KEY (banList) REFERENCES BanLists (id) ON DELETE CASCADE
    )
  `);

  await run(
    "INSERT INTO Organisations (id, name, createdAt, updatedAt) VALUES (1, 'Test organisation', NOW(), NOW())"
  );
  for (const id of BAN_LISTS)
    await run(
      'INSERT INTO BanLists (id, name, type, organisation, createdAt, updatedAt) VALUES (?, ?, ?, 1, NOW(), NOW())',
      [id, `Test ban list ${id}`, 'battlemetrics']
    );
  for (const id of [...steamUsers, OWNER])
    await run('INSERT INTO SteamUsers (id, createdAt, updatedAt) VALUES (?, NOW(), NOW())', [id]);
  for (const { id, settings } of EXPORT_BAN_LISTS)
    await run(
      `INSERT INTO ExportBanLists (id, name, owner, ${SCORING_FIELDS.join(', ')}, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [id, `Test export ban list ${id}`, OWNER, ...settings]
    );
  for (const { id, configs } of EXPORT_BAN_LISTS)
    for (const [banList, activePoints, expiredPoints] of configs)
      await run(
        `INSERT INTO ExportBanListConfigs (exportBanList, banList, activePoints, expiredPoints, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, NOW(), NOW())`,
        [id, banList, activePoints, expiredPoints]
      );
}

// Add the bans, in place of any there are. Their created and expiry times are worked out by MySQL,
// from the UTC time it is then.
async function seedBans() {
  await run('DELETE FROM Bans');
  const bans = [
    ...Object.entries(BANS).flatMap(([letter, bans]) =>
      bans.map((ban) => [PLAYERS[letter], ...ban])
    ),
    // Each player whose ID is not a SteamID64 has an active ban a day old on every ban list,
    // enough for most of the lists, so only their ID keeps them off.
    ...NOT_EXPORTABLE.flatMap((steamUser) =>
      BAN_LISTS.map((banList) => [steamUser, banList, 1, false])
    )
  ];
  let number = 0;
  for (const [steamUser, banList, age, expired, expiry] of bans)
    await run(
      `INSERT INTO Bans (id, created, expires, expired, reason, steamUser, banList, createdAt, updatedAt)
       VALUES (?, ${createdSQL(age)}, ${expiresSQL(expiry)}, ?, 'Made-up ban', ?, ?, NOW(), NOW())`,
      [`test-ban-${++number}`, expired, steamUser, banList]
    );
}

// Check every statement against the players worked out by hand, with every ban counted or with the
// bans of the paused ban list left out.
async function check(leaveOutPaused) {
  const excludedBanLists = leaveOutPaused ? [PAUSED] : [];
  const how = leaveOutPaused ? `with ban list ${PAUSED} paused` : 'with every ban list';

  // The importer's statement, run as the importer runs it: over all the players in batches, here
  // of 4, and in one batch. Each row is a new export ban.
  for (const batchSize of [4, steamUsers.length]) {
    const found = new Map(EXPORT_BAN_LISTS.map(({ id }) => [id, []]));
    for (let i = 0; i < steamUsers.length; i += batchSize) {
      const rows = await membershipForPlayers(steamUsers.slice(i, i + batchSize), {
        transaction: null,
        excludedBanLists
      });
      for (const row of rows) {
        assert.deepStrictEqual(
          { ...row },
          {
            id: `${row.steamUser},${row.exportBanList}`,
            status: 'TO_BE_CREATED',
            steamUser: row.steamUser,
            exportBanList: row.exportBanList
          }
        );
        assert.ok(found.has(row.exportBanList), `No export ban list ${row.exportBanList}`);
        found.get(row.exportBanList).push(row.steamUser);
      }
    }
    for (const list of EXPORT_BAN_LISTS)
      assert.deepStrictEqual(
        sorted(found.get(list.id)),
        expected(list, leaveOutPaused),
        `The importer's statement, in batches of ${batchSize}, for export ban list ${list.id} ${how}`
      );
  }

  // The count, and the players it counts, from each list's settings and configs as they are
  // stored.
  const stored = await select(`SELECT id, ${SCORING_FIELDS.join(', ')} FROM ExportBanLists`);
  const storedConfigs = await select(
    'SELECT exportBanList, banList, activePoints, expiredPoints FROM ExportBanListConfigs ORDER BY id'
  );
  for (const list of EXPORT_BAN_LISTS) {
    const settings = stored.find(({ id }) => id === list.id);
    const configs = storedConfigs.filter(({ exportBanList }) => exportBanList === list.id);
    assert.strictEqual(configs.length, list.configs.length);
    const players = expected(list, leaveOutPaused);
    assert.deepStrictEqual(
      sorted(await findMembers(settings, configs, { excludedBanLists })),
      players,
      `findMembers for export ban list ${list.id} ${how}`
    );
    assert.strictEqual(
      await countMembers(settings, configs, { excludedBanLists }),
      players.length,
      `countMembers for export ban list ${list.id} ${how}`
    );
  }

  assert.strictEqual(
    await countPlayersWithBans(2, { excludedBanLists }),
    expected(TWO_BANS, leaveOutPaused).length,
    `countPlayersWithBans(2) ${how}`
  );
}

// The comparison script, on the same rows, which must find that every list agrees.
const compare = () =>
  spawnSync(
    process.execPath,
    [fileURLToPath(new URL('../../scripts/compare-export-membership.js', import.meta.url))],
    {
      env: { ...process.env, DATABASE_URI: TEST_DATABASE_URI },
      encoding: 'utf8',
      timeout: 60 * 1000
    }
  );

const [{ tables }] = await select(
  'SELECT COUNT(*) AS tables FROM information_schema.tables WHERE table_schema = DATABASE()'
);
if (Number(tables) !== 0) {
  console.error(
    `The database in TEST_DATABASE_URI has ${tables} tables. The test only runs on an empty database, as it makes and drops its own.`
  );
  await sequelize.close();
  process.exit(1);
}

try {
  await seed();
  // The bans' ages are UTC days, so the checks are made on the day the bans were seeded. If the day
  // changed meanwhile, which a failed check may be down to, they are seeded and checked again.
  const today = async () => String((await select('SELECT UTC_DATE() AS day'))[0].day);
  for (let attempt = 1; ; attempt++) {
    const day = await today();
    await seedBans();
    let failure = null;
    try {
      await check(false);
      await check(true);
    } catch (err) {
      failure = err;
    }
    if ((await today()) === day) {
      if (failure) throw failure;
      break;
    }
    assert.ok(attempt < 2, 'The UTC day changed during both attempts.');
  }

  // The script reads the paused ban lists itself, so with none it counts every ban, and with ban
  // list 4 paused it leaves out its bans.
  for (const paused of [false, true]) {
    if (paused)
      await run(
        "INSERT INTO BanListSuspensions (banList, suspendedAt, suspendedBy) VALUES (?, UTC_TIMESTAMP(3), 'Test')",
        [PAUSED]
      );
    const result = compare();
    assert.strictEqual(
      result.status,
      0,
      `The comparison script failed:\n${result.stdout}${result.stderr}`
    );
    assert.match(
      result.stdout,
      new RegExp(`Compared ${EXPORT_BAN_LISTS.length} export ban lists, .*: every list agrees\\.`)
    );
    assert.strictEqual(
      result.stdout.includes(`Leaving out the bans of paused ban lists ${PAUSED}.`),
      paused
    );
  }
} finally {
  await run('DROP TABLE IF EXISTS BanListSuspensions');
  for (const model of [...MODELS].reverse()) await model.drop();
  await sequelize.close();
}

console.log(
  'Export membership checks on MySQL passed: every statement finds the players worked out by hand on every list, with and without a paused ban list, and the comparison script finds that every list agrees.'
);
