// How players' reputation points are worked out from their bans, in SQL. The recalculation of the
// players queued for it (Core.updateReputationPoints) and the reputation check, which finds the
// players whose stored points no longer match their bans (see reputation-check.js), are built from
// the same pieces here, so the two always follow one rule:
// - A ban is active when it has no expiry, or its expiry is now or later. The rule goes by the
//   ban's expiry, not by the flag that marks it expired.
// - On each ban list, a player scores 3 points when any of their bans there is active, and 1 point
//   for each of their bans there that is not.
// - A player's points are what they score on all their ban lists together, and a player with no
//   bans has none.
// - Their points a month before count only their bans created more than a month ago, each active
//   or not as it was a month ago.
// - Bans on a paused ban list, suspended or resuming, count for nothing, now or a month before, so
//   pausing a list does not show as a change in players' points over the month. Each statement is
//   given the paused lists' IDs (excluded), as the run read them once (see paused-lists.js), and
//   with none it is the statement it was before lists could be paused: the constants below are
//   those statements.
// A player's bans count together, whatever game their ban lists are for, so a player has one score
// and one rank. A breakdown by game would be made here, from these same pieces.
//
// Its only import has no imports either, so this file can be loaded on its own.

import { excludedBanListsSQL } from 'scbl-lib/db/excluded-ban-lists';

// Whether a ban, B, is active at the time given, in SQL.
const isActive = (at) => `B.expires IS NULL OR B.expires >= ${at}`;

// What a player scores on one ban list at the time given, from their bans there, grouped.
const listPoints = (at) =>
  `IF(SUM(IF(${isActive(at)}, 1, 0)) > 0, 3, 0) + SUM(IF(${isActive(at)}, 0, 1))`;

// The points at the time given of each player with bans, as a table of (steamUser, points) to join
// on, counting only the bans created before createdBefore, when it is given, and leaving out the
// bans of the ban lists with the IDs in excluded. A player with no bans has no row in it, and so no
// points (see pointsOf).
function pointsByPlayer(at, createdBefore, excluded) {
  const conditions = [
    createdBefore ? `B.created < ${createdBefore}` : null,
    excludedBanListsSQL(excluded)
  ].filter(Boolean);
  return `
      SELECT PPBL.steamUser, SUM(PPBL.points) AS "points"
      FROM (
        SELECT B.steamUser, ${listPoints(at)} AS "points"
        FROM Bans B${conditions.length > 0 ? `\n        WHERE ${conditions.join(' AND ')}` : ''}
        GROUP BY B.banList, B.steamUser
      ) PPBL
      GROUP BY PPBL.steamUser
    `;
}

// A month before now, in SQL.
const MONTH_AGO = 'NOW() - INTERVAL 1 MONTH';

// Each player's points now, and a month before, leaving out the bans of the lists in excluded.
export const pointsNow = (excluded) => pointsByPlayer('NOW()', null, excluded);
export const pointsMonthBefore = (excluded) => pointsByPlayer(MONTH_AGO, MONTH_AGO, excluded);

// A player's points from their row, if any, in one of those tables joined as alias, and 0 for a
// player with no bans, who has no row there.
export const pointsOf = (alias) => `IFNULL(${alias}.points, 0)`;

// Recalculate the points of the players queued for it, whose lastRefreshedReputationPoints is
// NULL, with their points a month before and the change since then, leaving out the bans of the
// lists in excluded, and mark them recalculated now.
export const recalculatePoints = (excluded) => `
    UPDATE SteamUsers SU
    LEFT JOIN (${pointsNow(excluded)}) PPBLC ON SU.id = PPBLC.steamUser
    LEFT JOIN (${pointsMonthBefore(excluded)}) PPBLMB ON SU.id = PPBLMB.steamUser
    SET
      SU.reputationPoints = ${pointsOf('PPBLC')},
      SU.reputationPointsMonthBefore = ${pointsOf('PPBLMB')},
      SU.reputationPointsMonthChange = ${pointsOf('PPBLC')} - ${pointsOf('PPBLMB')},
      SU.lastRefreshedReputationPoints = NOW()
    WHERE SU.lastRefreshedReputationPoints IS NULL
  `;

// The players whose stored points are not what their bans give now, leaving out the bans of the
// lists in excluded, by their IDs, in order, each with their stored points (reputationPoints) and
// the points their bans give (points), of the players not queued for a recalculation already: a
// player queued already is recalculated anyway.
// A player with no bans whose points are not 0 is among them, and so is one whose points are NULL.
// Only their points now are compared, not their points a month before, which change as bans pass
// the one-month mark (see reputation-check.js). It is a plain SELECT, so it locks nothing.
export const findMismatched = (excluded) => `
    SELECT SU.id, SU.reputationPoints, ${pointsOf('P')} AS points
    FROM SteamUsers SU
    LEFT JOIN (${pointsNow(excluded)}) P ON SU.id = P.steamUser
    WHERE SU.lastRefreshedReputationPoints IS NOT NULL
      AND NOT (SU.reputationPoints <=> ${pointsOf('P')})
    ORDER BY SU.id
  `;

// The statements with no list left out, as they were before lists could be paused.
export const POINTS = pointsNow([]);
export const POINTS_MONTH_BEFORE = pointsMonthBefore([]);
export const RECALCULATE_POINTS = recalculatePoints([]);
export const FIND_MISMATCHED = findMismatched([]);
