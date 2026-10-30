import { Op } from 'scbl-lib/db/sequelize';

// The ban lists an admin has paused, whose bans count for nothing, as the request's context read
// them (see web-server/src/paused-ban-lists.js): a Set of their IDs, and none for a request without
// them. The website leaves them and their bans out of its lists of ban lists and bans, and marks
// their bans on players' pages.
export const pausedOf = (context) => context?.paused ?? new Set();

// The where of a list of bans, leaving out the bans of paused ban lists.
export function withoutPaused(where, context) {
  const paused = pausedOf(context);
  if (paused.size === 0) return where;
  return { ...where, banList: { [Op.notIn]: [...paused] } };
}
