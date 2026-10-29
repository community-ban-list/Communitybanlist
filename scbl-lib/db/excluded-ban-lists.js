// The piece of SQL that leaves out the bans of paused ban lists, whose bans count for nothing (see
// ban-list-suspensions.js), which every statement that counts bans for players' reputation points
// or for export ban lists is built with. The lists are given to each statement as their IDs, which
// the caller read once, e.g. once a cycle in the importer, rather than the statement joining the
// table of paused lists, so the statement takes no locks on it and works before the importer has
// made it.
//
// This file has no imports, so the files with the rules, which are loaded on their own in tests,
// can import it.

// Check the IDs of the lists to leave out: an array of positive whole numbers, each once. Throws a
// TypeError otherwise, as a statement given anything else could count every ban, or none.
export function checkExcludedBanLists(ids) {
  if (!Array.isArray(ids)) throw new TypeError('The excluded ban lists must be an array of IDs.');
  for (const id of ids)
    if (!Number.isSafeInteger(id) || id <= 0)
      throw new TypeError(`The excluded ban list ID ${String(id)} is not a positive whole number.`);
  if (new Set(ids).size !== ids.length)
    throw new TypeError('The excluded ban list IDs must each be given once.');
  return ids;
}

// The condition that leaves out the bans of the lists with these IDs, for a ban as alias, e.g.
// "B.banList NOT IN (7, 46)", or null when there are none, so that a statement with no list to
// leave out is the one it was before lists could be paused. The IDs are checked (see
// checkExcludedBanLists) and written into the condition as numbers, in order, so the statement
// takes no replacements for them.
export function excludedBanListsSQL(ids, alias = 'B') {
  checkExcludedBanLists(ids);
  if (ids.length === 0) return null;
  return `${alias}.banList NOT IN (${[...ids].sort((a, b) => a - b).join(', ')})`;
}
