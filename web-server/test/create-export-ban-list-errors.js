import assert from 'assert';
import { readFile } from 'fs/promises';
import vm from 'vm';

import * as apolloClient from '@apollo/client';
import * as apolloClientErrors from '@apollo/client/errors';
import { Observable } from 'rxjs';

const { ApolloClient, ApolloLink, InMemoryCache, gql } = apolloClient;

// Load one of the client's modules. Its only package imports are Apollo Client's, which are the
// real package, so the cache and errors behave as they do in the browser.
async function loadClient(path) {
  const packages = { '@apollo/client': apolloClient, '@apollo/client/errors': apolloClientErrors };
  const url = new URL(path, import.meta.url);
  const module = new vm.SourceTextModule(await readFile(url, 'utf8'), { identifier: url.href });
  await module.link((specifier) => {
    const exports = packages[specifier];
    assert.ok(exports, `Unexpected dependency: ${specifier}`);
    return new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
    });
  });
  await module.evaluate();
  return module.namespace.default;
}

// The create form's cache update, and what its ErrorModal is given for an error.
const addToCache = await loadClient(
  '../../client/src/components/CreateExportBanList/add-to-cache.js'
);
const graphQLErrors = await loadClient('../../client/src/utils/graphql-errors.js');

// The list page's query, whose lists the cache update adds to.
const LISTS = gql`
  query GetExportBanLists {
    loggedInSteamUser {
      id
      exportBanLists {
        id
        name
      }
    }
  }
`;
// The form's create mutation, with the fields the cache update writes.
const CREATE = gql`
  mutation CreateExportBanList($name: String!, $discordWebhook: String) {
    createExportBanList(name: $name, server: "S", type: "remote", discordWebhook: $discordWebhook) {
      id
      name
      server
      type
      threshold
      defaultActivePoints
      defaultExpiredPoints
      maxBanAge
      discordWebhook
    }
  }
`;

// The web server answers each request with the next of these.
const answers = [];
const client = new ApolloClient({
  link: new ApolloLink(
    () =>
      new Observable((observer) => {
        observer.next(answers.shift());
        observer.complete();
      })
  ),
  cache: new InMemoryCache(),
  // As in the client's app.jsx, which passes a failed mutation's data to its cache update too.
  defaultOptions: { mutate: { errorPolicy: 'all' } }
});

// What the web server answers when it refuses to create a list, here because the user has tested
// too many webhooks.
const MESSAGE =
  'Discord webhooks can only be tested 5 times a minute. Please try again in 50 seconds.';
const refused = {
  data: { createExportBanList: null },
  errors: [{ message: MESSAGE, path: ['createExportBanList'] }]
};
const created = (id, name) => ({
  data: {
    createExportBanList: {
      __typename: 'ExportBanList',
      id,
      name,
      server: 'S',
      type: 'remote',
      threshold: 9,
      defaultActivePoints: 3,
      defaultExpiredPoints: 1,
      maxBanAge: null,
      discordWebhook: ''
    }
  }
});
const create = (name) =>
  client.mutate({ mutation: CREATE, variables: { name, discordWebhook: '' }, update: addToCache });
const cachedLists = () =>
  client.readQuery({ query: LISTS }).loggedInSteamUser.exportBanLists.map(({ id }) => id);

// With nothing cached, as when the form's address is opened directly, the form shows the error.
answers.push(refused);
let result = await create('Refused');
assert.deepStrictEqual(
  graphQLErrors(result.error).map(({ message }) => message),
  [MESSAGE]
);

// Opening the form from the list page leaves the user's lists in the cache. A refused create still
// reaches the form as the web server's errors, and the cached lists stay as they were.
client.writeQuery({
  query: LISTS,
  data: {
    loggedInSteamUser: {
      __typename: 'SteamUser',
      id: 'owner',
      exportBanLists: [{ __typename: 'ExportBanList', id: 1, name: 'First' }]
    }
  }
});
answers.push(refused);
result = await create('Refused');
assert.deepStrictEqual(
  graphQLErrors(result.error).map(({ message }) => message),
  [MESSAGE]
);
assert.deepStrictEqual(cachedLists(), [1]);

// A create that works adds the new list to the cached lists, and the same list coming back again
// is not added twice.
answers.push(created(2, 'Second'));
result = await create('Second');
assert.strictEqual(result.error, undefined);
assert.strictEqual(result.data.createExportBanList.id, 2);
assert.deepStrictEqual(cachedLists(), [1, 2]);
answers.push(created(2, 'Second'));
await create('Second');
assert.deepStrictEqual(cachedLists(), [1, 2]);
assert.strictEqual(answers.length, 0);

client.stop();

console.log(
  'Create export ban list error checks passed: refused creates show their errors, and new lists are cached.'
);
