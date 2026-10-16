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

// The config forms' cache updates, and what their ErrorModals are given for an error.
const addToCache = await loadClient(
  '../../client/src/components/CreateExportBanListConfig/add-to-cache.js'
);
const removeFromCache = await loadClient(
  '../../client/src/components/DeleteExportBanListConfig/remove-from-cache.js'
);
const graphQLErrors = await loadClient('../../client/src/utils/graphql-errors.js');

// The configs page's query, whose configs the cache updates add to and remove from.
const CONFIGS = gql`
  query GetExportBanListConfigs($exportBanListID: Int!) {
    loggedInSteamUser {
      id
      exportBanList(id: $exportBanListID) {
        id
        exportBanListConfigs {
          id
          activePoints
          expiredPoints
        }
      }
    }
  }
`;
// The forms' mutations, with the fields their cache updates use.
const CREATE = gql`
  mutation CreateExportBanListConfig($banList: Int!) {
    createExportBanListConfig(
      exportBanList: 1
      banList: $banList
      activePoints: 3
      expiredPoints: 1
    ) {
      id
      activePoints
      expiredPoints

      exportBanList {
        id
        name
      }
    }
  }
`;
const DELETE = gql`
  mutation DeleteExportBanListConfig($id: Int!) {
    deleteExportBanListConfig(id: $id) {
      id
      exportBanList {
        id
      }
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

// What the web server answers when it refuses a create or a delete.
const refused = (field, message) => ({
  data: { [field]: null },
  errors: [{ message, path: [field] }]
});
const created = (id) => ({
  data: {
    createExportBanListConfig: {
      __typename: 'ExportBanListConfig',
      id,
      activePoints: 3,
      expiredPoints: 1,
      exportBanList: { __typename: 'ExportBanList', id: 1, name: 'List' }
    }
  }
});
const deleted = (id) => ({
  data: {
    deleteExportBanListConfig: {
      __typename: 'ExportBanListConfig',
      id,
      exportBanList: { __typename: 'ExportBanList', id: 1 }
    }
  }
});
const create = (banList) =>
  client.mutate({ mutation: CREATE, variables: { banList }, update: addToCache });
const remove = (id) =>
  client.mutate({ mutation: DELETE, variables: { id }, update: removeFromCache });
const messages = (result) => graphQLErrors(result.error).map(({ message }) => message);
const cachedConfigs = () =>
  client
    .readQuery({ query: CONFIGS, variables: { exportBanListID: 1 } })
    .loggedInSteamUser.exportBanList.exportBanListConfigs.map(({ id }) => id);

const EXISTS = 'Export ban list config already exists for this ban list.';
const NO_BAN_LIST = 'Ban list does not exist!';
const NO_CONFIG = 'Export ban list config does not exist!';

// With nothing cached, a refused create or delete still shows the web server's error.
answers.push(refused('createExportBanListConfig', NO_BAN_LIST));
assert.deepStrictEqual(messages(await create(5)), [NO_BAN_LIST]);
answers.push(refused('deleteExportBanListConfig', NO_CONFIG));
assert.deepStrictEqual(messages(await remove(10)), [NO_CONFIG]);

// The configs page leaves the export ban list's configs in the cache. A refused create reaches the
// form as the web server's errors, and the cached configs stay as they were.
client.writeQuery({
  query: CONFIGS,
  variables: { exportBanListID: 1 },
  data: {
    loggedInSteamUser: {
      __typename: 'SteamUser',
      id: 'owner',
      exportBanList: {
        __typename: 'ExportBanList',
        id: 1,
        exportBanListConfigs: [
          { __typename: 'ExportBanListConfig', id: 10, activePoints: 3, expiredPoints: 1 }
        ]
      }
    }
  }
});
answers.push(refused('createExportBanListConfig', EXISTS));
assert.deepStrictEqual(messages(await create(5)), [EXISTS]);
assert.deepStrictEqual(cachedConfigs(), [10]);

// A create that works adds the new config to the cached configs, and the same config coming back
// again is not added twice.
answers.push(created(11));
let result = await create(6);
assert.strictEqual(result.error, undefined);
assert.strictEqual(result.data.createExportBanListConfig.id, 11);
assert.deepStrictEqual(cachedConfigs(), [10, 11]);
answers.push(created(11));
await create(6);
assert.deepStrictEqual(cachedConfigs(), [10, 11]);

// A refused delete shows the web server's error and keeps the cached configs, and one that works
// removes only the deleted config.
answers.push(refused('deleteExportBanListConfig', NO_CONFIG));
assert.deepStrictEqual(messages(await remove(12)), [NO_CONFIG]);
assert.deepStrictEqual(cachedConfigs(), [10, 11]);
answers.push(deleted(10));
result = await remove(10);
assert.strictEqual(result.error, undefined);
assert.deepStrictEqual(cachedConfigs(), [11]);
assert.strictEqual(answers.length, 0);

client.stop();

console.log(
  'Export ban list config error checks passed: refused creates and deletes show their errors, and the cached configs follow the ones that work.'
);
