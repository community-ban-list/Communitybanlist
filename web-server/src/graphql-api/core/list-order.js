import graphql from 'graphql';

import { Op } from 'scbl-lib/db/sequelize';

const { GraphQLError } = graphql;

// The sort orders each list accepts, which are the ones the site's pages use, and the order a
// request gets when it does not give one. Each order sorts by the field it is named after, in the
// direction asked for, then by the fields in thenBy, and the pagination library then sorts by id so
// that no two rows tie. Orders only use fields the API shows. The library finds the rows after a
// cursor by comparing these fields with the cursor's values, and such comparisons are never true
// for NULL, so paging would skip rows with no value to sort by, or every row after one. where
// leaves those rows out.
const LISTS = {
  bans: {
    default: 'created',
    orders: {
      created: { where: { created: { [Op.ne]: null } } }
    }
  },
  steamUsers: {
    default: 'id',
    orders: {
      id: {},
      reputationRank: { where: { reputationRank: { [Op.ne]: null } } },
      // The players whose points rose this month, by how much, and by rank when that is the same.
      reputationPointsMonthChange: {
        thenBy: [['reputationRank', 'ASC']],
        where: { reputationPointsMonthChange: { [Op.gt]: 0 }, reputationRank: { [Op.ne]: null } }
      },
      // The viewed players with reputation points, so that Recently Viewed Players shows the players
      // the ban lists name. A player's points follow their bans once the importer recalculates them.
      lastViewed: { where: { lastViewed: { [Op.ne]: null }, reputationPoints: { [Op.gt]: 0 } } }
    }
  }
};

// Whether a value is a date as page cursors hold them: the string JSON gives for a Date, with a
// four-digit year, as the database cannot compare dates with longer years.
function isDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-/.test(value)) return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}

// What a page cursor holds for each field the lists sort by.
const CURSOR_VALUES = {
  id: (value) => typeof value === 'string',
  created: isDate,
  lastViewed: isDate,
  reputationRank: Number.isSafeInteger,
  reputationPointsMonthChange: Number.isSafeInteger
};

function badInput(message) {
  return new GraphQLError(message, { extensions: { code: 'BAD_USER_INPUT' } });
}

// Whether a page cursor is one the pagination library could have written for a row in a list sorted
// by these fields: base64 JSON for an array of the row's values for them. It is decoded the way the
// library decodes it, so these are the values the library would use.
function isCursorFor(fields, cursor) {
  let values;
  try {
    values = JSON.parse(Buffer.from(cursor, 'base64').toString('utf8'));
  } catch {
    return false;
  }
  return (
    Array.isArray(values) &&
    values.length === fields.length &&
    fields.every((field, index) => CURSOR_VALUES[field](values[index]))
  );
}

// The order and where to pass to paginate for a list's orderBy and orderDirection arguments. The
// list's other arguments are checked as well, so a request the list cannot answer gets an error that
// says why before any query is made.
export function listOrder(list, { orderBy, orderDirection, first, after, last, before }) {
  const { default: fallback, orders } = LISTS[list];
  const name = orderBy || fallback;
  if (!Object.hasOwn(orders, name))
    throw badInput(`orderBy must be one of: ${Object.keys(orders).join(', ')}.`);

  const { thenBy = [], where } = orders[name];
  const order = [[name, orderDirection || 'DESC'], ...thenBy];

  // The pagination library refuses these requests with errors of its own, which would be reported
  // as server errors.
  if (last != null || before != null) {
    if (first || after) throw badInput('Use first and after, or last and before, but not both.');
    if (!before) throw badInput('Use last with a before cursor.');
  }

  // The library adds id to the order, unless the list is sorted by id already, and an empty cursor
  // is no cursor to it.
  const fields = order.map(([field]) => field);
  if (!fields.includes('id')) fields.push('id');
  for (const cursor of [after, before])
    if (cursor && !isCursorFor(fields, cursor)) throw badInput('Invalid page cursor.');

  return { order, where };
}
