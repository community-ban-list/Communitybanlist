import battlemetrics from './battlemetrics.js';

// A collection is read for at most this many pages, in case its links never end. The largest lists
// of bans need a few hundred.
const MAX_PAGES = 2000;

// Read every page of a BattleMetrics collection, such as a ban list's bans or invites, 100 records
// at a time, and return the records. The pages are read before anything is changed, so changes
// cannot make the paging skip records. Only links to the same collection are followed, each once,
// so a wrong link can neither send the API key elsewhere nor loop forever.
export default async function readBattlemetricsPages(endpoint, params = {}) {
  const records = [];
  const visited = new Set();
  const base = new URL(`https://api.battlemetrics.com/${endpoint}`);
  let page = new URL(base);
  for (const [name, value] of Object.entries({ ...params, 'page[size]': 100 }))
    page.searchParams.set(name, value);
  while (page) {
    if (page.origin !== base.origin || page.pathname !== base.pathname || visited.has(page.href))
      throw new Error('Invalid BattleMetrics pagination link.');
    if (visited.size >= MAX_PAGES)
      throw new Error(`BattleMetrics gave more than ${MAX_PAGES} pages for ${endpoint}.`);
    visited.add(page.href);
    const { data } = await battlemetrics('get', endpoint, Object.fromEntries(page.searchParams));
    if (!data || !Array.isArray(data.data))
      throw new Error('Invalid BattleMetrics collection response.');
    records.push(...data.data);
    const next = data.links && data.links.next;
    page = next ? new URL(typeof next === 'string' ? next : next.href, base) : null;
  }
  return records;
}
