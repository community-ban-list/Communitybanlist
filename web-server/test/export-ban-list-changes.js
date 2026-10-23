import assert from 'assert';
import { readFile } from 'fs/promises';
import vm from 'vm';

import * as exportListLimits from '../../scbl-lib/export-list-limits.js';
import logText from '../../scbl-lib/utils/log-text.js';
import Validators from '../../scbl-lib/validators.js';

// Checks for changes to export ban lists and their configs. Part 1 checks the guard that
// mutation/index.js puts on the mutations: changes need signing in, each user's are made one at a
// time, and creating and deleting lists is limited. Part 2 checks that the resolvers in
// mutation/resolver.js only look up and change the user's own lists and configs. Part 3 checks
// that, through mutation/index.js, the resolvers' checks hold when a user makes changes at once,
// and that the changes they refuse do not count towards the limits.

const MUTATIONS = [
  'createExportBanList',
  'updateExportBanList',
  'deleteExportBanList',
  'createExportBanListConfig',
  'deleteExportBanListConfig'
];
// The changes that neither create nor delete a list, which have no limits.
const UNLIMITED = ['updateExportBanList', 'createExportBanListConfig', 'deleteExportBanListConfig'];
const SIGN_IN = { message: 'Please sign in again to change your export ban lists.' };
const LIST_LIMIT = 'You are limited to 4 export ban lists.';
const CONFIG_EXISTS = 'Export ban list config already exists for this ban list.';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

// Load a module in a context. The imports in `stubs` get those exports, and other relative
// imports load the real files.
async function load(path, stubs, context) {
  const create = async (url) =>
    new vm.SourceTextModule(await readFile(url, 'utf8'), { context, identifier: url.href });
  const linker = async (specifier, referencingModule) => {
    if (Object.hasOwn(stubs, specifier)) {
      const exports = stubs[specifier];
      return new vm.SyntheticModule(
        Object.keys(exports),
        function () {
          for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
        },
        { context }
      );
    }
    assert.ok(specifier.startsWith('.'), `Unexpected dependency: ${specifier}`);
    return create(new URL(specifier, referencingModule.identifier));
  };
  const module = await create(new URL(path, import.meta.url));
  await module.link(linker);
  await module.evaluate();
  return module.namespace;
}

// Let the changes in progress run until they wait for something the checks control.
const settle = () => new Promise((resolve) => setImmediate(resolve));

const as = (id) => ({ user: { id } });
const outcomes = (results) =>
  results.map(({ status, value, reason }) => (status === 'fulfilled' ? value : reason.message));

// Part 1: the guard, through mutation/index.js, with stand-ins for the mutations in resolver.js.

// The maps the guard keeps, to check that it forgets changes once they have finished.
const maps = [];
class RecordedMap extends Map {
  constructor(...args) {
    super(...args);
    maps.push(this);
  }
}
const guardContext = vm.createContext({ Map: RecordedMap });

// Each stand-in records its change and then makes it with `change`, which the checks set.
const made = [];
let change;
const standIns = Object.fromEntries(
  MUTATIONS.map((name) => [
    name,
    async (parent, args, context, info) => {
      made.push({ name, parent, args, context, info });
      return change(name, args, context);
    }
  ])
);
const typedef = { kind: 'Document' };
const { typedef: exportedTypedef, resolver } = await load(
  '../src/graphql-api/mutation/index.js',
  { './typedef.js': { default: typedef }, './resolver.js': { default: { Mutation: standIns } } },
  guardContext
);
const { Mutation } = resolver;
const {
  default: guardChanges,
  CREATES_AND_DELETES_PER_MINUTE: PER_MINUTE,
  CREATES_AND_DELETES_PER_HOUR: PER_HOUR
} = await load('../src/graphql-api/mutation/guard-changes.js', {}, guardContext);

// The checks below work out their times and counts from the limits, so the limits can be tuned
// within these bounds. A user can replace a list at once, and in an hour can create their 4 lists
// and replace two of them.
assert.ok(PER_MINUTE >= 2 && PER_MINUTE <= 5, 'The checks need a minute limit from 2 to 5.');
assert.ok(
  PER_HOUR >= Math.max(8, PER_MINUTE + 2) && PER_HOUR <= 30 * PER_MINUTE,
  'The checks need an hourly limit of at least 8, from 2 more than the minute limit to 30 times it.'
);
const minuteLimit = (wait) => ({
  message: `Export ban lists can only be created or deleted ${PER_MINUTE} times a minute. Please try again in ${wait}.`
});
const hourLimit = (wait) => ({
  message: `Export ban lists can only be created or deleted ${PER_HOUR} times an hour. Please try again in ${wait}.`
});

// index.js passes the type definitions on and guards all five mutations. Each one is given the
// change's arguments and context, and its result is passed back.
assert.strictEqual(exportedTypedef, typedef);
assert.deepStrictEqual(Object.keys(Mutation).sort(), [...MUTATIONS].sort());
change = async (name) => `${name} made`;
for (const name of MUTATIONS) {
  assert.notStrictEqual(Mutation[name], standIns[name]);
  const [parent, args, context, info] = [{}, { id: 7 }, as(`wiring ${name}`), {}];
  assert.strictEqual(await Mutation[name](parent, args, context, info), `${name} made`);
  const call = made.pop();
  assert.strictEqual(call.name, name);
  assert.ok(call.parent === parent && call.args === args, `${name} is given the arguments`);
  assert.ok(call.context === context && call.info === info, `${name} is given the context`);
}

// A signed-out request's context has no user, or a user without an ID. Its changes are refused
// before any of them is made.
for (const name of MUTATIONS)
  for (const context of [{ user: null }, {}, { user: {} }])
    await assert.rejects(Mutation[name](null, { id: 7 }, context, {}), SIGN_IN);
assert.strictEqual(made.length, 0);

// Each user's changes are made one at a time, in the order they were asked for, and other users'
// changes are made alongside. Here each change waits until the checks let it finish.
const events = [];
const finish = {};
const allowed = {};
for (const id of ['first', 'second', 'neighbour', 'third'])
  allowed[id] = new Promise((resolve) => (finish[id] = resolve));
const finishWhenAllowed = async (name, args) => {
  events.push(`${args.id} started`);
  await allowed[args.id];
  events.push(`${args.id} finished`);
  return args.id;
};
change = finishWhenAllowed;
const changes = [
  Mutation.updateExportBanList(null, { id: 'first' }, as('alice'), {}),
  Mutation.createExportBanListConfig(null, { id: 'second' }, as('alice'), {}),
  Mutation.deleteExportBanListConfig(null, { id: 'neighbour' }, as('bob'), {}),
  Mutation.createExportBanList(null, { id: 'third' }, as('alice'), {})
];
await settle();
assert.deepStrictEqual(events, ['first started', 'neighbour started']);
// The second change could finish at once, but it does not start before the first has finished.
finish.second();
await settle();
assert.deepStrictEqual(events, ['first started', 'neighbour started']);
finish.neighbour();
await settle();
assert.deepStrictEqual(events, ['first started', 'neighbour started', 'neighbour finished']);
finish.first();
await settle();
assert.deepStrictEqual(events.slice(3), [
  'first finished',
  'second started',
  'second finished',
  'third started'
]);
finish.third();
assert.deepStrictEqual(await Promise.all(changes), ['first', 'second', 'neighbour', 'third']);

// A change that fails does not hold up the user's next one, and its error is passed on as it is.
const failure = new Error('Database unavailable');
change = async (name, args) => {
  await settle();
  if (args.id === 'failing') throw failure;
  return args.id;
};
const failing = Mutation.updateExportBanList(null, { id: 'failing' }, as('carol'), {});
const next = Mutation.deleteExportBanListConfig(null, { id: 'next' }, as('carol'), {});
await assert.rejects(failing, (error) => error === failure);
assert.strictEqual(await next, 'next');

// A change waits for all of the user's changes in progress, not only the first. Here the user's
// third change is asked for once their first has finished, while their second is being made.
events.length = 0;
for (const id of ['earlier', 'later', 'latest'])
  allowed[id] = new Promise((resolve) => (finish[id] = resolve));
change = finishWhenAllowed;
const earlier = Mutation.updateExportBanList(null, { id: 'earlier' }, as('helen'), {});
const later = Mutation.createExportBanListConfig(null, { id: 'later' }, as('helen'), {});
finish.earlier();
assert.strictEqual(await earlier, 'earlier');
await settle();
const latest = Mutation.deleteExportBanListConfig(null, { id: 'latest' }, as('helen'), {});
finish.latest();
await settle();
assert.deepStrictEqual(events, ['earlier started', 'earlier finished', 'later started']);
finish.later();
assert.deepStrictEqual(await Promise.all([later, latest]), ['later', 'latest']);
assert.deepStrictEqual(events.slice(3), ['later finished', 'latest started', 'latest finished']);

// Creating and deleting lists count towards the limits, together, and other changes do not. These
// changes use the real clock, so they all fall within a minute.
change = async (name) => name;
made.length = 0;
for (let i = 0; i < PER_MINUTE; i++) {
  const name = i % 2 ? 'deleteExportBanList' : 'createExportBanList';
  assert.strictEqual(await Mutation[name](null, { id: i }, as('dave'), {}), name);
}
const minuteLimitNow = new RegExp(
  `^Export ban lists can only be created or deleted ${PER_MINUTE} times a minute\\. Please try again in (1 minute|\\d+ seconds)\\.$`
);
await assert.rejects(Mutation.createExportBanList(null, {}, as('dave'), {}), {
  message: minuteLimitNow
});
await assert.rejects(Mutation.deleteExportBanList(null, { id: 0 }, as('dave'), {}), {
  message: minuteLimitNow
});
assert.strictEqual(made.length, PER_MINUTE);
for (const name of UNLIMITED)
  for (let i = 0; i <= PER_HOUR; i++) await Mutation[name](null, { id: i }, as('dave'), {});
assert.strictEqual(made.length, PER_MINUTE + 3 * (PER_HOUR + 1));
assert.strictEqual(
  await Mutation.createExportBanList(null, {}, as('erin'), {}),
  'createExportBanList'
);

// A user making changes at once cannot get past checks that look up their rows and then change
// them, as resolver.js does for the limit of 4 lists and for one config for each ban list. Other
// users' changes are made alongside. The clock here moves on an hour each time it is read, so the
// limits allow every change.
const rows = [];
let hours = 0;
const lookUpThenChange = guardChanges(
  {
    async createExportBanList(parent, args, context) {
      const count = rows.filter((row) => row.owner === context.user.id && row.list).length;
      await settle();
      if (count >= 4) throw new Error(LIST_LIMIT);
      rows.push({ owner: context.user.id, list: true });
      return 'created';
    },
    async createExportBanListConfig(parent, args, context) {
      const user = context.user.id;
      const exists = rows.some((row) => row.owner === user && row.banList === args.banList);
      await settle();
      if (exists) throw new Error(CONFIG_EXISTS);
      rows.push({ owner: user, banList: args.banList });
      return 'added';
    }
  },
  () => ++hours * HOUR
);
const atOnce = (count, name, args, users) =>
  Promise.allSettled(
    Array.from({ length: count }, (_, i) =>
      lookUpThenChange[name](null, args, as(users[i % users.length]), {})
    )
  );
const lists = outcomes(await atOnce(50, 'createExportBanList', {}, ['frank', 'grace']));
assert.strictEqual(rows.filter((row) => row.owner === 'frank').length, 4);
assert.strictEqual(rows.filter((row) => row.owner === 'grace').length, 4);
assert.deepStrictEqual(lists, [...Array(8).fill('created'), ...Array(42).fill(LIST_LIMIT)]);
const configs = outcomes(await atOnce(25, 'createExportBanListConfig', { banList: 1 }, ['frank']));
assert.strictEqual(rows.filter((row) => row.banList === 1).length, 1);
assert.deepStrictEqual(configs, ['added', ...Array(24).fill(CONFIG_EXISTS)]);

// A user can create and delete a few lists a minute and an hour, and is told when they can make
// another. Each call is made at the given time, and the times never go backwards, as on a real
// clock.
let clock;
const mapsBefore = maps.length;
const limited = guardChanges(
  Object.fromEntries(MUTATIONS.map((name) => [name, async () => name])),
  () => clock
);
const limitedMaps = maps.slice(mapsBefore);
assert.ok(limitedMaps.length > 0, 'The guard keeps what it needs in maps.');
const at = (time, name, user) => {
  clock = time;
  return limited[name](null, { id: 1 }, as(user), {});
};
const create = (time, user) => at(time, 'createExportBanList', user);
const remove = (time, user) => at(time, 'deleteExportBanList', user);
const start = Date.UTC(2026, 0, 1);

// The user creates a list, and a second later makes the rest of the minute's creates and deletes.
await create(start, 'busy');
for (let i = 1; i < PER_MINUTE; i++) await (i % 2 ? remove : create)(start + SECOND, 'busy');
await assert.rejects(create(start + 10 * SECOND, 'busy'), minuteLimit('50 seconds'));
await assert.rejects(remove(start + 10 * SECOND, 'busy'), minuteLimit('50 seconds'));
// Other users can still create lists, and the user can still make other changes.
await create(start + 10 * SECOND, 'someone-else');
for (const name of UNLIMITED) assert.strictEqual(await at(start + 10 * SECOND, name, 'busy'), name);
// Refused changes do not count, so trying again when told works. The changes from a second after
// the first are still under a minute old, so the next one waits for them.
await assert.rejects(create(start + MINUTE - 1, 'busy'), minuteLimit('1 second'));
await create(start + MINUTE, 'busy');
await assert.rejects(remove(start + MINUTE + 1, 'busy'), minuteLimit('1 second'));
await remove(start + MINUTE + SECOND, 'busy');

// Make so many creates and deletes for a user from the given time, as fast as the minute limit
// allows: a minute's worth at once, and the same again each minute after.
async function useUp(user, from, count) {
  for (let i = 0; i < count; i++)
    await (i % 2 ? remove : create)(from + Math.floor(i / PER_MINUTE) * MINUTE, user);
}

// A user who keeps within the minute limit still reaches the hourly one, which says how many
// minutes are left.
const hourly = start + HOUR;
await useUp('hourly', hourly, PER_HOUR);
await assert.rejects(create(hourly + 30 * MINUTE, 'hourly'), hourLimit('30 minutes'));
await assert.rejects(remove(hourly + HOUR - 1, 'hourly'), hourLimit('1 second'));
await create(hourly + HOUR, 'hourly');

// When both limits are reached, the longer wait is given, so trying again then works. Each user
// makes all but a minute's worth of their hourly changes from the given time, then the rest at
// once.
async function reachBothLimits(user, from, burst) {
  await useUp(user, from, PER_HOUR - PER_MINUTE);
  for (let i = 0; i < PER_MINUTE; i++) await (i % 2 ? remove : create)(burst + i, user);
}
const early = start + 3 * HOUR;
await reachBothLimits('early-burst', early, early + 30 * MINUTE);
await assert.rejects(
  create(early + 30 * MINUTE + 10 * SECOND, 'early-burst'),
  hourLimit('30 minutes')
);
await create(early + HOUR, 'early-burst');
const late = start + 5 * HOUR;
await reachBothLimits('late-burst', late, late + HOUR - 30 * SECOND);
await assert.rejects(remove(late + HOUR - 20 * SECOND, 'late-burst'), minuteLimit('50 seconds'));
// The hourly limit alone would allow a change by now.
await assert.rejects(create(late + HOUR, 'late-burst'), minuteLimit('30 seconds'));
await create(late + HOUR + 30 * SECOND, 'late-burst');

// Changes made at the same moment share the limit, so making them together cannot get past it,
// and only the changes it allows are made.
const together = outcomes(
  await Promise.allSettled(
    Array.from({ length: PER_MINUTE + 3 }, () => create(start + 7 * HOUR, 'together'))
  )
);
assert.deepStrictEqual(together, [
  ...Array(PER_MINUTE).fill('createExportBanList'),
  ...Array(3).fill(minuteLimit('1 minute').message)
]);

// A creation or deletion that resolver.js refuses before it changes anything does not count, so a
// user who corrects their mistakes can try again at once. Any other failure counts, as it may have
// come after requests to BattleMetrics. Each stand-in here waits until it is allowed to finish, if
// it is given a promise to wait for, and fails with the error it is given, which it marks as a
// refusal, as refusal.js does, when told to.
const mapsBeforeRefusing = maps.length;
const refusing = guardChanges(
  Object.fromEntries(
    MUTATIONS.map((name) => [
      name,
      async (parent, { error, until, marked }) => {
        await settle();
        await until;
        if (error) throw Object.assign(new Error(error), marked ? { refusal: true } : {});
        return name;
      }
    ])
  ),
  () => clock
);
const refusingMaps = maps.slice(mapsBeforeRefusing);
const attempt = (time, name, user, error, until, marked) => {
  clock = time;
  return refusing[name](null, { error, until, marked }, as(user), {});
};
const createOrDelete = (i) => (i % 2 ? 'deleteExportBanList' : 'createExportBanList');
const refusals = [
  LIST_LIMIT,
  'Export ban list does not exist!',
  'Invalid export ban list type.',
  'Invalid Discord Webhook',
  'We could not post a test message to your Discord webhook. Unknown Webhook.',
  'Only one Discord webhook can be tested per request. Please save one export ban list at a time.',
  'Discord webhooks can only be tested 5 times a minute. Please try again in 40 seconds.'
];
// Errors marked as refusals, such as settings outside the limits on export ban lists, are refusals
// whatever they say.
const markedRefusals = [
  'The threshold must be a whole number from 1 to 1,000.',
  "A remote export ban list's threshold must be at least 4.",
  'A refusal with any message.'
];

// The user is refused more often than the hourly limit allows changes, and can still make the
// minute's worth.
const refusedAt = start + 8 * HOUR;
for (let i = 0; i <= PER_HOUR; i++) {
  for (const error of refusals)
    await assert.rejects(attempt(refusedAt, createOrDelete(i), 'mistaken', error), {
      message: error
    });
  for (const error of markedRefusals)
    await assert.rejects(
      attempt(refusedAt, createOrDelete(i), 'mistaken', error, undefined, true),
      { message: error }
    );
}
for (let i = 0; i < PER_MINUTE; i++)
  assert.strictEqual(
    await attempt(refusedAt + SECOND, createOrDelete(i), 'mistaken'),
    createOrDelete(i)
  );
await assert.rejects(
  attempt(refusedAt + 2 * SECOND, 'createExportBanList', 'mistaken'),
  minuteLimit('59 seconds')
);

// Failures that are not refusals count, such as BattleMetrics or the database failing.
const failures = [
  'BattleMetrics could not create a ban list for your export ban list, so it was not created. Please try again later.',
  'BattleMetrics DELETE ban-lists/1 failed after 3 attempts: HTTP 502',
  'Connection lost: The server closed the connection.'
];
const failedAt = refusedAt + MINUTE;
for (let i = 0; i < PER_MINUTE; i++) {
  const error = failures[i % failures.length];
  await assert.rejects(attempt(failedAt, createOrDelete(i), 'unlucky', error), { message: error });
}
await assert.rejects(
  attempt(failedAt + 10 * SECOND, 'createExportBanList', 'unlucky'),
  minuteLimit('50 seconds')
);

// A refusal only takes back its own change, also among changes made at once.
const hastyAt = refusedAt + 2 * MINUTE;
const hasty = await Promise.allSettled([
  attempt(hastyAt, 'createExportBanList', 'hasty', LIST_LIMIT),
  ...Array.from({ length: PER_MINUTE - 1 }, () => attempt(hastyAt, 'createExportBanList', 'hasty'))
]);
assert.deepStrictEqual(outcomes(hasty), [
  LIST_LIMIT,
  ...Array(PER_MINUTE - 1).fill('createExportBanList')
]);
assert.strictEqual(
  await attempt(hastyAt + SECOND, 'createExportBanList', 'hasty'),
  'createExportBanList'
);
await assert.rejects(
  attempt(hastyAt + SECOND, 'createExportBanList', 'hasty'),
  minuteLimit('59 seconds')
);

// A refusal takes back its own change, not one counted while it was being made. Here the user's
// second creation, 30 seconds after the first, counts, and so does the rest of the minute's worth,
// so the limit allows another a minute after the second.
const patientAt = refusedAt + 3 * MINUTE;
let allowRefusal;
const slowRefusal = attempt(
  patientAt,
  'createExportBanList',
  'patient',
  LIST_LIMIT,
  new Promise((resolve) => (allowRefusal = resolve))
);
const meanwhile = attempt(patientAt + 30 * SECOND, 'createExportBanList', 'patient');
allowRefusal();
await assert.rejects(slowRefusal, { message: LIST_LIMIT });
assert.strictEqual(await meanwhile, 'createExportBanList');
for (let i = 1; i < PER_MINUTE; i++)
  assert.strictEqual(
    await attempt(patientAt + 31 * SECOND, 'createExportBanList', 'patient'),
    'createExportBanList'
  );
await assert.rejects(
  attempt(patientAt + 61 * SECOND, 'createExportBanList', 'patient'),
  minuteLimit('29 seconds')
);

// A user whose changes were all refused is not kept.
await assert.rejects(
  attempt(refusedAt + 4 * MINUTE, 'deleteExportBanList', 'careful', refusals[1]),
  { message: refusals[1] }
);
await settle();
assert.ok(
  refusingMaps.every((map) => !map.has('careful')),
  'A user whose changes were all refused is kept.'
);

// Once changes have finished, the guard keeps nothing for them, only the times of the lists users
// created and deleted, and an hour after a user's last one, it forgets those too.
await settle();
for (const map of maps)
  for (const value of map.values()) assert.ok(Array.isArray(value), 'A finished change is kept.');
await create(start + 9 * HOUR, 'last');
await settle();
const kept = limitedMaps.flatMap((map) => [...map.keys()]);
assert.deepStrictEqual(kept, ['last']);

// Stand-ins for the models, over rows kept here. Like the database, lookups only find the rows
// that match the whole where clause, and like Sequelize, they hand out copies of the rows, which
// only save and destroy write back. A config looked up with its list includes a copy of the list.
// `pause` stands for the time each query takes.
function database(pause = async () => {}) {
  const rows = {
    BanList: [{ id: 1 }, { id: 2 }],
    ExportBanList: [],
    ExportBanListConfig: [],
    Organisation: []
  };
  const queries = [];
  const writes = [];
  let nextID = 100;

  // A config's list owner is a column of the list, which the lookup must include.
  const matches = (row, where) =>
    Object.entries(where).every(([field, value]) => {
      if (field !== '$ExportBanList.owner$') return row[field] === value;
      const list = rows.ExportBanList.find((list) => list.id === row.exportBanList);
      return list !== undefined && list.owner === value;
    });

  function copy(model, row) {
    const methods = {
      async save() {
        await pause();
        writes.push(`save ${model} ${this.id}`);
        Object.assign(row, this);
      },
      async destroy() {
        await pause();
        writes.push(`destroy ${model} ${this.id}`);
        rows[model].splice(rows[model].indexOf(row), 1);
      },
      // The lists here are remote ones, which have no BattleMetrics invite to create, and no
      // BattleMetrics ban list to delete along with them.
      async createBattlemetricsInvite() {},
      async deleteExportBanList() {
        await this.destroy();
        return 'none';
      }
    };
    return Object.assign(Object.create(methods), row);
  }

  const model = (name) => ({
    async count({ where }) {
      queries.push([`${name}.count`, { ...where }]);
      await pause();
      return rows[name].filter((row) => matches(row, where)).length;
    },
    async findOne({ where, include }) {
      queries.push([`${name}.findOne`, { ...where }]);
      if ('$ExportBanList.owner$' in where)
        assert.ok(include && include.includes(models.ExportBanList), 'The list is included.');
      await pause();
      const row = rows[name].find((row) => matches(row, where));
      if (!row) return null;
      const found = copy(name, row);
      if (name === 'ExportBanListConfig' && include?.includes(models.ExportBanList)) {
        const list = rows.ExportBanList.find((list) => list.id === row.exportBanList);
        found.ExportBanList = copy('ExportBanList', list);
      }
      return found;
    },
    async findAll({ where }) {
      queries.push([`${name}.findAll`, { ...where }]);
      await pause();
      return rows[name].filter((row) => matches(row, where)).map((row) => copy(name, row));
    },
    async create(values) {
      await pause();
      const row = { id: nextID++, ...values };
      rows[name].push(row);
      writes.push(`create ${name} ${row.id}`);
      return copy(name, row);
    }
  });
  const models = {
    BanList: model('BanList'),
    ExportBanList: model('ExportBanList'),
    ExportBanListConfig: model('ExportBanListConfig'),
    Organisation: model('Organisation')
  };
  return { rows, queries, writes, models };
}

// The limits on export ban lists, with no limit on their players, so no list's players are
// counted, and the rules for each value.
const limits = {
  'scbl-lib/config': {
    EXPORT_LIST_LIMITS: exportListLimits.readLimits({
      EXPORT_BM_MAX_PLAYERS: '0',
      EXPORT_REMOTE_MAX_PLAYERS: '0'
    }).limits
  },
  'scbl-lib/export-list-limits': exportListLimits,
  'scbl-lib/validators': { default: Validators },
  'scbl-lib/db/export-membership': {
    countMembers() {
      throw new Error('A list was counted with no limit on its players.');
    },
    countPlayersWithBans() {
      throw new Error('Players were counted with no limit on lists.');
    }
  }
};

// The Discord webhook checks from scbl-lib, with Discord refusing every test message.
const webhookContext = vm.createContext({ URL });
const discordRefuses = {
  async default() {
    throw new Error('Unknown Webhook');
  }
};
const utils = {
  // The lines the resolvers post are checked in export-ban-list-audit.js.
  Logger: { verbose() {}, important() {} },
  logText,
  isDiscordWebhookUrl: (
    await load('../../scbl-lib/utils/discord-webhook-url.js', {}, webhookContext)
  ).default,
  testDiscordWebhook: (
    await load(
      '../../scbl-lib/utils/test-discord-webhook.js',
      { './discord-webhook.js': discordRefuses },
      webhookContext
    )
  ).default
};
const list = (id, owner, name = `List ${id}`) => ({
  id,
  owner,
  name,
  server: 'Server',
  type: 'remote',
  threshold: 9,
  defaultActivePoints: 3,
  defaultExpiredPoints: 1,
  maxBanAge: 0,
  discordWebhook: null
});

// Part 2: the resolvers in mutation/resolver.js, loaded on their own, only look up and change the
// user's own lists and configs. Another user is told they do not exist, and nothing is changed.
const db = database();
const { Mutation: Resolvers } = (
  await load(
    '../src/graphql-api/mutation/resolver.js',
    { ...limits, 'scbl-lib/db/models': db.models, 'scbl-lib/utils': utils },
    vm.createContext({ console: { error() {} } })
  )
).default;
const owner = as('owner');
const other = as('other');
const lastQuery = () => db.queries.at(-1);
const stored = (model, id) => db.rows[model].find((row) => row.id === id);
db.rows.ExportBanList.push(list(7, 'owner', 'Owned'), list(8, 'other', 'Theirs'));
db.rows.ExportBanListConfig.push({
  id: 70,
  exportBanList: 7,
  banList: 1,
  activePoints: 3,
  expiredPoints: 1
});

// Saving a list looks it up by its ID and the user's Steam ID.
await assert.rejects(Resolvers.updateExportBanList(null, { id: 7, name: 'Taken' }, other), {
  message: 'Export ban list does not exist!'
});
assert.deepStrictEqual(lastQuery(), ['ExportBanList.findOne', { id: 7, owner: 'other' }]);
assert.strictEqual(stored('ExportBanList', 7).name, 'Owned');
assert.strictEqual(
  (await Resolvers.updateExportBanList(null, { id: 7, name: 'Renamed' }, owner)).name,
  'Renamed'
);
assert.deepStrictEqual(lastQuery(), ['ExportBanList.findOne', { id: 7, owner: 'owner' }]);
assert.strictEqual(stored('ExportBanList', 7).name, 'Renamed');

// Adding a config looks its list up the same way.
const config = { exportBanList: 7, banList: 2, activePoints: 5, expiredPoints: 2 };
await assert.rejects(Resolvers.createExportBanListConfig(null, config, other), {
  message: 'Export ban list does not exist!'
});
assert.deepStrictEqual(lastQuery(), ['ExportBanList.findOne', { id: 7, owner: 'other' }]);
assert.strictEqual(db.rows.ExportBanListConfig.length, 1);
const added = await Resolvers.createExportBanListConfig(null, config, owner);
assert.deepStrictEqual({ ...stored('ExportBanListConfig', added.id) }, { id: added.id, ...config });

// Deleting a config looks it up by its ID and its list's owner.
await assert.rejects(Resolvers.deleteExportBanListConfig(null, { id: 70 }, other), {
  message: 'Export ban list config does not exist!'
});
assert.deepStrictEqual(lastQuery(), [
  'ExportBanListConfig.findOne',
  { id: 70, '$ExportBanList.owner$': 'other' }
]);
assert.ok(stored('ExportBanListConfig', 70));
await Resolvers.deleteExportBanListConfig(null, { id: 70 }, owner);
assert.strictEqual(stored('ExportBanListConfig', 70), undefined);

// Deleting a list looks it up by its ID and the user's Steam ID.
await assert.rejects(Resolvers.deleteExportBanList(null, { id: 7 }, other), {
  message: 'Export ban list does not exist!'
});
assert.deepStrictEqual(lastQuery(), ['ExportBanList.findOne', { id: 7, owner: 'other' }]);
assert.ok(stored('ExportBanList', 7));

// Only the owner's changes were written.
assert.deepStrictEqual(db.writes, [
  'save ExportBanList 7',
  `create ExportBanListConfig ${added.id}`,
  'destroy ExportBanListConfig 70'
]);

// The limit of 4 lists counts the user's own lists, so other users' lists do not use it up, and
// new lists belong to the user who created them.
db.rows.ExportBanList.push(list(9, 'other'), list(10, 'other'), list(11, 'other'));
const newList = { name: 'New', server: 'Server', type: 'remote' };
await assert.rejects(Resolvers.createExportBanList(null, newList, other), { message: LIST_LIMIT });
assert.deepStrictEqual(lastQuery(), ['ExportBanList.count', { owner: 'other' }]);
for (let i = 0; i < 3; i++) {
  const created = await Resolvers.createExportBanList(null, newList, owner);
  assert.deepStrictEqual(lastQuery(), ['ExportBanList.count', { owner: 'owner' }]);
  assert.strictEqual(stored('ExportBanList', created.id).owner, 'owner');
}
await assert.rejects(Resolvers.createExportBanList(null, newList, owner), { message: LIST_LIMIT });
assert.strictEqual(db.rows.ExportBanList.filter((row) => row.owner === 'owner').length, 4);

// Part 3: through mutation/index.js, the resolvers' checks hold when a user makes changes at once,
// and signed-out changes are refused before anything is looked up. Each query here takes a moment,
// so changes made at once would all look up the rows before any of them changed them.
const raced = database(settle);
const { Mutation: Guarded } = (
  await load(
    '../src/graphql-api/mutation/index.js',
    {
      ...limits,
      './typedef.js': { default: typedef },
      'scbl-lib/db/models': raced.models,
      'scbl-lib/utils': utils
    },
    vm.createContext({ console: { error() {} } })
  )
).resolver;
const racer = as('racer');

const anything = { id: 1, exportBanList: 1, banList: 1, ...newList };
for (const name of MUTATIONS)
  await assert.rejects(Guarded[name](null, anything, { user: null }, {}), SIGN_IN);
assert.deepStrictEqual(raced.queries, []);

// The user has room for one list fewer than the creates the limits allow them to make at once.
for (let id = 1; id <= 5 - PER_MINUTE; id++) raced.rows.ExportBanList.push(list(id, 'racer'));
const creates = await Promise.allSettled(
  Array.from({ length: PER_MINUTE }, () => Guarded.createExportBanList(null, newList, racer, {}))
);
assert.strictEqual(raced.rows.ExportBanList.length, 4);
assert.deepStrictEqual(
  creates.map(({ status, reason }) => (status === 'fulfilled' ? 'created' : reason.message)),
  [...Array(PER_MINUTE - 1).fill('created'), LIST_LIMIT]
);

// Adding the same config at once stores it once.
const sameConfig = { exportBanList: 1, banList: 2, activePoints: 3, expiredPoints: 1 };
const adds = await Promise.allSettled(
  Array.from({ length: 10 }, () => Guarded.createExportBanListConfig(null, sameConfig, racer, {}))
);
assert.strictEqual(raced.rows.ExportBanListConfig.length, 1);
assert.deepStrictEqual(
  adds.map(({ status, reason }) => (status === 'fulfilled' ? 'added' : reason.message)),
  ['added', ...Array(9).fill(CONFIG_EXISTS)]
);

// The user's other changes are still made.
assert.strictEqual(
  (await Guarded.updateExportBanList(null, { id: 1, name: 'Saved' }, racer, {})).name,
  'Saved'
);
assert.strictEqual(raced.rows.ExportBanList[0].name, 'Saved');

// Creations and deletions that resolver.js refuses before it changes anything do not count. Here a
// user with 3 lists makes more such mistakes than the hourly limit allows changes, and nothing is
// written for them.
for (let id = 301; id <= 303; id++) raced.rows.ExportBanList.push(list(id, 'fixer'));
raced.rows.ExportBanList.push(list(304, 'someone'));
const fixer = () => as('fixer');
const writesBefore = raced.writes.length;
const mistakes = [
  ['createExportBanList', { ...newList, type: 'remot' }, 'Invalid export ban list type.'],
  [
    'createExportBanList',
    { ...newList, maxBanAge: -1 },
    'The max ban age must be a whole number of days from 0 to 3,650. Use 0 to count bans of any age.'
  ],
  [
    'createExportBanList',
    { ...newList, discordWebhook: 'https://example.com/webhook' },
    'Invalid Discord Webhook'
  ],
  ['deleteExportBanList', { id: 999 }, 'Export ban list does not exist!'],
  ['deleteExportBanList', { id: 304 }, 'Export ban list does not exist!']
];
for (let i = 0; i <= PER_HOUR; i++)
  for (const [name, args, message] of mistakes)
    await assert.rejects(Guarded[name](null, args, fixer(), {}), { message });
// A webhook that fails its test is refused too, as is testing more webhooks than the user may, or
// a second webhook in one request, where mutation/test-webhook.js limits webhook tests. Here two
// creations share a request, and then the webhook is tried as often as the mistakes above.
const failingWebhook = { ...newList, discordWebhook: 'https://discord.com/api/webhooks/1/token' };
const webhookRefusals = [
  /^We could not post a test message to your Discord webhook\. Unknown Webhook\.$/,
  /^Only one Discord webhook can be tested per request\. Please save one export ban list at a time\.$/,
  /^Discord webhooks can only be tested \d+ times a minute\. Please try again in .+\.$/
];
const webhookRefused = ({ message }) => webhookRefusals.some((refusal) => refusal.test(message));
const oneRequest = fixer();
for (let i = 0; i < 2; i++)
  await assert.rejects(
    Guarded.createExportBanList(null, failingWebhook, oneRequest, {}),
    webhookRefused
  );
for (let i = 0; i <= PER_HOUR; i++)
  await assert.rejects(
    Guarded.createExportBanList(null, failingWebhook, fixer(), {}),
    webhookRefused
  );
assert.strictEqual(raced.writes.length, writesBefore);

// The user can still make the minute's worth of creations and deletions, and being refused a
// fifth list, while the limits allow another change, does not count either.
const fixerLists = [];
for (let i = 0; i < PER_MINUTE; i++) {
  if (i % 2) {
    await Guarded.deleteExportBanList(null, { id: fixerLists.pop() }, fixer(), {});
    continue;
  }
  fixerLists.push((await Guarded.createExportBanList(null, newList, fixer(), {})).id);
  if (i < PER_MINUTE - 1)
    await assert.rejects(Guarded.createExportBanList(null, newList, fixer(), {}), {
      message: LIST_LIMIT
    });
}
await assert.rejects(Guarded.createExportBanList(null, newList, fixer(), {}), {
  message: minuteLimitNow
});
assert.strictEqual(
  raced.rows.ExportBanList.filter((row) => row.owner === 'fixer').length,
  3 + (PER_MINUTE % 2)
);

console.log(
  'Export ban list change checks passed: signing in, one change at a time, limits, and owners.'
);
