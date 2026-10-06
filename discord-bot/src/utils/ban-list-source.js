import axios from 'axios';

import { BATTLEMETRICS_API_KEY } from 'scbl-lib/config';

import { plural } from './format.js';
import UserError from './user-error.js';

const CHECK_TIMEOUT = 30 * 1000;

// The ban format the ban importer reads from remote ban lists.
const REMOTE_BAN_REGEX = /([0-9]{17}):([0-9]+) ?\/\/(.+)/;

// Requests are made directly rather than through scbl-lib's BattleMetrics API, which retries
// failed requests for minutes, so that a wrong ban list ID is reported straight away.
const battlemetrics = axios.create({
  baseURL: 'https://api.battlemetrics.com/',
  timeout: CHECK_TIMEOUT,
  headers: { Authorization: `Bearer ${BATTLEMETRICS_API_KEY}` }
});

// Describe a failed request without the request config, as that includes the API key.
function describeRequestError(err) {
  if (err.response) return `the server responded with HTTP ${err.response.status}`;
  return err.code || err.message;
}

// Validate a ban list source for the type and normalise it to what the ban importer expects.
export function parseBanListSource(type, input) {
  const source = input.trim();

  if (type === 'remote') {
    if (!URL.canParse(source) || !['http:', 'https:'].includes(new URL(source).protocol))
      throw new UserError(
        'Remote ban list sources must be a link, e.g. `https://example.com/bans.txt`.'
      );
    return source;
  }

  if (type === 'battlemetrics') {
    if (source.includes('accept-invite'))
      throw new UserError(
        "That's a ban list invite. Accept it in BattleMetrics with the CBL organisation first, then use the ID of the ban list."
      );

    // Accept a link to the ban list as well as its ID.
    const match = source.match(/ban-lists\/([\w-]+)/);
    const id = match ? match[1] : source;
    if (!/^[\w-]+$/.test(id))
      throw new UserError(
        'BattleMetrics ban list sources must be the ID of the ban list, or a link to it.'
      );
    return id;
  }

  throw new UserError(`Unsupported ban list type "${type}".`);
}

// Fetch the ban list the way the ban importer does and describe what was found.
export async function checkBanListSource(type, source) {
  return type === 'battlemetrics' ? checkBattlemetricsSource(source) : checkRemoteSource(source);
}

async function checkRemoteSource(source) {
  let data;
  try {
    ({ data } = await axios.get(source, {
      timeout: CHECK_TIMEOUT,
      responseType: 'text',
      transformResponse: (body) => body
    }));
  } catch (err) {
    throw new UserError(`Could not fetch the ban list: ${describeRequestError(err)}.`);
  }

  const bans = String(data)
    .split('\n')
    .filter((line) => REMOTE_BAN_REGEX.test(line)).length;
  if (bans === 0)
    throw new UserError(
      'Fetched the link but found no bans in the `steamID:expiry //reason` format. Use `skip_check` if the list is meant to be empty.'
    );

  return `Found ${plural(bans, 'ban')}.`;
}

async function checkBattlemetricsSource(source) {
  let data;
  try {
    ({ data } = await battlemetrics.get('bans', {
      params: { 'filter[banList]': source, 'page[size]': 100 }
    }));
  } catch (err) {
    throw new UserError(
      `Could not fetch the BattleMetrics ban list: ${describeRequestError(
        err
      )}. Check the ID and that the CBL BattleMetrics organisation has accepted the list's invite.`
    );
  }

  if (!data || !Array.isArray(data.data) || data.data.length === 0)
    throw new UserError(
      "Found no bans on the BattleMetrics ban list. Check the ID and that the CBL BattleMetrics organisation has accepted the list's invite, or use `skip_check` if the list is meant to be empty."
    );

  // The list's name helps confirm the right list was used, but is not needed to import it.
  const banList = await battlemetrics
    .get(`ban-lists/${encodeURIComponent(source)}`)
    .catch(() => null);
  const name = banList?.data?.data?.attributes?.name;

  const bans =
    data.links && data.links.next ? `${data.data.length}+ bans` : plural(data.data.length, 'ban');
  return name ? `Found ${bans} on the BattleMetrics ban list "${name}".` : `Found ${bans}.`;
}
