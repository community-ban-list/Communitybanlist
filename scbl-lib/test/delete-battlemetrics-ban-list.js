import assert from 'assert';
import { readFile } from 'fs/promises';
import vm from 'vm';

const base = 'ban-lists/test-list/relationships';
let calls;
let failAt;
// The requests, as method and endpoint, that BattleMetrics answers 404, as the record is gone.
let goneAt;
let wrongOwner;
let invalidSubscription;
let loop;
const context = vm.createContext({ URL });
const subscription = (id) => ({
  type: 'banList',
  id: 'test-list',
  relationships: { organization: { data: { id } } }
});
const request = async (method, endpoint, params) => {
  calls.push([method, endpoint]);
  if (method === 'delete' && endpoint === failAt) {
    const error = new Error('Request failed with status code 400');
    error.response = { status: 400, data: { errors: [{ detail: 'Ownership transfer required' }] } };
    throw error;
  }
  if (goneAt.includes(`${method} ${endpoint}`)) {
    const error = new Error(`BattleMetrics ${method.toUpperCase()} ${endpoint} failed: HTTP 404`);
    error.response = { status: 404, data: { errors: [{ title: 'Not Found' }] } };
    throw error;
  }
  if (method === 'delete') return { status: 204 };
  if (endpoint === `${base}/organizations/42`)
    return {
      data: { data: { relationships: { owner: { data: { id: wrongOwner ? '99' : '42' } } } } }
    };
  const second = params['page[key]'] === 'next';
  const invites = endpoint.endsWith('/invites');
  const records = invites
    ? [{ type: 'banListInvite', id: second ? 'invite-two' : 'invite-one' }]
    : second
      ? [subscription('88')]
      : [subscription('42'), subscription('77')];
  if (!invites && invalidSubscription) records.push({ id: 'test-list' });
  return {
    data: {
      data: records,
      links: {
        next: second && !loop ? null : `https://api.battlemetrics.com/${endpoint}?page[key]=next`
      }
    }
  };
};
const module = new vm.SourceTextModule(
  await readFile(new URL('../apis/delete-battlemetrics-ban-list.js', import.meta.url), 'utf8'),
  { context }
);
await module.link(async (specifier) => {
  // The page reader is the real one, and makes its requests through the stand-in too.
  if (specifier === './read-battlemetrics-pages.js')
    return new vm.SourceTextModule(
      await readFile(new URL(`../apis/${specifier}`, import.meta.url), 'utf8'),
      { context }
    );
  const exports =
    specifier === './battlemetrics.js'
      ? { default: request }
      : { BATTLEMETRICS_ORGANIZATION: '42' };
  return new vm.SyntheticModule(
    Object.keys(exports),
    function () {
      for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
    },
    { context }
  );
});
await module.evaluate();
const remove = module.namespace.default;
const reset = () => {
  calls = [];
  failAt = null;
  goneAt = [];
  wrongOwner = false;
  invalidSubscription = false;
  loop = false;
};
const deletions = [
  ['delete', `${base}/invites/invite-one`],
  ['delete', `${base}/invites/invite-two`],
  ['delete', `${base}/organizations/77`],
  ['delete', `${base}/organizations/88`],
  ['delete', `${base}/organizations/42`]
];
reset();
await remove('test-list');
assert.deepStrictEqual(
  calls.filter(([method]) => method === 'delete'),
  deletions
);
assert.ok(calls.slice(0, 5).every(([method]) => method === 'get'));

// An invite or subscription that is already gone counts as removed, e.g. the owner's, when
// BattleMetrics removed it but answered too late, so the request was made again and got 404.
reset();
goneAt = [
  `delete ${base}/invites/invite-one`,
  `delete ${base}/organizations/77`,
  `delete ${base}/organizations/42`
];
await remove('test-list');
assert.deepStrictEqual(
  calls.filter(([method]) => method === 'delete'),
  deletions
);

// A 404 when checking ownership still fails, and the local list is kept, as it could also mean
// that the list's ID is wrong.
reset();
goneAt = [`get ${base}/organizations/42`];
await assert.rejects(remove('test-list'), /while checking ownership: Not Found/);
assert.deepStrictEqual(calls, [['get', `${base}/organizations/42`]]);

for (const endpoint of [
  `${base}/invites/invite-two`,
  `${base}/organizations/88`,
  `${base}/organizations/42`
]) {
  reset();
  failAt = endpoint;
  await assert.rejects(remove('test-list'), /Ownership transfer required/);
  assert.strictEqual(calls[calls.length - 1][1], endpoint);
}
reset();
wrongOwner = true;
await assert.rejects(remove('test-list'), /does not own/);
assert.strictEqual(calls.length, 1);
reset();
invalidSubscription = true;
await assert.rejects(remove('test-list'), /Invalid BattleMetrics subscription/);
assert.ok(calls.every(([method]) => method === 'get'));
reset();
loop = true;
await assert.rejects(remove('test-list'), /pagination/);
assert.ok(calls.every(([method]) => method === 'get'));
console.log('BattleMetrics cleanup checks passed.');
