import { excludedBanListsSQL } from './excluded-ban-lists.js';
import sequelize, { QueryTypes } from './sequelize.js';

// Who is on an export ban list. The importer recalculates the lists with membershipForPlayers, and
// countMembers counts the players a list would hold with given settings, before they are saved.
// Every statement here is built from the same pieces, so they always follow one rule:
// - A ban counts when it was created within the list's maxBanAge, in whole days, or at any age
//   when maxBanAge is 0. Days are UTC days, as Sequelize sets each connection's time zone to UTC.
// - For each partner ban list, a player with a counted ban there that has not expired scores the
//   list's active points once, and each counted expired ban there scores its expired points.
// - The points are those of the list's config for that ban list, or the list's defaults where it
//   has none or the config's value is NULL. With several configs for one ban list, the largest
//   active points count, and the expired points of every one are added up.
// - A player whose points from every ban list reach the list's threshold is on it.
// - The bans of paused ban lists count for nothing (see ban-list-suspensions.js). The importer's
//   statement is given their IDs (excludedBanLists), as the importer read them. A count leaves out
//   only the lists it is given, none by default, as a list's size cap must hold once paused lists
//   count again. With none to leave out, each statement is the one from before lists could be
//   paused.

// The columns of an export ban list that decide who is on it. Its configs are the only other input.
export const SCORING_FIELDS = [
  'threshold',
  'defaultActivePoints',
  'defaultExpiredPoints',
  'maxBanAge'
];

// The columns of a config that decide who is on its list.
const CONFIG_FIELDS = ['banList', 'activePoints', 'expiredPoints'];

// The rule in pieces. B is a ban, EBL the list's settings and EBLC the list's config for the ban's
// ban list, if it has one.
// Whether a ban has expired, by the flag the importer sets when it fetches the ban. NULL counts as
// not expired. Changing how expiry is decided changes only this piece.
const EXPIRED = 'B.expired';
// Whether a ban counts. One with no created time counts only when maxBanAge is 0.
const COUNTED = '(EBL.maxBanAge = 0 OR EBL.maxBanAge >= DATEDIFF(NOW(), B.created))';
// A player's points from one ban list: its active points once, if any of their bans there has not
// expired, and its expired points for each one that has.
const ACTIVE_POINTS = `MAX(IF(${EXPIRED}, 0, IFNULL(EBLC.activePoints, EBL.defaultActivePoints)))`;
const EXPIRED_POINTS = `SUM(IF(${EXPIRED}, IFNULL(EBLC.expiredPoints, EBL.defaultExpiredPoints), 0))`;
// Whether a player's points from every ban list reach the threshold.
const QUALIFIES = 'SUM(activePoints) + SUM(expiredPoints) >= MAX(threshold)';

// MySQL keeps a statement's temporary tables in memory up to this size, and moves larger ones to
// disk. A count groups the bans by player and ban list, and then by player, so its temporary tables
// grow with the number of players the bans are spread over. Spread over as many players as
// production's, they need more than MySQL's default of 16 MB, and on disk the count takes about
// four times as long.
const TEMPORARY_TABLE_SIZE = 64 * 1024 * 1024;

// The longest time limit MySQL takes, in milliseconds. It ignores a longer one with only a warning,
// and the statement then runs with none.
const MAX_TIME_LIMIT = 4294967295;

// Whether the bans of the lists with these IDs are left out, as the condition that leaves them out,
// joined on with AND, or nothing when there are none. The IDs must be given: an undefined one
// throws a TypeError, as a caller that forgot them would count the bans of paused lists.
function andNotExcluded(excludedBanLists) {
  if (excludedBanLists === undefined)
    throw new TypeError('The excluded ban lists are undefined. Give [] for none.');
  const condition = excludedBanListsSQL(excludedBanLists);
  return condition ? ` AND ${condition}` : '';
}

// The export bans that the players with these Steam IDs qualify for, on every export ban list, as
// new ExportBans rows: [{ id, status, steamUser, exportBanList }], leaving out the bans of the ban
// lists with the IDs in excludedBanLists. The caller chooses the transaction it runs in.
export function membershipForPlayers(steamUserIDs, { transaction, excludedBanLists }) {
  const notExcluded = andNotExcluded(excludedBanLists);
  return sequelize.query(
    `
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
          ${ACTIVE_POINTS} AS "activePoints",
          ${EXPIRED_POINTS} AS "expiredPoints"
        FROM Bans B
        CROSS JOIN ExportBanLists EBL
        LEFT JOIN ExportBanListConfigs EBLC ON EBL.id = EBLC.exportBanList AND B.banList = EBLC.banList
        WHERE ${COUNTED} AND B.steamUser IN (?)${notExcluded}
        GROUP BY EBL.id, B.steamUser, B.banList
      ) A
      GROUP BY exportBanList, steamUser
      HAVING ${QUALIFIES}
    `,
    {
      type: QueryTypes.SELECT,
      transaction,
      replacements: [steamUserIDs]
    }
  );
}

// The statement that finds the players a list with these settings and configs would hold, with
// its replacements, and the optimizer hints for the statement it goes in. The settings and configs
// take the place of the list's rows in ExportBanLists and ExportBanListConfigs, so the rule is the
// importer's, piece for piece. The bans of the ban lists with the IDs in excludedBanLists are left
// out.
function qualifyingPlayers(settings, configs, timeLimit, excludedBanLists) {
  // A setting left undefined means the caller did not merge in the stored values, and sending NULL
  // in its place could count fewer players than the importer will, or none. A NULL one is sent as
  // NULL, as the importer would read it.
  if (typeof settings !== 'object' || settings === null)
    throw new TypeError('The settings must be an object.');
  for (const field of SCORING_FIELDS)
    if (settings[field] === undefined) throw new TypeError(`The ${field} setting is undefined.`);
  if (!Array.isArray(configs)) throw new TypeError('The configs must be an array.');
  configs.forEach((config, index) => {
    for (const field of CONFIG_FIELDS)
      if (config?.[field] === undefined)
        throw new TypeError(`The ${field} of config ${index} is undefined.`);
  });
  // The time limit is written into the statement, as a placeholder can't go in an optimizer hint.
  if (!Number.isSafeInteger(timeLimit) || timeLimit <= 0 || timeLimit > MAX_TIME_LIMIT)
    throw new TypeError(
      `The time limit must be a whole number of milliseconds from 1 to ${MAX_TIME_LIMIT}.`
    );
  const notExcluded = andNotExcluded(excludedBanLists);

  // Each config is a row of literals, which UNION ALL keeps even when it repeats another, so
  // duplicates count as they do in the importer. MySQL reads these faster than a JSON_TABLE.
  const configRows =
    configs.length === 0
      ? 'SELECT NULL AS banList, NULL AS activePoints, NULL AS expiredPoints FROM DUAL WHERE FALSE'
      : [
          `SELECT ${CONFIG_FIELDS.map((field) => `? AS ${field}`).join(', ')}`,
          ...configs.slice(1).map(() => `SELECT ${CONFIG_FIELDS.map(() => '?').join(', ')}`)
        ].join(' UNION ALL ');

  return {
    // The temporary table size is set for this one statement only.
    hints: `/*+ SET_VAR(tmp_table_size = ${TEMPORARY_TABLE_SIZE}) SET_VAR(max_heap_table_size = ${TEMPORARY_TABLE_SIZE}) MAX_EXECUTION_TIME(${timeLimit}) */`,
    // The threshold is the same on every row. MAX is only there because ONLY_FULL_GROUP_BY, on in
    // MySQL 8's default sql_mode, refuses a column that is neither grouped nor aggregated.
    sql: `
      SELECT steamUser FROM (
        SELECT
          B.steamUser AS steamUser,
          MAX(EBL.threshold) AS threshold,
          ${ACTIVE_POINTS} AS activePoints,
          ${EXPIRED_POINTS} AS expiredPoints
        FROM Bans B
        CROSS JOIN (SELECT ${SCORING_FIELDS.map((field) => `? AS ${field}`).join(', ')}) EBL
        LEFT JOIN (${configRows}) EBLC ON B.banList = EBLC.banList
        WHERE ${COUNTED}${notExcluded}
        GROUP BY B.steamUser, B.banList
      ) A
      GROUP BY steamUser
      HAVING ${QUALIFIES}
    `,
    replacements: [
      ...SCORING_FIELDS.map((field) => settings[field]),
      ...configs.flatMap((config) => CONFIG_FIELDS.map((field) => config[field]))
    ]
  };
}

// How many players a list with these settings and configs would hold now.
// - settings holds the SCORING_FIELDS, e.g. a stored list with a change applied. An undefined one
//   throws a TypeError, and null is sent as NULL.
// - configs are the list's configs as stored, duplicates and NULLs included, with a change applied:
//   plus a new config, or minus a deleted one. A new list has none.
// - timeLimit is how long MySQL may take, in milliseconds.
// - excludedBanLists are the IDs of the ban lists whose bans are left out, none by default: the
//   website's size check counts paused lists' bans too, so a list cannot be given more points while
//   a large list is paused and go over its cap when that list counts again, as the importer never
//   refuses players for the cap. The importer's own count leaves them out.
// - transaction, if given, is a REPEATABLE READ transaction to count in, on the connection it
//   holds, whichever pool that is from, so counts in it all read the same snapshot of the bans.
// The count is one statement, outside any transaction unless one is given, so it reads a
// consistent snapshot and takes no locks: in the importer's SERIALIZABLE transaction it would lock
// every ban it reads. Errors, such as MySQL's ER_QUERY_TIMEOUT when the time limit is reached, are
// passed on as Sequelize gives them.
export async function countMembers(
  settings,
  configs,
  { timeLimit = 3000, excludedBanLists = [], transaction } = {}
) {
  const { hints, sql, replacements } = qualifyingPlayers(
    settings,
    configs,
    timeLimit,
    excludedBanLists
  );
  const [{ players }] = await sequelize.query(
    `SELECT ${hints} COUNT(*) AS players FROM (${sql}) Q`,
    {
      type: QueryTypes.SELECT,
      replacements,
      ...(transaction && { transaction })
    }
  );
  return Number(players);
}

// The Steam IDs of the players countMembers counts, as it would count them.
export async function findMembers(
  settings,
  configs,
  { timeLimit = 3000, excludedBanLists = [] } = {}
) {
  const { hints, sql, replacements } = qualifyingPlayers(
    settings,
    configs,
    timeLimit,
    excludedBanLists
  );
  const rows = await sequelize.query(`SELECT ${hints} steamUser FROM (${sql}) Q`, {
    type: QueryTypes.SELECT,
    replacements
  });
  return rows.map((row) => row.steamUser);
}

// How many players have at least this many counted bans of any age, counted as the rule counts
// them: one for each ban list with a ban that has not expired, and one for each expired ban. It is
// countMembers with 1 point for each, the number of bans as the threshold, any age and no configs.
// A list whose threshold is above the most points that one of these can give holds only players
// with two or more, so never more than countPlayersWithBans(2).
export function countPlayersWithBans(bans, options) {
  return countMembers(
    { threshold: bans, defaultActivePoints: 1, defaultExpiredPoints: 1, maxBanAge: 0 },
    [],
    options
  );
}
