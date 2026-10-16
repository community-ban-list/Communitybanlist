import assert from 'assert';
import { readFile } from 'fs/promises';
import vm from 'vm';

// Exercise how ExportBanManager.updateExportBans changes the export bans of players who qualify
// again or no longer qualify, without a database: the ExportBans table is a Map, which the
// stand-ins for Sequelize's update and destroy change as MySQL would. The one statement written in
// SQL is checked as written, and carried out by the stand-in as MySQL would carry it out.

const Op = { in: Symbol('in'), notIn: Symbol('notIn'), not: Symbol('not') };
const MINUTE = 60 * 1000;
const now = Date.UTC(2026, 9, 15, 12);
const lists = { 1: 'battlemetrics', 2: 'remote' };

const table = new Map();
const statements = [];
// The export bans the generating query finds for the batch of players.
let generated = [];

function matches(row, where) {
  return Object.entries(where).every(([column, condition]) => {
    const value = row[column];
    if (condition === null) return value === null;
    if (typeof condition !== 'object') return value === condition;
    if (Op.in in condition) return condition[Op.in].includes(value);
    if (Op.notIn in condition) return !condition[Op.notIn].includes(value);
    if (Op.not in condition && condition[Op.not] === null) return value !== null;
    throw new Error(`Unexpected condition on ${column}`);
  });
}

// The export bans whose deletion is cancelled on BattleMetrics lists with no ban, or a claimed one,
// as the manager's UPDATE ... JOIN is expected to say.
const CREATE_AGAIN = `UPDATE ExportBans EB JOIN ExportBanLists EBL ON EBL.id = EB.exportBanList SET EB.status = 'TO_BE_CREATED' WHERE EB.id IN (?) AND EB.status = 'TO_BE_DELETED' AND EBL.type = 'battlemetrics' AND (EB.battlemetricsID IS NULL OR EB.battlemetricsID = 'pending')`;

const sequelize = {
  transaction: async (options, work) => work({}),
  async query(sql, { type, replacements }) {
    const statement = sql.replace(/\s+/g, ' ').trim();
    if (statement.startsWith('SELECT')) {
      statements.push('generate');
      return generated;
    }
    assert.strictEqual(statement, CREATE_AGAIN);
    assert.strictEqual(type, 'BULKUPDATE');
    const [ids] = replacements;
    statements.push(`create again ${ids.length} generated`);
    let changed = 0;
    for (const row of table.values())
      if (
        ids.includes(row.id) &&
        row.status === 'TO_BE_DELETED' &&
        lists[row.exportBanList] === 'battlemetrics' &&
        (row.battlemetricsID === null || row.battlemetricsID === 'pending')
      ) {
        row.status = 'TO_BE_CREATED';
        changed++;
      }
    return changed;
  }
};

const ExportBan = {
  async bulkCreate(rows, { ignoreDuplicates }) {
    assert.strictEqual(ignoreDuplicates, true);
    statements.push('add');
    for (const row of rows)
      if (!table.has(row.id)) table.set(row.id, { ...row, battlemetricsID: null, updatedAt: now });
  },
  async update(values, { where, silent }) {
    statements.push(`update to ${values.status}${silent ? ', silent' : ''}`);
    for (const row of table.values())
      if (matches(row, where)) Object.assign(row, values, silent ? {} : { updatedAt: now });
    return [0];
  },
  async destroy({ where }) {
    statements.push('destroy');
    for (const [id, row] of table) if (matches(row, where)) table.delete(id);
  }
};

const context = vm.createContext({ process: { env: {} } });
const dependencies = {
  'scbl-lib/db': { sequelize },
  'scbl-lib/db/models': {
    ExportBan,
    SteamUser: {
      findAll: async () => [{ id: 'A' }, { id: 'B' }],
      update: async () => statements.push('mark players updated')
    }
  },
  'scbl-lib/db/sequelize': {
    Op,
    QueryTypes: { SELECT: 'SELECT', BULKUPDATE: 'BULKUPDATE' },
    Transaction: { ISOLATION_LEVELS: { SERIALIZABLE: 'SERIALIZABLE' } }
  },
  'scbl-lib/utils': { Logger: { verbose() {}, discordProgressBar: () => ({}) } },
  './run-control.js': { stopIfRequested() {} }
};
const source = await readFile(new URL('../src/export-ban-manager.js', import.meta.url), 'utf8');
const module = new vm.SourceTextModule(source, { context });
await module.link((specifier) => {
  const exports = dependencies[specifier];
  assert.ok(exports, `Unexpected dependency: ${specifier}`);
  return new vm.SyntheticModule(
    Object.keys(exports),
    function () {
      for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
    },
    { context }
  );
});
await module.evaluate();
const ExportBanManager = module.namespace.default;

// An export ban of player A or B on list 1, a BattleMetrics list, or 2, a remote one.
function add(steamUser, list, status, battlemetricsID = null) {
  const id = `${steamUser}${status}${battlemetricsID},${list}`;
  table.set(id, {
    id,
    steamUser,
    exportBanList: list,
    status,
    battlemetricsID,
    updatedAt: now - 30 * MINUTE
  });
  return id;
}
const state = (id) => table.get(id) && [table.get(id).status, table.get(id).battlemetricsID];

// Player A qualifies for the lists again, and so does each of their export bans: a deletion is
// cancelled. On the BattleMetrics list, an export ban with no BattleMetrics ban, or a claimed one
// whose ban may or may not have been made, is created again, keeping its claim and the claim's
// time. One with a ban, and any on the remote list, are marked as created, as before.
const qualifying = {
  noBan: add('A', 1, 'TO_BE_DELETED'),
  claimed: add('A', 1, 'TO_BE_DELETED', 'pending'),
  withBan: add('A', 1, 'TO_BE_DELETED', '777'),
  remote: add('A', 2, 'TO_BE_DELETED')
};
// Player B no longer qualifies. An export ban not created yet is deleted only if it has no
// BattleMetrics ban; one whose ban was made, or may have been, is queued to be deleted, so its ban
// is deleted too, keeping a claim's time.
const notQualifying = {
  noBan: add('B', 1, 'TO_BE_CREATED'),
  claimed: add('B', 1, 'TO_BE_CREATED', 'pending'),
  withBan: add('B', 1, 'TO_BE_CREATED', '888'),
  remote: add('B', 2, 'TO_BE_CREATED'),
  created: add('B', 1, 'CREATED', '999')
};
generated = Object.values(qualifying).map((id) => ({
  id,
  status: 'TO_BE_CREATED',
  steamUser: 'A',
  exportBanList: Number(id.split(',')[1])
}));

await ExportBanManager.updateExportBans();

assert.deepStrictEqual(statements, [
  'generate',
  'add',
  'create again 4 generated',
  'update to CREATED',
  'update to TO_BE_DELETED',
  'update to TO_BE_DELETED, silent',
  'destroy',
  'mark players updated'
]);
assert.deepStrictEqual(Object.values(qualifying).map(state), [
  ['TO_BE_CREATED', null],
  ['TO_BE_CREATED', 'pending'],
  ['CREATED', '777'],
  ['CREATED', null]
]);
assert.strictEqual(table.get(qualifying.claimed).updatedAt, now - 30 * MINUTE);
assert.deepStrictEqual(Object.values(notQualifying).map(state), [
  undefined,
  ['TO_BE_DELETED', 'pending'],
  ['TO_BE_DELETED', '888'],
  undefined,
  ['TO_BE_DELETED', '999']
]);
assert.strictEqual(table.get(notQualifying.claimed).updatedAt, now - 30 * MINUTE);

// With no export bans generated, there is nothing to create again, and the UPDATE ... JOIN, whose
// list of IDs would be empty, is not made.
statements.length = 0;
generated = [];
await ExportBanManager.updateExportBans();
assert.ok(!statements.some((statement) => statement.startsWith('create again')));

console.log(
  'Export ban manager checks passed: cancelled deletions created again, and claimed or made bans queued to be deleted.'
);
