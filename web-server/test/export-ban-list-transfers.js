import assert from 'assert';
import { readFile } from 'fs/promises';
import vm from 'vm';

import * as exportListLimits from '../../scbl-lib/export-list-limits.js';
import isDiscordWebhookUrl from '../../scbl-lib/utils/discord-webhook-url.js';
import logText from '../../scbl-lib/utils/log-text.js';
import Validators from '../../scbl-lib/validators.js';

// Checks that changes to export ban lists on the website and the Discord bot's /exportbanlist
// transfer, made at the same time from their two processes, cannot together leave a list outside
// the limits, give a user more lists than they may have, or delete a list that was just given to
// another user. Changes go through mutation/index.js to the real resolvers, with a stand-in for the
// database that locks rows as MySQL does for the statements they make. The transfer makes the
// database steps of the bot's transferIfUnchanged (discord-bot/src/commands/exportbanlist.js), in
// the order the bot's own checks hold it to. Webhook tests, counts of players and deletions of
// BattleMetrics ban lists wait until a check lets them finish, so a transfer can be made while a
// change waits for one of them, and a transaction can be held while it has a lock.

// Load a module in a context. The imports in `stubs` get those exports, and other relative imports
// load the real files.
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
async function settle() {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
}

// Something a change waits for until the check opens it.
function gate() {
  let open;
  const until = new Promise((resolve) => (open = resolve));
  return { until, open };
}

// MySQL's error for a transaction it ended in a deadlock, as Sequelize gives it.
function deadlock() {
  const original = Object.assign(new Error('Deadlock found when trying to get lock'), {
    errno: 1213
  });
  return Object.assign(new Error(original.message), { original, parent: original });
}

// A stand-in for the database, over rows kept here, that locks as MySQL does for the statements
// the resolvers and the transfer make. Each lock is held until the transaction that took it ends,
// and a statement outside a transaction holds its locks only while it runs:
// - reading a list FOR UPDATE, writing it, or adding a config to it locks the list's row, whether
//   or not the rest of the where clause matches;
// - locking a user's lists (lockListsOf) locks their range of the index on the owner, and each of
//   their rows, and adding a list to that range, by creating it or giving it to the user, needs the
//   range.
// A transaction waits for a lock another holds until that one ends. Reading without a lock reads
// the rows as they are. A transaction that fails is rolled back, and, as the real
// ExportBanList.inTransaction does, a transaction ended by a deadlock is run once more.
function database() {
  const rows = {
    Organisation: [{ id: 1, name: 'Org' }],
    BanList: [
      { id: 1, name: 'Ban List 1', organisation: 1 },
      { id: 2, name: 'Ban List 2', organisation: 1 }
    ],
    ExportBanList: [],
    ExportBanListConfig: []
  };
  let nextID = 100;
  const writes = [];
  // Each lock's holder, and the transactions waiting for it in turn, by name.
  const locks = new Map();
  // The lists whose deletion lock is held.
  const deleting = new Set();
  // Locks to hold the transaction that takes them until the check opens their gate, by name.
  const holds = new Map();
  // Gates the deletion lock waits for before it is taken, by list.
  const beforeDeleting = new Map();
  // Gates each BattleMetrics list's deletion waits for, for its requests to BattleMetrics.
  const battlemetrics = new Map();
  // How many of the next lock requests MySQL ends in a deadlock.
  const deadlocks = { next: 0 };

  let transactions = 0;
  const newTransaction = () => ({ number: ++transactions, locks: new Set(), undo: [] });

  // Whether a transaction waits for another, directly or through the transactions it waits for.
  function waitsFor(waiter, transaction) {
    for (let current = waiter; current?.waitingFor;) {
      current = locks.get(current.waitingFor).holder;
      if (current === transaction) return true;
    }
    return false;
  }

  async function lock(transaction, name) {
    if (deadlocks.next > 0) {
      deadlocks.next--;
      throw deadlock();
    }
    const entry = locks.get(name);
    if (!entry) locks.set(name, { holder: transaction, waiting: [] });
    else if (entry.holder !== transaction) {
      if (waitsFor(entry.holder, transaction)) throw deadlock();
      transaction.waitingFor = name;
      await new Promise((resolve) => entry.waiting.push({ transaction, resolve }));
      transaction.waitingFor = undefined;
    }
    transaction.locks.add(name);
    const hold = holds.get(name);
    if (hold) {
      holds.delete(name);
      await hold.until;
    }
  }

  function release(transaction) {
    for (const name of transaction.locks) {
      const entry = locks.get(name);
      const next = entry.waiting.shift();
      if (!next) {
        locks.delete(name);
        continue;
      }
      entry.holder = next.transaction;
      next.resolve();
    }
    transaction.locks.clear();
  }

  async function inTransaction(work) {
    for (let attempt = 1; ; attempt++) {
      const transaction = newTransaction();
      try {
        const result = await work(transaction);
        release(transaction);
        return result;
      } catch (error) {
        for (const undo of transaction.undo.reverse()) undo();
        release(transaction);
        if (attempt > 1 || error.original?.errno !== 1213) throw error;
      }
    }
  }

  // Make a write that needs these locks, in the transaction or as a statement of its own. change
  // makes it, and gives how to undo it.
  async function write(transaction, names, change) {
    const statement = transaction ?? newTransaction();
    try {
      for (const name of names) await lock(statement, name);
      statement.undo.push(change());
    } finally {
      if (!transaction) release(statement);
    }
  }

  // A config's list owner is a column of the list, which the lookup must include.
  const matches = (row, where) =>
    Object.entries(where).every(([field, value]) => {
      if (field !== '$ExportBanList.owner$') return row[field] === value;
      const list = rows.ExportBanList.find((list) => list.id === row.exportBanList);
      return list !== undefined && list.owner === value;
    });
  const remove = (model, row) => {
    const index = rows[model].indexOf(row);
    if (index === -1) return () => {};
    rows[model].splice(index, 1);
    return () => rows[model].splice(index, 0, row);
  };

  // Rows are handed out as copies, as Sequelize does, and like Sequelize's, save() writes only the
  // values changed since the row was read, by ID.
  function copy(model, row) {
    const loaded = { ...row };
    const methods = {
      async save({ transaction } = {}) {
        const names = Object.keys(loaded).filter((name) => this[name] !== loaded[name]);
        if (names.length === 0) return;
        const values = Object.fromEntries(names.map((name) => [name, this[name]]));
        await write(transaction, [`list ${this.id}`], () => {
          const before = Object.fromEntries(names.map((name) => [name, row[name]]));
          Object.assign(row, values);
          writes.push(`save ${model} ${this.id}`);
          return () => Object.assign(row, before);
        });
        Object.assign(loaded, values);
      },
      async destroy({ transaction } = {}) {
        const name = model === 'ExportBanList' ? `list ${this.id}` : `config ${this.id}`;
        await write(transaction, [name], () => {
          writes.push(`destroy ${model} ${this.id}`);
          // A list's configs go with it.
          const configs =
            model === 'ExportBanList'
              ? rows.ExportBanListConfig.filter((config) => config.exportBanList === this.id)
              : [];
          const undo = [
            remove(model, row),
            ...configs.map((c) => remove('ExportBanListConfig', c))
          ];
          return () => undo.reverse().forEach((step) => step());
        });
      },
      async createBattlemetricsInvite() {},
      // ExportBanList's shared deletion: a BattleMetrics list's requests to BattleMetrics, which
      // can take minutes, and then the row, by ID.
      async deleteExportBanList() {
        if (this.type === 'battlemetrics') await battlemetrics.get(this.id)?.until;
        await this.destroy();
        return this.type === 'battlemetrics' ? 'deleted' : 'none';
      }
    };
    return Object.assign(Object.create(methods), row);
  }

  // The rows a lookup includes, as Sequelize adds them.
  function withIncluded(found, include = []) {
    for (const included of include) {
      if (included === models.ExportBanList)
        found.ExportBanList = copy(
          'ExportBanList',
          rows.ExportBanList.find((list) => list.id === found.exportBanList)
        );
      else if (included === models.Organisation)
        found.Organisation = { ...rows.Organisation.find(({ id }) => id === found.organisation) };
      else if (included.model === models.BanList)
        found.BanList = withIncluded(
          { ...rows.BanList.find(({ id }) => id === found.banList) },
          included.include
        );
      else assert.fail('A lookup has an unexpected include.');
    }
    return found;
  }

  const model = (name) => ({
    async count({ where }) {
      return rows[name].filter((row) => matches(row, where)).length;
    },
    async findOne({ where, include, lock: locked, transaction }) {
      if (locked) {
        assert.strictEqual(name, 'ExportBanList', 'Only lists are read FOR UPDATE.');
        assert.ok(transaction, 'A row is locked in a transaction.');
        await lock(transaction, `list ${where.id}`);
      }
      const row = rows[name].find((row) => matches(row, where));
      return row ? withIncluded(copy(name, row), include) : null;
    },
    async findAll({ where, include }) {
      return rows[name]
        .filter((row) => matches(row, where))
        .map((row) => withIncluded(copy(name, row), include));
    },
    // A new list goes into its owner's range of the owner index, and a config needs its list's row
    // for its foreign key.
    async create(values, { transaction } = {}) {
      const row = { id: nextID++, ...values };
      const names =
        name === 'ExportBanList' ? [`lists of ${values.owner}`] : [`list ${values.exportBanList}`];
      await write(transaction, names, () => {
        rows[name].push(row);
        writes.push(`create ${name} ${row.id}`);
        return remove.bind(null, name, row);
      });
      return copy(name, row);
    }
  });
  const models = {
    BanList: model('BanList'),
    ExportBanList: model('ExportBanList'),
    ExportBanListConfig: model('ExportBanListConfig'),
    Organisation: model('Organisation')
  };
  Object.assign(models.ExportBanList, {
    inTransaction,
    async lockListsOf(owner, { transaction }) {
      await lock(transaction, `lists of ${owner}`);
      const lists = rows.ExportBanList.filter((row) => row.owner === owner);
      for (const { id } of lists.toSorted((a, b) => a.id - b.id))
        await lock(transaction, `list ${id}`);
      return lists.length;
    },
    findByPk: (id, options) => models.ExportBanList.findOne({ where: { id }, ...options }),
    // The bot's UPDATE ... WHERE id = ? AND owner = ?, which locks the row by its ID first, and
    // moves it into the new owner's range of the owner index.
    async update(values, { where, transaction }) {
      let updated = 0;
      const names = [
        `list ${where.id}`,
        ...('owner' in values ? [`lists of ${values.owner}`] : [])
      ];
      await write(transaction, names, () => {
        const row = rows.ExportBanList.find((list) => matches(list, where));
        if (!row) return () => {};
        updated = 1;
        const before = { ...row };
        Object.assign(row, values);
        writes.push(`update ExportBanList ${row.id}`);
        return () => Object.assign(row, before);
      });
      return [updated];
    },
    async whileDeleting(id, deletion) {
      await beforeDeleting.get(id)?.until;
      if (deleting.has(id)) throw new Error('This export ban list is already being deleted.');
      deleting.add(id);
      try {
        return await deletion();
      } finally {
        deleting.delete(id);
      }
    },
    isBeingDeleted: async (id) => deleting.has(id)
  });

  const waiting = (name) => locks.get(name)?.waiting.length ?? 0;
  return { rows, writes, models, holds, beforeDeleting, battlemetrics, deadlocks, waiting };
}

// The bot's transfer once an admin has confirmed it, as transferIfUnchanged makes it: in one
// transaction, the new owner's lists are locked and counted, the list is read again with its row
// locked, and only its owner is written. Gives 'transferred', or why it was left as it is.
function transfer(db, id, from, to) {
  const { ExportBanList } = db.models;
  return ExportBanList.inTransaction(async (transaction) => {
    const lists = await ExportBanList.lockListsOf(to, { transaction });
    const current = await ExportBanList.findByPk(id, { lock: true, transaction });
    if (!current) return 'no longer exists';
    if (current.owner !== from) return `now belongs to ${current.owner}`;
    if (await ExportBanList.isBeingDeleted(id, { transaction })) return 'is being deleted';
    if (lists >= 4) return `${to} has ${lists} lists`;
    const [updated] = await ExportBanList.update(
      { owner: to },
      { where: { id, owner: from }, transaction }
    );
    return updated === 1 ? 'transferred' : 'changed as it was being transferred';
  });
}

// The mutations, as mutation/index.js guards them, over a database of their own, with these limits
// on export ban lists. Webhook tests and counts of players wait for their gate, if they have one,
// and the lines the resolvers post are recorded.
const webhook = (id) => `https://discord.com/api/webhooks/${id}/token-${id}`;
async function mutations(env = { EXPORT_BM_MAX_PLAYERS: '0', EXPORT_REMOTE_MAX_PLAYERS: '0' }) {
  const db = database();
  const webhookTests = new Map();
  const counts = { gate: null };
  const posted = [];
  const { resolver } = await load(
    '../src/graphql-api/mutation/index.js',
    {
      './typedef.js': { default: { kind: 'Document' } },
      'scbl-lib/config': { EXPORT_LIST_LIMITS: exportListLimits.readLimits(env).limits },
      'scbl-lib/db/export-membership': {
        async countMembers() {
          await counts.gate?.until;
          return 100;
        },
        countPlayersWithBans: async () => 100
      },
      'scbl-lib/db/models': db.models,
      'scbl-lib/export-list-limits': exportListLimits,
      'scbl-lib/utils': {
        // Each line, with the messages of the errors it is posted with.
        Logger: {
          verbose(module, level, line, ...errors) {
            posted.push([line, ...errors.map((error) => error.message)].join(' '));
          },
          important(module, line, ...errors) {
            this.verbose(module, 1, line, ...errors);
          }
        },
        logText,
        isDiscordWebhookUrl,
        async testDiscordWebhook(url) {
          await webhookTests.get(url)?.until;
        }
      },
      'scbl-lib/validators': { default: Validators }
    },
    vm.createContext({ console: { error() {}, log() {} }, setTimeout, clearTimeout })
  );
  return { db, webhookTests, counts, posted, Mutation: resolver.Mutation };
}

const as = (id) => ({ user: { id } });
const list = (id, owner, values = {}) => ({
  id,
  owner,
  name: `List ${id}`,
  server: 'Server',
  type: 'remote',
  threshold: 9,
  defaultActivePoints: 3,
  defaultExpiredPoints: 1,
  maxBanAge: 0,
  discordWebhook: null,
  battlemetricsID: null,
  battlemetricsInvite: null,
  generated: true,
  ...values
});
const SCORING = ['threshold', 'defaultActivePoints', 'defaultExpiredPoints', 'maxBanAge'];
const LIMITS = exportListLimits.readLimits({}).limits;
// The problems of a stored list under the points rules.
function problems(db, id) {
  const stored = db.rows.ExportBanList.find((row) => row.id === id);
  const settings = Object.fromEntries(SCORING.map((name) => [name, stored[name]]));
  const configs = db.rows.ExportBanListConfig.filter((config) => config.exportBanList === id);
  return exportListLimits.checkRules(stored.type, { settings, configs }, LIMITS);
}
const ownerOf = (db, id) => db.rows.ExportBanList.find((row) => row.id === id)?.owner;
const listsOf = (db, owner) =>
  db.rows.ExportBanList.filter((row) => row.owner === owner).map(({ id }) => id);
const DOES_NOT_EXIST = { message: 'Export ban list does not exist!' };
const LIST_LIMIT = { message: 'You are limited to 4 export ban lists.' };

// 1. The old owner's change in progress when a list is given to another user is not saved, so it
// cannot together with the new owner's change leave the list outside the rules. Here remote list 1,
// at threshold 9 with 3/1 points, belongs to A. A lowers its threshold to 5, which 3 + 1 + 1 allows,
// with a new webhook, whose test takes a while. Meanwhile the list is given to B, who adds a 6/1
// config, which the stored threshold of 9 allows (6 + 1 + 1 = 8). A's change is then refused, so
// the list keeps its threshold, and a player with one 6-point ban is not on it.
{
  const { db, webhookTests, posted, Mutation } = await mutations();
  db.rows.ExportBanList.push(list(1, 'A'));
  const testing = gate();
  webhookTests.set(webhook(101), testing);
  const saving = Mutation.updateExportBanList(
    null,
    { id: 1, threshold: 5, discordWebhook: webhook(101) },
    as('A'),
    {}
  );
  await settle();
  assert.strictEqual(await transfer(db, 1, 'A', 'B'), 'transferred');
  const added = await Mutation.createExportBanListConfig(
    null,
    { exportBanList: 1, banList: 1, activePoints: 6, expiredPoints: 1 },
    as('B'),
    {}
  );
  testing.open();
  await assert.rejects(saving, DOES_NOT_EXIST);
  const stored = db.rows.ExportBanList.find((row) => row.id === 1);
  assert.deepStrictEqual([stored.owner, stored.threshold, stored.discordWebhook], ['B', 9, null]);
  assert.deepStrictEqual(db.writes, [
    'update ExportBanList 1',
    `create ExportBanListConfig ${added.id}`
  ]);
  assert.deepStrictEqual(problems(db, 1), []);
  // A's refused change changed nothing, so it posts nothing.
  assert.deepStrictEqual(posted, [
    `Steam user B added a config to export ban list Server's List "List 1" (ID: 1, remote): ban list "Ban List 1" (ID: 1) of organisation "Org", 6 points for an active ban and 1 for an expired ban.`
  ]);
}

// 2. When the transfer comes while A's change is being saved, it waits for A's change, which locks
// the list's row, and then the list is given away with A's change. B's config is then checked
// against the threshold of 5, and refused.
{
  const { db, Mutation } = await mutations();
  db.rows.ExportBanList.push(list(1, 'A'));
  const saved = gate();
  db.holds.set('list 1', saved);
  const saving = Mutation.updateExportBanList(null, { id: 1, threshold: 5 }, as('A'), {});
  await settle();
  const transferring = transfer(db, 1, 'A', 'B');
  await settle();
  assert.strictEqual(db.waiting('list 1'), 1, 'The transfer waits for the list.');
  assert.strictEqual(ownerOf(db, 1), 'A');
  saved.open();
  assert.strictEqual((await saving).threshold, 5);
  assert.strictEqual(await transferring, 'transferred');
  await assert.rejects(
    Mutation.createExportBanListConfig(
      null,
      { exportBanList: 1, banList: 1, activePoints: 6, expiredPoints: 1 },
      as('B'),
      {}
    ),
    /reaches this list's threshold of 5\. Use fewer points, or raise the list's threshold to 8 or more first\.$/
  );
  assert.deepStrictEqual(problems(db, 1), []);
  assert.deepStrictEqual(db.rows.ExportBanListConfig, []);
}

// 3. The same holds for a config the old owner was deleting, here while its list's players were
// counted, as remote lists have no points rules and a cap on their players: the deletion is
// refused once the list belongs to B, and the config stays.
{
  const { db, counts, Mutation } = await mutations({
    EXPORT_REMOTE_NEVER_ENOUGH: 'none',
    EXPORT_REMOTE_MAX_PLAYERS: '40000'
  });
  db.rows.ExportBanList.push(list(2, 'A'));
  db.rows.ExportBanListConfig.push({
    id: 20,
    exportBanList: 2,
    banList: 1,
    activePoints: 1,
    expiredPoints: 0
  });
  counts.gate = gate();
  const deleting = Mutation.deleteExportBanListConfig(null, { id: 20 }, as('A'), {});
  await settle();
  assert.strictEqual(await transfer(db, 2, 'A', 'B'), 'transferred');
  counts.gate.open();
  await assert.rejects(deleting, DOES_NOT_EXIST);
  assert.deepStrictEqual(
    db.rows.ExportBanListConfig.map(({ id }) => id),
    [20]
  );
}

// 4. A change whose list changed after its checks is refused rather than saved over a change it
// was not checked with, even when the list belongs to its user again by then: here the list is
// given to B while A's change waits for its webhook test, B adds the 6/1 config, and the list is
// given back to A. Nothing of A's change is saved, and nothing is posted for it.
{
  const { db, webhookTests, posted, Mutation } = await mutations();
  db.rows.ExportBanList.push(list(3, 'A'));
  const testing = gate();
  webhookTests.set(webhook(103), testing);
  const saving = Mutation.updateExportBanList(
    null,
    { id: 3, threshold: 5, discordWebhook: webhook(103) },
    as('A'),
    {}
  );
  await settle();
  assert.strictEqual(await transfer(db, 3, 'A', 'B'), 'transferred');
  await Mutation.createExportBanListConfig(
    null,
    { exportBanList: 3, banList: 1, activePoints: 6, expiredPoints: 1 },
    as('B'),
    {}
  );
  assert.strictEqual(await transfer(db, 3, 'B', 'A'), 'transferred');
  posted.length = 0;
  testing.open();
  await assert.rejects(saving, {
    message:
      'This export ban list was changed while your change was being saved, so your change was not saved. Please reload the page and try again.'
  });
  const stored = db.rows.ExportBanList.find((row) => row.id === 3);
  assert.deepStrictEqual([stored.owner, stored.threshold, stored.discordWebhook], ['A', 9, null]);
  assert.deepStrictEqual(problems(db, 3), []);
  assert.deepStrictEqual(posted, []);
}

// 5. A user with 3 lists, who creates a fourth while one is given to them, ends up with 4: the
// creation counts their lists again, with them locked, just before it creates the list. Here the
// transfer comes while the new list's webhook is tested, and the creation is refused.
{
  const { db, webhookTests, posted, Mutation } = await mutations();
  db.rows.ExportBanList.push(list(11, 'C'), list(12, 'C'), list(13, 'C'), list(20, 'D'));
  const testing = gate();
  webhookTests.set(webhook(105), testing);
  const creating = Mutation.createExportBanList(
    null,
    { name: 'Fourth', server: 'Server', type: 'remote', discordWebhook: webhook(105) },
    as('C'),
    {}
  );
  await settle();
  assert.strictEqual(await transfer(db, 20, 'D', 'C'), 'transferred');
  testing.open();
  await assert.rejects(creating, LIST_LIMIT);
  assert.deepStrictEqual(listsOf(db, 'C'), [11, 12, 13, 20]);
  assert.deepStrictEqual(posted, []);
}

// 6. When the transfer comes while the list is being created, it waits for the user's lists, which
// the creation has locked, and then counts the new list, and leaves its list as it is.
{
  const { db, Mutation } = await mutations();
  db.rows.ExportBanList.push(list(11, 'C'), list(12, 'C'), list(13, 'C'), list(20, 'D'));
  const created = gate();
  db.holds.set('lists of C', created);
  const creating = Mutation.createExportBanList(
    null,
    { name: 'Fourth', server: 'Server', type: 'remote' },
    as('C'),
    {}
  );
  await settle();
  const transferring = transfer(db, 20, 'D', 'C');
  await settle();
  assert.strictEqual(db.waiting('lists of C'), 1, "The transfer waits for C's lists.");
  created.open();
  const fourth = await creating;
  assert.strictEqual(await transferring, 'C has 4 lists');
  assert.deepStrictEqual(listsOf(db, 'C'), [11, 12, 13, fourth.id]);
  assert.strictEqual(ownerOf(db, 20), 'D');
}

// 7. And a creation that comes while the transfer is being made waits for it, and is then refused.
{
  const { db, Mutation } = await mutations();
  db.rows.ExportBanList.push(list(11, 'C'), list(12, 'C'), list(13, 'C'), list(20, 'D'));
  const transferred = gate();
  db.holds.set('list 20', transferred);
  const transferring = transfer(db, 20, 'D', 'C');
  await settle();
  const creating = Mutation.createExportBanList(
    null,
    { name: 'Fourth', server: 'Server', type: 'remote' },
    as('C'),
    {}
  );
  await settle();
  assert.strictEqual(db.waiting('lists of C'), 1, "The creation waits for C's lists.");
  transferred.open();
  assert.strictEqual(await transferring, 'transferred');
  await assert.rejects(creating, LIST_LIMIT);
  assert.deepStrictEqual(listsOf(db, 'C'), [11, 12, 13, 20]);
}

// 8. A list whose deletion has started on the website is not given to another user while its
// BattleMetrics ban list is deleted, which can take minutes, so the transfer cannot give E a list
// that is then deleted. The deletion goes on.
{
  const { db, posted, Mutation } = await mutations();
  db.rows.ExportBanList.push(list(30, 'F', { type: 'battlemetrics', battlemetricsID: 'bm-30' }));
  const requests = gate();
  db.battlemetrics.set(30, requests);
  const deleting = Mutation.deleteExportBanList(null, { id: 30 }, as('F'), {});
  await settle();
  assert.strictEqual(await transfer(db, 30, 'F', 'E'), 'is being deleted');
  requests.open();
  await deleting;
  assert.deepStrictEqual(db.rows.ExportBanList, []);
  assert.deepStrictEqual(db.writes, ['destroy ExportBanList 30']);
  assert.deepStrictEqual(posted, [
    `Steam user F deleted export ban list Server's List "List 30" (ID: 30, BattleMetrics) and its BattleMetrics ban list bm-30.`
  ]);
}

// 9. A list given to another user after the deletion looked it up, but before it took the list's
// deletion lock, is looked up again once the lock is held, and not deleted.
{
  const { db, posted, Mutation } = await mutations();
  db.rows.ExportBanList.push(list(30, 'F', { type: 'battlemetrics', battlemetricsID: 'bm-30' }));
  const lockTaken = gate();
  db.beforeDeleting.set(30, lockTaken);
  const deleting = Mutation.deleteExportBanList(null, { id: 30 }, as('F'), {});
  await settle();
  assert.strictEqual(await transfer(db, 30, 'F', 'E'), 'transferred');
  lockTaken.open();
  await assert.rejects(deleting, DOES_NOT_EXIST);
  assert.strictEqual(ownerOf(db, 30), 'E');
  assert.deepStrictEqual(db.writes, ['update ExportBanList 30']);
  assert.deepStrictEqual(posted, []);
}

// 10. And when the deletion takes the lock while the transfer is being made, it waits for the
// list's row, and the transfer, which finds the deletion lock held, leaves the list as it is. The
// list is then deleted, as its owner asked.
{
  const { db, Mutation } = await mutations();
  db.rows.ExportBanList.push(list(30, 'F', { type: 'battlemetrics', battlemetricsID: 'bm-30' }));
  const read = gate();
  db.holds.set('list 30', read);
  const transferring = transfer(db, 30, 'F', 'E');
  await settle();
  const deleting = Mutation.deleteExportBanList(null, { id: 30 }, as('F'), {});
  await settle();
  assert.strictEqual(db.waiting('list 30'), 1, "The deletion waits for the list's row.");
  read.open();
  assert.strictEqual(await transferring, 'is being deleted');
  await deleting;
  assert.deepStrictEqual(db.rows.ExportBanList, []);
}

// 11. A change whose transaction MySQL ends in a deadlock, as it can with the ban importer's export
// step, which reads every list, is made once more, and saved once. A second deadlock is given to
// the user, nothing is saved, and the failure is posted.
{
  const { db, posted, Mutation } = await mutations();
  db.rows.ExportBanList.push(list(5, 'A'));
  const config = (banList) => ({ exportBanList: 5, banList, activePoints: 3, expiredPoints: 1 });
  db.deadlocks.next = 1;
  const added = await Mutation.createExportBanListConfig(null, config(1), as('A'), {});
  assert.deepStrictEqual(db.writes, [`create ExportBanListConfig ${added.id}`]);
  assert.strictEqual(posted.length, 1);
  assert.match(posted[0], /^Steam user A added a config to export ban list /);

  db.deadlocks.next = 2;
  await assert.rejects(
    Mutation.createExportBanListConfig(null, config(2), as('A'), {}),
    ({ original }) => original?.errno === 1213
  );
  assert.strictEqual(db.rows.ExportBanListConfig.length, 1);
  assert.strictEqual(posted.length, 2);
  assert.match(
    posted[1],
    /^Steam user A could not add a config to export ban list .*: Deadlock found when trying to get lock$/
  );
}

console.log(
  'Export ban list transfer checks passed: changes in progress, new lists and deletions on the website, with the Discord bot giving lists away at the same time.'
);
