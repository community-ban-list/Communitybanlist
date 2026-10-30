import assert from 'assert';
import { EventEmitter } from 'events';
import { readFile } from 'fs/promises';
import { format } from 'util';
import vm from 'vm';

// /exportbanlist removes the export ban lists outside the bot's limits, which must be the web
// server's, so when the bot starts it warns about each EXPORT_* setting set to a value it cannot
// use, and names in one warning those that are unset, with the default it uses for each. Load the
// bot's entry point, index.js, with the real scbl-lib/config.js and the environment given, and
// stand-ins for Discord, the database and the commands, and check what it prints.

const CONFIG = new URL('../../scbl-lib/config.js', import.meta.url).href;

// Start the bot with this environment, and give what it printed once it has logged in.
async function startBot(env) {
  const output = [];
  const fakeProcess = new EventEmitter();
  fakeProcess.env = env;
  fakeProcess.exit = () => assert.fail('The bot does not exit.');
  const context = vm.createContext({
    URL,
    console: {
      log: (...args) => output.push(format(...args)),
      warn: (...args) => output.push(format(...args)),
      error: (...args) => output.push(format(...args))
    },
    process: fakeProcess
  });

  let loggedIn;
  const login = new Promise((resolve) => (loggedIn = resolve));
  class Client extends EventEmitter {
    async login() {
      loggedIn();
    }
  }
  const stubs = {
    'discord.js': {
      Client,
      Events: { ClientReady: 'ready', InteractionCreate: 'interactionCreate', Error: 'error' },
      GatewayIntentBits: { Guilds: 1 },
      MessageFlags: { Ephemeral: 64 }
    },
    'scbl-lib/db': {
      connect: async () => {},
      disconnect: async () => {},
      recordLogMessages: () => {},
      stopRecordingLogMessages: () => {}
    },
    'scbl-lib/utils': {
      describeError: String,
      Logger: { verbose: () => {}, getLogQueue: () => ({}) },
      stackTrace: () => ''
    },
    './src/commands/index.js': { default: new Map() },
    './src/health-check-server.js': { default: () => {} },
    './src/config.js': {
      DISCORD_ADMIN_ROLE_IDS: ['2'],
      DISCORD_BOT_TOKEN: 'bot-token',
      DISCORD_GUILD_ID: '1'
    },
    './src/utils/index.js': { UserError: class UserError extends Error {} }
  };

  // The bot's files, scbl-lib/config.js and the limits it reads them with are the real ones, each
  // loaded once.
  const modules = new Map();
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
  const bot = await moduleAt(new URL('../index.js', import.meta.url).href);
  await bot.link(async (specifier, referencingModule) => {
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
    if (specifier === 'scbl-lib/config') return moduleAt(CONFIG);
    assert.ok(specifier.startsWith('.'), `Unexpected dependency: ${specifier}`);
    return moduleAt(new URL(specifier, referencingModule.identifier).href);
  });
  await bot.evaluate();
  await login;
  return output;
}

// The warning about the unset settings, with each one's default.
const unsetWarning = (defaults) =>
  `Warning: These EXPORT_* settings are unset, so the bot uses their defaults: ${defaults}. /exportbanlist removes the export ban lists outside these limits, so the bot and the web server must have the same EXPORT_* values.`;

// With none of them set, the bot uses every default, and says so in one warning.
assert.deepStrictEqual(await startBot({}), [
  unsetWarning(
    'EXPORT_BM_MAX_PLAYERS=20000, EXPORT_BM_MIN_THRESHOLD=4, EXPORT_BM_NEVER_ENOUGH=active-plus-expired, EXPORT_REMOTE_MAX_PLAYERS=40000, EXPORT_REMOTE_MIN_THRESHOLD=4, EXPORT_REMOTE_NEVER_ENOUGH=active-plus-expired'
  )
]);

// Only those unset or empty are named. One set to a value the bot cannot use has its own warning.
assert.deepStrictEqual(
  await startBot({
    EXPORT_BM_MAX_PLAYERS: '25000',
    EXPORT_BM_MIN_THRESHOLD: '5',
    EXPORT_BM_NEVER_ENOUGH: '',
    EXPORT_REMOTE_MAX_PLAYERS: '0',
    EXPORT_REMOTE_NEVER_ENOUGH: 'lots'
  }),
  [
    'Warning: EXPORT_REMOTE_NEVER_ENOUGH must be active-plus-expired, one-ban or none, not "lots", so the default of active-plus-expired is used.',
    unsetWarning('EXPORT_BM_NEVER_ENOUGH=active-plus-expired, EXPORT_REMOTE_MIN_THRESHOLD=4')
  ]
);

// With every one set, there is nothing to warn about.
assert.deepStrictEqual(
  await startBot({
    EXPORT_BM_MAX_PLAYERS: '20000',
    EXPORT_BM_MIN_THRESHOLD: '4',
    EXPORT_BM_NEVER_ENOUGH: 'active-plus-expired',
    EXPORT_REMOTE_MAX_PLAYERS: '40000',
    EXPORT_REMOTE_MIN_THRESHOLD: '4',
    EXPORT_REMOTE_NEVER_ENOUGH: 'one-ban'
  }),
  []
);

console.log(
  'Bot start-up warning checks passed: unset EXPORT_* settings named with their defaults in one warning, and values that cannot be used warned about.'
);
