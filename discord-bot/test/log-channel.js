import assert from 'assert';
import { EventEmitter } from 'events';
import { readFile } from 'fs/promises';
import { createRequire } from 'module';
import { format } from 'util';
import vm from 'vm';

import describeError, { stackTrace } from '../../scbl-lib/utils/describe-error.js';

const Bottleneck = createRequire(import.meta.url)('bottleneck');

// The bot keeps the newest message it posts to the log channel in the database, for the importer
// service to keep its status message below it. Load the bot's entry point, index.js, with the real
// logger and the real recorder (scbl-lib/db/log-channel.js), and stand-ins for Discord's client
// and webhook, the database and the commands, and check that it records from its start, that a
// database that is missing the importer's table, is down, or never answers, never stops or holds
// up its lines, and that it stops recording before it closes its database connections.

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

// Load index.js. db.answer answers each of the database's queries, and the stand-in for the log
// webhook posts each message with an ID that grows, as Discord's do.
async function loadBot() {
  const output = [];
  const sent = [];
  const events = [];
  const db = { queries: [], answer: async () => [] };
  let next = 1430000000000000000n;
  const fakeProcess = new EventEmitter();
  fakeProcess.env = { DISCORD_LOG_WEBHOOK: webhook };
  fakeProcess.exits = [];
  fakeProcess.exit = (code) => fakeProcess.exits.push(code);
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
    await module.link(async (specifier, referencingModule) => {
      if (stubs[specifier]) return synthetic(stubs[specifier]);
      assert.ok(specifier.startsWith('.'), `Unexpected dependency: ${specifier}`);
      return moduleAt(new URL(specifier, referencingModule.identifier).href);
    });
    await module.evaluate();
    return module.namespace;
  }

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
  assert.strictEqual(logger.postListener, null);

  // Discord's client, which logs in and says when it is ready.
  const clients = [];
  class Client extends EventEmitter {
    constructor() {
      super();
      clients.push(this);
      this.user = { tag: 'CBL#0001' };
      this.application = { commands: { set: async () => {} } };
    }

    async login() {
      events.push('login');
    }

    async destroy() {
      events.push('destroy');
    }
  }
  await load(new URL('../index.js', import.meta.url), {
    'discord.js': {
      Client,
      Events: { ClientReady: 'ready', InteractionCreate: 'interactionCreate', Error: 'error' },
      GatewayIntentBits: { Guilds: 1 },
      MessageFlags: { Ephemeral: 64 }
    },
    'scbl-lib/config': { EXPORT_LIST_LIMIT_PROBLEMS: [], UNSET_EXPORT_LIST_LIMITS: [] },
    'scbl-lib/db': {
      connect: async () => events.push('connect'),
      disconnect: async () => {
        events.push(`disconnect, recording ${logger.postListener ? 'on' : 'off'}`);
      },
      recordLogMessages: logChannel.recordLogMessages,
      stopRecordingLogMessages: logChannel.stopRecordingLogMessages
    },
    'scbl-lib/utils': { describeError, Logger: logger, stackTrace },
    './src/commands/index.js': { default: new Map() },
    './src/health-check-server.js': { default: () => {} },
    './src/config.js': {
      DISCORD_ADMIN_ROLE_IDS: ['2'],
      DISCORD_BOT_TOKEN: 'bot-token',
      DISCORD_GUILD_ID: '1'
    },
    './src/utils/index.js': { UserError: class UserError extends Error {} }
  });
  await until(() => events.includes('login'), 'the bot to log in');
  return {
    logger,
    db,
    sent,
    output,
    events,
    process: fakeProcess,
    client: clients[0],
    writes: () => db.queries.filter(({ sql }) => sql.startsWith('INSERT'))
  };
}

// The bot records the newest message it posts to the log channel from its start, as 'bot': its
// line saying it logged in, once it is posted, is written to the database. As it stops, it stops
// recording before it closes its database connections, and the lines it still sends then are not
// written.
{
  const bot = await loadBot();
  assert.strictEqual(typeof bot.logger.postListener, 'function');
  bot.client.emit('ready');
  await until(() => bot.writes().length === 1, 'the line to be recorded');
  assert.deepStrictEqual(
    bot.sent.map(({ content }) => content),
    ['[DiscordBot][1] Logged in as CBL#0001 and registered 0 commands.']
  );
  assert.deepStrictEqual(
    { ...bot.writes()[0].replacements },
    { name: 'lastLogMessage', messageId: '1430000000000000001', service: 'bot' }
  );
  bot.process.emit('SIGTERM');
  await until(() => bot.process.exits.length === 1, 'the bot to exit');
  assert.deepStrictEqual(bot.events, ['connect', 'login', 'destroy', 'disconnect, recording off']);
  assert.deepStrictEqual(bot.process.exits, [0]);
  bot.logger.important('DiscordBot', 'A line sent as the bot stops.');
  await until(() => bot.sent.length === 2, 'the last line to be sent');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.strictEqual(bot.writes().length, 1);
  assert.deepStrictEqual(warnings(bot.output), []);
}

// A database without the importer's tables yet, one that is down, and one that never answers, never
// stop the bot's lines, such as its audit lines, nor hold them up.
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
  const bot = await loadBot();
  bot.db.answer = answer;
  bot.client.emit('ready');
  for (let i = 1; i <= 4; i++) bot.logger.important('DiscordBot', `Audit line ${i}`);
  await until(() => bot.sent.length === 5, `the lines to be sent, with the database ${name}`);
  await until(() => bot.writes().length === 1, `the first write, with the database ${name}`);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.strictEqual(bot.writes().length, 1, name);
  assert.deepStrictEqual(warnings(bot.output), said ? [said] : [], name);
  assert.deepStrictEqual(
    { ...bot.logger.getLogQueue() },
    { RECEIVED: 0, QUEUED: 0, RUNNING: 0, EXECUTING: 0 },
    name
  );
}

assert.deepStrictEqual(unhandled, []);

console.log(
  'Bot log channel checks passed: the newest message it posts recorded from its start, its lines never stopped or held up by a database without the table, down or not answering, and recording stopped before its database connections close.'
);
