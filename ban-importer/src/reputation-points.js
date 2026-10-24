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
// A player's bans count together, whatever game their ban lists are for, so a player has one score
// and one rank. A breakdown by game would be made here, from these same pieces.
//
// This file has no imports, so it can be loaded on its own.

// Whether a ban, B, is active at the time given, in SQL.
const isActive = (at) => `B.expires IS NULL OR B.expires >= ${at}`;

// What a player scores on one ban list at the time given, from their bans there, grouped.
const listPoints = (at) =>
  `IF(SUM(IF(${isActive(at)}, 1, 0)) > 0, 3, 0) + SUM(IF(${isActive(at)}, 0, 1))`;

// The points at the time given of each player with bans, as a table of (steamUser, points) to join
// on, counting only the bans created before createdBefore, when it is given. A player with no bans
// has no row in it, and so no points (see pointsOf).
function pointsByPlayer(at, createdBefore = null) {
  return `
      SELECT PPBL.steamUser, SUM(PPBL.points) AS "points"
      FROM (
        SELECT B.steamUser, ${listPoints(at)} AS "points"
        FROM Bans B${createdBefore ? `\n        WHERE B.created < ${createdBefore}` : ''}
        GROUP BY B.banList, B.steamUser
      ) PPBL
      GROUP BY PPBL.steamUser
    `;
}

// A month before now, in SQL.
const MONTH_AGO = 'NOW() - INTERVAL 1 MONTH';

// Each player's points now, and a month before.
export const POINTS = pointsByPlayer('NOW()');
export const POINTS_MONTH_BEFORE = pointsByPlayer(MONTH_AGO, MONTH_AGO);

// A player's points from their row, if any, in one of those tables joined as alias, and 0 for a
// player with no bans, who has no row there.
export const pointsOf = (alias) => `IFNULL(${alias}.points, 0)`;

// Recalculate the points of the players queued for it, whose lastRefreshedReputationPoints is
// NULL, with their points a month before and the change since then, and mark them recalculated
// now.
export const RECALCULATE_POINTS = `
    UPDATE SteamUsers SU
    LEFT JOIN (${POINTS}) PPBLC ON SU.id = PPBLC.steamUser
    LEFT JOIN (${POINTS_MONTH_BEFORE}) PPBLMB ON SU.id = PPBLMB.steamUser
    SET
      SU.reputationPoints = ${pointsOf('PPBLC')},
      SU.reputationPointsMonthBefore = ${pointsOf('PPBLMB')},
      SU.reputationPointsMonthChange = ${pointsOf('PPBLC')} - ${pointsOf('PPBLMB')},
      SU.lastRefreshedReputationPoints = NOW()
    WHERE SU.lastRefreshedReputationPoints IS NULL
  `;

// The players whose stored points are not what their bans give now, by their IDs, in order, each
// with their stored points (reputationPoints) and the points their bans give (points), of the
// players not queued for a recalculation already: a player queued already is recalculated anyway.
// A player with no bans whose points are not 0 is among them, and so is one whose points are NULL.
// Only their points now are compared, not their points a month before, which change as bans pass
// the one-month mark (see reputation-check.js). It is a plain SELECT, so it locks nothing.
export const FIND_MISMATCHED = `
    SELECT SU.id, SU.reputationPoints, ${pointsOf('P')} AS points
    FROM SteamUsers SU
    LEFT JOIN (${POINTS}) P ON SU.id = P.steamUser
    WHERE SU.lastRefreshedReputationPoints IS NOT NULL
      AND NOT (SU.reputationPoints <=> ${pointsOf('P')})
    ORDER BY SU.id
  `;
