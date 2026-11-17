import assert from 'assert';
import { readFile } from 'fs/promises';
import vm from 'vm';

import * as apolloClient from '@apollo/client';

const { ApolloClient, HttpLink, InMemoryCache, gql } = apolloClient;

// Checks what the client tells the user when a request fails: the errors its forms show for a
// change, and the messages its pages show for something they could not load. Requests go through
// Apollo Client's own HTTP link, with a stand-in for the browser's fetch, so each failure reaches
// the client's helper as it does in the browser.

// Load one of the client's modules. Its only package import is Apollo Client, which is the real
// package, so its errors are the ones the browser sees.
async function loadClient(path) {
  const url = new URL(path, import.meta.url);
  const module = new vm.SourceTextModule(await readFile(url, 'utf8'), { identifier: url.href });
  await module.link((specifier) => {
    assert.strictEqual(specifier, '@apollo/client', `Unexpected dependency: ${specifier}`);
    return new vm.SyntheticModule(Object.keys(apolloClient), function () {
      for (const [name, value] of Object.entries(apolloClient)) this.setExport(name, value);
    });
  });
  await module.evaluate();
  return module.namespace;
}

const {
  default: graphQLErrors,
  loadErrorMessages,
  CHANGE_NOT_REACHED,
  LOAD_NOT_REACHED
} = await loadClient('../../client/src/utils/graphql-errors.js');

// How the web server, or what stands between it and the browser, answers the next request.
let answer;
const client = new ApolloClient({
  link: new HttpLink({ uri: '/graphql', fetch: async () => answer() }),
  cache: new InMemoryCache(),
  // As in the client's app.jsx, so a failed change still gives its data to the form.
  defaultOptions: { mutate: { errorPolicy: 'all' } }
});

const DATABASE_UNAVAILABLE = 'The database is unavailable at the moment. Please try again shortly.';
const graphQLAnswer = (body) => () =>
  new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/graphql-response+json; charset=utf-8' }
  });
// A proxy's error page, as while the web server restarts.
const badGateway = () =>
  new Response('<html><body>502 Bad Gateway</body></html>', {
    status: 502,
    headers: { 'content-type': 'text/html' }
  });
// The browser's error for a request that got no answer, e.g. as the connection dropped.
const noAnswer = () => {
  throw new TypeError('fetch failed');
};

// A form's change, and the errors its error box shows.
const DELETE = gql`
  mutation DeleteExportBanList($id: Int!) {
    deleteExportBanList(id: $id) {
      id
    }
  }
`;
async function changeErrors(failure, update) {
  answer = failure;
  const { error } = await client.mutate({ mutation: DELETE, variables: { id: 1 }, update });
  return graphQLErrors(error).map((error) => error.message);
}

// A change the web server refused shows its reason.
const REFUSED = 'Export ban list does not exist!';
assert.deepStrictEqual(
  await changeErrors(
    graphQLAnswer({ data: { deleteExportBanList: null }, errors: [{ message: REFUSED }] })
  ),
  [REFUSED]
);

// A change that got no answer says so, and that it may still have been made, rather than showing
// an error box with nothing in it.
assert.deepStrictEqual(await changeErrors(badGateway), [CHANGE_NOT_REACHED]);
assert.deepStrictEqual(await changeErrors(noAnswer), [CHANGE_NOT_REACHED]);

// Any other error a change ends with, e.g. one in the page's own code once the change was made,
// shows its own message.
assert.deepStrictEqual(
  await changeErrors(
    graphQLAnswer({ data: { deleteExportBanList: { __typename: 'ExportBanList', id: 1 } } }),
    () => {
      throw new Error('Cache update failed');
    }
  ),
  ['Cache update failed']
);

// With no error there is nothing to show.
assert.deepStrictEqual(graphQLErrors(undefined), []);

// What a page that could not load its query tells the user. The pages' queries fail as a whole
// when any part of them fails (app.jsx).
const RECENT_BANS = gql`
  query RecentBans {
    bans(first: 3) {
      edges {
        node {
          id
          steamUser {
            id
          }
        }
      }
    }
  }
`;
async function loadMessages(failure) {
  answer = failure;
  const error = await client
    .query({ query: RECENT_BANS, fetchPolicy: 'network-only', errorPolicy: 'none' })
    .then(
      () => assert.fail('the query should fail'),
      (error) => error
    );
  return loadErrorMessages(error);
}

// The web server's own messages, which say why and what to do, each once however many parts of
// the answer failed for that reason.
const unreadPlayer = (index, message) => ({
  message,
  path: ['bans', 'edges', index, 'node', 'steamUser']
});
assert.deepStrictEqual(
  await loadMessages(
    graphQLAnswer({
      data: {
        bans: { edges: [0, 1, 2].map((id) => ({ node: { id: String(id), steamUser: null } })) }
      },
      errors: [
        unreadPlayer(0, DATABASE_UNAVAILABLE),
        unreadPlayer(1, DATABASE_UNAVAILABLE),
        unreadPlayer(2, 'Internal server error')
      ]
    })
  ),
  [DATABASE_UNAVAILABLE, 'Internal server error']
);

// A load that got no answer says so, in place of the browser's own message.
assert.deepStrictEqual(await loadMessages(badGateway), [LOAD_NOT_REACHED]);
assert.deepStrictEqual(await loadMessages(noAnswer), [LOAD_NOT_REACHED]);

// Any other error shows its own message.
assert.deepStrictEqual(loadErrorMessages(new Error('Something else failed')), [
  'Something else failed'
]);

client.stop();

console.log(
  'Client error message checks passed: refused changes, changes and loads that got no answer, and other errors.'
);
