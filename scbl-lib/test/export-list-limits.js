import assert from 'assert';

import {
  DEFAULT_CONFIG_POINTS,
  DEFAULT_LIMITS,
  DEFAULT_SETTINGS,
  MAX_BAN_AGE_MAX,
  NEVER_ENOUGH,
  POINTS_MAX,
  THRESHOLD_MAX,
  checkBounds,
  checkChange,
  checkRules,
  defaultThreshold,
  effectivePoints,
  readLimits
} from '../export-list-limits.js';

// Checks for the limits on export ban lists: reading them from the environment, the points rules,
// the bounds on each value, and which changes to a list are allowed.

const VARIABLES = [
  'EXPORT_BM_MAX_PLAYERS',
  'EXPORT_REMOTE_MAX_PLAYERS',
  'EXPORT_BM_MIN_THRESHOLD',
  'EXPORT_REMOTE_MIN_THRESHOLD',
  'EXPORT_BM_NEVER_ENOUGH',
  'EXPORT_REMOTE_NEVER_ENOUGH'
];

// The defaults, which the checks below work from.
assert.deepStrictEqual(DEFAULT_SETTINGS, {
  threshold: 9,
  defaultActivePoints: 3,
  defaultExpiredPoints: 1,
  maxBanAge: 0
});
assert.deepStrictEqual(DEFAULT_CONFIG_POINTS, { activePoints: 3, expiredPoints: 1 });
assert.deepStrictEqual(NEVER_ENOUGH, ['active-plus-expired', 'one-ban', 'none']);
assert.deepStrictEqual([POINTS_MAX, THRESHOLD_MAX, MAX_BAN_AGE_MAX], [100, 1000, 3650]);
assert.deepStrictEqual(DEFAULT_LIMITS, {
  battlemetrics: { maxPlayers: 20000, minThreshold: 4, neverEnough: 'active-plus-expired' },
  remote: { maxPlayers: 40000, minThreshold: 4, neverEnough: 'active-plus-expired' }
});

// The limits are read once, when scbl-lib/config.js loads, from these environment variables. Each
// load here is a fresh copy of the file.
let configLoads = 0;
async function limitsFrom(env) {
  for (const variable of VARIABLES) delete process.env[variable];
  Object.assign(process.env, env);
  configLoads++;
  const config = await import(`../config.js?load=${configLoads}`);
  return { limits: config.EXPORT_LIST_LIMITS, problems: config.EXPORT_LIST_LIMIT_PROBLEMS };
}
const everyVariable = (value) => Object.fromEntries(VARIABLES.map((name) => [name, value]));

// Unset and empty variables keep the defaults, with nothing to warn about.
for (const env of [{}, everyVariable(''), everyVariable('   ')])
  assert.deepStrictEqual(await limitsFrom(env), { limits: DEFAULT_LIMITS, problems: [] });

// Each variable sets its limit for its list type. A limit of 0 players means no limit, and the
// rules can be named in any case.
assert.deepStrictEqual(
  await limitsFrom({
    EXPORT_BM_MAX_PLAYERS: '25000',
    EXPORT_REMOTE_MAX_PLAYERS: '0',
    EXPORT_BM_MIN_THRESHOLD: '12',
    EXPORT_REMOTE_MIN_THRESHOLD: ' 1 ',
    EXPORT_BM_NEVER_ENOUGH: 'one-ban',
    EXPORT_REMOTE_NEVER_ENOUGH: 'NONE'
  }),
  {
    limits: {
      battlemetrics: { maxPlayers: 25000, minThreshold: 12, neverEnough: 'one-ban' },
      remote: { maxPlayers: 0, minThreshold: 1, neverEnough: 'none' }
    },
    problems: []
  }
);
for (const rule of NEVER_ENOUGH)
  assert.strictEqual(
    readLimits({ EXPORT_BM_NEVER_ENOUGH: rule }).limits.battlemetrics.neverEnough,
    rule
  );

// A value that cannot be used keeps the default, and the problem is given to warn about.
assert.deepStrictEqual(
  await limitsFrom({
    EXPORT_BM_MAX_PLAYERS: 'lots',
    EXPORT_REMOTE_MAX_PLAYERS: '-1',
    EXPORT_BM_MIN_THRESHOLD: '0',
    EXPORT_REMOTE_MIN_THRESHOLD: '1001',
    EXPORT_BM_NEVER_ENOUGH: 'two-bans',
    EXPORT_REMOTE_NEVER_ENOUGH: 'active plus expired'
  }),
  {
    limits: DEFAULT_LIMITS,
    problems: [
      'EXPORT_BM_MAX_PLAYERS must be a whole number of players, or 0 for no limit, not "lots", so the default of 20,000 is used.',
      'EXPORT_BM_MIN_THRESHOLD must be a whole number from 1 to 1,000, not "0", so the default of 4 is used.',
      'EXPORT_BM_NEVER_ENOUGH must be active-plus-expired, one-ban or none, not "two-bans", so the default of active-plus-expired is used.',
      'EXPORT_REMOTE_MAX_PLAYERS must be a whole number of players, or 0 for no limit, not "-1", so the default of 40,000 is used.',
      'EXPORT_REMOTE_MIN_THRESHOLD must be a whole number from 1 to 1,000, not "1001", so the default of 4 is used.',
      'EXPORT_REMOTE_NEVER_ENOUGH must be active-plus-expired, one-ban or none, not "active plus expired", so the default of active-plus-expired is used.'
    ]
  }
);
for (const value of ['1.5', '20,000', '2e4', '+5', '0x10', 'NaN', 'Infinity', '9'.repeat(20)])
  assert.strictEqual(readLimits({ EXPORT_BM_MAX_PLAYERS: value }).problems.length, 1, value);
for (const value of ['4.0', '-4', 'four'])
  assert.strictEqual(readLimits({ EXPORT_REMOTE_MIN_THRESHOLD: value }).problems.length, 1, value);
for (const value of ['1', '1000'])
  assert.deepStrictEqual(readLimits({ EXPORT_REMOTE_MIN_THRESHOLD: value }).problems, [], value);

// Reading them never throws, as everything that loads scbl-lib/config.js reads them.
const throwing = new Proxy(
  {},
  {
    get() {
      throw new Error('No environment here');
    }
  }
);
const unprintable = {
  toString() {
    throw new Error('This value cannot be turned into text.');
  }
};
for (const env of [undefined, null, 42, throwing, everyVariable(unprintable)])
  assert.deepStrictEqual(readLimits(env).limits, DEFAULT_LIMITS);
assert.deepStrictEqual(
  readLimits({ EXPORT_BM_MAX_PLAYERS: 30000, EXPORT_BM_MIN_THRESHOLD: 5 }).limits.battlemetrics,
  { maxPlayers: 30000, minThreshold: 5, neverEnough: 'active-plus-expired' }
);

// A new list's threshold is the model's default, or a minimum threshold of either type above it.
const limitsWith = (env) => readLimits(env).limits;
const limits = limitsWith({});
assert.strictEqual(defaultThreshold(limits), 9);
assert.strictEqual(defaultThreshold(limitsWith({ EXPORT_BM_MIN_THRESHOLD: '9' })), 9);
assert.strictEqual(defaultThreshold(limitsWith({ EXPORT_REMOTE_MIN_THRESHOLD: '12' })), 12);
assert.strictEqual(
  defaultThreshold(
    limitsWith({ EXPORT_BM_MIN_THRESHOLD: '15', EXPORT_REMOTE_MIN_THRESHOLD: '12' })
  ),
  15
);

// Lists and configs as the checks take them.
const list = (
  threshold,
  defaultActivePoints,
  defaultExpiredPoints,
  configs = [],
  maxBanAge = 0
) => ({
  settings: { threshold, defaultActivePoints, defaultExpiredPoints, maxBanAge },
  configs
});
let configIDs = 0;
const config = (banList, activePoints, expiredPoints) => ({
  id: ++configIDs,
  banList,
  activePoints,
  expiredPoints,
  banListName: `Ban List ${banList}`,
  organisationName: `Partner Org ${banList}`
});
const types = ['battlemetrics', 'remote'];
const withRule = (rule) =>
  limitsWith({ EXPORT_BM_NEVER_ENOUGH: rule, EXPORT_REMOTE_NEVER_ENOUGH: rule });
const messages = (problems) => problems.map(({ message }) => message);

// The most points an active and an expired ban can give, counted as the importer counts them, and
// where they come from. The defaults give them when a config gives no more.
assert.deepStrictEqual(effectivePoints(list(9, 3, 1)), {
  active: { points: 3, config: null },
  expired: { points: 1, config: null }
});
const sameAsDefaults = config(1, 3, 1);
assert.deepStrictEqual(effectivePoints(list(9, 3, 1, [sameAsDefaults])), {
  active: { points: 3, config: null },
  expired: { points: 1, config: null }
});
const higher = config(2, 5, 0);
const highExpired = config(3, 0, 2);
assert.deepStrictEqual(effectivePoints(list(9, 3, 1, [sameAsDefaults, higher, highExpired])), {
  active: { points: 5, config: higher },
  expired: { points: 2, config: highExpired }
});
// Each copy of a ban list's config adds its expired points for each expired ban, and the most
// active points of any copy count once.
const copies = [config(4, 2, 2), config(4, 1, 2), config(4, 2, 2)];
assert.deepStrictEqual(effectivePoints(list(4, 0, 0, copies)), {
  active: { points: 2, config: copies[0] },
  expired: { points: 6, config: copies[0] }
});
// A config's missing points take the defaults.
const noActive = config(5, null, 4);
assert.deepStrictEqual(effectivePoints(list(9, 3, 1, [noActive, config(5, 2, null)])), {
  active: { points: 3, config: null },
  expired: { points: 5, config: noActive }
});
// Points below 0, or missing with no default, count as 0, so a copy of a config with points below
// 0 takes nothing away from the others.
assert.deepStrictEqual(effectivePoints(list(9, -3, null, [config(6, -5, -2)])), {
  active: { points: 0, config: null },
  expired: { points: 0, config: null }
});
const belowZero = config(7, 1, -4);
assert.deepStrictEqual(effectivePoints(list(9, 3, 1, [belowZero, config(7, 1, 3)])), {
  active: { points: 3, config: null },
  expired: { points: 3, config: belowZero }
});

// The points rules, for both list types. Under the default rule, one active ban plus one expired
// ban must not be enough, so the threshold must be above the most points one of each can give,
// and at least the type's minimum of 4. These are the lowest thresholds that allows for each pair
// of default points, with no configs.
for (const [points, lowest] of [
  ['1/1', 4],
  ['2/1', 4],
  ['3/1', 5],
  ['3/2', 6],
  ['4/1', 6],
  ['4/2', 7],
  ['5/1', 7],
  ['6/2', 9],
  ['0/0', 4],
  ['0/5', 6]
]) {
  const [active, expired] = points.split('/').map(Number);
  for (const type of types) {
    assert.deepStrictEqual(checkRules(type, list(lowest, active, expired), limits), [], points);
    assert.deepStrictEqual(checkRules(type, list(THRESHOLD_MAX, active, expired), limits), []);
    for (const threshold of [lowest - 1, 1])
      assert.strictEqual(
        checkRules(type, list(threshold, active, expired), limits).length,
        1,
        `${points} at ${threshold}`
      );
  }
}

// What each rule says, and the lowest threshold within both rules that it gives.
const rules = (rule, type, ...args) => checkRules(type, list(...args), withRule(rule));
for (const type of types) {
  for (const rule of NEVER_ENOUGH) {
    // The site's defaults, and points of 3/1 at threshold 5, are within every rule.
    assert.deepStrictEqual(rules(rule, type, 9, 3, 1), []);
    assert.deepStrictEqual(rules(rule, type, 5, 3, 1), []);
    // Every banned player qualifies with any of their bans at threshold 1, which is below the
    // minimum threshold under any rule.
    assert.deepStrictEqual(rules(rule, type, 1, 1, 1), [
      {
        rule: 'min-threshold',
        field: 'threshold',
        message: `A ${type === 'remote' ? 'remote' : 'BattleMetrics'} export ban list's threshold must be at least 4.`
      }
    ]);
  }

  // One active ban is enough at 5/1 and threshold 5.
  assert.deepStrictEqual(rules('active-plus-expired', type, 5, 5, 1), [
    {
      rule: 'never-enough',
      field: 'threshold',
      message:
        'One active ban plus one expired ban must not be enough to put a player on an export ban list. Here they can give 6 points (5 for an active ban, plus 1 for an expired ban), so the threshold must be 7 or more. Raise the threshold or lower the points.'
    }
  ]);
  assert.deepStrictEqual(messages(rules('one-ban', type, 5, 5, 1)), [
    'One ban must not be enough to put a player on an export ban list. Here one ban can give 5 points (an active ban), so the threshold must be 6 or more. Raise the threshold or lower the points.'
  ]);
  assert.deepStrictEqual(rules('none', type, 5, 5, 1), []);

  // One active plus one expired ban is enough at 3/1 and threshold 4, which only the default rule
  // refuses.
  assert.deepStrictEqual(messages(rules('active-plus-expired', type, 4, 3, 1)), [
    'One active ban plus one expired ban must not be enough to put a player on an export ban list. Here they can give 4 points (3 for an active ban, plus 1 for an expired ban), so the threshold must be 5 or more. Raise the threshold or lower the points.'
  ]);
  assert.deepStrictEqual(rules('one-ban', type, 4, 3, 1), []);
  assert.deepStrictEqual(rules('none', type, 4, 3, 1), []);

  // One expired ban can be enough too.
  assert.deepStrictEqual(messages(rules('one-ban', type, 4, 1, 4)), [
    'One ban must not be enough to put a player on an export ban list. Here one ban can give 4 points (an expired ban), so the threshold must be 5 or more. Raise the threshold or lower the points.'
  ]);
}

// Configs count, each copy of a ban list's config included: with defaults of 0/0, three copies of a
// 2/2 config give an expired ban 6 points.
assert.deepStrictEqual(
  messages(
    checkRules('remote', list(4, 0, 0, [config(8, 2, 2), config(8, 2, 2), config(8, 2, 2)]), limits)
  ),
  [
    "One active ban plus one expired ban must not be enough to put a player on an export ban list. Here they can give 8 points (2 for an active ban on Partner Org 8's Ban List 8, plus 6 for an expired ban on Partner Org 8's Ban List 8), so the threshold must be 9 or more. Raise the threshold or lower the points."
  ]
);
assert.deepStrictEqual(
  messages(
    checkRules(
      'battlemetrics',
      list(4, 0, 0, [config(8, 2, 2), config(8, 2, 2), config(8, 2, 2)]),
      withRule('one-ban')
    )
  ),
  [
    "One ban must not be enough to put a player on an export ban list. Here one ban can give 6 points (an expired ban on Partner Org 8's Ban List 8), so the threshold must be 7 or more. Raise the threshold or lower the points."
  ]
);
assert.deepStrictEqual(messages(checkRules('remote', list(6, 3, 1, [config(9, 5, 1)]), limits)), [
  "One active ban plus one expired ban must not be enough to put a player on an export ban list. Here they can give 6 points (5 for an active ban on Partner Org 9's Ban List 9, plus 1 for an expired ban), so the threshold must be 7 or more. Raise the threshold or lower the points."
]);
// A config with no names is named by its ban list's ID, and one with no organisation by its name.
assert.match(
  messages(
    checkRules(
      'remote',
      list(5, 3, 1, [{ banList: 12, activePoints: 6, expiredPoints: 1 }]),
      limits
    )
  )[0],
  /\(6 for an active ban on ban list 12, plus 1 for an expired ban\)/
);
assert.match(
  messages(
    checkRules(
      'remote',
      list(5, 3, 1, [{ banList: 12, activePoints: 6, expiredPoints: 1, banListName: 'Main' }]),
      limits
    )
  )[0],
  /\(6 for an active ban on Main, plus 1 for an expired ban\)/
);

// Each type has its own limits. Here BattleMetrics lists need a threshold of at least 6, and
// remote lists only the rule that one ban must not be enough.
const typeLimits = limitsWith({
  EXPORT_BM_MIN_THRESHOLD: '6',
  EXPORT_REMOTE_MIN_THRESHOLD: '1',
  EXPORT_REMOTE_NEVER_ENOUGH: 'one-ban'
});
assert.deepStrictEqual(messages(checkRules('battlemetrics', list(5, 3, 1), typeLimits)), [
  "A BattleMetrics export ban list's threshold must be at least 6."
]);
assert.deepStrictEqual(checkRules('remote', list(4, 3, 1), typeLimits), []);
assert.deepStrictEqual(checkRules('remote', list(2, 1, 1), typeLimits), []);
assert.strictEqual(checkRules('remote', list(3, 3, 1), typeLimits).length, 1);
// With the rule off, only the minimum threshold is left.
const ruleOff = limitsWith({ EXPORT_REMOTE_NEVER_ENOUGH: 'none' });
assert.deepStrictEqual(checkRules('remote', list(4, 100, 100), ruleOff), []);
assert.deepStrictEqual(messages(checkRules('remote', list(3, 0, 0), ruleOff)), [
  "A remote export ban list's threshold must be at least 4."
]);

// The message gives the lowest threshold within both rules: the minimum threshold when it is
// higher, and otherwise the points rule, also when the threshold is below both.
assert.deepStrictEqual(checkRules('remote', list(2, 1, 1), limits)[0].rule, 'min-threshold');
assert.match(messages(checkRules('remote', list(2, 2, 1), limits))[0], /must be 4 or more\./);
assert.match(messages(checkRules('remote', list(3, 3, 1), limits))[0], /must be 5 or more\./);
const highMinimum = limitsWith({ EXPORT_REMOTE_MIN_THRESHOLD: '10' });
assert.deepStrictEqual(messages(checkRules('remote', list(9, 3, 1), highMinimum)), [
  "A remote export ban list's threshold must be at least 10."
]);
assert.deepStrictEqual(checkRules('remote', list(10, 3, 1), highMinimum), []);
assert.match(
  messages(checkRules('remote', list(10, 9, 1), highMinimum))[0],
  /so the threshold must be 11 or more\./
);

// A threshold that is missing or not a whole number is not within the rules.
for (const threshold of [null, undefined, 4.5, '9'])
  assert.deepStrictEqual(messages(checkRules('remote', list(threshold, 3, 1), limits)), [
    'One active ban plus one expired ban must not be enough to put a player on an export ban list. Here they can give 4 points (3 for an active ban, plus 1 for an expired ban), so the threshold must be 5 or more. Raise the threshold or lower the points.'
  ]);

// The site's defaults are within the rules under every rule and minimum threshold, whichever type
// a new list is.
for (const rule of NEVER_ENOUGH)
  for (let minimum = 1; minimum <= 15; minimum++) {
    const env = everyVariable('');
    env.EXPORT_BM_NEVER_ENOUGH = env.EXPORT_REMOTE_NEVER_ENOUGH = rule;
    env.EXPORT_BM_MIN_THRESHOLD = String(minimum);
    const settings = { ...DEFAULT_SETTINGS, threshold: defaultThreshold(limitsWith(env)) };
    for (const type of types)
      assert.deepStrictEqual(
        checkRules(type, { settings, configs: [] }, limitsWith(env)),
        [],
        `${rule}, minimum ${minimum}`
      );
  }

// Lists of a type with no limits are a mistake in the caller.
assert.throws(() => checkRules('discord', list(9, 3, 1), limits), TypeError);
assert.throws(() => checkRules('remote', list(9, 3, 1), {}), TypeError);

// A command that finds the stored lists outside today's rules can check each list as stored. Of
// these lists, those where one active ban is enough, or one active ban plus one expired ban, are
// outside them, and the rest are within them.
const stored = [
  [
    'remote',
    list(3, 3, 1, [config(1, 3, 1), config(2, 3, 1), config(3, 3, 1), config(4, 3, 1)]),
    false
  ],
  ['battlemetrics', list(5, 5, 1), false],
  ['remote', list(5, 5, 1), false],
  ['battlemetrics', list(3, 2, 1, [config(1, 3, 1), config(2, 3, 1)]), false],
  ['remote', list(4, 3, 1), false],
  ['battlemetrics', list(5, 3, 1, [config(1, 3, 1), config(2, 4, 1), config(3, 5, 1)]), false],
  ['battlemetrics', list(9, 6, 2), true],
  ['remote', list(5, 3, 1), true],
  ['battlemetrics', list(6, 3, 2, [config(1, 3, 1)]), true],
  ['battlemetrics', list(5, 3, 1, [config(1, 3, 1)], 1825), true],
  ['battlemetrics', list(7, 4, 1, [config(1, 0, 0), config(2, 0, 0)]), true],
  ['battlemetrics', list(7, 3, 1, [config(1, 2, 0), config(2, 3, 1)]), true],
  ['remote', list(9, 3, 1, [config(1, 3, 2), config(2, 5, 2)]), true],
  ['remote', list(9, 3, 1, [config(1, 5, 1)]), true],
  ['battlemetrics', list(9, 3, 1), true]
];
for (const [type, storedList, within] of stored)
  assert.strictEqual(checkRules(type, storedList, limits).length === 0, within);

// Bounds: each value a change sets must be a whole number within its bounds.
const BOUND_MESSAGES = {
  threshold: 'The threshold must be a whole number from 1 to 1,000.',
  points: 'Points must be whole numbers from 0 to 100.',
  maxBanAge:
    'The max ban age must be a whole number of days from 0 to 3,650. Use 0 to count bans of any age.'
};
const POINTS_FIELDS = [
  'defaultActivePoints',
  'defaultExpiredPoints',
  'activePoints',
  'expiredPoints'
];
const notWhole = [null, undefined, 2.5, '5', NaN, Infinity, true, {}];
for (const [field, good, bad, message] of [
  ['threshold', [1, 9, 1000], [0, -1, 1001, ...notWhole], BOUND_MESSAGES.threshold],
  ['maxBanAge', [0, 730, 3650], [-1, 3651, ...notWhole], BOUND_MESSAGES.maxBanAge],
  ...POINTS_FIELDS.map((field) => [
    field,
    [0, 3, 100],
    [-1, 101, ...notWhole],
    BOUND_MESSAGES.points
  ])
]) {
  for (const value of good) assert.deepStrictEqual(checkBounds({ [field]: value }), [], field);
  for (const value of bad)
    assert.deepStrictEqual(
      checkBounds({ [field]: value }),
      [{ field, message }],
      `${field} ${value}`
    );
}
// Only the values given are checked, in the order of the form, and a value given as undefined is
// missing.
assert.deepStrictEqual(checkBounds({}), []);
assert.deepStrictEqual(
  checkBounds({ expiredPoints: 101, maxBanAge: -1, activePoints: undefined, threshold: 0 }),
  [
    { field: 'threshold', message: BOUND_MESSAGES.threshold },
    { field: 'maxBanAge', message: BOUND_MESSAGES.maxBanAge },
    { field: 'activePoints', message: BOUND_MESSAGES.points },
    { field: 'expiredPoints', message: BOUND_MESSAGES.points }
  ]
);

// Changes. A new list is a change from nothing, which could make it bigger, and every value it
// sets is checked.
const change = (before, after, type = 'remote', withLimits = limits) =>
  checkChange(type, before, after, withLimits);
assert.deepStrictEqual(change(null, list(9, 3, 1)), {
  problems: [],
  mayGrow: true,
  withinRules: true
});
for (const type of types) {
  assert.deepStrictEqual(change(null, list(4, 3, 1), type), {
    problems: [
      {
        rule: 'never-enough',
        field: 'threshold',
        message:
          'One active ban plus one expired ban must not be enough to put a player on an export ban list. Here they can give 4 points (3 for an active ban, plus 1 for an expired ban), so the threshold must be 5 or more. Raise the threshold or lower the points.'
      }
    ],
    mayGrow: true,
    withinRules: false
  });
  assert.deepStrictEqual(change(null, list(5, 3, 1), type).problems, []);
  assert.deepStrictEqual(change(null, list(4, 3, 1), type, withRule('one-ban')).problems, []);
}
// The bounds come before the rules.
assert.deepStrictEqual(messages(change(null, list(0, 3, 1)).problems), [BOUND_MESSAGES.threshold]);
assert.deepStrictEqual(messages(change(null, list(9, 101, -1, [], 3651)).problems), [
  BOUND_MESSAGES.points,
  BOUND_MESSAGES.points,
  BOUND_MESSAGES.maxBanAge
]);
assert.deepStrictEqual(messages(change(null, list(9, 3, 1, [config(1, 3, 101)])).problems), [
  BOUND_MESSAGES.points
]);

// Whether a change could make a list bigger, with the list's other values valid. Each change below
// is to this list: threshold 9, points 3/1, a 4/1 config for ban list 1, two 3/2 configs for ban
// list 2, and a max ban age of 30 days.
const configs = [config(1, 4, 1), config(2, 3, 2), config(2, 3, 2)];
const base = list(9, 3, 1, configs, 30);
const changeTo = ({ threshold = 9, active = 3, expired = 1, maxBanAge = 30, to = configs }) =>
  change(base, list(threshold, active, expired, to, maxBanAge)).mayGrow;
// Nothing changed, as when the list is only renamed.
assert.strictEqual(changeTo({}), false);
// The threshold going up can only make it smaller, and going down could make it bigger.
assert.strictEqual(changeTo({ threshold: 10 }), false);
assert.strictEqual(changeTo({ threshold: 8 }), true);
// The same goes for the default points.
assert.strictEqual(changeTo({ active: 2 }), false);
assert.strictEqual(changeTo({ expired: 0 }), false);
assert.strictEqual(changeTo({ active: 2, expired: 0 }), false);
assert.strictEqual(changeTo({ active: 4 }), true);
assert.strictEqual(changeTo({ expired: 2 }), true);
// A max ban age that counts fewer bans, and one that counts more: 0 counts all of them.
assert.strictEqual(changeTo({ maxBanAge: 10 }), false);
assert.strictEqual(changeTo({ maxBanAge: 31 }), true);
assert.strictEqual(changeTo({ maxBanAge: 0 }), true);
assert.strictEqual(change(list(9, 3, 1, configs, 0), list(9, 3, 1, configs, 365)).mayGrow, false);
// A config for another ban list with points of at most the defaults, and one with more.
assert.strictEqual(changeTo({ to: [...configs, config(3, 3, 1)] }), false);
assert.strictEqual(changeTo({ to: [...configs, config(3, 0, 0)] }), false);
assert.strictEqual(changeTo({ to: [...configs, config(3, 4, 1)] }), true);
assert.strictEqual(changeTo({ to: [...configs, config(3, 3, 2)] }), true);
// A second config for a ban list adds its expired points, which could make the list bigger.
assert.strictEqual(changeTo({ to: [...configs, config(1, 0, 0)] }), false);
assert.strictEqual(changeTo({ to: [...configs, config(1, 0, 1)] }), true);
// Deleting a config with points of at least the defaults, one with fewer, and one of two copies,
// which lowers the expired points of its ban list.
assert.strictEqual(changeTo({ to: [configs[1], configs[2]] }), false);
assert.strictEqual(change(list(9, 3, 1, [config(1, 2, 1)]), list(9, 3, 1, [])).mayGrow, true);
assert.strictEqual(changeTo({ to: [configs[0], configs[2]] }), false);
// Lower default points that a config's missing points follow.
const followsDefault = config(1, null, 1);
assert.deepStrictEqual(change(list(9, 3, 1, [followsDefault]), list(9, 2, 1, [followsDefault])), {
  problems: [],
  mayGrow: false,
  withinRules: true
});
// Several changes at once can only make the list smaller if each of them can.
assert.strictEqual(changeTo({ threshold: 10, active: 2, maxBanAge: 10 }), false);
assert.strictEqual(changeTo({ threshold: 10, active: 2, maxBanAge: 0 }), true);
assert.strictEqual(changeTo({ threshold: 12, active: 4 }), true);
// Configs are told apart by their IDs when they are copies.
assert.strictEqual(changeTo({ to: configs.map((stored) => ({ ...stored })) }), false);

// A list with a value that is missing or below 0 might grow with any change, as the importer's
// rule only gives fewer players for fewer points with whole numbers of at least 0.
for (const odd of [
  list(null, 3, 1),
  list(9, null, 1),
  list(9, 3, -1),
  list(9, 3, 1, [], null),
  list(-1, 3, 1),
  list(9, 3, 1, [config(1, -2, 1)]),
  list(9, null, 1, [config(1, null, 1)])
]) {
  const raised = { ...odd, settings: { ...odd.settings, threshold: 10 } };
  assert.strictEqual(change(odd, raised).mayGrow, true);
}

// Lists outside today's rules. A change that can only make one smaller is allowed, as is a change
// to no setting, and one that could make it bigger must bring the whole list within the rules.
// Here one active ban, with 3/3/1 and four 3/1 configs, is enough for the list.
const everyActiveBan = list(3, 3, 1, [
  config(1, 3, 1),
  config(2, 3, 1),
  config(3, 3, 1),
  config(4, 3, 1)
]);
assert.deepStrictEqual(change(everyActiveBan, everyActiveBan), {
  problems: [],
  mayGrow: false,
  withinRules: false
});
// Adding a config the same as its defaults, and raising its threshold while still outside the
// rules.
assert.deepStrictEqual(
  change(everyActiveBan, {
    ...everyActiveBan,
    configs: [...everyActiveBan.configs, config(5, 3, 1)]
  }),
  { problems: [], mayGrow: false, withinRules: false }
);
assert.deepStrictEqual(
  change(everyActiveBan, {
    ...everyActiveBan,
    settings: { ...everyActiveBan.settings, threshold: 4 }
  }),
  { problems: [], mayGrow: false, withinRules: false }
);
// A list with 5/5/1 lowers its expired points, and then cannot put them back unless its threshold
// goes up with them.
const fiveFive = list(5, 5, 1);
const lowered = list(5, 5, 0);
assert.deepStrictEqual(change(fiveFive, lowered, 'battlemetrics'), {
  problems: [],
  mayGrow: false,
  withinRules: false
});
assert.deepStrictEqual(change(lowered, fiveFive, 'battlemetrics'), {
  problems: [
    {
      rule: 'never-enough',
      field: 'threshold',
      message:
        'One active ban plus one expired ban must not be enough to put a player on an export ban list. Here they can give 6 points (5 for an active ban, plus 1 for an expired ban), so the threshold must be 7 or more. Raise the threshold or lower the points.'
    }
  ],
  mayGrow: true,
  withinRules: false
});
assert.deepStrictEqual(change(lowered, list(7, 5, 1), 'battlemetrics'), {
  problems: [],
  mayGrow: true,
  withinRules: true
});
// The values a change leaves alone are not checked against the bounds, so an older list with a
// value outside them can still change others.
const outOfBounds = list(9, 3, 1, [], 5000);
assert.deepStrictEqual(change(outOfBounds, list(10, 3, 1, [], 5000)).problems, []);
assert.deepStrictEqual(change(outOfBounds, list(8, 3, 1, [], 5000)).problems, []);
assert.deepStrictEqual(messages(change(outOfBounds, list(9, 3, 1, [], 4000)).problems), [
  BOUND_MESSAGES.maxBanAge
]);
assert.deepStrictEqual(change(list(0, 3, 1), list(0, 3, 1)).problems, []);

// The messages for a config added or deleted say what the config does.
const nine = list(9, 3, 1);
const addTo = (stored, added, type = 'remote', withLimits = limits) =>
  messages(
    change(stored, { ...stored, configs: [...stored.configs, added] }, type, withLimits).problems
  );
assert.deepStrictEqual(addTo(nine, config(10, 6, 2)), []);
assert.deepStrictEqual(addTo(nine, config(10, 6, 3)), [
  "With these points, an active ban on Partner Org 10's Ban List 10 plus an expired ban on Partner Org 10's Ban List 10 could give 9 points, which reaches this list's threshold of 9. Use fewer points, or raise the list's threshold to 10 or more first."
]);
assert.deepStrictEqual(addTo(list(9, 3, 1, [config(11, 7, 0)]), config(12, 0, 3)), [
  "With these points, an active ban on Partner Org 11's Ban List 11 plus an expired ban on Partner Org 12's Ban List 12 could give 10 points, which reaches this list's threshold of 9. Use fewer points, or raise the list's threshold to 11 or more first."
]);
assert.deepStrictEqual(addTo(list(5, 3, 1), config(13, 5, 0)), [
  "With these points, an active ban on Partner Org 13's Ban List 13 plus an expired ban could give 6 points, which reaches this list's threshold of 5. Use fewer points, or raise the list's threshold to 7 or more first."
]);
assert.deepStrictEqual(addTo(list(5, 3, 1), config(13, 5, 0), 'remote', withRule('one-ban')), [
  "With these points, one active ban on Partner Org 13's Ban List 13 could give 5 points, which reaches this list's threshold of 5. Use fewer points, or raise the list's threshold to 6 or more first."
]);
assert.deepStrictEqual(addTo(list(5, 3, 1), config(13, 0, 6), 'remote', withRule('one-ban')), [
  "With these points, one expired ban on Partner Org 13's Ban List 13 could give 6 points, which reaches this list's threshold of 5. Use fewer points, or raise the list's threshold to 7 or more first."
]);
// When the list's other settings already put it outside the rules, the message says so, names the
// settings that give the points, and says what can still be added. Here two copies of a 2/2 config
// for one ban list give an expired ban 4 points, so one active ban plus one expired ban can give 7
// at threshold 6, and a 3/2 config for another ban list changes nothing of that.
const outsideRules = list(6, 3, 1, [config(19, 2, 2), config(19, 2, 2)]);
assert.deepStrictEqual(addTo(outsideRules, config(20, 3, 2)), [
  "This list's settings are outside today's limits. One active ban plus one expired ban can already give 7 points (3 for an active ban, plus 4 for an expired ban on Partner Org 19's Ban List 19), which reaches the list's threshold of 6. Use points no higher than the list's defaults (3 for an active ban, 1 for an expired ban), or raise the list's threshold to 8 or more first."
]);
assert.deepStrictEqual(addTo(outsideRules, config(20, 3, 1)), []);
// A config that gives more points than the list's settings did is named, though the list was
// outside the rules before it.
assert.deepStrictEqual(addTo(outsideRules, config(20, 4, 1)), [
  "With these points, an active ban on Partner Org 20's Ban List 20 plus an expired ban on Partner Org 19's Ban List 19 could give 8 points, which reaches this list's threshold of 6. Use fewer points, or raise the list's threshold to 9 or more first."
]);
// A list with a 5/1 config at threshold 5, given a 4/1 config.
const fivePointConfig = list(5, 3, 1, [config(21, 3, 1), config(22, 4, 1), config(23, 5, 1)]);
assert.deepStrictEqual(addTo(fivePointConfig, config(24, 4, 1), 'battlemetrics'), [
  "This list's settings are outside today's limits. One active ban plus one expired ban can already give 6 points (5 for an active ban on Partner Org 23's Ban List 23, plus 1 for an expired ban), which reaches the list's threshold of 5. Use points no higher than the list's defaults (3 for an active ban, 1 for an expired ban), or raise the list's threshold to 7 or more first."
]);
// Under the rule that one ban must not be enough, more expired points than before are not why
// one active ban reaches the threshold.
assert.deepStrictEqual(addTo(list(5, 5, 0), config(25, 0, 3), 'remote', withRule('one-ban')), [
  "This list's settings are outside today's limits. One ban can already give 5 points (an active ban), which reaches the list's threshold of 5. Use points no higher than the list's defaults (5 for an active ban, 0 for an expired ban), or raise the list's threshold to 6 or more first."
]);
assert.deepStrictEqual(addTo(list(5, 5, 0), config(25, 0, 6), 'remote', withRule('one-ban')), [
  "With these points, one expired ban on Partner Org 25's Ban List 25 could give 6 points, which reaches this list's threshold of 5. Use fewer points, or raise the list's threshold to 7 or more first."
]);
// A list with a value missing can only be given a config once it is within the rules.
assert.deepStrictEqual(
  addTo(
    { ...outsideRules, settings: { ...outsideRules.settings, maxBanAge: null } },
    config(20, 0, 0)
  ),
  [
    "This list's settings are outside today's limits. One active ban plus one expired ban can already give 7 points (3 for an active ban, plus 4 for an expired ban on Partner Org 19's Ban List 19), which reaches the list's threshold of 6. Raise the list's threshold to 8 or more first."
  ]
);
// A threshold below the minimum is the list's own, whatever a config's points.
assert.deepStrictEqual(addTo(list(3, 1, 0), config(14, 1, 1), 'battlemetrics'), [
  "This list's settings are outside today's limits. A BattleMetrics export ban list's threshold must be at least 4. Use points no higher than the list's defaults (1 for an active ban, 0 for an expired ban), or raise the list's threshold to 4 or more first."
]);
// Deleting a config never gives a ban more points than the list's other settings do already, so
// a list that is refused one is outside the rules without it.
const withDefaultsOutside = list(9, 9, 1, [config(15, 1, 1), config(16, 9, 1)]);
const deleteFrom = (stored, deleted, type = 'remote') =>
  messages(
    change(stored, { ...stored, configs: stored.configs.filter((kept) => kept !== deleted) }, type)
      .problems
  );
assert.deepStrictEqual(deleteFrom(withDefaultsOutside, withDefaultsOutside.configs[1]), []);
assert.deepStrictEqual(deleteFrom(withDefaultsOutside, withDefaultsOutside.configs[0]), [
  "This list's settings are outside today's limits. One active ban plus one expired ban can already give 10 points (9 for an active ban, plus 1 for an expired ban), which reaches the list's threshold of 9. Keep this points setting, or raise the list's threshold to 11 or more first."
]);
const anotherConfigOutside = list(9, 3, 1, [config(26, 1, 1), config(27, 9, 1)]);
assert.deepStrictEqual(deleteFrom(anotherConfigOutside, anotherConfigOutside.configs[0]), [
  "This list's settings are outside today's limits. One active ban plus one expired ban can already give 10 points (9 for an active ban on Partner Org 27's Ban List 27, plus 1 for an expired ban), which reaches the list's threshold of 9. Keep this points setting, or raise the list's threshold to 11 or more first."
]);
const lowThreshold = list(3, 1, 1, [config(17, 0, 0)]);
assert.deepStrictEqual(deleteFrom(lowThreshold, lowThreshold.configs[0], 'battlemetrics'), [
  "This list's settings are outside today's limits. A BattleMetrics export ban list's threshold must be at least 4. Keep this points setting, or raise the list's threshold to 4 or more first."
]);
// Raising the threshold of a list with a value missing must bring the list as it is within the
// rules, so a config can only be deleted from it after that, and the message is about the list
// as it is.
const missingAge = list(4, 3, 1, [config(29, 5, 0)], null);
assert.deepStrictEqual(deleteFrom(missingAge, missingAge.configs[0]), [
  "This list's settings are outside today's limits. One active ban plus one expired ban can already give 6 points (5 for an active ban on Partner Org 29's Ban List 29, plus 1 for an expired ban), which reaches the list's threshold of 4. Keep this points setting, or raise the list's threshold to 7 or more first."
]);
const withThreshold = (stored, threshold) => ({
  ...stored,
  settings: { ...stored.settings, threshold }
});
assert.strictEqual(change(missingAge, withThreshold(missingAge, 6)).problems.length, 1);
const raisedFirst = withThreshold(missingAge, 7);
assert.deepStrictEqual(change(missingAge, raisedFirst).problems, []);
assert.deepStrictEqual(deleteFrom(raisedFirst, raisedFirst.configs[0]), []);

// With a minimum threshold of 1, the points in the messages can be 1 point.
const minimumOne = limitsWith({ EXPORT_REMOTE_MIN_THRESHOLD: '1' });
const oneBanMinimumOne = limitsWith({
  EXPORT_REMOTE_MIN_THRESHOLD: '1',
  EXPORT_REMOTE_NEVER_ENOUGH: 'one-ban'
});
assert.deepStrictEqual(messages(checkRules('remote', list(1, 1, 0), minimumOne)), [
  'One active ban plus one expired ban must not be enough to put a player on an export ban list. Here they can give 1 point (1 for an active ban, plus 0 for an expired ban), so the threshold must be 2 or more. Raise the threshold or lower the points.'
]);
assert.deepStrictEqual(messages(checkRules('remote', list(1, 1, 0), oneBanMinimumOne)), [
  'One ban must not be enough to put a player on an export ban list. Here one ban can give 1 point (an active ban), so the threshold must be 2 or more. Raise the threshold or lower the points.'
]);
assert.deepStrictEqual(messages(checkRules('remote', list(0, 0, 0), minimumOne)), [
  'One active ban plus one expired ban must not be enough to put a player on an export ban list. Here they can give 0 points (0 for an active ban, plus 0 for an expired ban), so the threshold must be 1 or more. Raise the threshold or lower the points.'
]);
assert.deepStrictEqual(addTo(list(1, 0, 0), config(28, 1, 0), 'remote', minimumOne), [
  "With these points, an active ban on Partner Org 28's Ban List 28 plus an expired ban could give 1 point, which reaches this list's threshold of 1. Use fewer points, or raise the list's threshold to 2 or more first."
]);
assert.deepStrictEqual(addTo(list(1, 0, 0), config(28, 0, 1), 'remote', oneBanMinimumOne), [
  "With these points, one expired ban on Partner Org 28's Ban List 28 could give 1 point, which reaches this list's threshold of 1. Use fewer points, or raise the list's threshold to 2 or more first."
]);
assert.deepStrictEqual(
  addTo(list(1, 1, 0, [], null), config(28, 0, 0), 'remote', oneBanMinimumOne),
  [
    "This list's settings are outside today's limits. One ban can already give 1 point (an active ban), which reaches the list's threshold of 1. Raise the list's threshold to 2 or more first."
  ]
);
// When the list's threshold is not a whole number, there is none for a config's points to reach,
// so the message is the one for the list's own settings.
assert.match(
  addTo(list(null, 3, 1), config(18, 3, 1))[0],
  /^One active ban plus one expired ban must not be enough/
);

console.log(
  'Export list limit checks passed: settings, effective points, the points rules, bounds, changes that could make a list bigger, and messages.'
);
