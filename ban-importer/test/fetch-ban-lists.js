import assert from 'assert';
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

const dependencies = {
  axios: {
    default: {
      async get(url, options) {
        remoteRequests.push({ url, options });
        return remote();
      }
    }
  },
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
const source = await readFile(new URL('../src/ban-fetcher.js', import.meta.url), 'utf8');
const module = new vm.SourceTextModule(source, { context });
await module.link((specifier) => {
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
const fetcher = new BanFetcher();

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
    return { status: 200, data: reply };
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

reset();
answers(
  networkError('ECONNABORTED', 'timeout of 30000ms exceeded'),
  networkError('ERR_CANCELED', 'canceled'),
  httpError(429)
);
await assert.rejects(
  fetcher.fetchBanList(remoteList),
  /^Error: Could not fetch the remote ban list: the server answered HTTP 429\.$/
);
assert.strictEqual(remoteRequests.length, 3);

reset();
answers(networkError('ERR_CANCELED', 'canceled'), networkError('ERR_CANCELED'), httpError(500));
await assert.rejects(fetcher.fetchBanList(remoteList), /HTTP 500/);

// Other answers, and lists over the size limit, fail at once.
for (const [error, message] of [
  [httpError(404), /the server answered HTTP 404\.$/],
  [httpError(403), /the server answered HTTP 403\.$/],
  [
    networkError('ERR_BAD_RESPONSE', 'maxContentLength size of 20971520 exceeded'),
    /the list is over 20 MB\.$/
  ]
]) {
  reset();
  answers(error);
  await assert.rejects(fetcher.fetchBanList(remoteList), message);
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

// Links that never end stop at the pages the list's ban count needs plus 50, or at 2,000 pages
// without a count.
let pageNumber = 0;
const endless = (meta) => () => ({
  meta,
  data: [ban(`u${++pageNumber}`, steam(1))],
  links: { next: link(`page${pageNumber}`) }
});
for (const [meta, pages] of [
  [{ total: 150 }, 52],
  [undefined, 2000]
]) {
  reset();
  book(new Proxy({}, { get: endless(meta) }));
  await assert.rejects(fetcher.fetchBanList(banList), new RegExp(`more than ${pages} pages`));
  assert.strictEqual(battlemetricsRequests.length, pages);
}

await assert.rejects(
  fetcher.fetchBanList({ id: 9, type: 'unknown', source: 'x' }),
  /Unsupported ban list type/
);

console.log(
  'Ban list fetch checks passed: remote bodies, limits and retries, and BattleMetrics paging.'
);
