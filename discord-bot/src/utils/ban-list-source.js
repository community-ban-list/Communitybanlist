import axios from 'axios';

import { BATTLEMETRICS_API_KEY } from 'scbl-lib/config';
import { ExportBanList } from 'scbl-lib/db/models';
import { parseRemoteFile } from 'scbl-lib/player-ids';
import { isSameBattlemetricsID } from 'scbl-lib/utils';

import { plural } from './format.js';
import UserError from './user-error.js';

const CHECK_TIMEOUT = 30 * 1000;

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

  // The file is read by the ban importer's own rule. A blank file is a list with no bans, which may
  // be meant, so skip_check saves it. Any other file with no bans, such as an error page, or one of
  // EOS IDs only, the importer would fail on every cycle, so the check says why in its words, and
  // does not suggest skip_check.
  const { bans, problem } = parseRemoteFile(data);
  if (problem)
    throw new UserError(
      `Fetched the link, but the ban importer would fail to import it: ${problem}`
    );
  if (bans.length === 0)
    throw new UserError(
      'Fetched the link, but the file is empty. Use `skip_check` if the list is meant to be empty.'
    );

  return `Found ${plural(bans.length, 'ban')}.`;
}

// The list's expired bans count too, as the importer reads them. BattleMetrics' API documentation
// says that GET /bans hides expired bans unless filter[expired] is true, although without the
// filter it gives them too, so the filter is sent, and a list whose bans have all expired is not
// taken for an empty one.
async function checkBattlemetricsSource(source) {
  let data;
  try {
    ({ data } = await battlemetrics.get('bans', {
      params: { 'filter[banList]': source, 'filter[expired]': 'true', 'page[size]': 100 }
    }));
  } catch (err) {
    throw new UserError(
      `Could not fetch the BattleMetrics ban list: ${describeRequestError(
        err
      )}. Check the ID and that the CBL BattleMetrics organisation has accepted the list's invite.`
    );
  }

  // BattleMetrics answers a list that CBL may see, but not its bans, with no bans that it still
  // counts. The ban importer fails such a list as one CBL cannot read, as it has not emptied, so it
  // is refused in the importer's words, without suggesting skip_check. A list that counts no bans,
  // or gives no count, is empty, as the importer takes it.
  const bans = Array.isArray(data?.data) ? data.data : [];
  const total = data?.meta?.total;
  if (bans.length === 0 && Number.isInteger(total) && total > 0)
    throw new UserError(
      `BattleMetrics counts ${plural(total, 'ban')} on the list but gave none of them, so CBL may not be allowed to see its bans, and the ban importer would fail to import it.`
    );
  if (bans.length === 0)
    throw new UserError(
      "Found no bans on the BattleMetrics ban list. Check the ID and that the CBL BattleMetrics organisation has accepted the list's invite, or use `skip_check` if the list is meant to be empty."
    );

  // The list's name helps confirm the right list was used, but is not needed to import it.
  const banList = await battlemetrics
    .get(`ban-lists/${encodeURIComponent(source)}`)
    .catch(() => null);
  const name = banList?.data?.data?.attributes?.name;

  const count = data.links && data.links.next ? `${bans.length}+ bans` : plural(bans.length, 'ban');
  const found = name
    ? `Found ${count} on the BattleMetrics ban list "${name}".`
    : `Found ${count}.`;
  if ((await isListedForCBL(source)) !== false) return found;
  return `${found} **BattleMetrics does not list it among the ban lists the CBL organisation can see**, so its new bans are saved, but none are removed while BattleMetrics does not list it.`;
}

// Whether BattleMetrics lists the source among the ban lists the CBL organisation can see, as the
// ban importer's access check asks: true or false, or null when BattleMetrics could not be asked.
// The importer saves the new bans of a list that BattleMetrics does not list, but removes none of
// them, so the check warns of that, without refusing the list, and a list that could not be
// checked is saved without a word, as the importer goes without its check then too. The IDs are
// those /exportbanlist reads, compared ignoring case, hyphens and spaces, as the importer compares
// them. The request goes through scbl-lib's BattleMetrics API, as /exportbanlist's does, once the
// list's bans were read.
async function isListedForCBL(source) {
  try {
    const visible = await ExportBanList.findVisibleBattlemetricsBanLists();
    return [...visible].some((id) => isSameBattlemetricsID(id, source));
  } catch {
    return null;
  }
}
