import assert from 'assert';
import { EventEmitter } from 'events';
import { readFile } from 'fs/promises';
import { createRequire } from 'module';
import { format } from 'util';
import vm from 'vm';

import describeError, { stackTrace } from '../../scbl-lib/utils/describe-error.js';

const Bottleneck = createRequire(import.meta.url)('bottleneck');

// The web server keeps the newest message it posts to the log channel in the database, for the
// importer service to keep its status message below it. Load the web server's entry point,
// index.js, with the real logger and the real recorder (scbl-lib/db/log-channel.js), and
// stand-ins for Discord, the database, Koa and the sign-in checks, and check that it starts
// recording as it starts, and that a database that is missing the importer's table, is down, or
// never answers, never stops or holds up its lines to the log channel.

const unhandled = [];
process.on('unhandledRejection', (reason) => unhandled.push(reason));

const webhook = 'https://discord.com/api/webhooks/1/secret-token';

// The console's warnings, among the lines it printed.
const warnings = (output) => output.filter((line) => /^(Warning|Could not)/.test(line));

async function until(condition, what) {
  const deadline = Date.now() + 15000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, `Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

// Load index.js. db.answer answers each of the database's queries, and the stand-in for Discord
// posts each message with an ID that grows, as Discord's do.
async function loadWebServer() {
  const output = [];
  const sent = [];
  const listening = [];
  const db = { queries: [], answer: async () => [] };
  let next = 1430000000000000000n;
  const fakeProcess = new EventEmitter();
  fakeProcess.env = { DISCORD_LOG_WEBHOOK: webhook };
  fakeProcess.exit = (code) => assert.fail(`The web server exited ${code}`);
  const context = vm.createContext({
    URL,
    console: {
      log: (...args) => output.push(format(...args)),
      warn: (...args) => output.push(format(...args)),
      error: (...args) => output.push(format(...args))
    },
    process: fakeProcess,
    setTimeout,
    clearTimeout
  });
  const synthetic = (exports) =>
    new vm.SyntheticModule(
      Object.keys(exports),
      function () {
        for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
      },
      { context }
    );
  const modules = new Map();
  // Load a file, with the stubs given for some of its imports, and the real files for the others,
  // each loaded once.
  async function load(url, stubs) {
    const link = async (specifier, referencingModule) => {
      if (stubs[specifier]) return synthetic(stubs[specifier]);
      assert.ok(specifier.startsWith('.'), `Unexpected dependency: ${specifier}`);
      return moduleAt(new URL(specifier, referencingModule.identifier).href);
    };
    const moduleAt = async (href) => {
      if (!modules.has(href))
        modules.set(
          href,
          new vm.SourceTextModule(await readFile(new URL(href), 'utf8'), {
            context,
            identifier: href
          })
        );
      return modules.get(href);
    };
    const module = await moduleAt(url.href);
    await module.link(link);
    await module.evaluate();
    return module.namespace;
  }

  // The recorder, with the real logger, as scbl-lib/db gives it. Discord answers each post.
  class FastLimiter extends Bottleneck {
    constructor(options) {
      super({ ...options, minTime: 0 });
    }
  }
  const request = async (details) => {
    sent.push(details);
    return { id: String(++next) };
  };
  const logChannel = await load(new URL('../../scbl-lib/db/log-channel.js', import.meta.url), {
    './sequelize.js': {
      default: {
        query: async (sql, options) => {
          db.queries.push({ sql, ...options });
          return db.answer(sql, options);
        }
      },
      QueryTypes: { SELECT: 'SELECT' }
    },
    chalk: { default: { white: (text) => text } },
    bottleneck: { default: FastLimiter },
    './discord-webhook.js': {
      DELETED_WEBHOOK_CODES: [10015, 50027],
      default: async (url, { content, embeds }) => request({ type: 'send', content, embeds }),
      editDiscordWebhookMessage: async (url, id) => request({ type: 'edit', id }),
      getDiscordWebhookMessage: async (url, id) => request({ type: 'get', id }),
      deleteDiscordWebhookMessage: async (url, id) => {
        await request({ type: 'delete', id });
      }
    }
  });
  const logger = modules.get(new URL('../../scbl-lib/utils/logger.js', import.meta.url).href)
    .namespace.default;
  // Nothing is recorded before the web server starts recording.
  assert.strictEqual(logger.postListener, null);

  await load(new URL('../index.js', import.meta.url), {
    'scbl-lib/config': { JWT_AUTH: { SECRET: 'a-secret-only-these-checks-use-0123456789abcdef' } },
    'scbl-lib/db': {
      connect: async () => {},
      recordLogMessages: logChannel.recordLogMessages
    },
    'scbl-lib/utils': { describeError, stackTrace },
    './src/app.js': {
      default: {
        listen: (port, callback) => {
          listening.push(port);
          callback?.();
        }
      }
    },
    './src/auth/openid-request-timeout.js': { default: () => {} },
    './src/jwt-secret.js': { default: () => null }
  });
  await until(() => listening.length === 1, 'the web server to listen');
  return {
    logger,
    db,
    sent,
    output,
    writes: () => db.queries.filter(({ sql }) => sql.startsWith('INSERT'))
  };
}

// As it starts, the web server records the newest message it posts to the log channel, as 'web',
// once each message is posted: a line its models log, such as a BattleMetrics ban list made for an
// export ban list, is posted and then written to the database.
{
  const web = await loadWebServer();
  assert.strictEqual(typeof web.logger.postListener, 'function');
  web.logger.verbose('ExportBanList', 1, 'Creating Battlemetrics ban list...');
  await until(() => web.writes().length === 1, 'the line to be recorded');
  assert.deepStrictEqual(
    web.sent.map(({ content }) => content),
    ['[ExportBanList][1] Creating Battlemetrics ban list...']
  );
  assert.deepStrictEqual(
    { ...web.writes()[0].replacements },
    { name: 'lastLogMessage', messageId: '1430000000000000001', service: 'web' }
  );
  assert.deepStrictEqual(warnings(web.output), []);
}

// A database without the importer's tables yet, one that is down, and one that never answers, never
// stop the web server's lines to the log channel, nor hold them up: each line is sent at once, and
// the console says once why the newest could not be recorded.
for (const [name, answer, said] of [
  [
    'missing table',
    async () => {
      throw Object.assign(new Error("Table 'cbl.ImporterState' doesn't exist"), {
        original: { errno: 1146 }
      });
    },
    'Could not record the newest message in the Discord log in the database, as the importer has not made its tables yet, so it is tried again every 60s.'
  ],
  [
    'down',
    async () => {
      throw Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:3306'), {
        name: 'SequelizeConnectionRefusedError'
      });
    },
    'Warning: could not record the newest message in the Discord log in the database, so it is tried again every 60s: SequelizeConnectionRefusedError: connect ECONNREFUSED 10.0.0.5:3306'
  ],
  ['never answering', () => new Promise(() => {}), null]
]) {
  const web = await loadWebServer();
  web.db.answer = answer;
  for (let i = 1; i <= 5; i++) web.logger.verbose('ExportBanList', 1, `Line ${i}`);
  web.logger.important('Core', 'An important line');
  await until(() => web.sent.length === 6, `the lines to be sent, with the database ${name}`);
  await until(() => web.writes().length === 1, `the first write, with the database ${name}`);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepStrictEqual(
    web.sent.map(({ content }) => content),
    [1, 2, 3, 4, 5]
      .map((i) => `[ExportBanList][1] Line ${i}`)
      .concat('[Core][1] An important line'),
    name
  );
  // One write: the next waits for the minute after a failure, or for the write under way.
  assert.strictEqual(web.writes().length, 1, name);
  assert.deepStrictEqual(warnings(web.output), said ? [said] : [], name);
  assert.deepStrictEqual(
    { ...web.logger.getLogQueue() },
    { RECEIVED: 0, QUEUED: 0, RUNNING: 0, EXECUTING: 0 },
    name
  );
}

assert.deepStrictEqual(unhandled, []);

console.log(
  'Web server log channel checks passed: the newest message it posts recorded from its start, and its lines never stopped or held up by a database without the table, down or not answering.'
);
