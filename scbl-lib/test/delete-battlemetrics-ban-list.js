import assert from 'assert';
import { readFile } from 'fs/promises';
import vm from 'vm';

const base = 'ban-lists/test-list/relationships';
let calls;
let failAt;
let wrongOwner;
let invalidSubscription;
let loop;
const context = vm.createContext({ URL });
const subscription = (id) => ({
  type: 'banList', id: 'test-list',
  relationships: { organization: { data: { id } } }
});
const request = async (method, endpoint, params) => {
  calls.push([method, endpoint]);
  if (method === 'delete' && endpoint === failAt) {
    const error = new Error('Request failed with status code 400');
    error.response = { status: 400, data: { errors: [{ detail: 'Ownership transfer required' }] } };
    throw error;
  }
  if (method === 'delete') return { status: 204 };
  if (endpoint === `${base}/organizations/42`)
    return { data: { data: { relationships: { owner: { data: { id: wrongOwner ? '99' : '42' } } } } } };
  const second = params['page[key]'] === 'next';
  const invites = endpoint.endsWith('/invites');
  const records = invites
    ? [{ type: 'banListInvite', id: second ? 'invite-two' : 'invite-one' }]
    : second ? [subscription('88')] : [subscription('42'), subscription('77')];
  if (!invites && invalidSubscription) records.push({ id: 'test-list' });
  return { data: {
    data: records,
    links: { next: second && !loop ? null : `https://api.battlemetrics.com/${endpoint}?page[key]=next` }
  } };
};
const module = new vm.SourceTextModule(
  await readFile(new URL('../apis/delete-battlemetrics-ban-list.js', import.meta.url), 'utf8'),
  { context }
);
await module.link((specifier) => {
  const exports = specifier === './battlemetrics.js'
    ? { default: request } : { BATTLEMETRICS_ORGANIZATION: '42' };
  return new vm.SyntheticModule(Object.keys(exports), function () {
    for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
  }, { context });
});
await module.evaluate();
const remove = module.namespace.default;
const reset = () => {
  calls = [];
  failAt = null;
  wrongOwner = false;
  invalidSubscription = false;
  loop = false;
};
reset();
await remove('test-list');
assert.deepStrictEqual(calls.filter(([method]) => method === 'delete'), [
  ['delete', `${base}/invites/invite-one`],
  ['delete', `${base}/invites/invite-two`],
  ['delete', `${base}/organizations/77`],
  ['delete', `${base}/organizations/88`],
  ['delete', `${base}/organizations/42`]
]);
assert.ok(calls.slice(0, 5).every(([method]) => method === 'get'));

for (const endpoint of [
  `${base}/invites/invite-two`, `${base}/organizations/88`, `${base}/organizations/42`
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
