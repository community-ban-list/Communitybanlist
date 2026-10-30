// Check that the two ways of working out who is on an export ban list agree: membershipForPlayers,
// with which the importer recalculates the lists, and countMembers, which counts the players a list
// would hold from its settings and configs alone. For every export ban list in the database in
// DATABASE_URI, it works out the list's players both ways and compares how many there are and who
// they are. The importer's way runs over every Steam user, in batches of the importer's size.
//
// It only reads, outside any transaction, so it takes no locks. A change to the database while it
// runs shows as a difference, so run it while nothing writes to the database, e.g. on a copy, and
// never during an importer run. Lists with a maxBanAge count bans by UTC days, so they can also
// differ when a check runs across midnight UTC; run it again if only those differ then. The bans of
// paused ban lists are left out both ways, as the importer leaves them out, with the lists paused
// when it starts.
//
//   DATABASE_URI=mysql://<user>:<password>@<host>:3306/<database> node scripts/compare-export-membership.js
//
// It prints each list that differs, and exits with 1 if any does or the check fails.
import { readExcludedBanLists } from 'scbl-lib/db/ban-list-suspensions';
import {
  SCORING_FIELDS,
  countMembers,
  findMembers,
  membershipForPlayers
} from 'scbl-lib/db/export-membership';
import sequelize, { QueryTypes } from 'scbl-lib/db/sequelize';

// The importer's batch size, which it reads the same way (ban-importer/src/export-ban-manager.js).
const BATCH_SIZE = Number(process.env.UPDATE_EXPORT_BANS_BATCH_SIZE) || 250;

// The counts here may take longer than the web server would let them, as only what they count is
// checked.
const TIME_LIMIT = 10 * 60 * 1000;

// How many Steam IDs to show of each kind of difference.
const EXAMPLES = 3;

// The lists, configs and Steam users are read with plain statements, as the models need the
// BattleMetrics settings to load.
const select = (sql) => sequelize.query(sql, { type: QueryTypes.SELECT });

const number = (value) => value.toLocaleString('en-US');
const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;
const examples = (steamUsers) =>
  steamUsers.length > EXAMPLES
    ? `${steamUsers.slice(0, EXAMPLES).join(', ')} and ${number(steamUsers.length - EXAMPLES)} more`
    : steamUsers.join(', ');

// Compare every list, print each one that differs, and give how many do.
async function compare() {
  const started = Date.now();
  const lists = await select(
    `SELECT id, ${SCORING_FIELDS.join(', ')} FROM ExportBanLists ORDER BY id`
  );
  const configs = await select(
    'SELECT exportBanList, banList, activePoints, expiredPoints FROM ExportBanListConfigs ORDER BY id'
  );
  const steamUsers = await select('SELECT id FROM SteamUsers');
  const excludedBanLists = await readExcludedBanLists();
  if (excludedBanLists.length > 0)
    console.log(`Leaving out the bans of paused ban lists ${excludedBanLists.join(', ')}.`);

  // The importer's way: each list's players, from every batch of Steam users.
  const importerStarted = Date.now();
  const fromImporter = new Map(lists.map((list) => [list.id, new Set()]));
  let batches = 0;
  for (let i = 0; i < steamUsers.length; i += BATCH_SIZE) {
    const batch = steamUsers.slice(i, i + BATCH_SIZE).map((steamUser) => steamUser.id);
    const generated = await membershipForPlayers(batch, { transaction: null, excludedBanLists });
    for (const { steamUser, exportBanList } of generated) {
      if (!fromImporter.has(exportBanList)) fromImporter.set(exportBanList, new Set());
      fromImporter.get(exportBanList).add(steamUser);
    }
    batches++;
  }
  const importerTime = Date.now() - importerStarted;

  // The count's way, for each list with its configs as they are stored.
  let differences = 0;
  let players = 0;
  let countTime = 0;
  let slowest = null;
  for (const list of lists) {
    const listConfigs = configs.filter((config) => config.exportBanList === list.id);
    const countStarted = Date.now();
    const count = await countMembers(list, listConfigs, {
      timeLimit: TIME_LIMIT,
      excludedBanLists
    });
    const took = Date.now() - countStarted;
    players += count;
    countTime += took;
    if (!slowest || took > slowest.took) slowest = { id: list.id, took };

    const found = new Set(
      await findMembers(list, listConfigs, { timeLimit: TIME_LIMIT, excludedBanLists })
    );
    const importer = fromImporter.get(list.id);
    const onlyFound = [...found].filter((steamUser) => !importer.has(steamUser));
    const onlyImporter = [...importer].filter((steamUser) => !found.has(steamUser));
    if (count === importer.size && onlyFound.length === 0 && onlyImporter.length === 0) continue;

    differences++;
    const settings = SCORING_FIELDS.map((field) => `${field} ${list[field]}`).join(', ');
    console.log(
      `List ${list.id} (${settings}, ${number(listConfigs.length)} configs): counted ` +
        `${number(count)} players, where the importer's statement gives ${number(importer.size)}.`
    );
    if (onlyFound.length > 0) console.log(`  Found only by the count: ${examples(onlyFound)}.`);
    if (onlyImporter.length > 0)
      console.log(`  Found only by the importer's statement: ${examples(onlyImporter)}.`);
  }

  // A list the importer's statement gave players for, but that was not read, was made during the
  // check.
  const read = new Set(lists.map((list) => list.id));
  for (const [id, steamUsersOnList] of fromImporter)
    if (!read.has(id)) {
      differences++;
      console.log(
        `List ${id} was made during the check: the importer's statement gives it ` +
          `${number(steamUsersOnList.size)} players.`
      );
    }

  console.log(
    `Compared ${number(lists.length)} export ban lists, with ${number(players)} players in all, ` +
      `over ${number(steamUsers.length)} Steam users in ${number(batches)} batches of ` +
      `${BATCH_SIZE}: ${differences === 0 ? 'every list agrees' : `${number(differences)} differ`}.`
  );
  console.log(
    `The importer's statement took ${seconds(importerTime)} and the counts ${seconds(countTime)}` +
      `${slowest ? ` (the slowest ${number(slowest.took)} ms, for list ${slowest.id})` : ''}. ` +
      `The whole check took ${seconds(Date.now() - started)}.`
  );
  return differences;
}

try {
  process.exitCode = (await compare()) === 0 ? 0 : 1;
} catch (err) {
  console.error(`The check failed: ${err.name}: ${err.message}`);
  process.exitCode = 1;
} finally {
  await sequelize.close();
}
