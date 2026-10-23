import assert from 'assert';
import { readFile } from 'fs/promises';
import { format } from 'util';
import vm from 'vm';

import isNewerMessage, { isMessageID, newerMessage } from '../utils/message-id.js';

// Check how the services keep the newest message they post to the log channel in the database,
// for the importer service to keep its status message below it, without a database: the row's
// statements, and the recorder each service starts, which writes in the background, at most once
// every 5 seconds, one write at a time, and copes with the database being down and the importer's
// tables not being there yet, on a clock that only moves when the test moves it.

const unhandled = [];
process.on('unhandledRejection', (reason) => unhandled.push(reason));

// Let promise callbacks run.
const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise(setImmediate);
};

function deferred() {
  let resolve, reject;
  const promise = new Promise((_resolve, _reject) => {
    resolve = _resolve;
    reject = _reject;
  });
  return { promise, resolve, reject };
}

// Discord's IDs are compared as the 64-bit numbers they are, so 10 is newer than 9, and anything
// that is not an ID is older than every message.
assert.ok(isNewerMessage('10', '9'));
assert.ok(!isNewerMessage('9', '10'));
assert.ok(!isNewerMessage('10', '10'));
assert.ok(isNewerMessage('1430000000000000001', '1430000000000000000'));
assert.ok(isNewerMessage('18446744073709551615', '18446744073709551614'));
assert.ok(isNewerMessage('1', null));
assert.ok(isNewerMessage('1', 'not an ID'));
for (const value of [null, undefined, '', '12a', '-1', '1.5', 15, '123456789012345678901'])
  assert.ok(!isNewerMessage(value, '1'), `${value}`);
assert.ok(isMessageID('1430000000000000000'));
assert.ok(!isMessageID(1430000000));
assert.strictEqual(newerMessage('9', '10'), '10');
assert.strictEqual(newerMessage('10', null), '10');
assert.strictEqual(newerMessage(null, 'x'), null);

// Load log-channel.js with a stand-in for the database, whose queries the test answers (answer),
// and a logger whose post listener the test can call, as the logger calls it.
async function loadLogChannel() {
  const queries = [];
  const output = [];
  const timers = new Set();
  let now = 1000000;
  const db = {
    // Answers each query: resolves for a write, and with the rows for a read.
    answer: async () => [],
    async query(sql, options) {
      queries.push({ sql, ...options, at: now });
      return db.answer(sql, options);
    }
  };
  const logger = {
    listener: null,
    listeners: [],
    setPostListener(listener) {
      logger.listeners.push(listener);
      logger.listener = listener;
    }
  };
  const context = vm.createContext({
    console: {
      log: (...args) => output.push(format(...args)),
      warn: (...args) => output.push(format(...args))
    },
    Date: { now: () => now },
    setTimeout: (callback, ms) => {
      const timer = { at: now + ms, ms, callback, unrefed: false };
      timer.unref = () => Object.assign(timer, { unrefed: true });
      timers.add(timer);
      return timer;
    },
    clearTimeout: (timer) => timers.delete(timer)
  });
  const stubs = {
    './sequelize.js': { default: db, QueryTypes: { SELECT: 'SELECT' } },
    '../utils/logger.js': { default: logger }
  };
  const url = new URL('../db/log-channel.js', import.meta.url);
  const module = new vm.SourceTextModule(await readFile(url, 'utf8'), {
    context,
    identifier: url.href
  });
  await module.link(async (specifier, referencingModule) => {
    const exports = stubs[specifier];
    if (exports)
      return new vm.SyntheticModule(
        Object.keys(exports),
        function () {
          for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
        },
        { context }
      );
    assert.ok(specifier.startsWith('../utils/'), `Unexpected dependency: ${specifier}`);
    const dependency = new URL(specifier, referencingModule.identifier);
    return new vm.SourceTextModule(await readFile(dependency, 'utf8'), {
      context,
      identifier: dependency.href
    });
  });
  await module.evaluate();
  return {
    ...module.namespace,
    db,
    logger,
    queries,
    output,
    timers,
    now: () => now,
    // Move the clock on, running the timers that fall due, in order, and let what they start run.
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        await settle();
        const [next] = [...timers].filter((timer) => timer.at <= end).sort((a, b) => a.at - b.at);
        if (!next) break;
        timers.delete(next);
        now = next.at;
        next.callback();
      }
      now = end;
      await settle();
    },
    // The messages written, as [messageId, service, when, in milliseconds after the first query].
    writes: () =>
      queries
        .filter(({ sql }) => sql.startsWith('INSERT'))
        .map(({ replacements, at }) => [replacements.messageId, replacements.service, at])
  };
}

// MySQL's errors as Sequelize gives them: for a table that does not exist, and a database that is
// down.
const missingTable = () =>
  Object.assign(new Error("Table 'cbl.ImporterState' doesn't exist"), {
    name: 'SequelizeDatabaseError',
    original: { errno: 1146 }
  });
const refused = () =>
  Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:3306'), {
    name: 'SequelizeConnectionRefusedError'
  });

// The newest message is written to the importer's ImporterState table, in one statement that keeps
// the row's message when it is newer, comparing the IDs as numbers, and which service posted it.
// A value that is not a message's ID is never written. Reading it gives the ID, or null when there
// is none, or the importer has not made its tables yet. Other errors reach the caller.
{
  const channel = await loadLogChannel();
  assert.strictEqual(channel.LAST_LOG_MESSAGE, 'lastLogMessage');
  await channel.saveLogMessage('1430000000000000123', 'web');
  const [write] = channel.queries;
  assert.match(write.sql, /^INSERT INTO ImporterState \(name, value, updatedAt\)/);
  assert.match(write.sql, /JSON_OBJECT\('messageId', :messageId, 'service', :service\)/);
  assert.match(write.sql, /ON DUPLICATE KEY UPDATE\s+updatedAt = IF\(.*\),\s+value = IF\(/s);
  assert.strictEqual(write.sql.match(/CAST\(:messageId AS UNSIGNED\) > IF\(/g).length, 2);
  assert.strictEqual(write.sql.match(/REGEXP '\^\[0-9\]\{1,19\}\$'/g).length, 2);
  assert.deepStrictEqual(
    { ...write.replacements },
    { name: 'lastLogMessage', messageId: '1430000000000000123', service: 'web' }
  );
  await assert.rejects(channel.saveLogMessage('../x', 'web'), /Not a Discord message ID/);
  // An ID given as a number, which could not hold one exactly, is not one either.
  await assert.rejects(channel.saveLogMessage(1430000000, 'web'), /Not a Discord message ID/);
  assert.strictEqual(channel.queries.length, 1);

  channel.db.answer = async () => [{ messageId: '1430000000000000123' }];
  assert.strictEqual(await channel.readLogMessage(), '1430000000000000123');
  const read = channel.queries.at(-1);
  assert.match(read.sql, /^SELECT JSON_UNQUOTE\(JSON_EXTRACT\(value, '\$\.messageId'\)\)/);
  assert.deepStrictEqual(
    [read.type, { ...read.replacements }],
    ['SELECT', { name: 'lastLogMessage' }]
  );
  for (const rows of [[], [{ messageId: null }], [{ messageId: 'junk' }]]) {
    channel.db.answer = async () => rows;
    assert.strictEqual(await channel.readLogMessage(), null, JSON.stringify(rows));
  }
  channel.db.answer = async () => {
    throw missingTable();
  };
  assert.strictEqual(await channel.readLogMessage(), null);
  channel.db.answer = async () => {
    throw refused();
  };
  await assert.rejects(channel.readLogMessage(), /ECONNREFUSED/);
}

// A service starts the recorder once, which the logger tells of each message it posts, as the post
// listener. The first message is written at once, and a burst of them costs one more write, of the
// newest, 5 seconds after the last write. An older message than one written or waiting is not
// written. Its timers never keep the process running.
{
  const channel = await loadLogChannel();
  const recorder = channel.recordLogMessages('web');
  assert.strictEqual(typeof channel.logger.listener, 'function');
  const post = (id) => channel.logger.listener(id);
  post('1430000000000000100');
  await settle();
  assert.deepStrictEqual(channel.writes(), [['1430000000000000100', 'web', 1000000]]);
  for (let id = 101n; id <= 140n; id++) post(`1430000000000000${id}`);
  post('1430000000000000099');
  post('junk');
  await channel.advance(4999);
  assert.strictEqual(channel.writes().length, 1);
  assert.ok([...channel.timers].every(({ unrefed }) => unrefed));
  await channel.advance(1);
  assert.deepStrictEqual(channel.writes(), [
    ['1430000000000000100', 'web', 1000000],
    ['1430000000000000140', 'web', 1005000]
  ]);
  // Nothing newer: nothing more is written.
  post('1430000000000000140');
  post('1430000000000000120');
  await channel.advance(60000);
  assert.strictEqual(channel.writes().length, 2);
  // Long after the last write, the next message is written at once.
  post('1430000000000000141');
  await settle();
  assert.deepStrictEqual(channel.writes().at(-1), ['1430000000000000141', 'web', 1065000]);
  // The recorder is told of messages as the logger is, through record().
  recorder.record('1430000000000000142');
  await channel.advance(5000);
  assert.deepStrictEqual(channel.writes().at(-1).slice(0, 2), ['1430000000000000142', 'web']);
  assert.deepStrictEqual(channel.output, []);
}

// One write at a time, so a database that is slow to answer is never sent a second write, nor
// more than one of the service's connections: messages posted meanwhile are written, the newest,
// once the write under way is done and 5 seconds have passed.
{
  const channel = await loadLogChannel();
  channel.recordLogMessages('bot');
  const slow = deferred();
  channel.db.answer = () => slow.promise;
  channel.logger.listener('1430000000000000200');
  await settle();
  channel.logger.listener('1430000000000000201');
  channel.logger.listener('1430000000000000202');
  await channel.advance(30000);
  assert.strictEqual(channel.writes().length, 1);
  channel.db.answer = async () => [];
  slow.resolve([]);
  await channel.advance(4999);
  assert.strictEqual(channel.writes().length, 1);
  await channel.advance(1);
  assert.deepStrictEqual(
    channel.writes().map(([id, service]) => [id, service]),
    [
      ['1430000000000000200', 'bot'],
      ['1430000000000000202', 'bot']
    ]
  );
}

// A write that fails, as the database is down, never fails or holds up logging: it is warned about
// in the console once, without anything posted to the log channel, and tried again a minute
// later, with the newest message by then. Once a write works again, the console says so, and the
// next failure is warned about again. Before the importer has made its tables, in a new database,
// the console says that instead.
{
  const channel = await loadLogChannel();
  channel.recordLogMessages('web');
  channel.db.answer = async () => {
    throw refused();
  };
  channel.logger.listener('1430000000000000300');
  await settle();
  channel.logger.listener('1430000000000000301');
  await channel.advance(59999);
  assert.strictEqual(channel.writes().length, 1);
  await channel.advance(1);
  assert.deepStrictEqual(
    channel.writes().map(([id]) => id),
    ['1430000000000000300', '1430000000000000301']
  );
  assert.deepStrictEqual(channel.output, [
    'Warning: could not record the newest message in the Discord log in the database, so it is tried again every 60s: SequelizeConnectionRefusedError: connect ECONNREFUSED 10.0.0.5:3306'
  ]);
  channel.db.answer = async () => [];
  await channel.advance(60000);
  assert.deepStrictEqual(channel.writes().at(-1)[0], '1430000000000000301');
  assert.strictEqual(
    channel.output.at(-1),
    'Recorded the newest message in the Discord log in the database again.'
  );
  channel.db.answer = async () => {
    throw missingTable();
  };
  channel.logger.listener('1430000000000000302');
  await channel.advance(5000);
  assert.strictEqual(
    channel.output.at(-1),
    'Could not record the newest message in the Discord log in the database, as the importer has not made its tables yet, so it is tried again every 60s.'
  );
  assert.strictEqual(channel.output.length, 3);
  // Once the importer has made them, the message is written.
  channel.db.answer = async () => [];
  await channel.advance(60000);
  assert.deepStrictEqual(channel.writes().at(-1)[0], '1430000000000000302');
}

// The importer service writes the newest message it posted as it ends, rather than when it is due,
// e.g. its line saying it is stopping: flushing writes it at once, after a write under way, and
// resolves once it has been tried, never failing, or at once when nothing is waiting. Stopping, as
// the bot does before it closes its database connections, writes no more, and the logger tells
// the recorder of nothing more. A second recorder replaces the first.
{
  const channel = await loadLogChannel();
  await channel.flushLogMessages();
  channel.recordLogMessages('importer');
  await channel.flushLogMessages();
  assert.strictEqual(channel.writes().length, 0);
  const slow = deferred();
  channel.db.answer = () => slow.promise;
  channel.logger.listener('1430000000000000400');
  await settle();
  channel.logger.listener('1430000000000000401');
  let flushed = false;
  const flushing = channel.flushLogMessages().then(() => (flushed = true));
  await settle();
  assert.deepStrictEqual([channel.writes().length, flushed], [1, false]);
  channel.db.answer = async () => {
    throw refused();
  };
  slow.resolve([]);
  await flushing;
  assert.deepStrictEqual(
    channel.writes().map(([id, , at]) => [id, at]),
    [
      ['1430000000000000400', 1000000],
      ['1430000000000000401', 1000000]
    ]
  );
  // The failed write is tried again when it is due, unless the recorder is stopped first.
  channel.stopRecordingLogMessages();
  assert.strictEqual(channel.logger.listener, null);
  assert.strictEqual(channel.timers.size, 0);
  await channel.advance(120000);
  assert.strictEqual(channel.writes().length, 2);
  assert.strictEqual(channel.timers.size, 0);
  await channel.flushLogMessages();
  assert.strictEqual(channel.writes().length, 2);

  const first = channel.recordLogMessages('web');
  const firstListener = channel.logger.listener;
  channel.db.answer = async () => [];
  channel.recordLogMessages('bot');
  firstListener('1430000000000000500');
  first.record('1430000000000000501');
  await settle();
  assert.strictEqual(channel.writes().length, 2);
  channel.logger.listener('1430000000000000502');
  await settle();
  assert.deepStrictEqual(channel.writes().at(-1).slice(0, 2), ['1430000000000000502', 'bot']);
}

await settle();
assert.deepStrictEqual(unhandled, []);

console.log(
  'Log channel checks passed: message IDs compared as numbers, the newest message written and read, at most once every 5 seconds and one write at a time, failures and missing tables warned about and tried again, flushing as a service ends, and stopping.'
);
