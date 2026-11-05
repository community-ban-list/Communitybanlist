import assert from 'assert';
import { readFile } from 'fs/promises';
import vm from 'vm';

import * as apolloClient from '@apollo/client';
import classnames from 'classnames';
import * as React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import * as reactRouter from 'react-router';
import * as reactstrap from 'reactstrap';
import { transformWithOxc } from 'vite';

import * as config from 'scbl-lib/config';
import * as playerIDs from 'scbl-lib/player-ids';

// Checks what the client's player pages show for a player listed under their SteamID64 or under
// their EOS ID, and for an ID with nothing on record: the search page, the "I'm banned" page and a
// player in a list. The pages are compiled the way the client's build compiles them, loaded with
// the client's own packages, and rendered to HTML with a stand-in for the GraphQL query.

const CLIENT = new URL('../../client/src/', import.meta.url);

const STEAM_ID = '76561198000000001';
const EOS_ID = '0002a1b2c3d4e5f60718293a4b5c6d7e';

// The query's stand-in: the answer every page's query gets, and the IDs the queries asked for.
let answer;
const queried = [];
const useQuery = (query, options) => {
  queried.push(options.variables.id);
  return answer;
};

// The client's packages, and stand-ins for the parts of the client these pages only show.
const Plain = (props) => jsxRuntime.jsx(jsxRuntime.Fragment, { children: props.children });
const packages = {
  react: { default: React, ...React },
  'react/jsx-runtime': jsxRuntime,
  'react-router': reactRouter,
  reactstrap,
  classnames: { default: classnames },
  '@apollo/client': apolloClient,
  '@apollo/client/react': { useQuery },
  'scbl-lib/config': config,
  'scbl-lib/player-ids': playerIDs,
  // The "I'm banned" page's steps all render, one after another.
  'react-step-wizard': { default: Plain }
};
const stand = (name) => () => jsxRuntime.jsx('span', { children: `[${name}]` });
const stubs = {
  'views/layout/layout.jsx': { default: Plain },
  'assets/img/misc/avatar.jpg': { default: 'avatar.jpg' },
  components: {
    BanDates: stand('BanDates'),
    DisplayRiskRating: stand('DisplayRiskRating'),
    FormattedDate: stand('FormattedDate'),
    RecentlyViewedSteamUsers: stand('RecentlyViewedSteamUsers')
  }
};

const synthetic = (exports) =>
  new vm.SyntheticModule(Object.keys(exports), function () {
    for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
  });

// Load one of the client's modules, compiled as the client's build does, with the client's
// modules it imports loaded the same way unless they have a stand-in.
const loaded = new Map();
async function loadClient(path) {
  const url = new URL(path, CLIENT);
  if (loaded.has(url.href)) return loaded.get(url.href);
  const { code } = await transformWithOxc(await readFile(url, 'utf8'), url.pathname, {
    lang: 'jsx',
    jsx: { runtime: 'automatic' }
  });
  const module = new vm.SourceTextModule(code, { identifier: url.href });
  loaded.set(url.href, module);
  await module.link(async (specifier, referrer) => {
    if (!specifier.startsWith('.')) {
      assert.ok(Object.hasOwn(packages, specifier), `Unexpected dependency: ${specifier}`);
      return synthetic(packages[specifier]);
    }
    const resolved = new URL(specifier, referrer.identifier).href.slice(CLIENT.href.length);
    if (Object.hasOwn(stubs, resolved)) return synthetic(stubs[resolved]);
    return loadClient(resolved);
  });
  return module;
}
async function component(path) {
  const module = await loadClient(path);
  if (module.status !== 'evaluated') await module.evaluate();
  return module.namespace.default;
}

const Search = await component('views/pages/search.jsx');
const Banned = await component('views/pages/banned.jsx');
const SteamUser = await component('components/SteamUser/index.jsx');

const { createElement: h } = React;
const { MemoryRouter, Route, Routes } = reactRouter;

// The HTML of a page at an address, as the client's routes give it, with the query's answer, and
// the IDs its queries asked for.
function render(address, data) {
  answer = { loading: false, error: undefined, data };
  queried.length = 0;
  const html = renderToStaticMarkup(
    h(
      MemoryRouter,
      { initialEntries: [address] },
      h(
        Routes,
        null,
        h(Route, { path: '/search/:search', element: h(Search) }),
        h(Route, { path: '/search', element: h(Search) }),
        h(Route, { path: '/banned/:steamUser', element: h(Banned) }),
        h(Route, { path: '/banned', element: h(Banned) })
      )
    )
  );
  return { html, queried: [...queried] };
}
const listed = (steamUser) =>
  renderToStaticMarkup(h(MemoryRouter, null, h(SteamUser, { steamUser })));

// A player as the search page's query gives them.
const noBans = { edges: [] };
const player = (id, fields) => ({
  id,
  name: null,
  avatarFull: null,
  reputationPoints: 3,
  riskRating: 1,
  reputationRank: 1200,
  lastRefreshedInfo: '2026-11-01T00:00:00.000Z',
  lastRefreshedReputationPoints: '2026-11-01T00:00:00.000Z',
  lastRefreshedReputationRank: '2026-11-01T00:00:00.000Z',
  activeBans: noBans,
  expiredBans: noBans,
  bans: noBans,
  ...fields
});

// The search box takes either kind of ID.
{
  const { html, queried } = render('/search', null);
  assert.deepStrictEqual(queried, []);
  assert.match(html, /placeholder="Steam 64 ID or EOS ID"/);
  assert.match(html, /\[RecentlyViewedSteamUsers\]/);
}

// A search that is neither kind of ID asks for no player.
for (const address of ['/search/hello', `/search/${STEAM_ID}0`, `/search/${EOS_ID.slice(1)}`]) {
  const { html, queried } = render(address, null);
  assert.deepStrictEqual(queried, [], address);
  assert.match(html, /\[RecentlyViewedSteamUsers\]/, address);
}

// An EOS ID with nothing on record says so, and that a Steam player's bans are under their
// SteamID64. An EOS ID in capitals is looked up as CBL stores it.
for (const id of [EOS_ID, EOS_ID.toUpperCase()]) {
  const { html, queried } = render(`/search/${id}`, { steamUser: null });
  assert.deepStrictEqual(queried, [EOS_ID]);
  assert.match(html, /Unknown EOS ID/);
  assert.match(html, /No bans are stored under this EOS ID\./);
  assert.match(html, /their bans are listed under their Steam 64\s+ID/);
  assert.doesNotMatch(html, /Unknown Steam User/);
  assert.doesNotMatch(html, /\[RecentlyViewedSteamUsers\]/);
}

// A SteamID64 with nothing on record is as before.
{
  const { html, queried } = render(`/search/${STEAM_ID}`, { steamUser: null });
  assert.deepStrictEqual(queried, [STEAM_ID]);
  assert.match(html, /Unknown Steam User/);
  assert.match(html, /We do not have this Steam user on record\./);
  assert.doesNotMatch(html, /Unknown EOS ID|No bans are stored|EOS Player/);
}

// A player listed under their EOS ID gets an EOS player's page: their EOS ID, no Steam profile or
// Steam tools, and their reputation and bans as a Steam player's.
{
  const { html, queried } = render(`/search/${EOS_ID}`, { steamUser: player(EOS_ID) });
  assert.deepStrictEqual(queried, [EOS_ID]);
  assert.match(html, /<h4>EOS Player<\/h4>/);
  assert.match(html, /Unknown name/);
  assert.match(html, new RegExp(`<code[^>]*>${EOS_ID}</code>`));
  assert.match(html, new RegExp(`filter\\[search\\]=${EOS_ID}&amp;method=quick`));
  assert.match(html, new RegExp(`href="/banned/${EOS_ID}"`));
  assert.match(html, /Reputation Points/);
  assert.match(html, /No active bans on record\./);
  for (const steamOnly of ['Steam Profile', 'steamcommunity.com', 'SteamID.UK', 'steamrep', 'rep.tf'])
    assert.ok(!html.includes(steamOnly), steamOnly);
  // There is no Steam profile to refresh, so only the reputation's times are shown.
  assert.strictEqual(html.match(/Last Refreshed/g).length, 2);
}

// A Steam player's page is as before.
{
  const steamUser = player(STEAM_ID, { name: 'Someone', avatarFull: 'https://avatars/full.jpg' });
  const { html, queried } = render(`/search/${STEAM_ID}`, { steamUser });
  assert.deepStrictEqual(queried, [STEAM_ID]);
  assert.match(html, /<h4>Steam Profile<\/h4>/);
  assert.match(html, new RegExp(`href="https://steamcommunity.com/profiles/${STEAM_ID}"`));
  assert.match(html, /SteamID\.UK/);
  assert.match(html, /src="https:\/\/avatars\/full\.jpg"/);
  assert.strictEqual(html.match(/Last Refreshed/g).length, 3);
  assert.doesNotMatch(html, /EOS Player|EOS ID:/);
}

// The "I'm banned" page asks for either kind of ID when the address has none.
{
  const { html, queried } = render('/banned', null);
  assert.deepStrictEqual(queried, []);
  assert.match(html, /Who are you\?/);
  assert.match(html, /placeholder="Steam 64 ID or EOS ID"/);
  assert.match(html, /your EOS ID if you bought Squad on the Epic Games\s+Store/);
}

// It takes an EOS ID in its address, in capitals too, and when nothing is on record under it,
// says that a Steam player should enter their SteamID64.
for (const id of [EOS_ID, EOS_ID.toUpperCase()]) {
  const { html, queried } = render(`/banned/${id}`, { steamUser: null });
  assert.deepStrictEqual(queried, [EOS_ID]);
  assert.doesNotMatch(html, /Who are you\?/);
  assert.match(html, /We have no bans under this EOS ID\./);
  assert.match(html, /href="\/banned"[^>]*>enter your Steam 64 ID<\/a>/);
}

// A player found under their EOS ID, or a SteamID64 with nothing on record, gets no such note.
for (const [id, steamUser] of [
  [EOS_ID, player(EOS_ID)],
  [STEAM_ID, null],
  [STEAM_ID, player(STEAM_ID, { name: 'Someone' })]
]) {
  const { html, queried } = render(`/banned/${id}`, { steamUser });
  assert.deepStrictEqual(queried, [id]);
  assert.doesNotMatch(html, /We have no bans under this EOS ID/);
  assert.doesNotMatch(html, /Who are you\?/);
}

// A player in a list: a Steam player by name, or by SteamID64 before Steam has given their name;
// a player listed under their EOS ID by the start and end of it, marked EOS; and a missing player.
{
  const named = listed({ id: STEAM_ID, name: 'Someone', avatar: 'https://avatars/a.jpg' });
  assert.match(named, new RegExp(`href="/search/${STEAM_ID}"`));
  assert.match(named, />Someone</);
  assert.match(named, /src="https:\/\/avatars\/a\.jpg"/);
  assert.doesNotMatch(named, /EOS/);

  const unnamed = listed({ id: STEAM_ID, name: null, avatar: null });
  assert.match(unnamed, new RegExp(`>${STEAM_ID}<`));
  assert.match(unnamed, /src="avatar\.jpg"/);
  assert.doesNotMatch(unnamed, /EOS/);

  const eos = listed({ id: EOS_ID, name: null, avatar: null });
  assert.match(eos, new RegExp(`href="/search/${EOS_ID}"`));
  assert.match(eos, />0002a1b2…6d7e</);
  assert.match(eos, new RegExp(`title="EOS ID ${EOS_ID}"`));
  assert.match(eos, />EOS<\/span>/);

  assert.match(listed(null), /Unknown player/);
}

console.log("Player page checks passed: search, the I'm banned page and players in lists.");
