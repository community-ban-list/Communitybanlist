import axios from 'axios';
import { createHash } from 'crypto';

import { battlemetrics } from 'scbl-lib/apis';
import { classifyBanReason, Logger } from 'scbl-lib/utils';

import { stopIfRequested } from './run-control.js';
import { findSteamIDIn } from './steam-id.js';

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

// BattleMetrics answers a page of bans in under a second as a rule, but can take longer than the
// BattleMetrics client's 30 seconds for a page of a large list, so each page's later attempts have
// longer: 30 seconds, then 45, and 45 again. Once the run is asked to stop, a page's request makes
// no more attempts, and stops waiting, for the budget, a pause or another attempt, within a second
// (see readNextPage), so only an attempt already sent holds the run up, for at most 45 seconds:
// well within the 60 seconds a run has to stop after its time limit before it is ended at once,
// which in once mode also has to leave the run the time to end, to save its record and send its
// log messages. A page that fails every attempt fails its list, as before.
const BATTLEMETRICS_PAGE_TIMEOUTS = [30 * 1000, 45 * 1000, 45 * 1000];

// A BattleMetrics list is read for at most this many pages, in case its links never end. The
// largest lists need about 120. With the count check on for the list, it is read for at most as
// many pages as BattleMetrics' count of its bans needs, and BATTLEMETRICS_EXTRA_PAGES more, as bans
// may be added while it is read.
const BATTLEMETRICS_MAX_PAGES = 2000;
const BATTLEMETRICS_EXTRA_PAGES = 50;

// A read of all of a BattleMetrics list is complete only if the number of different bans it read,
// with or without a SteamID, is within this many of BattleMetrics' count of the list's bans on its
// first page, plus however much that count changed by its last page.
const COUNT_TOLERANCE = 2;

// A read may also find more bans than BattleMetrics counts, by this many, or this share of the
// count if that is more (see checkCount).
const OVER_READ_BANS = 5;
const OVER_READ_SHARE = 0.005;

// Bans added or removed while a list is read change BattleMetrics' count of them on later pages,
// but by little: counts on the pages of one read that differ by more than this many, or this share
// of the first page's count if that is more, are taken to be wrong, so the read cannot be checked.
// A wrong count on the last page would otherwise widen the tolerance above to most of the list.
const COUNT_DRIFT_BANS = 10;
const COUNT_DRIFT_SHARE = 0.01;

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

// A count BattleMetrics gave, or null when it gave none, or something else.
function countOf(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

// Mark an error from reading a page of a BattleMetrics list with which page it was (page), and how
// many pages a read of all of the list takes, about, by BattleMetrics' count of its bans on its
// first page (pages), or null before that count is known, so the list's failure can say where it
// failed, e.g. on page 37 of about 93.
function atPage(err, page, count) {
  if (err && typeof err === 'object')
    Object.assign(err, {
      page,
      pages: count === null ? null : Math.max(1, Math.ceil(count / BATTLEMETRICS_PAGE_SIZE))
    });
  return err;
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
  // BattleMetrics counts on it, for every list but those whose IDs, as text, countCheckSkip has.
  // newestFirst asks BattleMetrics for each list's newest bans first, which head polls need: a
  // read's first page is then the list's newest page. Without it, lists are read in BattleMetrics'
  // own order, as before head polls. The BattleMetrics requests the fetcher makes are counted in
  // requests, by what they were for: a list's newest page (head), the pages a head poll follows
  // after it (follow), and the other pages of a read of all of a list (full).
  constructor({
    countCheck = true,
    countCheckSkip = new Set(),
    newestFirst = true,
    requests = { head: 0, follow: 0, full: 0 }
  } = {}) {
    this.countCheck = countCheck;
    this.countCheckSkip = countCheckSkip;
    this.newestFirst = newestFirst;
    this.requests = requests;
  }

  // Fetch all of a ban list, or throw if any part of it cannot be fetched, so the bans that could
  // not be read never look removed. Returns:
  // - bans: the bans, each with its SteamIDs (steamIDs) and the player a new ban is for
  //   (steamUser);
  // - rawCount: the number of records the list gave, including those without a SteamID;
  // - firstMetaTotal: BattleMetrics' count of the list's bans, or null;
  // - complete: whether the read is complete, so that the bans it did not find may be removed, and
  //   if it is not, why not (incomplete). A BattleMetrics list is read in full by following its
  //   links to the end, and with the count check on for the list, the bans read must also match
  //   BattleMetrics' count of them (see checkCount);
  // - for a remote list, remote: its ETag and Last-Modified, if it has them, and the SHA-256 of
  //   the file, and unchanged: whether the file is the one the list was last imported from, by
  //   those of previous, the ones the list was last imported with, if given. A list whose file is
  //   unchanged is not read again, so it has no bans here;
  // - for a BattleMetrics list, head: when it was read newest first, the IDs of all the bans on its
  //   first page, its newest, with or without a SteamID (uids), and BattleMetrics' count on it
  //   (total), which later head polls compare their pages with, and otherwise null.
  // A BattleMetrics list whose read a head poll began (read, see fetchBattlemetricsHead) is read on
  // from where the poll stopped, so the pages it read are not read again. A BattleMetrics list that
  // gives no bans but counts some throws an error marked bansHidden, with the count as metaTotal,
  // whether the count check is on or not. A run that is asked to stop throws RunStopped before the
  // next request, as nothing of the list has been saved yet.
  async fetchBanList(banList, { previous = null, read = null } = {}) {
    Logger.verbose('BanFetcher', 2, `Fetching ban list (ID: ${banList.id})...`);
    let list;
    switch (banList.type) {
      case 'remote':
        list = await this.fetchRemoteBanList(banList, previous);
        break;
      case 'battlemetrics':
        list = await this.fetchBattlemetricsBanList(banList, read);
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
  // read (scanned) and BattleMetrics' counts of the list's bans: on its first page (first), its
  // last (last), and the lowest and highest on any page. With the count check off (countCheck), a
  // read that reached the list's last page is complete. With it on, the counts must differ by no
  // more than COUNT_DRIFT_BANS, or COUNT_DRIFT_SHARE of the first, and then:
  // - a read that found fewer bans than the first count may be short by no more than
  //   COUNT_TOLERANCE, plus however much the count changed by the last page, as bans added or
  //   removed while the list is read explain no more. Being short by more means pages may have been
  //   skipped, and their bans would look removed;
  // - a read that found more bans than the first count may also be over by OVER_READ_BANS, or
  //   OVER_READ_SHARE of the count if that is more. Bans read are there, so a read that found more
  //   cannot be hiding any that are missing. BattleMetrics' count of one list is 3 below the bans
  //   it gives on every read, which would otherwise fail every read of it.
  // A list without a count cannot be checked.
  checkCount(scanned, { first, last, lowest, highest }, countCheck = this.countCheck) {
    if (!countCheck) return { complete: true };
    if (first === null)
      return {
        complete: false,
        incomplete:
          "BattleMetrics gave no count of the list's bans, so it could not be checked that every ban was read"
      };
    const format = (count) => count.toLocaleString('en-US');
    if (highest - lowest > Math.max(COUNT_DRIFT_BANS, Math.ceil(first * COUNT_DRIFT_SHARE))) {
      const other = highest - first >= first - lowest ? highest : lowest;
      return {
        complete: false,
        incomplete: `BattleMetrics counts ${format(first)} bans on the list's first page, but ${format(other)} on a later one, which bans added or removed while it was read cannot explain, so it could not be checked that every ban was read`
      };
    }
    const tolerance = Math.abs(last - first) + COUNT_TOLERANCE;
    const allowed =
      scanned > first
        ? tolerance + Math.max(OVER_READ_BANS, Math.ceil(first * OVER_READ_SHARE))
        : tolerance;
    if (Math.abs(scanned - first) <= allowed) return { complete: true };
    return {
      complete: false,
      incomplete: `BattleMetrics counts ${format(first)} bans on the list, but ${format(scanned)} were read`
    };
  }

  // Begin a read of a BattleMetrics list, which readBattlemetricsPage then reads a page at a time,
  // from its first page: 100 bans of the list, expired or not, the newest first with newestFirst.
  // BattleMetrics' links lead from each page to the bans after its last one, so a page read later
  // still follows on from the one before it. The read keeps the pages read, BattleMetrics' counts of
  // the list's bans, the next page to read, the pages it has been to, so it never reads one twice,
  // and how many pages it may read.
  startBattlemetricsRead(banList) {
    const params = { 'filter[banList]': banList.source };
    if (this.newestFirst) params.sort = '-timestamp';
    params['page[size]'] = BATTLEMETRICS_PAGE_SIZE;
    return {
      banList,
      // The count check is on for the list unless it is off, or off for the list.
      countCheck: this.countCheck && !this.countCheckSkip.has(String(banList.id)),
      pages: [],
      // BattleMetrics' counts of the list's bans: on its first page, its last, and the lowest and
      // highest on any page.
      counts: { first: null, last: null, lowest: null, highest: null },
      next: params,
      visited: new Set([pageAddress(params)]),
      maxPages: BATTLEMETRICS_MAX_PAGES
    };
  }

  // Read the next page of a read of a BattleMetrics list, as startBattlemetricsRead began it, with
  // one request, counted as kind: head, follow or full. Returns the page, which the read keeps too:
  // - bans: its bans that have a SteamID, each with its SteamIDs (steamIDs) and the player a new ban
  //   is for (steamUser);
  // - uids: the IDs of all its bans, with or without a SteamID, in its order;
  // - rawCount: how many bans it gave;
  // - total, active and expired: BattleMetrics' counts of the list's bans, of those still running
  //   and of those that have expired, or null for any it did not give;
  // - next: the parameters of the page after it, or null on the list's last page.
  // Throws if the page cannot be fetched, after the BattleMetrics client's own retries, is not a
  // page of bans, or links to a page the read has been to, or elsewhere, with the error marked with
  // the page's number (see atPage). A list with no bans on its first page that still counts some
  // throws as hidden bans. A run that is asked to stop throws RunStopped before the request, and
  // before any later attempt at it, marked with the page's number too, so a list stopped part-way
  // can say where it was.
  async readBattlemetricsPage(read, kind) {
    const page = read.pages.length + 1;
    // A run that is asked to stop does so between pages, as the largest lists take over a minute to
    // read.
    try {
      stopIfRequested();
    } catch (err) {
      throw atPage(err, page, read.counts.first);
    }
    if (!read.next) throw new Error('The BattleMetrics list has no more pages to read.');
    if (read.pages.length >= read.maxPages)
      throw new Error(`BattleMetrics gave more than ${read.maxPages} pages of bans for the list.`);

    try {
      return await this.readNextPage(read, kind);
    } catch (err) {
      throw atPage(err, page, read.counts.first);
    }
  }

  // Read the next page of a read, once readBattlemetricsPage has checked that it may. Its attempts
  // have BATTLEMETRICS_PAGE_TIMEOUTS, and a run that is asked to stop meanwhile makes no more of
  // them: the BattleMetrics client calls stopIfRequested before each attempt, just before it is
  // sent, and at least every second while the request waits, for its turn in the client's queue, a
  // pause, Retry-After or another attempt, and the request ends with the RunStopped it throws. So
  // only an attempt already sent can still hold the run up, by at most 45 seconds.
  async readNextPage(read, kind) {
    const { banList, counts } = read;

    // Get the ban page's data.
    Logger.verbose(
      'BanFetcher',
      2,
      `Fetching Battlemetrics ban list data for ban list (ID: ${banList.id})...`
    );
    this.requests[kind] = (this.requests[kind] ?? 0) + 1;
    const { data } = await battlemetrics('get', 'bans', read.next, undefined, 5, {
      timeouts: BATTLEMETRICS_PAGE_TIMEOUTS,
      beforeAttempt: stopIfRequested
    });
    if (!data || !Array.isArray(data.data) || !data.links)
      throw new Error('BattleMetrics returned an invalid page of bans.');

    // The list's ban count, if BattleMetrics gives one, is returned with its bans, and with the
    // count check on, it limits the pages read.
    const first = read.pages.length === 0;
    const total = countOf(data.meta && data.meta.total);
    if (first && total !== null) {
      counts.first = total;
      if (read.countCheck)
        read.maxPages = Math.min(
          BATTLEMETRICS_MAX_PAGES,
          Math.ceil(total / BATTLEMETRICS_PAGE_SIZE) + BATTLEMETRICS_EXTRA_PAGES
        );
    }
    if (total !== null)
      Object.assign(counts, {
        last: total,
        lowest: Math.min(counts.lowest ?? total, total),
        highest: Math.max(counts.highest ?? total, total)
      });

    // BattleMetrics answers a list that CBL may see, but not its bans, with no bans that it still
    // counts. Such a list has not emptied, so it fails as hidden bans rather than look empty.
    if (first && data.data.length === 0 && counts.first > 0) {
      const error = new Error(
        `BattleMetrics counts ${counts.first.toLocaleString('en-US')} bans on the list but gave none of them, so CBL may no longer be allowed to see its bans.`
      );
      error.bansHidden = true;
      error.metaTotal = counts.first;
      throw error;
    }

    const page = {
      bans: [],
      uids: [],
      rawCount: data.data.length,
      total,
      active: countOf(data.meta && data.meta.active),
      expired: countOf(data.meta && data.meta.expired),
      next: null
    };

    // Loop over each ban in the page's data.
    for (const ban of data.data) {
      const attributes = ban && ban.attributes;
      if (!attributes || !attributes.uid)
        throw new Error('BattleMetrics returned a ban without an ID.');
      page.uids.push(attributes.uid);

      // Get the SteamIDs of the player banned.
      const steamIDs = findSteamIDs(attributes.identifiers);

      // Sometimes there is no SteamID in the response. If this is the case we ignore the ban.
      if (steamIDs.length === 0) continue;

      // Turn the dates into date objects or null if permanent ban.
      const created = new Date(attributes.timestamp);
      const expires = attributes.expires ? new Date(attributes.expires) : null;

      // Store the ban.
      page.bans.push({
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

    // Store the parameters for the next page fetch, unless this is the last page. The link must
    // stay on the list's bans and must not lead back to a page already fetched.
    const next = data.links.next;
    if (next) {
      const link = new URL(typeof next === 'string' ? next : next.href, BATTLEMETRICS_BANS);
      const params = Object.fromEntries(link.searchParams);
      const address = pageAddress(params);
      if (
        link.origin !== BATTLEMETRICS_BANS.origin ||
        link.pathname !== BATTLEMETRICS_BANS.pathname ||
        read.visited.has(address)
      )
        throw new Error('Invalid BattleMetrics pagination link.');
      read.visited.add(address);
      page.next = params;
    }
    read.next = page.next;
    read.pages.push(page);
    return page;
  }

  // Read a BattleMetrics list's newest page of bans, with one request: its bans, BattleMetrics'
  // counts of the list's bans, and the link to the next page, as readBattlemetricsPage gives them.
  // Returns the read, whose first page that is, for followBattlemetrics to read on from, or for
  // fetchBanList to read the rest of the list.
  async fetchBattlemetricsHead(banList) {
    const read = this.startBattlemetricsRead(banList);
    await this.readBattlemetricsPage(read, 'head');
    return read;
  }

  // Read the page after the last one a head poll read, as a head poll that has found only new bans
  // so far does.
  followBattlemetrics(read) {
    return this.readBattlemetricsPage(read, 'follow');
  }

  // Read all of a BattleMetrics list, from its first page, or on from the last page of a read that a
  // head poll began. Every page is read by following BattleMetrics' links to the list's last page,
  // and a page that cannot be fetched fails the whole list.
  async fetchBattlemetricsBanList(banList, read = null) {
    read ??= this.startBattlemetricsRead(banList);
    while (read.next) await this.readBattlemetricsPage(read, 'full');

    // The count check counts the different bans read, with or without a SteamID.
    const uids = new Set(read.pages.flatMap((page) => page.uids));
    const [newest] = read.pages;
    return {
      bans: read.pages.flatMap((page) => page.bans),
      rawCount: read.pages.reduce((count, page) => count + page.rawCount, 0),
      firstMetaTotal: read.counts.first,
      head: this.newestFirst ? { uids: newest.uids, total: newest.total } : null,
      ...this.checkCount(uids.size, read.counts, read.countCheck)
    };
  }
}
