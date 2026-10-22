import assert from 'assert';
import { createHash } from 'crypto';
import { readFile } from 'fs/promises';
import vm from 'vm';

import classifyBanReason from '../../scbl-lib/utils/classify-ban-reason.js';

// Exercise BanFetcher without network requests. Remote lists and BattleMetrics answer from the
// stand-ins below, and the waits between attempts are skipped but recorded. The run is never asked
// to stop here; stop-points.js checks where the fetcher stops.
const delays = [];
const remoteRequests = [];
const battlemetricsRequests = [];
let remote;
let battlemetrics;

// A remote list's host answers with what remote() returns, as axios would: an answer whose status
// the request does not take fails, with the answer.
const dependencies = {
  axios: {
    default: {
      async get(url, options) {
        remoteRequests.push({ url, options });
        const response = await remote();
        if (!options.validateStatus(response.status))
          throw Object.assign(new Error(`Request failed with status code ${response.status}`), {
            response
          });
        return response;
      }
    }
  },
  crypto: { createHash },
  'scbl-lib/apis': {
    async battlemetrics(method, endpoint, params) {
      battlemetricsRequests.push({ method, endpoint, params });
      return { data: battlemetrics(params) };
    }
  },
  'scbl-lib/utils': { classifyBanReason, Logger: { verbose() {} } },
  './run-control.js': { stopIfRequested() {} }
};

const context = vm.createContext({
  URL,
  AbortSignal,
  setTimeout: (callback, ms) => {
    delays.push(ms);
    setImmediate(callback);
  }
});
const load = async (path) =>
  new vm.SourceTextModule(await readFile(new URL(path, import.meta.url), 'utf8'), { context });
const module = await load('../src/ban-fetcher.js');
// The fetcher finds SteamIDs with the real steam-id.js.
const steamIDModule = await load('../src/steam-id.js');
await module.link((specifier) => {
  if (specifier === './steam-id.js') return steamIDModule;
  const exports = dependencies[specifier];
  assert.ok(exports, `Unexpected dependency: ${specifier}`);
  return new vm.SyntheticModule(
    Object.keys(exports),
    function () {
      for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
    },
    { context }
  );
});
await module.evaluate();
const BanFetcher = module.namespace.default;
const { findSteamIDs } = module.namespace;
// The count check is on unless it is turned off.
const fetcher = new BanFetcher();
const uncounted = new BanFetcher({ countCheck: false });
assert.deepStrictEqual([fetcher.countCheck, uncounted.countCheck], [true, false]);

const reset = () => {
  delays.length = 0;
  remoteRequests.length = 0;
  battlemetricsRequests.length = 0;
};
const ids = (bans) => Array.from(bans, (ban) => ban.id);
const httpError = (status) =>
  Object.assign(new Error(`Request failed with status code ${status}`), { response: { status } });
const networkError = (code, message = code) => Object.assign(new Error(message), { code });

// Remote lists.
const remoteList = { id: 7, type: 'remote', source: 'https://bans.example/bans.txt' };
const answers = (...replies) => {
  remote = () => {
    const reply = replies.shift();
    if (reply instanceof Error) throw reply;
    if (reply && typeof reply === 'object') return reply;
    return { status: 200, data: reply, headers: {} };
  };
};

// A remote list is read as text, with time and size limits, and each ban line becomes a ban. A ban
// listed twice is kept once.
reset();
answers(
  [
    '76561198000000001:0 //Cheating',
    '76561198000000002:4102444800 //Teamkilling',
    '76561198000000003:946684800 //An old ban',
    'Not a ban',
    '76561198000000001:0 //Listed again'
  ].join('\n')
);
let list = await fetcher.fetchBanList(remoteList);
assert.strictEqual(remoteRequests.length, 1);
const { url, options } = remoteRequests[0];
assert.strictEqual(url, remoteList.source);
assert.strictEqual(options.responseType, 'text');
assert.strictEqual(options.timeout, 30 * 1000);
assert.ok(options.signal instanceof AbortSignal);
assert.strictEqual(options.maxContentLength, 20 * 1024 * 1024);
assert.strictEqual(options.maxBodyLength, 20 * 1024 * 1024);
assert.deepStrictEqual(ids(list.bans), [
  '7,76561198000000001,null',
  '7,76561198000000002,4102444800000',
  '7,76561198000000003,946684800000'
]);
assert.deepStrictEqual(
  Array.from(list.bans, (ban) => [ban.rawReason, ban.expired]),
  [
    ['Cheating', false],
    ['Teamkilling', false],
    ['An old ban', true]
  ]
);
assert.strictEqual(list.rawCount, 4);
assert.strictEqual(list.firstMetaTotal, null);

// An empty or blank file is a list with no bans, fetched once.
for (const body of ['', ' \r\n\n', '﻿', undefined]) {
  reset();
  answers(body);
  list = await fetcher.fetchBanList(remoteList);
  assert.strictEqual(list.bans.length, 0);
  assert.strictEqual(list.rawCount, 0);
  assert.strictEqual(remoteRequests.length, 1, `Requests for ${JSON.stringify(body)}`);
}

// Anything else without a ban, such as an error page or JSON, is a failed fetch, not an empty list.
for (const body of ['<!DOCTYPE html><html><body>Sign in</body></html>', 'null', '{"bans":[]}']) {
  reset();
  answers(body);
  await assert.rejects(fetcher.fetchBanList(remoteList), /no bans in the `steamID:expiry/);
  assert.strictEqual(remoteRequests.length, 1);
}

// Passing problems are tried 3 times in all, waiting longer each time.
reset();
answers(httpError(503), networkError('ECONNRESET'), '76561198000000001:0 //Cheating');
list = await fetcher.fetchBanList(remoteList);
assert.deepStrictEqual(ids(list.bans), ['7,76561198000000001,null']);
assert.strictEqual(remoteRequests.length, 3);
assert.deepStrictEqual(delays, [2000, 4000]);

// The error of a list that could not be fetched carries the server's last status, if it answered,
// so the importer can tell a list it refused from a passing problem.
reset();
answers(
  networkError('ECONNABORTED', 'timeout of 30000ms exceeded'),
  networkError('ERR_CANCELED', 'canceled'),
  httpError(429)
);
await assert.rejects(fetcher.fetchBanList(remoteList), (err) => {
  assert.strictEqual(
    err.message,
    'Could not fetch the remote ban list: the server answered HTTP 429.'
  );
  assert.strictEqual(err.status, 429);
  return true;
});
assert.strictEqual(remoteRequests.length, 3);

reset();
answers(networkError('ERR_CANCELED', 'canceled'), networkError('ERR_CANCELED'), httpError(500));
await assert.rejects(fetcher.fetchBanList(remoteList), /HTTP 500/);

reset();
answers(networkError('ECONNRESET'), networkError('ECONNRESET'), networkError('ECONNREFUSED'));
await assert.rejects(fetcher.fetchBanList(remoteList), (err) => {
  assert.match(err.message, /ECONNREFUSED\.$/);
  assert.strictEqual(err.status, undefined);
  return true;
});

// Other answers, and lists over the size limit, fail at once.
for (const [error, message, status] of [
  [httpError(404), /the server answered HTTP 404\.$/, 404],
  [httpError(403), /the server answered HTTP 403\.$/, 403],
  [
    networkError('ERR_BAD_RESPONSE', 'maxContentLength size of 20971520 exceeded'),
    /the list is over 20 MB\.$/,
    undefined
  ]
]) {
  reset();
  answers(error);
  await assert.rejects(fetcher.fetchBanList(remoteList), (err) => {
    assert.match(err.message, message);
    assert.strictEqual(err.status, status);
    return true;
  });
  assert.strictEqual(remoteRequests.length, 1);
}

// BattleMetrics lists.
const banList = { id: 3, type: 'battlemetrics', source: 'bm-list' };
const steamID = (n) => `7656119800000${String(n).padStart(4, '0')}`;
const ban = (uid, identifiers, attributes = {}) => ({
  type: 'ban',
  id: `id-${uid}`,
  attributes: {
    uid,
    timestamp: '2026-01-01T00:00:00.000Z',
    expires: null,
    reason: 'Cheating',
    note: null,
    identifiers,
    ...attributes
  }
});
const steam = (n) => [{ type: 'steamID', identifier: steamID(n) }];
const link = (key) =>
  `https://api.battlemetrics.com/bans?filter%5BbanList%5D=bm-list&page%5Bkey%5D=${key}&page%5Bsize%5D=100`;
const book = (pages) => {
  battlemetrics = (params) => {
    const page = pages[params['page[key]'] ?? 'first'];
    if (page instanceof Error) throw page;
    return typeof page === 'function' ? page(params) : page;
  };
};

// Every page is read by following BattleMetrics' links, from the same first request as before.
// Bans without a SteamID are skipped but counted, as is a ban listed twice.
reset();
book({
  first: {
    meta: { active: 4, expired: 2, total: 6 },
    data: [
      ban('a', steam(1)),
      ban('b', [
        { type: 'steamID', identifier: `https://steamcommunity.com/profiles/${steamID(2)}` }
      ])
    ],
    links: { next: link('two') }
  },
  two: {
    data: [
      ban('c', [{ type: 'eosID', identifier: 'abc' }]),
      ban('d', [
        { type: 'steamID', metadata: {} },
        { type: 'steamID', metadata: { profile: { steamid: steamID(4) } } }
      ]),
      ban('a', steam(1))
    ],
    links: { next: { href: link('three') } }
  },
  three: {
    data: [ban('e', steam(5), { expires: '2000-01-01T00:00:00.000Z', note: 'Appeal denied' })],
    links: { next: null }
  }
});
list = await fetcher.fetchBanList(banList);
assert.deepStrictEqual(ids(list.bans), ['3,a', '3,b', '3,d', '3,e']);
assert.deepStrictEqual(
  Array.from(list.bans, (ban) => [ban.steamUser, ban.expired, ban.rawNote]),
  [
    [steamID(1), false, null],
    [steamID(2), false, null],
    [steamID(4), false, null],
    [steamID(5), true, 'Appeal denied']
  ]
);
assert.strictEqual(list.rawCount, 6);
assert.strictEqual(list.firstMetaTotal, 6);
assert.deepStrictEqual(
  battlemetricsRequests.map(({ method, endpoint, params }) => [method, endpoint, { ...params }]),
  [
    ['get', 'bans', { 'filter[banList]': 'bm-list', 'page[size]': 100 }],
    ['get', 'bans', { 'filter[banList]': 'bm-list', 'page[key]': 'two', 'page[size]': '100' }],
    ['get', 'bans', { 'filter[banList]': 'bm-list', 'page[key]': 'three', 'page[size]': '100' }]
  ]
);

// A page that cannot be fetched, after the BattleMetrics client's own retries, fails the whole
// list instead of returning the pages before it. So does a page that is not a list of bans.
for (const page of [
  httpError(500),
  { errors: [{ title: 'Unknown error' }] },
  { data: null, links: {} },
  { data: [ban('x', steam(9))] },
  { data: [{ type: 'ban' }], links: {} }
]) {
  reset();
  book({ first: { data: [ban('a', steam(1))], links: { next: link('two') } }, two: page });
  await assert.rejects(
    fetcher.fetchBanList(banList),
    /status code 500|invalid page of bans|ban without an ID/
  );
  assert.strictEqual(battlemetricsRequests.length, 2);
}

// Links that lead back to a page already fetched, however they are written, are refused.
reset();
book({
  first: {
    data: [ban('a', steam(1))],
    links: { next: 'https://api.battlemetrics.com/bans?page[size]=100&filter[banList]=bm-list' }
  }
});
await assert.rejects(fetcher.fetchBanList(banList), /Invalid BattleMetrics pagination link/);
assert.strictEqual(battlemetricsRequests.length, 1);

reset();
book({
  first: { data: [ban('a', steam(1))], links: { next: link('two') } },
  two: { data: [ban('b', steam(2))], links: { next: link('three') } },
  three: { data: [ban('c', steam(3))], links: { next: link('two') } }
});
await assert.rejects(fetcher.fetchBanList(banList), /Invalid BattleMetrics pagination link/);
assert.strictEqual(battlemetricsRequests.length, 3);

// So are links to another host, scheme or endpoint, while a relative link to the next page works.
for (const next of [
  'https://evil.example/bans?page[key]=two',
  'http://api.battlemetrics.com/bans?page[key]=two',
  'https://api.battlemetrics.com/players?page[key]=two',
  'https://api.battlemetrics.com:8443/bans?page[key]=two'
]) {
  reset();
  book({ first: { data: [ban('a', steam(1))], links: { next } } });
  await assert.rejects(fetcher.fetchBanList(banList), /Invalid BattleMetrics pagination link/);
  assert.strictEqual(battlemetricsRequests.length, 1, next);
}
reset();
book({
  first: {
    data: [ban('a', steam(1))],
    links: { next: '/bans?filter[banList]=bm-list&page[key]=two' }
  },
  two: { data: [ban('b', steam(2))], links: {} }
});
assert.deepStrictEqual(ids((await fetcher.fetchBanList(banList)).bans), ['3,a', '3,b']);

// BattleMetrics' count of the list's bans is returned. With the count check off, it does not limit
// the pages read: a list with many more bans than its count is still read in full, and is complete
// once its last page is read. With the check on, a list is read for at most as many pages as its
// count needs, and 50 more.
const pagesOf = (count, meta) =>
  Object.fromEntries(
    Array.from({ length: count }, (_, page) => [
      page === 0 ? 'first' : `page${page}`,
      {
        meta: page === 0 ? meta : undefined,
        data: [ban(`v${page}`, steam(page))],
        links: { next: page < count - 1 ? link(`page${page + 1}`) : null }
      }
    ])
  );
reset();
book(pagesOf(120, { active: 1, total: 1 }));
list = await uncounted.fetchBanList(banList);
assert.strictEqual(list.bans.length, 120);
assert.deepStrictEqual(ids(list.bans).slice(-2), ['3,v118', '3,v119']);
assert.deepStrictEqual([list.firstMetaTotal, list.complete], [1, true]);
assert.strictEqual(battlemetricsRequests.length, 120);
reset();
book(pagesOf(120, { active: 1, total: 1 }));
await assert.rejects(fetcher.fetchBanList(banList), /more than 51 pages of bans/);
assert.strictEqual(battlemetricsRequests.length, 51);
reset();
book(pagesOf(120, { total: 7000 }));
list = await fetcher.fetchBanList(banList);
assert.deepStrictEqual([list.bans.length, list.complete], [120, false]);

// A list whose first page has no bans, but whose count says it has some, is not an empty list:
// BattleMetrics answers so for a list CBL may see but not its bans. Its fetch fails as hidden bans,
// with the count. A list with no bans that counts none, or gives no count, is empty, and a later
// page without bans is read past as before.
reset();
book({ first: { meta: { active: 4376, expired: 7392, total: 11768 }, data: [], links: {} } });
await assert.rejects(fetcher.fetchBanList(banList), (err) => {
  assert.strictEqual(
    err.message,
    'BattleMetrics counts 11,768 bans on the list but gave none of them, so CBL may no longer be allowed to see its bans.'
  );
  assert.strictEqual(err.bansHidden, true);
  assert.strictEqual(err.metaTotal, 11768);
  return true;
});
assert.strictEqual(battlemetricsRequests.length, 1);
for (const meta of [{ total: 0 }, undefined, { total: 'many' }]) {
  reset();
  book({ first: { meta, data: [], links: { next: null } } });
  list = await fetcher.fetchBanList(banList);
  assert.deepStrictEqual(
    [list.bans.length, list.rawCount, list.firstMetaTotal],
    [0, 0, meta?.total === 0 ? 0 : null],
    JSON.stringify(meta)
  );
}
reset();
book({
  first: { meta: { total: 2 }, data: [ban('a', steam(1))], links: { next: link('two') } },
  two: { data: [], links: { next: link('three') } },
  three: { data: [ban('b', steam(2))], links: {} }
});
assert.deepStrictEqual(ids((await fetcher.fetchBanList(banList)).bans), ['3,a', '3,b']);

// Links that never end stop at 2,000 pages, whatever the list's ban count when the count check is
// off, or when the list has no count, and at the pages its count needs and 50 more with it on.
let pageNumber = 0;
const endless = (meta) => () => ({
  meta,
  data: [ban(`u${++pageNumber}`, steam(1))],
  links: { next: link(`page${pageNumber}`) }
});
for (const [reader, meta, pages] of [
  [uncounted, { total: 150 }, 2000],
  [uncounted, undefined, 2000],
  [fetcher, undefined, 2000],
  [fetcher, { total: 150 }, 52],
  [fetcher, { total: 1000000 }, 2000]
]) {
  reset();
  book(new Proxy({}, { get: endless(meta) }));
  await assert.rejects(reader.fetchBanList(banList), new RegExp(`more than ${pages} pages`));
  assert.strictEqual(battlemetricsRequests.length, pages);
}

await assert.rejects(
  fetcher.fetchBanList({ id: 9, type: 'unknown', source: 'x' }),
  /Unsupported ban list type/
);

// Only a player's SteamID64 is taken from a ban: exactly 17 digits, not part of a longer number,
// on its own or in a profile's address, and in the range of players' accounts. A ban with anything
// else is skipped, as one without a SteamID is, rather than making a player Steam never knows.
reset();
const steamIDs = (...values) => values.map((identifier) => ({ type: 'steamID', identifier }));
book({
  first: {
    data: [
      ban('f', steamIDs(`https://steamcommunity.com/profiles/${steamID(6)}/`)),
      ban('g', steamIDs(`http://steamcommunity.com/profiles/${steamID(7)}`)),
      ban('h', steamIDs(` ${steamID(8)} `)),
      ban('i', steamIDs(`${steamID(9)}1`)),
      ban('j', steamIDs(steamID(10).slice(1))),
      ban('k', steamIDs('76561197960265728')),
      ban('l', steamIDs('76561202255233024')),
      ban('m', steamIDs('12345678901234567')),
      ban('n', steamIDs('76561197960265729')),
      ban('o', steamIDs('76561202255233023')),
      ban('p', steamIDs('1', steamID(11)))
    ],
    links: { next: null }
  }
});
list = await fetcher.fetchBanList(banList);
assert.deepStrictEqual(
  Array.from(list.bans, (ban) => [ban.id, ban.steamUser]),
  [
    ['3,f', steamID(6)],
    ['3,g', steamID(7)],
    ['3,h', steamID(8)],
    ['3,n', '76561197960265729'],
    ['3,o', '76561202255233023'],
    ['3,p', steamID(11)]
  ]
);
assert.strictEqual(list.rawCount, 11);

// The same goes for a remote list's lines: one whose SteamID is part of a longer number, or is not a
// player's account, is skipped like a line with no ban on it.
reset();
answers(
  [
    '76561198000000001:0 //Cheating',
    '176561198000000002:0 //Eighteen digits',
    '76561197960265728:0 //Not an account',
    '12345678901234567:0 //Not Steam',
    ' 76561198000000003:0 //After a space'
  ].join('\n')
);
list = await fetcher.fetchBanList(remoteList);
assert.deepStrictEqual(ids(list.bans), ['7,76561198000000001,null', '7,76561198000000003,null']);

// Every valid SteamID of a ban is kept, in the order the ban gives them, each once, with whether an
// admin added it by hand: on its own, with spaces around it, in a profile's address in any case,
// or else in the profile's details. Identifiers of other kinds are left out.
const plain = (value) => JSON.parse(JSON.stringify(value));
assert.deepStrictEqual(
  plain(
    findSteamIDs([
      { type: 'steamID', identifier: ` ${steamID(1)} `, manual: true },
      { type: 'eosID', identifier: steamID(9), manual: true },
      { type: 'steamID', identifier: `HTTPS://STEAMCOMMUNITY.COM/PROFILES/${steamID(2)}/` },
      {
        type: 'steamID',
        identifier: `https://steamcommunity.com/id/someone`,
        metadata: { profile: { steamid: steamID(3) } }
      },
      { type: 'steamID', identifier: steamID(1) },
      { type: 'steamID', identifier: steamID(2), manual: true },
      { type: 'steamID', identifier: '1234' },
      null,
      { type: 'steamID', metadata: {} }
    ])
  ),
  [
    { steamID: steamID(1), manual: true },
    { steamID: steamID(2), manual: true },
    { steamID: steamID(3), manual: false }
  ]
);
assert.deepStrictEqual(plain(findSteamIDs(undefined)), []);
assert.deepStrictEqual(plain(findSteamIDs('76561198000000001')), []);

// A ban gives all its SteamIDs, and is for the first that an admin added by hand, or else the
// first.
reset();
book({
  first: {
    meta: { total: 3 },
    data: [
      ban('q', [
        { type: 'steamID', identifier: steamID(1) },
        { type: 'steamID', identifier: steamID(2), manual: true },
        { type: 'steamID', identifier: steamID(3), manual: true }
      ]),
      ban('r', [
        { type: 'steamID', identifier: steamID(4), manual: false },
        { type: 'steamID', identifier: steamID(5) }
      ]),
      ban('s', [{ type: 'steamID', identifier: steamID(6), manual: true }])
    ],
    links: {}
  }
});
list = await fetcher.fetchBanList(banList);
assert.deepStrictEqual(
  Array.from(list.bans, (ban) => [
    ban.id,
    ban.steamUser,
    plain(ban.steamIDs).map(({ steamID }) => steamID)
  ]),
  [
    ['3,q', steamID(2), [steamID(1), steamID(2), steamID(3)]],
    ['3,r', steamID(4), [steamID(4), steamID(5)]],
    ['3,s', steamID(6), [steamID(6)]]
  ]
);
assert.strictEqual(list.complete, true);

// A list read to its last page is complete, with the count check, only if the number of different
// bans it read, with or without a SteamID, is within 2 of BattleMetrics' count on its first page,
// plus however much the count changed by its last page. A ban listed twice counts once.
const counted = (first, last, data) => ({
  first: {
    meta: first === null ? undefined : { total: first },
    data: data.slice(0, 2),
    links: { next: link('two') }
  },
  two: { meta: last === null ? undefined : { total: last }, data: data.slice(2), links: {} }
});
const fiveBans = [
  ban('a', steam(1)),
  ban('b', [{ type: 'eosID', identifier: 'b' }]),
  ban('c', steam(3)),
  ban('a', steam(1)),
  ban('d', steam(4)),
  ban('e', steam(5))
];
for (const [first, last, complete] of [
  [5, 5, true],
  [3, 3, true],
  [7, 7, true],
  [2, 2, false],
  [8, 8, false],
  [2, 5, true],
  [9, 6, true],
  [12, 9, false],
  [5, null, true],
  [8, null, false]
]) {
  reset();
  book(counted(first, last, fiveBans));
  list = await fetcher.fetchBanList(banList);
  const label = `${first} then ${last}`;
  assert.strictEqual(list.complete, complete, label);
  assert.strictEqual(
    list.incomplete,
    complete ? undefined : `BattleMetrics counts ${first} bans on the list, but 5 were read`,
    label
  );
  assert.deepStrictEqual(
    [list.bans.length, list.rawCount, list.firstMetaTotal],
    [4, 6, first],
    label
  );
}
// Without a count on its first page, a list cannot be checked, so it is not complete.
reset();
book(counted(null, 5, fiveBans));
list = await fetcher.fetchBanList(banList);
assert.deepStrictEqual(
  [list.complete, list.incomplete],
  [
    false,
    "BattleMetrics gave no count of the list's bans, so it could not be checked that every ban was read"
  ]
);
// With the check off, a list read to its last page is complete, whatever its count.
for (const [first, last] of [
  [null, null],
  [100, 100],
  [0, 0]
]) {
  reset();
  book(counted(first, last, fiveBans));
  assert.strictEqual((await uncounted.fetchBanList(banList)).complete, true, `${first}`);
}

// Bans added or removed while a list is read change its count by little, so counts on its pages
// that differ by more than 10, or 1% of the first page's count if that is more, cannot be trusted,
// and the read is not complete. So a last page that counts no bans, or the bans left after it,
// cannot widen the tolerance to most of the list. Each case is [the count on each page, the bans
// on each page, whether the read is complete].
const countedPages = (counts, perPage) =>
  Object.fromEntries(
    counts.map((count, page) => [
      page === 0 ? 'first' : `c${page}`,
      {
        meta: count === null ? undefined : { total: count },
        data: Array.from({ length: perPage }, (_, i) =>
          ban(`c${page}-${i}`, steam(page * perPage + i))
        ),
        links: { next: page < counts.length - 1 ? link(`c${page + 1}`) : null }
      }
    ])
  );
const DRIFT =
  /^BattleMetrics counts ([\d,]+) bans on the list's first page, but ([\d,]+) on a later one, which bans added or removed while it was read cannot explain, so it could not be checked that every ban was read$/;
for (const [counts, perPage, complete] of [
  [[300, 0], 50, false],
  [[300, 100], 150, false],
  [[300, 0, 300], 100, false],
  [[300, 300, 300, 300, 300, 300, 301], 43, true],
  [[...Array(9).fill(1000), 1012], 100, false],
  [[...Array(9).fill(1000), 1010], 100, true],
  [[1000, 990, ...Array(8).fill(1000)], 100, true],
  [[1000, 989, ...Array(8).fill(1000)], 100, false],
  [[20, 31], 10, false],
  [[20, 30], 10, true],
  [[300, null], 150, true]
]) {
  reset();
  book(countedPages(counts, perPage));
  list = await fetcher.fetchBanList(banList);
  const label = JSON.stringify(counts);
  assert.strictEqual(list.complete, complete, label);
  if (complete) continue;
  const [, first, other] = list.incomplete.match(DRIFT) ?? [];
  assert.deepStrictEqual(
    [first, other],
    [counts[0], counts.find((count) => count !== counts[0])].map((count) =>
      count.toLocaleString('en-US')
    ),
    label
  );
}

// A list that IMPORTER_SCAN_COUNT_CHECK_SKIP names is left out of the check, as with the check off,
// so a read of it to its last page is complete, whatever its count, and it is read for up to 2,000
// pages. A list it does not name is checked. A list that gives no bans but counts some still has
// hidden bans.
const skipping = new BanFetcher({ countCheckSkip: new Set(['3']) });
reset();
book(countedPages([300, 0], 50));
list = await skipping.fetchBanList(banList);
assert.deepStrictEqual([list.complete, list.bans.length, list.firstMetaTotal], [true, 100, 300]);
reset();
book(countedPages([300, 0], 50));
assert.strictEqual(
  (await skipping.fetchBanList({ ...banList, id: 4 })).complete,
  false,
  'Another list is checked'
);
reset();
pageNumber = 0;
book(new Proxy({}, { get: endless({ total: 150 }) }));
await assert.rejects(skipping.fetchBanList(banList), /more than 2000 pages/);
reset();
book({ first: { meta: { total: 40 }, data: [], links: {} } });
await assert.rejects(skipping.fetchBanList(banList), (err) => err.bansHidden === true);

// A remote list's file is kept by its ETag and Last-Modified, when they are plain text that fits
// their columns, and its SHA-256, and a file read in full is complete.
const FILE = '76561198000000001:0 //Cheating\n76561198000000002:0 //Toxic';
const FILE_HASH = createHash('sha256').update(FILE).digest('hex');
reset();
answers({
  status: 200,
  data: FILE,
  headers: { etag: 'W/"v1"', 'last-modified': 'Wed, 21 Oct 2026 10:00:00 GMT' }
});
list = await fetcher.fetchBanList(remoteList);
assert.deepStrictEqual(
  [list.bans.length, list.complete, list.unchanged, plain(list.remote)],
  [
    2,
    true,
    undefined,
    { etag: 'W/"v1"', lastModified: 'Wed, 21 Oct 2026 10:00:00 GMT', bodyHash: FILE_HASH }
  ]
);
assert.deepStrictEqual(plain(remoteRequests[0].options.headers), {});
for (const headers of [
  { etag: `"${'x'.repeat(254)}"` },
  { etag: '"ünïcode"' },
  { 'last-modified': 'x'.repeat(65) }
]) {
  reset();
  answers({ status: 200, data: FILE, headers });
  list = await fetcher.fetchBanList(remoteList);
  assert.deepStrictEqual(
    [list.remote.etag, list.remote.lastModified],
    [null, null],
    JSON.stringify(headers)
  );
}
// An empty file is complete too.
reset();
answers({ status: 200, data: '', headers: {} });
list = await fetcher.fetchBanList(remoteList);
assert.deepStrictEqual(
  [list.bans.length, list.complete, list.remote.bodyHash],
  [0, true, createHash('sha256').update('').digest('hex')]
);

// Given the file the list was last imported from, its host is asked whether the file has changed,
// and an answer of 304 Not Modified means it has not: nothing is read, and the old ETag and
// Last-Modified are kept unless the host gives new ones.
const previous = {
  etag: '"v1"',
  lastModified: 'Wed, 21 Oct 2026 10:00:00 GMT',
  bodyHash: FILE_HASH
};
for (const [headers, kept] of [
  [{}, previous],
  [{ etag: '"v2"' }, { ...previous, etag: '"v2"' }]
]) {
  reset();
  answers({ status: 304, data: '', headers });
  list = await fetcher.fetchBanList(remoteList, { previous });
  assert.deepStrictEqual(plain(remoteRequests[0].options.headers), {
    'If-None-Match': '"v1"',
    'If-Modified-Since': 'Wed, 21 Oct 2026 10:00:00 GMT'
  });
  assert.deepStrictEqual(
    [list.bans.length, list.complete, list.unchanged, plain(list.remote)],
    [0, true, true, kept]
  );
}
// A host that gives the file again, here without an ETag, gives the same SHA-256, so the file has
// not changed either. One whose file differs gives it to read.
reset();
answers(FILE);
list = await fetcher.fetchBanList(remoteList, {
  previous: { etag: null, lastModified: null, bodyHash: FILE_HASH }
});
assert.deepStrictEqual(plain(remoteRequests[0].options.headers), {});
assert.deepStrictEqual(
  [list.unchanged, list.bans.length, plain(list.remote)],
  [true, 0, { etag: null, lastModified: null, bodyHash: FILE_HASH }]
);
reset();
answers(`${FILE}\n76561198000000003:0 //Cheating`);
list = await fetcher.fetchBanList(remoteList, { previous });
assert.deepStrictEqual([list.unchanged, list.bans.length], [undefined, 3]);
// A 304 the host was not asked for is a failed fetch.
reset();
answers({ status: 304, data: '', headers: {} });
await assert.rejects(fetcher.fetchBanList(remoteList), /the server answered HTTP 304\.$/);

console.log(
  'Ban list fetch checks passed: remote bodies, limits and retries, remote files kept and asked about, BattleMetrics paging, the count check, counts that change too much, lists left out of the check, SteamIDs and hidden bans.'
);
