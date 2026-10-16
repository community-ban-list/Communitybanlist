// How many rows a page of a GraphQL list holds when a request does not say, and the most a request
// can ask for. A player's bans have a larger default, as the profile and banned pages show all of a
// player's bans at once. A default above max is also that list's largest page, so raising
// playerBans alone lets those pages show more of a player's bans.
export const PAGE_SIZE = { list: 20, playerBans: 100, max: 100 };

// The most rows a page of a list with this default can hold.
export function largestPage(fallback) {
  return Math.max(PAGE_SIZE.max, fallback);
}

// The page arguments to pass to paginate for a list's first, after, last and before arguments.
// The page holds as many rows as asked for, from 1 up to the largest page, or the list's default
// when the request does not say, so every query fetches at most one page.
export function pageArgs({ first, after, last, before }, fallback) {
  const size = (requested) => Math.min(Math.max(requested ?? fallback, 1), largestPage(fallback));

  // The page before a cursor. first and after are passed on as well, so that paginate still
  // refuses a request that mixes both directions.
  if (last != null || before != null) return { first, after, last: size(last), before };

  return { first: size(first), after };
}
