import assert from 'assert';
import { readFile } from 'fs/promises';
import vm from 'vm';

import * as apolloClient from '@apollo/client';
import * as apolloUtilities from '@apollo/client/utilities';
import classnames from 'classnames';
import * as React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import * as reactRouter from 'react-router';
import * as reactstrap from 'reactstrap';
import { Observable } from 'rxjs';
import { transformWithOxc } from 'vite';

import * as config from 'scbl-lib/config';
import * as playerIDs from 'scbl-lib/player-ids';

// Checks what the client's pages show while their data loads and when it cannot be loaded: that
// they say so, with the web server's reason and a way to try again, instead of showing nothing or
// claiming nothing is on record; that Load More says when it is loading and when it failed; that a
// page which fails to render is replaced by a message until the user goes to another address; and
// that the pages look as before when their data arrives. The client's modules are compiled the way
// its build compiles them, loaded with its own packages, and rendered to HTML, with stand-ins for
// its GraphQL queries and React's state.

const CLIENT = new URL('../../client/src/', import.meta.url);

const STEAM_ID = '76561198000000001';
const EOS_ID = '0002a1b2c3d4e5f60718293a4b5c6d7e';
const DATABASE_UNAVAILABLE = 'The database is unavailable at the moment. Please try again shortly.';

const { createElement: h } = React;
const { ApolloClient, ApolloLink, HttpLink, InMemoryCache, gql } = apolloClient;
const { MemoryRouter, Route, Routes, useLocation } = reactRouter;

// Real errors, as Apollo Client gives them to a page: the web server's answer that the database is
// unavailable, and a request that got no answer, e.g. as the connection dropped.
async function errorFor(answer) {
  const client = new ApolloClient({
    link: new HttpLink({ uri: '/graphql', fetch: async () => answer() }),
    cache: new InMemoryCache()
  });
  const query = gql`
    query {
      banLists {
        id
      }
    }
  `;
  const error = await client.query({ query }).then(
    () => assert.fail('the query should fail'),
    (error) => error
  );
  client.stop();
  return error;
}
const databaseUnavailable = await errorFor(
  () =>
    new Response(
      JSON.stringify({ data: { banLists: null }, errors: [{ message: DATABASE_UNAVAILABLE }] }),
      { headers: { 'content-type': 'application/graphql-response+json; charset=utf-8' } }
    )
);
const noAnswer = await errorFor(() => {
  throw new TypeError('fetch failed');
});

// The queries' stand-in: the answer every query on the page gets, with refetch and fetchMore that
// record their calls and end as set. React's state is a stand-in too: each component's state
// starts as given here, in the order they ask for it, or else as the component sets it, and what
// they set it to is recorded.
let answer;
const refetches = [];
const fetches = [];
let refetchOutcome;
let fetchMoreOutcome;
const useQuery = () => answer;
const states = [];
const stateUpdates = [];
function useState(initial) {
  const value = states.length > 0 ? states.shift() : initial;
  return [value, (next) => stateUpdates.push(next)];
}
function result(fields) {
  return {
    loading: false,
    refetch: () => {
      refetches.push(true);
      return refetchOutcome;
    },
    fetchMore: (options) => {
      fetches.push(options);
      return fetchMoreOutcome;
    },
    ...fields
  };
}

// The props of the buttons and the error boxes on the last page rendered, as a page can only be
// rendered, not used.
const buttons = [];
const errorModals = [];
const capture = (list, Component) => (props) => {
  list.push(props);
  return Component ? h(Component, props) : null;
};
const buttonCalled = (text) => {
  const found = buttons.filter((props) => [props.children].flat().includes(text));
  assert.strictEqual(found.length, 1, `one ${text} button`);
  return found[0];
};
let mutationResult;

const Plain = (props) => jsxRuntime.jsx(jsxRuntime.Fragment, { children: props.children });
const stand = (name) => () => jsxRuntime.jsx('span', { children: `[${name}]` });
const packages = {
  react: { default: React, ...React, useState },
  'react/jsx-runtime': jsxRuntime,
  'react-router': { ...reactRouter, useNavigate: () => () => {} },
  reactstrap: { ...reactstrap, Button: capture(buttons, reactstrap.Button) },
  classnames: { default: classnames },
  '@apollo/client': apolloClient,
  '@apollo/client/react': { useQuery, useMutation: () => [() => {}, mutationResult] },
  'scbl-lib/config': config,
  'scbl-lib/player-ids': playerIDs,
  // The "I'm banned" page's steps all render, one after another.
  'react-step-wizard': { default: Plain }
};
// The parts of the client these pages only show. The layout marks where it is.
const components = {
  AdvancedModal: stand('AdvancedModal'),
  BanDates: stand('BanDates'),
  CreateExportBanListConfig: stand('CreateExportBanListConfig'),
  DeleteExportBanList: stand('DeleteExportBanList'),
  DeleteExportBanListConfig: stand('DeleteExportBanListConfig'),
  DisplayRiskRating: stand('DisplayRiskRating'),
  ErrorModal: capture(errorModals),
  FormattedDate: stand('FormattedDate'),
  LoadingModal: stand('LoadingModal'),
  RecentlyViewedSteamUsers: stand('RecentlyViewedSteamUsers'),
  SteamUser: stand('SteamUser')
};
const stubs = {
  'views/layout/layout.jsx': {
    default: (props) => jsxRuntime.jsx('div', { 'data-layout': '', children: props.children })
  },
  'assets/img/misc/avatar.jpg': { default: 'avatar.jpg' },
  components,
  'components/': components,
  'components/index': components,
  'components/CreateExportBanList/mutate-export-ban-list': {
    default: stand('MutateExportBanList')
  }
};

const synthetic = (exports) =>
  new vm.SyntheticModule(Object.keys(exports), function () {
    for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
  });

// Load the client's modules, compiled as the client's build does, with the client's modules they
// import loaded the same way unless they have a stand-in. Each loader keeps its own modules, so
// app.jsx can be loaded with stand-ins of its own.
function loader(packages, stubs) {
  const loaded = new Map();
  async function load(path) {
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
      return load(resolved);
    });
    return module;
  }
  return async (path) => {
    const module = await load(path);
    if (module.status !== 'evaluated') await module.evaluate();
    return module.namespace;
  };
}
const load = loader(packages, stubs);
const component = async (path) => (await load(path)).default;

const Search = await component('views/pages/search.jsx');
const Banned = await component('views/pages/banned.jsx');
const RecentBans = await component('views/pages/recent-bans.jsx');
const MostHarmfulPlayers = await component('views/pages/most-harmful-players.jsx');
const MostHarmfulPlayersThisMonth = await component(
  'views/pages/most-harmful-players-this-month.jsx'
);
const PartnerOrganisationList = await component('views/pages/partner-organisation-list.jsx');
const ExportBanLists = await component('views/pages/export-ban-lists.jsx');
const RecentlyViewedSteamUsers = await component('components/RecentlyViewedSteamUsers/index.jsx');
const BanListSelector = await component('components/BanListSelector/index.jsx');
const ExportBanListConfigs = await component('components/ExportBanListConfigs/index.jsx');
const QueryExportBanList = await component(
  'components/CreateExportBanList/query-export-ban-list.jsx'
);
const DeleteExportBanList = await component('components/DeleteExportBanList/index.jsx');
const { Loading, LoadError, LoadMore } = await load('components/LoadStatus/index.jsx');
const ErrorBoundary = await component('components/ErrorBoundary/index.jsx');
const PageError = await component('views/pages/page-error.jsx');
const { CHANGE_NOT_REACHED, LOAD_NOT_REACHED } = await load('utils/graphql-errors.js');

// The pages' routes that name their parameters, as the client's routes name them, since the pages
// read the ID by its name.
const routesFile = await readFile(new URL('views/routes.js', CLIENT), 'utf8');
const ROUTES = { search: '/search/:search', banned: '/banned/:steamUser' };
for (const path of Object.values(ROUTES)) assert.ok(routesFile.includes(`path: '${path}',`), path);

// The HTML of an element at an address, on a route, with the queries' answer and the state to
// start with.
function render(element, { address = '/', path = '*', data, ...fields } = {}, startStates = []) {
  answer = result({ data, ...fields });
  buttons.length = 0;
  errorModals.length = 0;
  refetches.length = 0;
  fetches.length = 0;
  stateUpdates.length = 0;
  states.length = 0;
  states.push(...startStates);
  const html = renderToStaticMarkup(
    h(MemoryRouter, { initialEntries: [address] }, h(Routes, null, h(Route, { path, element })))
  );
  assert.deepStrictEqual(states, [], 'every state given was used');
  return html;
}
const page = (Page, address, path) => (fields) => render(h(Page), { address, path, ...fields });
const settle = () => new Promise((resolve) => setImmediate(resolve));

// What every page and list here shows while loading, and when it could not load: the reason, and a
// button that loads it again and says while it tries. None of them shows its old "Something went
// wrong" message, and none shows what it shows with its data.
async function checkStates(name, show, { loaded, small = false }) {
  let html = show({ loading: true });
  assert.match(html, /role="status"[^>]*>(<[^>]+>)*Loading\.\.\./, `${name} says it is loading`);
  assert.doesNotMatch(html, /role="alert"/, name);

  for (const [error, message] of [
    [databaseUnavailable, DATABASE_UNAVAILABLE],
    [noAnswer, LOAD_NOT_REACHED]
  ]) {
    html = show({ error });
    assert.match(html, /role="alert"/, `${name} shows its error`);
    assert.ok(html.includes(message), `${name} says why: ${html}`);
    assert.doesNotMatch(html, /\[ERR 1\]|Sad times/, name);
    assert.doesNotMatch(html, /role="status"/, name);
    assert.ok(!html.includes(loaded), `${name} shows no data with an error`);
    assert.strictEqual(html.includes('>Error!<'), !small, name);
  }

  // Try again loads it again, and says so until it is done, as the page's error stays the same
  // until a new try fails or works.
  show({ error: databaseUnavailable });
  refetchOutcome = Promise.reject(databaseUnavailable);
  refetchOutcome.catch(() => {});
  buttonCalled('Try again').onClick();
  assert.strictEqual(refetches.length, 1, `${name} tries again`);
  assert.deepStrictEqual(stateUpdates, [true]);
  await settle();
  assert.deepStrictEqual(stateUpdates, [true, false], `${name} is done trying`);
}

// Recent Bans, Most Harmful Players and Most Harmful Players This Month.
const ban = (id) => ({
  cursor: `ban-${id}`,
  node: {
    id: String(id),
    steamUser: { id: STEAM_ID, name: 'Someone', avatar: null },
    banList: { id: 1, name: 'Main List', organisation: { id: 1, name: 'Org', discord: 'd' } },
    reason: 'Cheating',
    created: '2026-11-01T00:00:00.000Z',
    expires: null
  }
});
const player = (id) => ({
  cursor: `player-${id}`,
  node: {
    id: `7656119800000000${id}`,
    name: `Player ${id}`,
    avatar: null,
    reputationPoints: 10,
    reputationPointsMonthChange: 3,
    riskRating: 5,
    reputationRank: id
  }
});
const pageOf = (edges, hasNextPage) => ({
  edges,
  pageInfo: {
    hasPreviousPage: false,
    hasNextPage,
    startCursor: edges[0].cursor,
    endCursor: edges.at(-1).cursor
  }
});
for (const [name, Page, field, edge, row] of [
  ['Recent Bans', RecentBans, 'bans', ban, 'Main List'],
  ['Most Harmful Players', MostHarmfulPlayers, 'steamUsers', player, '[DisplayRiskRating]'],
  [
    'Most Harmful Players This Month',
    MostHarmfulPlayersThisMonth,
    'steamUsers',
    player,
    '[DisplayRiskRating]'
  ]
]) {
  const show = page(Page);
  await checkStates(name, show, { loaded: row });

  // With its data, it shows its rows and Load More, and no loading or error.
  const data = { [field]: pageOf([edge(1), edge(2)], true) };
  let html = show({ data });
  assert.ok(html.includes(row), name);
  assert.doesNotMatch(html, /role="status"|role="alert"/, name);
  const loadMore = buttonCalled('Load More');
  assert.ok(!loadMore.disabled, name);

  // Load More asks for the page after the last row. While it loads, the button says so.
  fetchMoreOutcome = Promise.reject(noAnswer);
  fetchMoreOutcome.catch(() => {});
  loadMore.onClick();
  assert.strictEqual(fetches.length, 1, name);
  assert.deepStrictEqual(fetches[0].variables, { after: data[field].pageInfo.endCursor });
  assert.ok(fetches[0].query, name);
  assert.deepStrictEqual(stateUpdates, [{ loading: true, error: null }], name);
  // A page that could not be loaded is remembered, to be shown.
  await settle();
  assert.deepStrictEqual(stateUpdates.slice(1), [{ loading: false, error: noAnswer }], name);

  // The last page has no Load More to press.
  html = show({ data: { [field]: pageOf([edge(1)], false) } });
  assert.strictEqual(buttonCalled('Load More').disabled, true, name);
}

// Load More, while the next page loads and once it could not be loaded. The rows stay as they
// were, and a second press while loading asks for nothing more.
{
  const show = (state) =>
    render(h(LoadMore, { hasNextPage: true, fetchMore: () => fetches.push(true) }), {}, [state]);
  let html = show({ loading: true, error: null });
  assert.match(html, /fa-spin[^>]*><\/i>Loading\.\.\./);
  assert.doesNotMatch(html, /Load More|role="alert"/);
  buttonCalled('Loading...').onClick();
  assert.deepStrictEqual(fetches, []);
  assert.deepStrictEqual(stateUpdates, []);

  html = show({ loading: false, error: databaseUnavailable });
  assert.ok(
    html.includes(`role="alert" class="mb-3">Could not load more. ${DATABASE_UNAVAILABLE}<`)
  );
  assert.ok(html.includes('Load More'));
  html = show({ loading: false, error: noAnswer });
  assert.ok(html.includes(`role="alert" class="mb-3">Could not load more. ${LOAD_NOT_REACHED}<`));

  // Pressing it again clears the error while it tries.
  fetchMoreOutcome = Promise.resolve();
  render(h(LoadMore, { hasNextPage: true, fetchMore: () => fetchMoreOutcome }), {}, [
    { loading: false, error: noAnswer }
  ]);
  buttonCalled('Load More').onClick();
  await settle();
  assert.deepStrictEqual(stateUpdates, [
    { loading: true, error: null },
    { loading: false, error: null }
  ]);
}

// A load error's Try again says it is trying, and a second press while it tries does nothing. A
// small one, in a form, has no heading, and one with nothing to try again has no button.
{
  let html = render(h(LoadError, { error: noAnswer, retry: () => refetches.push(true) }), {}, [
    true
  ]);
  assert.ok(html.includes('Trying again...'));
  buttonCalled('Trying again...').onClick();
  assert.deepStrictEqual(refetches, []);
  assert.deepStrictEqual(stateUpdates, []);

  html = render(h(LoadError, { error: databaseUnavailable, small: true }));
  assert.ok(html.includes(DATABASE_UNAVAILABLE));
  assert.ok(!html.includes('Error!'));
  assert.strictEqual(buttons.length, 0);
}

// The loading card is marked, so the page's footer waits while it shows (theme/_sections.scss).
assert.match(render(h(Loading)), /^<div role="status" class="loading-placeholder">/);
const sections = await readFile(new URL('assets/scss/theme/_sections.scss', CLIENT), 'utf8');
assert.match(sections, /body:has\(\.loading-placeholder\) \.footer \{\s*display: none;\s*\}/);

// The search page, for a player's ID.
{
  const show = page(Search, `/search/${STEAM_ID}`, ROUTES.search);
  const profile = (id) => ({
    steamUser: {
      id,
      name: 'Someone',
      avatarFull: null,
      reputationPoints: 3,
      riskRating: 1,
      reputationRank: 1200,
      lastRefreshedInfo: null,
      lastRefreshedReputationPoints: null,
      lastRefreshedReputationRank: null,
      activeBans: { edges: [] },
      expiredBans: { edges: [] }
    }
  });
  await checkStates('The search page', show, { loaded: 'Reputation Points' });

  // A lookup that failed never says the player is not on record, even when an earlier lookup of
  // theirs, still in the cache, found nothing.
  for (const [address, unknown] of [
    [`/search/${STEAM_ID}`, /Unknown Steam User|not have this Steam user/],
    [`/search/${EOS_ID}`, /Unknown EOS ID|No bans are stored/]
  ]) {
    const html = render(h(Search), {
      address,
      path: ROUTES.search,
      error: databaseUnavailable,
      data: { steamUser: null }
    });
    assert.ok(html.includes(DATABASE_UNAVAILABLE), address);
    assert.doesNotMatch(html, unknown, address);
    // One that worked still says so.
    assert.match(
      render(h(Search), { address, path: ROUTES.search, data: { steamUser: null } }),
      unknown,
      address
    );
  }

  // A player found by an earlier lookup stays on the page under the error of a later one.
  let html = show({ error: databaseUnavailable, data: profile(STEAM_ID) });
  assert.ok(html.includes(DATABASE_UNAVAILABLE));
  assert.ok(html.includes('Steam Profile'));

  // With its data, the page is as before. Its disclaimer looks like an alert but is not announced
  // as one, as it is on every player's page.
  html = show({ data: profile(STEAM_ID) });
  assert.ok(html.includes('Steam Profile'));
  assert.doesNotMatch(html, /role="status"|role="alert"/);
  assert.match(
    html,
    /<div class="alert alert-danger"><i class="fas fa-exclamation-circle me-2"><\/i><strong>Disclaimer<\/strong>/
  );
}

// The "I'm banned" page, for a player's ID. Its steps show only with its data.
{
  const show = page(Banned, `/banned/${STEAM_ID}`, ROUTES.banned);
  await checkStates("The I'm banned page", show, { loaded: 'Foreword' });
  const html = show({
    data: { steamUser: { id: STEAM_ID, name: 'Someone', bans: { edges: [] } } }
  });
  assert.ok(html.includes('Foreword'));
  assert.doesNotMatch(html, /role="status"|role="alert"/);
}

// The partner organisation list, the owner's export ban lists, and the players last looked up.
for (const [name, Page, data, loaded] of [
  [
    'The partner organisation list',
    PartnerOrganisationList,
    { organisations: [{ id: 1, name: 'Org', discord: 'd', banLists: [{ id: 1, name: 'Main' }] }] },
    'Main'
  ],
  [
    'The export ban lists page',
    ExportBanLists,
    {
      loggedInSteamUser: {
        id: STEAM_ID,
        exportBanLists: [
          {
            id: 1,
            name: 'My List',
            threshold: 9,
            type: 'remote',
            defaultActivePoints: 3,
            defaultExpiredPoints: 1,
            battlemetricsID: null,
            battlemetricsInvite: null
          }
        ]
      }
    },
    'My List'
  ],
  [
    'Recently Viewed Players',
    RecentlyViewedSteamUsers,
    { steamUsers: pageOf([player(1)], false) },
    '[SteamUser]'
  ]
]) {
  const show = page(Page);
  await checkStates(name, show, { loaded });
  const html = show({ data });
  assert.ok(html.includes(loaded), name);
  assert.doesNotMatch(html, /role="status"|role="alert"/, name);
}

// The ban list chooser in the points form: its own small error, with Try again.
{
  const show = (fields) => render(h(BanListSelector, { onChange() {} }), fields);
  await checkStates('The ban list chooser', show, { loaded: '<select', small: true });
  const html = show({
    data: { banLists: [{ id: 2, name: 'Main', organisation: { id: 1, name: 'Org' } }] }
  });
  assert.match(html, /<select[^>]*>.*Org&#x27;s Main/);
}

// The export ban list edit page's list and its points table.
{
  const exportBanList = {
    id: 1,
    type: 'remote',
    threshold: 9,
    defaultActivePoints: 3,
    defaultExpiredPoints: 1,
    maxBanAge: null,
    exportBanListConfigs: [
      {
        id: 4,
        activePoints: 5,
        expiredPoints: 2,
        banList: { id: 2, name: 'Main', paused: false, organisation: { id: 1, name: 'Org' } }
      }
    ]
  };
  const showList = (fields) => render(h(QueryExportBanList, { exportBanListID: 1 }), fields);
  await checkStates('The export ban list edit page', showList, { loaded: '[MutateExportBanList]' });
  assert.ok(
    showList({ data: { loggedInSteamUser: { exportBanList } } }).includes('[MutateExportBanList]')
  );
  // An answer with no list, or none at all, says the list is unknown rather than failing.
  for (const data of [{ loggedInSteamUser: null }, undefined])
    assert.ok(showList({ data }).includes('Unknown Export Ban List'));

  const showConfigs = (fields) => render(h(ExportBanListConfigs, { exportBanListID: 1 }), fields);
  await checkStates('The points table', showConfigs, { loaded: 'Org&#x27;s' });
  assert.ok(showConfigs({ data: { loggedInSteamUser: { exportBanList } } }).includes('Org&#x27;s'));
}

// Deleting an export ban list: a delete that got no answer says so in its error box, as the other
// forms' error boxes do, one the web server refused gives its reason, and one that worked shows no
// error box.
for (const [error, messages] of [
  [noAnswer, [CHANGE_NOT_REACHED]],
  [databaseUnavailable, [DATABASE_UNAVAILABLE]],
  [undefined, null]
]) {
  mutationResult = { loading: false, error };
  render(h(DeleteExportBanList, { exportBanListID: 1 }));
  assert.deepStrictEqual(
    errorModals.length > 0 ? errorModals[0].errors.map(({ message }) => message) : null,
    messages
  );
  assert.ok(errorModals.length <= 1);
}

// A page that fails to render shows a message within the site's layout, with a way to reload.
{
  const html = render(h(PageError));
  assert.match(html, /^<div data-layout="">/);
  assert.match(html, /role="alert".*Something went wrong.*This page could not be shown/);
  const reloads = [];
  globalThis.window = { location: { reload: () => reloads.push(true) } };
  try {
    buttonCalled('Reload').onClick();
  } finally {
    delete globalThis.window;
  }
  assert.deepStrictEqual(reloads, [true]);
}

// The error boundary shows its children until one fails to render. Then it shows its fallback in
// their place, and keeps doing so until its resetKey changes, as when the user goes to another
// address. The update in which it caught the error is left alone, as the new address may be what
// failed.
{
  const fallback = h('p', null, 'Fallback');
  const props = { resetKey: 'first', fallback, children: h('p', null, 'Page') };
  assert.strictEqual(renderToStaticMarkup(h(ErrorBoundary, props)), '<p>Page</p>');

  const boundary = new ErrorBoundary(props);
  const resets = [];
  boundary.setState = (state) => resets.push(state);
  const failed = new Error('Render failed');
  const before = boundary.state;
  assert.deepStrictEqual(before, { error: null });
  boundary.state = { ...before, ...ErrorBoundary.getDerivedStateFromError(failed) };
  assert.strictEqual(renderToStaticMarkup(boundary.render()), '<p>Fallback</p>');

  boundary.componentDidUpdate({ ...props, resetKey: 'before' }, before);
  boundary.componentDidUpdate(props, boundary.state);
  assert.deepStrictEqual(resets, []);
  boundary.props = { ...props, resetKey: 'second' };
  boundary.componentDidUpdate(props, boundary.state);
  assert.deepStrictEqual(resets, [{ error: null }]);
}

// The app: its pages are within the error boundary, whose resetKey is the address the router is
// at, with the page error message as its fallback. Its queries give the pages their errors, rather
// than an empty answer or the part of one that arrived.
{
  let appClient;
  const boundaries = [];
  const locations = [];
  function Probe() {
    locations.push(useLocation());
    return h('p', null, 'Probe page');
  }
  const loadApp = loader(
    {
      ...packages,
      '@apollo/client': {
        ...apolloClient,
        ApolloClient: class extends ApolloClient {
          constructor(options) {
            super(options);
            appClient = { options, client: this };
          }
        }
      },
      '@apollo/client/react': { ApolloProvider: Plain },
      '@apollo/client/utilities': apolloUtilities,
      'react-router': {
        ...reactRouter,
        BrowserRouter: (props) => h(MemoryRouter, { initialEntries: ['/probe'] }, props.children)
      }
    },
    {
      ...stubs,
      'components/ErrorBoundary/index.jsx': {
        default: (props) => {
          boundaries.push(props);
          return props.children;
        }
      },
      'utils/apollo-link.js': { default: (link) => link },
      'utils/auth': { default: { restoreAuth() {} } },
      views: { default: [h(Route, { key: 'probe', path: '/probe', element: h(Probe) })] }
    }
  );
  const App = (await loadApp('app.jsx')).default;
  const AppPageError = (await loadApp('views/pages/page-error.jsx')).default;
  appClient.client.stop();

  states.length = 0;
  // The app renders once it has restored the user's sign-in.
  states.push(true);
  const html = renderToStaticMarkup(h(App));
  assert.strictEqual(html, '<p>Probe page</p>');
  assert.strictEqual(boundaries.length, 1);
  assert.strictEqual(locations.length, 1);
  assert.strictEqual(boundaries[0].resetKey, locations[0]);
  assert.strictEqual(locations[0].pathname, '/probe');
  assert.strictEqual(boundaries[0].fallback.type, AppPageError);

  // A query that fails, in part or as a whole, with the app's defaults for queries.
  const { defaultOptions, cache } = appClient.options;
  let respond;
  const client = new ApolloClient({
    link: new ApolloLink(() => respond()),
    cache,
    defaultOptions
  });
  const RECENT_BANS = gql`
    query RecentBans {
      bans(first: 1) {
        edges {
          node {
            id
            banList {
              id
            }
          }
        }
      }
    }
  `;
  async function firstResult() {
    const results = [];
    const subscription = client.watchQuery({ query: RECENT_BANS }).subscribe((result) => {
      results.push(result);
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    subscription.unsubscribe();
    assert.ok(results.length > 0);
    return results.at(-1);
  }
  respond = () =>
    new Observable((observer) => {
      observer.next({
        data: { bans: { edges: [{ node: { id: '1', banList: null } }] } },
        errors: [{ message: DATABASE_UNAVAILABLE, path: ['bans', 'edges', 0, 'node', 'banList'] }]
      });
      observer.complete();
    });
  let failed = await firstResult();
  assert.strictEqual(failed.error?.message, DATABASE_UNAVAILABLE);
  assert.strictEqual(failed.data, undefined);
  respond = () => new Observable((observer) => observer.error(new TypeError('fetch failed')));
  failed = await firstResult();
  assert.strictEqual(failed.error?.message, 'fetch failed');
  client.stop();
}

console.log(
  'Load error checks passed: loading and error states, Try again, Load More, the page error boundary and the query defaults.'
);
