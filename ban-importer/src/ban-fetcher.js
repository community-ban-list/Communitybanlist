import axios from 'axios';
import { createHash } from 'crypto';

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

// A remote list's ETag and Last-Modified are kept, to ask its host whether the file has changed,
// only when they fit the columns that keep them and are plain text.
const MAX_ETAG_LENGTH = 255;
const MAX_LAST_MODIFIED_LENGTH = 64;

const BATTLEMETRICS_BANS = new URL('https://api.battlemetrics.com/bans');
const BATTLEMETRICS_PAGE_SIZE = 100;

// A BattleMetrics list is read for at most this many pages, in case its links never end. The
// largest lists need about 120. With the count check on, a list is read for at most as many pages
// as BattleMetrics' count of its bans needs, and BATTLEMETRICS_EXTRA_PAGES more, as bans may be
// added while it is read.
const BATTLEMETRICS_MAX_PAGES = 2000;
const BATTLEMETRICS_EXTRA_PAGES = 50;

// A read of all of a BattleMetrics list is complete only if the number of different bans it read,
// with or without a SteamID, is within this many of BattleMetrics' count of the list's bans on its
// first page, plus however much that count changed by its last page.
const COUNT_TOLERANCE = 2;

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
// make a player that is never found. Spaces around the value, and the case of an address, make no
// difference.
export function findSteamIDIn(value) {
  const match = /(?<![0-9])[0-9]{17}(?![0-9])/.exec(String(value ?? ''));
  if (!match) return null;
  const steamID = BigInt(match[0]);
  return steamID >= MIN_STEAM_ID && steamID <= MAX_STEAM_ID ? match[0] : null;
}

// The SteamIDs of the player banned, from a BattleMetrics ban's steamID identifiers: each valid one
// once, in the order the ban gives them, as { steamID, manual }, where manual says whether an admin
// added it by hand rather than BattleMetrics linking it to the player. A ban without any is
// skipped.
export function findSteamIDs(identifiers) {
  const steamIDs = [];
  for (const identifier of Array.isArray(identifiers) ? identifiers : []) {
    // Ignore identifiers other than SteamIDs.
    if (!identifier || identifier.type !== 'steamID') continue;

    // The SteamID is on its own or in the profile's address, or else in the profile's details.
    const steamID =
      findSteamIDIn(identifier.identifier) ?? findSteamIDIn(identifier.metadata?.profile?.steamid);
    if (!steamID) continue;
    const manual = identifier.manual === true;
    const known = steamIDs.find((entry) => entry.steamID === steamID);
    if (known) known.manual ||= manual;
    else steamIDs.push({ steamID, manual });
  }
  return steamIDs;
}

// The player a new ban is for, of its SteamIDs: the first that an admin added by hand, as that is
// the account the admin meant, or else the first. A ban already saved keeps its player while that
// is still one of its SteamIDs (see chooseSteamUser in apply-list.js).
function firstChoice(steamIDs) {
  return (steamIDs.find(({ manual }) => manual) ?? steamIDs[0]).steamID;
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// A response header to keep, if it fits its column and is plain text, or null.
function keptHeader(response, name, maxLength) {
  const value = response?.headers?.[name];
  if (typeof value !== 'string' || value.length > maxLength || !/^[\x20-\x7e]+$/.test(value))
    return null;
  return value;
}

export default class BanFetcher {
  // countCheck turns on the check that a read of all of a BattleMetrics list read every ban
  // BattleMetrics counts on it.
  constructor({ countCheck = true } = {}) {
    this.countCheck = countCheck;
  }

  // Fetch all of a ban list, or throw if any part of it cannot be fetched, so the bans that could
  // not be read never look removed. Returns:
  // - bans: the bans, each with its SteamIDs (steamIDs) and the player a new ban is for
  //   (steamUser);
  // - rawCount: the number of records the list gave, including those without a SteamID;
  // - firstMetaTotal: BattleMetrics' count of the list's bans, or null;
  // - complete: whether the read is complete, so that the bans it did not find may be removed, and
  //   if it is not, why not (incomplete). A BattleMetrics list is read in full by following its
  //   links to the end, and with the count check on, the bans read must also match BattleMetrics'
  //   count of them (see checkCount);
  // - for a remote list, remote: its ETag and Last-Modified, if it has them, and the SHA-256 of
  //   the file, and unchanged: whether the file is the one the list was last imported from, by
  //   those of previous, the ones the list was last imported with, if given. A list whose file is
  //   unchanged is not read again, so it has no bans here.
  // A BattleMetrics list that gives no bans but counts some throws an error marked bansHidden, with
  // the count as metaTotal, whether the count check is on or not. A run that is asked to stop
  // throws RunStopped before the next request, as nothing of the list has been saved yet.
  async fetchBanList(banList, { previous = null } = {}) {
    Logger.verbose('BanFetcher', 2, `Fetching ban list (ID: ${banList.id})...`);
    let list;
    switch (banList.type) {
      case 'remote':
        list = await this.fetchRemoteBanList(banList, previous);
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

  // Fetch a remote list's file. When previous gives the ETag or Last-Modified the list was last
  // imported with, its host is asked whether the file has changed since, and an answer of 304 Not
  // Modified means it has not. A file whose SHA-256 is the one in previous has not changed either.
  async fetchRemoteBanList(banList, previous = null) {
    // Fetch ban data.
    Logger.verbose(
      'BanFetcher',
      2,
      `Fetching remote ban list data for ban list (ID: ${banList.id})...`
    );
    const headers = {};
    if (previous?.etag) headers['If-None-Match'] = previous.etag;
    if (previous?.lastModified) headers['If-Modified-Since'] = previous.lastModified;
    const conditional = Object.keys(headers).length > 0;

    let data;
    let response;
    for (let attempt = 1; ; attempt++) {
      // A run that is asked to stop does so before the next attempt.
      stopIfRequested();
      try {
        response = await axios.get(banList.source, {
          responseType: 'text',
          timeout: REMOTE_TIMEOUT,
          signal: AbortSignal.timeout(REMOTE_DEADLINE),
          maxContentLength: REMOTE_MAX_SIZE,
          maxBodyLength: REMOTE_MAX_SIZE,
          headers,
          // 304 Not Modified is an answer only to a question asked.
          validateStatus: (status) =>
            (status >= 200 && status < 300) || (conditional && status === 304)
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

    // A file that has not changed since the list was last imported is not read again. A host that
    // answers 304 Not Modified may give a new ETag or Last-Modified, and otherwise the old ones are
    // kept.
    const unchanged = {
      bans: [],
      rawCount: 0,
      firstMetaTotal: null,
      complete: true,
      unchanged: true
    };
    if (response.status === 304)
      return {
        ...unchanged,
        remote: {
          etag: keptHeader(response, 'etag', MAX_ETAG_LENGTH) ?? previous.etag ?? null,
          lastModified:
            keptHeader(response, 'last-modified', MAX_LAST_MODIFIED_LENGTH) ??
            previous.lastModified ??
            null,
          bodyHash: previous.bodyHash ?? null
        }
      };
    const remote = {
      etag: keptHeader(response, 'etag', MAX_ETAG_LENGTH),
      lastModified: keptHeader(response, 'last-modified', MAX_LAST_MODIFIED_LENGTH),
      bodyHash: sha256(data)
    };
    if (previous?.bodyHash && previous.bodyHash === remote.bodyHash)
      return { ...unchanged, remote };

    // An empty file is a list with no bans.
    if (data.trim() === '')
      return { bans: [], rawCount: 0, firstMetaTotal: null, complete: true, remote };

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

    return { bans, rawCount: bans.length, firstMetaTotal: null, complete: true, remote };
  }

  // Whether a read of all of a BattleMetrics list is complete, by the number of different bans it
  // read (scanned) and BattleMetrics' count of the list's bans on its first and last pages. With the
  // count check off, a read that reached the list's last page is complete. With it on, the number
  // read must also be within COUNT_TOLERANCE of the first count, plus however much the count
  // changed while the list was read, and a list without a count cannot be checked.
  checkCount(scanned, firstMetaTotal, lastMetaTotal) {
    if (!this.countCheck) return { complete: true };
    if (firstMetaTotal === null)
      return {
        complete: false,
        incomplete:
          "BattleMetrics gave no count of the list's bans, so it could not be checked that every ban was read"
      };
    const tolerance = Math.abs(lastMetaTotal - firstMetaTotal) + COUNT_TOLERANCE;
    if (Math.abs(scanned - firstMetaTotal) <= tolerance) return { complete: true };
    return {
      complete: false,
      incomplete: `BattleMetrics counts ${firstMetaTotal.toLocaleString('en-US')} bans on the list, but ${scanned.toLocaleString('en-US')} were read`
    };
  }

  async fetchBattlemetricsBanList(banList) {
    // Setup the initial parameters for the first fetch.
    let params = { 'filter[banList]': banList.source, 'page[size]': BATTLEMETRICS_PAGE_SIZE };
    const visited = new Set([pageAddress(params)]);
    let firstMetaTotal = null;
    let lastMetaTotal = null;
    let maxPages = BATTLEMETRICS_MAX_PAGES;
    let rawCount = 0;
    // The IDs of the bans read, with or without a SteamID, which the count check counts.
    const uids = new Set();
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

      // The list's ban count, if BattleMetrics gives one, is returned with its bans, and with the
      // count check on, it limits the pages read.
      const total = data.meta && data.meta.total;
      const count = Number.isInteger(total) && total >= 0 ? total : null;
      if (page === 1 && count !== null) {
        firstMetaTotal = count;
        if (this.countCheck)
          maxPages = Math.min(
            BATTLEMETRICS_MAX_PAGES,
            Math.ceil(count / BATTLEMETRICS_PAGE_SIZE) + BATTLEMETRICS_EXTRA_PAGES
          );
      }
      if (count !== null) lastMetaTotal = count;

      // BattleMetrics answers a list that CBL may see, but not its bans, with no bans that it still
      // counts. Such a list has not emptied, so it fails as hidden bans rather than look empty.
      if (page === 1 && data.data.length === 0 && firstMetaTotal > 0) {
        const error = new Error(
          `BattleMetrics counts ${firstMetaTotal.toLocaleString('en-US')} bans on the list but gave none of them, so CBL may no longer be allowed to see its bans.`
        );
        error.bansHidden = true;
        error.metaTotal = firstMetaTotal;
        throw error;
      }

      // Loop over each ban in the page's data.
      rawCount += data.data.length;
      for (const ban of data.data) {
        const attributes = ban && ban.attributes;
        if (!attributes || !attributes.uid)
          throw new Error('BattleMetrics returned a ban without an ID.');
        uids.add(attributes.uid);

        // Get the SteamIDs of the player banned.
        const steamIDs = findSteamIDs(attributes.identifiers);

        // Sometimes there is no SteamID in the response. If this is the case we ignore the ban.
        if (steamIDs.length === 0) continue;

        // Turn the dates into date objects or null if permanent ban.
        const created = new Date(attributes.timestamp);
        const expires = attributes.expires ? new Date(attributes.expires) : null;

        // Store the ban.
        bans.push({
          id: `${banList.id},${attributes.uid}`,

          steamUser: firstChoice(steamIDs),
          steamIDs,

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
      if (page >= maxPages)
        throw new Error(`BattleMetrics gave more than ${maxPages} pages of bans for the list.`);

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

    return {
      bans,
      rawCount,
      firstMetaTotal,
      ...this.checkCount(uids.size, firstMetaTotal, lastMetaTotal)
    };
  }
}
