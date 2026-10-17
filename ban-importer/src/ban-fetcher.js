import axios from 'axios';

import { battlemetrics } from 'scbl-lib/apis';
import { classifyBanReason, Logger } from 'scbl-lib/utils';

import { stopIfRequested } from './run-control.js';

// Remote ban lists are downloaded with a limit on each wait, a limit on the whole download and a
// size limit, so a host that stalls, trickles or sends something huge cannot hold up the run.
const REMOTE_TIMEOUT = 30 * 1000;
const REMOTE_DEADLINE = 60 * 1000;
const REMOTE_MAX_SIZE = 20 * 1024 * 1024;
const REMOTE_ATTEMPTS = 3;
const REMOTE_RETRY_DELAY = 2000; // doubled after each failed attempt

const BATTLEMETRICS_BANS = new URL('https://api.battlemetrics.com/bans');
const BATTLEMETRICS_PAGE_SIZE = 100;

// A BattleMetrics list is read for at most this many pages, in case its links never end. The
// largest lists need about 120. BattleMetrics' count of a list's bans does not lower the limit, as
// it is not known yet whether the count includes expired bans.
const BATTLEMETRICS_MAX_PAGES = 2000;

async function doSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTooLarge(err) {
  return /maxContentLength/.test(err.message);
}

// Describe a failed download without the request, which axios includes in its errors.
function describeRemoteError(err) {
  if (err.response) return `the server answered HTTP ${err.response.status}`;
  if (err.code === 'ECONNABORTED')
    return `the server did not answer within ${REMOTE_TIMEOUT / 1000}s`;
  if (err.code === 'ERR_CANCELED') return `the download took over ${REMOTE_DEADLINE / 1000}s`;
  if (isTooLarge(err)) return `the list is over ${REMOTE_MAX_SIZE / 1024 / 1024} MB`;
  return err.message;
}

// Whether a failed download could work if it is tried again: the server could not be reached, was
// too slow or had a passing problem. Any other answer, or a list over the size limit, would fail
// again.
function isRetryableRemoteError(err) {
  if (err.response) return [408, 429].includes(err.response.status) || err.response.status >= 500;
  return !isTooLarge(err);
}

// The address of a page of bans, written the same way however a link orders or encodes its
// parameters, so that a page linked to twice is recognised.
function pageAddress(params) {
  const url = new URL(BATTLEMETRICS_BANS.href);
  for (const [name, value] of Object.entries(params)) url.searchParams.append(name, value);
  url.searchParams.sort();
  return url.href;
}

// The SteamID64s of players' Steam accounts: account numbers 1 to 4,294,967,295 in Steam's public
// universe.
const MIN_STEAM_ID = 76561197960265729n;
const MAX_STEAM_ID = 76561202255233023n;

// The SteamID64 in a value, such as a SteamID on its own or in a profile's address, or null. It is a
// run of exactly 17 digits, not part of a longer number, that is a player's account. Anything else,
// e.g. a longer number or one outside that range, is not a SteamID Steam can know, and would only
// make a player that is never found.
export function findSteamIDIn(value) {
  const match = /(?<![0-9])[0-9]{17}(?![0-9])/.exec(String(value ?? ''));
  if (!match) return null;
  const steamID = BigInt(match[0]);
  return steamID >= MIN_STEAM_ID && steamID <= MAX_STEAM_ID ? match[0] : null;
}

// Get the SteamID of the player banned from a BattleMetrics ban's identifiers. A ban without a
// valid one is skipped.
function findSteamID(identifiers) {
  for (const identifier of Array.isArray(identifiers) ? identifiers : []) {
    // Ignore identifiers other than SteamIDs.
    if (!identifier || identifier.type !== 'steamID') continue;

    // The SteamID is on its own or in the profile's address, or else in the profile's details.
    const steamUser = findSteamIDIn(identifier.identifier || identifier.metadata?.profile?.steamid);
    if (steamUser) return steamUser;
  }
  return null;
}

export default class BanFetcher {
  // Fetch all of a ban list, or throw if any part of it cannot be fetched, so the bans that could
  // not be read never look removed. Returns the bans, the number of records the list gave
  // (including those without a SteamID), and BattleMetrics' count of the list's bans, or null. A
  // run that is asked to stop throws RunStopped before the next request, as nothing of the list has
  // been saved yet.
  async fetchBanList(banList) {
    Logger.verbose('BanFetcher', 2, `Fetching ban list (ID: ${banList.id})...`);
    let list;
    switch (banList.type) {
      case 'remote':
        list = await this.fetchRemoteBanList(banList);
        break;
      case 'battlemetrics':
        list = await this.fetchBattlemetricsBanList(banList);
        break;
      default:
        throw new Error('Unsupported ban list type.');
    }

    // A ban that is listed twice, e.g. on two pages, is only kept once.
    const bans = new Map();
    for (const ban of list.bans) if (!bans.has(ban.id)) bans.set(ban.id, ban);
    return { ...list, bans: [...bans.values()] };
  }

  async fetchRemoteBanList(banList) {
    // Fetch ban data.
    Logger.verbose(
      'BanFetcher',
      2,
      `Fetching remote ban list data for ban list (ID: ${banList.id})...`
    );
    let data;
    for (let attempt = 1; ; attempt++) {
      // A run that is asked to stop does so before the next attempt.
      stopIfRequested();
      try {
        const response = await axios.get(banList.source, {
          responseType: 'text',
          timeout: REMOTE_TIMEOUT,
          signal: AbortSignal.timeout(REMOTE_DEADLINE),
          maxContentLength: REMOTE_MAX_SIZE,
          maxBodyLength: REMOTE_MAX_SIZE
        });
        // Any successful response is final, whatever it holds.
        data = String(response.data ?? '');
        break;
      } catch (err) {
        const problem = describeRemoteError(err);
        if (attempt >= REMOTE_ATTEMPTS || !isRetryableRemoteError(err)) {
          // The status tells the importer whether the list is worth fetching again later.
          const error = new Error(`Could not fetch the remote ban list: ${problem}.`);
          error.status = err.response?.status;
          throw error;
        }

        const delay = REMOTE_RETRY_DELAY * 2 ** (attempt - 1);
        Logger.verbose(
          'BanFetcher',
          2,
          `Failed to fetch remote ban list (ID: ${banList.id}): ${problem}. Retrying in ${delay / 1000}s...`
        );
        await doSleep(delay);
      }
    }

    // An empty file is a list with no bans.
    if (data.trim() === '') return { bans: [], rawCount: 0, firstMetaTotal: null };

    const bans = [];

    // Loop over each line of the ban file.
    for (const line of data.split('\n')) {
      // Split the line to get the steam user, expiry data and reason.
      const match = line.match(/(?<![0-9])([0-9]{17}):([0-9]+) ?\/\/(.+)/);

      // Skip the line if there's no match, i.e. no ban is contained on the line, or if its SteamID
      // is not a player's account.
      if (!match || !findSteamIDIn(match[1])) continue;

      let [, steamUser, expires, reason] = match;

      // Turn the expiry data into a date object or null for perm bans.
      expires = parseInt(expires);
      expires = expires ? new Date(expires * 1000) : null;
      if (expires instanceof Date && expires.getFullYear() > 9999) expires = null;
      // Store the new ban.
      bans.push({
        id: `${banList.id},${steamUser},${expires ? expires.getTime() : 'null'}`,

        steamUser,

        expires,
        expired: !(expires === null || expires.getTime() > Date.now()),

        reason: classifyBanReason(reason),
        rawReason: reason,

        banList
      });
    }

    // Anything else with no bans in it, such as an error page, is not a ban list.
    if (bans.length === 0)
      throw new Error(
        'The remote ban list has no bans in the `steamID:expiry //reason` format, so it may be an error page.'
      );

    return { bans, rawCount: bans.length, firstMetaTotal: null };
  }

  async fetchBattlemetricsBanList(banList) {
    // Setup the initial parameters for the first fetch.
    let params = { 'filter[banList]': banList.source, 'page[size]': BATTLEMETRICS_PAGE_SIZE };
    const visited = new Set([pageAddress(params)]);
    let firstMetaTotal = null;
    let rawCount = 0;
    const bans = [];

    // Loop until there's no more pages to fetch. A page that cannot be fetched, after the
    // BattleMetrics client's own retries, fails the whole list.
    for (let page = 1; ; page++) {
      // A run that is asked to stop does so between pages, as the largest lists take over a minute
      // to read.
      stopIfRequested();

      // Get the ban page's data.
      Logger.verbose(
        'BanFetcher',
        2,
        `Fetching Battlemetrics ban list data for ban list (ID: ${banList.id})...`
      );
      const { data } = await battlemetrics('get', 'bans', params);
      if (!data || !Array.isArray(data.data) || !data.links)
        throw new Error('BattleMetrics returned an invalid page of bans.');

      // The list's ban count, if BattleMetrics gives one, is returned with its bans.
      const total = data.meta && data.meta.total;
      if (page === 1 && Number.isInteger(total) && total >= 0) firstMetaTotal = total;

      // Loop over each ban in the page's data.
      rawCount += data.data.length;
      for (const ban of data.data) {
        const attributes = ban && ban.attributes;
        if (!attributes || !attributes.uid)
          throw new Error('BattleMetrics returned a ban without an ID.');

        // Get the SteamID of the player banned.
        const steamUser = findSteamID(attributes.identifiers);

        // Sometimes there is no SteamID in the response. If this is the case we ignore the ban.
        if (steamUser === null) continue;

        // Turn the dates into date objects or null if permanent ban.
        const created = new Date(attributes.timestamp);
        const expires = attributes.expires ? new Date(attributes.expires) : null;

        // Store the ban.
        bans.push({
          id: `${banList.id},${attributes.uid}`,

          steamUser,

          created,
          expires,
          expired: expires !== null && expires.getTime() <= Date.now(),

          reason: classifyBanReason(attributes.reason, attributes.note),
          rawReason: attributes.reason,
          rawNote: attributes.note,

          banList
        });
      }

      // If that is the last page then break out the loop.
      const next = data.links.next;
      if (!next) break;
      if (page >= BATTLEMETRICS_MAX_PAGES)
        throw new Error(
          `BattleMetrics gave more than ${BATTLEMETRICS_MAX_PAGES} pages of bans for the list.`
        );

      // Store the parameters for the next page fetch. The link must stay on the list's bans and
      // must not lead back to a page already fetched.
      const link = new URL(typeof next === 'string' ? next : next.href, BATTLEMETRICS_BANS);
      params = Object.fromEntries(link.searchParams);
      const address = pageAddress(params);
      if (
        link.origin !== BATTLEMETRICS_BANS.origin ||
        link.pathname !== BATTLEMETRICS_BANS.pathname ||
        visited.has(address)
      )
        throw new Error('Invalid BattleMetrics pagination link.');
      visited.add(address);
    }

    return { bans, rawCount, firstMetaTotal };
  }
}
