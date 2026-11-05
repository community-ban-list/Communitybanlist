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
// player in a list, and where their forms and the copy button send an ID. The pages are compiled
// the way the client's build compiles them, loaded with the client's own packages, and rendered to
// HTML with a stand-in for the GraphQL query.

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

// What the forms and buttons do, as a page can only be rendered, not used: the props of the forms
// and buttons on the last page rendered, where they send the browser, and what the copy button
// copies. A form's box starts empty, so the text to have typed in the next one is set beforehand.
const forms = [];
const buttons = [];
const navigations = [];
const copied = [];
const typed = [];
const capture = (list, Component) => (props) => {
  list.push(props);
  return React.createElement(Component, props);
};
// A clipboard, so the copy button shows, as in a browser that lets the page copy text.
Object.defineProperty(globalThis.navigator, 'clipboard', {
  configurable: true,
  value: {
    writeText: async (text) => {
      copied.push(text);
    }
  }
});

// The client's packages, and stand-ins for the parts of the client these pages only show.
const Plain = (props) => jsxRuntime.jsx(jsxRuntime.Fragment, { children: props.children });
const packages = {
  react: {
    default: React,
    ...React,
    useState: (initial) => React.useState(typed.length > 0 ? typed.shift() : initial)
  },
  'react/jsx-runtime': jsxRuntime,
  'react-router': {
    ...reactRouter,
    useNavigate: () => (to) => {
      navigations.push(to);
    }
  },
  reactstrap: {
    ...reactstrap,
    Form: capture(forms, reactstrap.Form),
    Button: capture(buttons, reactstrap.Button)
  },
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
const SearchBox = await component('components/steam-user-search-box.jsx');

const { createElement: h } = React;
const { MemoryRouter, Route, Routes } = reactRouter;

// The pages' routes, as the client's routes name them, since the pages read the ID by its name.
const routesFile = await readFile(new URL('views/routes.js', CLIENT), 'utf8');
const ROUTES = [
  ['/search/:search', Search],
  ['/search', Search],
  ['/banned/:steamUser', Banned],
  ['/banned/', Banned]
];
for (const [path] of ROUTES) assert.ok(routesFile.includes(`path: '${path}',`), path);

// The HTML of a page at an address, as the client's routes give it, with the query's answer, and
// the IDs its queries asked for.
function render(address, data) {
  answer = { loading: false, error: undefined, data };
  queried.length = 0;
  forms.length = 0;
  buttons.length = 0;
  navigations.length = 0;
  const html = renderToStaticMarkup(
    h(
      MemoryRouter,
      { initialEntries: [address] },
      h(
        Routes,
        null,
        ...ROUTES.map(([path, Page]) => h(Route, { key: path, path, element: h(Page) }))
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
  assert.match(html, /most of their bans are listed under their\s+Steam 64 ID/);
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
  for (const steamOnly of [
    'Steam Profile',
    'steamcommunity.com',
    'SteamID.UK',
    'steamrep',
    'rep.tf'
  ])
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

// The search box sends a search for the ID as CBL stores it, so an EOS ID in capitals, with spaces,
// or a Steam profile's address, finds the same page as the ID itself.
function searchBox(props) {
  forms.length = 0;
  buttons.length = 0;
  navigations.length = 0;
  const html = renderToStaticMarkup(h(MemoryRouter, null, h(SearchBox, props)));
  assert.strictEqual(forms.length, 1);
  assert.strictEqual(buttons.length, 1);
  forms[0].onSubmit({ preventDefault() {} });
  return { html, disabled: buttons[0].disabled, to: [...navigations] };
}
for (const [search, to] of [
  [` ${EOS_ID.toUpperCase()} `, `/search/${EOS_ID}`],
  [STEAM_ID, `/search/${STEAM_ID}`],
  [`https://steamcommunity.com/profiles/${STEAM_ID}/`, `/search/${STEAM_ID}`]
]) {
  for (const frontpageVersion of [false, true]) {
    const box = searchBox({ search, frontpageVersion });
    assert.doesNotMatch(box.html, /is-invalid/, search);
    assert.strictEqual(box.disabled, false, search);
    assert.deepStrictEqual(box.to, [to], search);
  }
}
// Anything else is marked as wrong and can't be searched for, except on the home page, which sends
// what was typed, as before. An empty box is not marked as wrong. 17 digits that are not a Steam
// account's ID, such as a SteamID64 with a typo, are called that, and anything else is told what an
// ID looks like.
const NOT_STEAM = /This is not the ID of a Steam account: check it for a typo\./;
const LOOKS_LIKE =
  /Enter a Steam 64 ID, which is a 17 digit number starting with 7656, or an EOS ID/;
const TYPOS = [
  '76561197960265728',
  '76561188000000001',
  '76569999999999999',
  ' 76561202255233024 '
];
for (const search of ['hello', ...TYPOS, EOS_ID.slice(1), `${STEAM_ID}0`, '']) {
  const box = searchBox({ search });
  if (search) assert.match(box.html, /is-invalid/, search);
  else assert.doesNotMatch(box.html, /is-invalid/);
  assert.match(box.html, TYPOS.includes(search) ? NOT_STEAM : LOOKS_LIKE, search);
  assert.doesNotMatch(box.html, TYPOS.includes(search) ? LOOKS_LIKE : NOT_STEAM, search);
  assert.strictEqual(box.disabled, true, search);
  const home = searchBox({ search, frontpageVersion: true });
  assert.doesNotMatch(home.html, /is-invalid/, search);
  assert.strictEqual(home.disabled, false, search);
  assert.deepStrictEqual(home.to, [`/search/${search}`], search);
}

// The "I'm banned" page's form goes to the page for the ID typed in it, as CBL stores it, and marks
// anything else as wrong, with no way on.
function bannedForm(text) {
  typed.length = 0;
  typed.push(text);
  const { html } = render('/banned', null);
  assert.strictEqual(typed.length, 0, 'the form took the typed text');
  const next = buttons.filter((props) => typeof props.onClick === 'function');
  assert.strictEqual(next.length, 1);
  assert.strictEqual(next[0].children[0], 'Next');
  return { html, disabled: next[0].disabled, next: next[0] };
}
for (const [text, id] of [
  [` ${EOS_ID.toUpperCase()} `, EOS_ID],
  [STEAM_ID, STEAM_ID]
]) {
  const form = bannedForm(text);
  assert.doesNotMatch(form.html, /is-invalid/, text);
  assert.strictEqual(form.disabled, false, text);
  form.next.onClick({ preventDefault() {} });
  assert.deepStrictEqual(navigations, [`/banned/${id}`], text);
}
for (const text of ['hello', ...TYPOS, EOS_ID.slice(1), `${STEAM_ID}0`]) {
  const form = bannedForm(text);
  assert.match(form.html, /is-invalid/, text);
  assert.strictEqual(form.disabled, true, text);
  assert.match(form.html, TYPOS.includes(text) ? NOT_STEAM : LOOKS_LIKE, text);
  assert.doesNotMatch(form.html, TYPOS.includes(text) ? LOOKS_LIKE : NOT_STEAM, text);
}

// An EOS player's copy button copies their EOS ID as CBL stores it, and says what it copies.
{
  const { html } = render(`/search/${EOS_ID.toUpperCase()}`, { steamUser: player(EOS_ID) });
  const copy = buttons.filter((props) => props['aria-label'] === 'Copy EOS ID');
  assert.strictEqual(copy.length, 1);
  assert.match(html, /aria-label="Copy EOS ID"[^>]*>Copy</);
  copied.length = 0;
  await copy[0].onClick();
  assert.deepStrictEqual(copied, [EOS_ID]);
}

console.log(
  "Player page checks passed: search, the I'm banned page, their forms, the copy button and players in lists."
);
