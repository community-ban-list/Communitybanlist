import assert from 'assert';
import { readFile } from 'fs/promises';
import vm from 'vm';

const base = 'ban-lists/test-list/relationships';
let calls;
let failAt;
// A request that times out without an answer, so its error gives only the request's path.
let timeoutAt;
// The requests, as method and endpoint, that BattleMetrics answers 404, as the record is gone.
let goneAt;
// What BattleMetrics answers when the ban list itself is looked up: an answer, or an error.
let banListAnswer;
// An error for the ownership check to fail with, or an answer for it to get instead of CBL's.
let ownershipError;
let ownershipAnswer;
let wrongOwner;
let invalidSubscription;
let loop;
const context = vm.createContext({ URL });
const subscription = (id) => ({
  type: 'banList',
  id: 'test-list',
  relationships: { organization: { data: { id } } }
});
// An error as the BattleMetrics client throws one for an answer with this status and these errors.
const apiError = (status, errors) =>
  Object.assign(new Error(`BattleMetrics GET failed: HTTP ${status}`), {
    response: { status, data: { errors } }
  });
const request = async (method, endpoint, params) => {
  calls.push([method, endpoint]);
  if (method === 'delete' && endpoint === failAt) {
    const error = new Error('Request failed with status code 400');
    error.response = { status: 400, data: { errors: [{ detail: 'Ownership transfer required' }] } };
    throw error;
  }
  if (method === 'delete' && endpoint === timeoutAt)
    throw Object.assign(
      new Error(`BattleMetrics DELETE ${endpoint} failed after 3 attempts: timed out after 30s`),
      { code: 'ECONNABORTED' }
    );
  if (goneAt.includes(`${method} ${endpoint}`)) {
    const error = new Error(`BattleMetrics ${method.toUpperCase()} ${endpoint} failed: HTTP 404`);
    error.response = { status: 404, data: { errors: [{ title: 'Not Found' }] } };
    throw error;
  }
  if (method === 'delete') return { status: 204 };
  if (endpoint === 'ban-lists/test-list') {
    if (banListAnswer instanceof Error) throw banListAnswer;
    return banListAnswer;
  }
  if (endpoint === `${base}/organizations/42`) {
    if (ownershipError) throw ownershipError;
    if (ownershipAnswer) return ownershipAnswer;
    return {
      data: { data: { relationships: { owner: { data: { id: wrongOwner ? '99' : '42' } } } } }
    };
  }
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
const { checkOwnership, removeInvitesAndSubscribers, removeOwner } = module.namespace;
// The steps in the order ExportBanList's deleteExportBanList takes them, without its saves.
const remove = async (id) => {
  if (!(await checkOwnership(id))) return 'gone';
  await removeInvitesAndSubscribers(id);
  await removeOwner(id);
  return 'deleted';
};
const reset = () => {
  calls = [];
  failAt = null;
  timeoutAt = null;
  goneAt = [];
  banListAnswer = { data: { data: { type: 'banList', id: 'test-list' } } };
  ownershipError = null;
  ownershipAnswer = null;
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
assert.strictEqual(await remove('test-list'), 'deleted');
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
assert.strictEqual(await remove('test-list'), 'deleted');
assert.deepStrictEqual(
  calls.filter(([method]) => method === 'delete'),
  deletions
);

// A 404 when checking ownership means CBL's organisation is not on the ban list. The ban list is
// then looked up, and it is only gone when BattleMetrics answers that it does not know it, whether
// it says so in the error's title or its detail. Nothing is removed either way.
const ownership = ['get', `${base}/organizations/42`];
const lookUp = ['get', 'ban-lists/test-list'];
for (const unknown of [
  { status: '404', title: 'Not Found', detail: 'Unknown ban list.' },
  { status: '404', title: 'Unknown ban list' }
]) {
  reset();
  goneAt = [`get ${base}/organizations/42`];
  banListAnswer = apiError(404, [unknown]);
  assert.strictEqual(await remove('test-list'), 'gone');
  assert.deepStrictEqual(calls, [ownership, lookUp]);
}

// A ban list that BattleMetrics still has is kept, as the configured organisation may be wrong.
// The error ends its reason with one full stop.
reset();
goneAt = [`get ${base}/organizations/42`];
await assert.rejects(
  remove('test-list'),
  /^Error: BattleMetrics deletion failed while checking ownership: The BattleMetrics list still exists, but the configured CBL organization does not own it, so the configured organization may be wrong\. The local list was retained;/
);
assert.deepStrictEqual(calls, [ownership, lookUp]);

// So is one whose look-up gets any other answer: a refused key, a refusal, a rate limit, a
// failure, no answer in time, an answer that is not a ban list, or a 404 that does not say that
// the ban list is unknown.
for (const [answer, message] of [
  [apiError(401, [{ title: 'Unauthorized' }]), /Unauthorized/],
  [apiError(403, [{ title: 'Forbidden', detail: 'Unknown ban list.' }]), /Unknown ban list/],
  [apiError(429, [{ title: 'Too Many Requests' }]), /Too Many Requests/],
  [apiError(503, undefined), /HTTP 503/],
  [
    Object.assign(new Error('BattleMetrics GET ban-lists/test-list failed: timed out after 30s'), {
      code: 'ECONNABORTED'
    }),
    /timed out after 30s/
  ],
  [{ data: '<html>Not JSON</html>' }, /Invalid BattleMetrics ban list response/],
  [apiError(404, undefined), /HTTP 404/],
  [apiError(404, [{ title: 'Not Found', detail: 'Route not found.' }]), /Route not found/]
]) {
  reset();
  goneAt = [`get ${base}/organizations/42`];
  banListAnswer = answer;
  await assert.rejects(remove('test-list'), (error) => {
    assert.match(error.message, /^BattleMetrics deletion failed while checking ownership: /);
    assert.match(error.message, message);
    // A reason that ends in a full stop, such as "Unknown ban list.", is not given a second one.
    assert.match(error.message, /[^.]\. The local list was retained;/);
    return true;
  });
  assert.deepStrictEqual(calls, [ownership, lookUp]);
}

// An answer to the ownership check that does not say who owns the ban list fails the check, and
// says so, without looking the ban list up.
for (const answer of [
  { data: '<html>Not JSON</html>' },
  { data: {} },
  { data: { data: { relationships: { owner: { data: null } } } } }
]) {
  reset();
  ownershipAnswer = answer;
  await assert.rejects(remove('test-list'), (error) => {
    assert.strictEqual(
      error.message,
      'BattleMetrics deletion failed while checking ownership: Invalid BattleMetrics ownership response. The local list was retained; any invites or subscriptions already removed remain removed.'
    );
    return true;
  });
  assert.deepStrictEqual(calls, [ownership]);
}

// Any other failure of the ownership check fails without looking the ban list up.
for (const status of [401, 403, 429, 500]) {
  reset();
  ownershipError = apiError(status, [{ title: `HTTP ${status} title` }]);
  await assert.rejects(remove('test-list'), new RegExp(`while checking ownership: HTTP ${status}`));
  assert.deepStrictEqual(calls, [ownership]);
}

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
// An invite's ID is its code, with which any organisation can use the ban list, so the error for a
// removal that failed without BattleMetrics saying why gives the request's path without it.
reset();
timeoutAt = `${base}/invites/invite-two`;
await assert.rejects(remove('test-list'), (error) => {
  assert.strictEqual(
    error.message,
    `BattleMetrics deletion failed while removing invites: BattleMetrics DELETE ${base}/invites/[invite code] failed after 3 attempts: timed out after 30s. The local list was retained; any invites or subscriptions already removed remain removed.`
  );
  return true;
});
assert.strictEqual(calls[calls.length - 1][1], timeoutAt);
reset();
failAt = `${base}/organizations/42`;
await assert.rejects(
  removeOwner('test-list'),
  /^Error: BattleMetrics deletion failed while removing owner: Ownership transfer required\./
);
reset();
wrongOwner = true;
await assert.rejects(
  remove('test-list'),
  /: The configured CBL organization does not own this BattleMetrics list\. The local list was retained;/
);
assert.strictEqual(calls.length, 1);
reset();
invalidSubscription = true;
await assert.rejects(
  remove('test-list'),
  /while listing subscribers: Invalid BattleMetrics subscription response\. The local list was retained;/
);
assert.ok(calls.every(([method]) => method === 'get'));
reset();
loop = true;
await assert.rejects(remove('test-list'), /pagination/);
assert.ok(calls.every(([method]) => method === 'get'));
console.log('BattleMetrics cleanup checks passed.');
