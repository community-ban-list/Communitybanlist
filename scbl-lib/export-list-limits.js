// Limits on export ban lists' settings, which changes to a list must keep to: the points rules,
// which keep one ban, or one active ban and one expired ban, from being enough to put a player on
// a list, and the bounds on each value. The web server checks changes against them, and the forms
// can show the same problems, as this file has no imports.
//
// Who is on a list is worked out by the importer (ban-importer/src/export-ban-manager.js). For each
// partner ban list, a player gets the list's active points once if they have an active ban on it,
// and its expired points for each expired ban on it. The points come from the list's config for
// that ban list, or its defaults when it has none. Bans older than the max ban age are left out,
// and players whose points come to the threshold are on the list.

// The values a new list takes for the settings it is not given, which are also the model's
// defaults. Its threshold also follows the minimum thresholds (see defaultThreshold).
export const DEFAULT_SETTINGS = {
  threshold: 9,
  defaultActivePoints: 3,
  defaultExpiredPoints: 1,
  maxBanAge: 0
};

// The points the form for a list's config starts with.
export const DEFAULT_CONFIG_POINTS = { activePoints: 3, expiredPoints: 1 };

// What must never be enough to put a player on a list, the values of EXPORT_BM_NEVER_ENOUGH and
// EXPORT_REMOTE_NEVER_ENOUGH: one active ban plus one expired ban (so one ban is not enough either),
// one ban, or nothing, which turns the rule off.
export const NEVER_ENOUGH = ['active-plus-expired', 'one-ban', 'none'];

// The largest value of each setting a change can set. Points and the max ban age can be 0, the
// threshold no less than 1, and every value is a whole number.
export const POINTS_MAX = 100;
export const THRESHOLD_MAX = 1000;
export const MAX_BAN_AGE_MAX = 3650;

// The limits for each list type, used when their environment variables are unset: the most players
// a list can have (0 for no limit), its lowest threshold, and what must never be enough to put a
// player on it. Each player on a BattleMetrics list is a request to BattleMetrics, so those lists
// are kept smaller.
export const DEFAULT_LIMITS = {
  battlemetrics: { maxPlayers: 20000, minThreshold: 4, neverEnough: 'active-plus-expired' },
  remote: { maxPlayers: 40000, minThreshold: 4, neverEnough: 'active-plus-expired' }
};

// The environment variables that set each limit.
const VARIABLES = {
  battlemetrics: {
    maxPlayers: 'EXPORT_BM_MAX_PLAYERS',
    minThreshold: 'EXPORT_BM_MIN_THRESHOLD',
    neverEnough: 'EXPORT_BM_NEVER_ENOUGH'
  },
  remote: {
    maxPlayers: 'EXPORT_REMOTE_MAX_PLAYERS',
    minThreshold: 'EXPORT_REMOTE_MIN_THRESHOLD',
    neverEnough: 'EXPORT_REMOTE_NEVER_ENOUGH'
  }
};

// How each limit is read from its variable, and what it must be. read gives undefined for a value
// it cannot use.
const READERS = {
  maxPlayers: {
    read: (value) => wholeNumber(value, 0, Number.MAX_SAFE_INTEGER),
    expected: 'a whole number of players, or 0 for no limit'
  },
  minThreshold: {
    read: (value) => wholeNumber(value, 1, THRESHOLD_MAX),
    expected: `a whole number from 1 to ${formatNumber(THRESHOLD_MAX)}`
  },
  neverEnough: {
    read: (value) => NEVER_ENOUGH.find((rule) => rule === value.toLowerCase()),
    expected: 'active-plus-expired, one-ban or none'
  }
};

const TYPE_NAMES = { battlemetrics: 'BattleMetrics', remote: 'remote' };

// The settings that decide who is on a list, with its configs.
const SETTINGS = Object.keys(DEFAULT_SETTINGS);

const POINTS_BOUNDS = {
  min: 0,
  max: POINTS_MAX,
  message: `Points must be whole numbers from 0 to ${formatNumber(POINTS_MAX)}.`
};

// The bounds on each value, in the order they are checked, and the message for a value outside
// them.
const BOUNDS = {
  threshold: {
    min: 1,
    max: THRESHOLD_MAX,
    message: `The threshold must be a whole number from 1 to ${formatNumber(THRESHOLD_MAX)}.`
  },
  defaultActivePoints: POINTS_BOUNDS,
  defaultExpiredPoints: POINTS_BOUNDS,
  maxBanAge: {
    min: 0,
    max: MAX_BAN_AGE_MAX,
    message: `The max ban age must be a whole number of days from 0 to ${formatNumber(MAX_BAN_AGE_MAX)}. Use 0 to count bans of any age.`
  },
  activePoints: POINTS_BOUNDS,
  expiredPoints: POINTS_BOUNDS
};

// Read the limits from environment variables, given as an object like process.env. A variable that
// is unset or empty keeps its default, and so does one that cannot be used, which is described in
// problems. This never throws, as everything that loads scbl-lib/config.js reads them.
export function readLimits(env) {
  const limits = {};
  const problems = [];
  for (const [type, variables] of Object.entries(VARIABLES)) {
    limits[type] = { ...DEFAULT_LIMITS[type] };
    for (const [limit, variable] of Object.entries(variables)) {
      let value;
      try {
        const given = env?.[variable];
        value = given === undefined || given === null ? '' : String(given).trim();
      } catch {
        value = '';
      }
      if (value === '') continue;

      const read = READERS[limit].read(value);
      if (read !== undefined) limits[type][limit] = read;
      else
        problems.push(
          `${variable} must be ${READERS[limit].expected}, not ${JSON.stringify(value)}, so the default of ${formatNumber(limits[type][limit])} is used.`
        );
    }
  }
  return { limits, problems };
}

// Read limits given as values rather than environment variables, as the web server gives the
// client its limits through /config.js, by the same rules: each limit is read as its variable
// would be, and one that is missing or cannot be used keeps its default. This never throws, as the
// client reads them when it loads scbl-lib/config.js.
export function readGivenLimits(given) {
  const env = {};
  for (const [type, variables] of Object.entries(VARIABLES)) {
    for (const [limit, variable] of Object.entries(variables)) {
      let value;
      try {
        value = given?.[type]?.[limit];
      } catch {
        value = undefined;
      }
      // A variable's value is text, so only numbers and text can be read as one.
      if (typeof value === 'number' || typeof value === 'string') env[variable] = value;
    }
  }
  return readLimits(env);
}

// The threshold a new list starts with: the model's default, or a minimum threshold above it, so
// it is allowed whichever type the list is.
export function defaultThreshold(limits) {
  const minimums = Object.values(limits ?? {}).map((limit) => limit?.minThreshold);
  return Math.max(DEFAULT_SETTINGS.threshold, ...minimums.filter(Number.isInteger));
}

// The problems with the values a change sets, which must each be a whole number within its bounds.
// values holds any of the list's settings and a config's activePoints and expiredPoints, and only
// those it holds are checked, so one left as undefined is refused.
export function checkBounds(values) {
  return Object.entries(BOUNDS)
    .filter(([field]) => Object.hasOwn(values, field))
    .filter(([field, { min, max }]) => {
      const value = values[field];
      return !(Number.isInteger(value) && value >= min && value <= max);
    })
    .map(([field, { message }]) => ({ field, message }));
}

// The most points an active ban and an expired ban can give a player on a list, and where they
// come from: config is null for the list's defaults, which every ban list without a config gets,
// or else the config that gives them. A list is { settings, configs }, with the list's settings
// and its configs as they are stored: { id, banList, activePoints, expiredPoints }, plus
// banListName and organisationName for the messages.
//
// Points are counted as the importer counts them. A config's missing points take the list's
// defaults, and points below 0 count as 0. A ban list with more than one config, which older lists
// can have, gives the most active points of any of them, and the expired points of all of them
// added together for each expired ban.
export function effectivePoints({ settings, configs = [] }) {
  let active = { points: points(settings.defaultActivePoints), config: null };
  let expired = { points: points(settings.defaultExpiredPoints), config: null };
  for (const banList of banListPoints(settings, configs).values()) {
    if (banList.active > active.points) active = { points: banList.active, config: banList.config };
    if (banList.expired > expired.points)
      expired = { points: banList.expired, config: banList.config };
  }
  return { active, expired };
}

// The problems of a whole list under its type's points rules, as { rule, field, message }: what
// must never be enough to put a player on it, and its lowest threshold. A list breaks them when it
// has any. Each message gives the lowest threshold within both rules.
export function checkRules(type, list, limits) {
  return ruleProblems(type, list, limits);
}

// Check a change to a list: its creation, a change to its settings, or a config added or deleted.
// before is the list as stored, or null for a new list, and after is the whole list after the
// change; both are lists as effectivePoints takes them. The values the change sets must be within
// their bounds. A change that can only make the list smaller, or keep it the same, is then allowed,
// so lists saved before these rules keep working. One that could make the list bigger must leave
// the whole list within the points rules.
//
// Gives the problems that refuse the change, whether it could make the list bigger, and whether the
// whole list is within the rules after it.
export function checkChange(type, before, after, limits) {
  const set = setValues(before, after);
  const outOfBounds = [
    ...checkBounds(set.settings),
    ...set.configs.flatMap(({ activePoints, expiredPoints }) =>
      checkBounds({ activePoints, expiredPoints })
    )
  ];
  const growing = mayGrow(before, after);
  const change = { kind: set.kind, before };
  const rules = ruleProblems(type, after, limits, change);

  // A list with values that are missing or below 0 can only have its threshold raised to one
  // within the rules for the list as it is, as any change to it could make it bigger. So a config
  // is deleted from one after its threshold is raised that far, and the problems are those of the
  // list as it is. Deleting a config never takes a list further outside the rules, so the list as
  // it is has problems whenever the list after the change does.
  const refusals =
    rules.length > 0 && set.kind === 'delete' && !comparable(before)
      ? ruleProblems(type, before, limits, change)
      : rules;
  return {
    problems: outOfBounds.length > 0 ? outOfBounds : growing ? refusals : [],
    mayGrow: growing,
    withinRules: rules.length === 0
  };
}

// The values a change sets: the settings that differ from before, or all of them for a new list,
// and the configs added. kind says what the change is, for the messages: a change to the list
// itself, or a config added or deleted.
function setValues(before, after) {
  const settings = Object.fromEntries(
    SETTINGS.filter((name) => !before || after.settings[name] !== before.settings[name]).map(
      (name) => [name, after.settings[name]]
    )
  );
  const beforeConfigs = before?.configs ?? [];
  const afterConfigs = after.configs ?? [];
  const configs = afterConfigs.filter((config) => !includesConfig(beforeConfigs, config));
  let kind = 'list';
  if (before && Object.keys(settings).length === 0) {
    if (configs.length > 0) kind = 'add';
    else if (beforeConfigs.some((config) => !includesConfig(afterConfigs, config))) kind = 'delete';
  }
  return { settings, configs, kind };
}

// Whether a list of configs includes a config, as the same object or one with the same ID.
function includesConfig(configs, config) {
  return configs.some(
    (other) =>
      other === config || (other.id !== undefined && other.id !== null && other.id === config.id)
  );
}

// Whether a change could put a player on the list who would not be on it before. A new list
// could. Otherwise it could only if it lowers the threshold, makes the max ban age count older
// bans, or gives a ban on any ban list more points. That only holds for whole numbers of at least
// 0, so a change to a list with any other values counts as one that could.
function mayGrow(before, after) {
  if (!before || !comparable(before) || !comparable(after)) return true;
  const was = before.settings;
  const will = after.settings;
  if (will.threshold < was.threshold || countsOlderBans(was.maxBanAge, will.maxBanAge)) return true;

  // The defaults stand for every ban list without a config.
  if (
    will.defaultActivePoints > was.defaultActivePoints ||
    will.defaultExpiredPoints > was.defaultExpiredPoints
  )
    return true;
  const wasPoints = banListPoints(was, before.configs ?? []);
  const willPoints = banListPoints(will, after.configs ?? []);
  for (const banList of new Set([...wasPoints.keys(), ...willPoints.keys()])) {
    const from = wasPoints.get(banList) ?? defaultPoints(was);
    const to = willPoints.get(banList) ?? defaultPoints(will);
    if (to.active > from.active || to.expired > from.expired) return true;
  }
  return false;
}

// Whether a list's settings, and its configs' points after missing ones take the defaults, are
// all whole numbers of at least 0.
function comparable({ settings, configs = [] }) {
  const valid = (value) => Number.isInteger(value) && value >= 0;
  return (
    SETTINGS.every((name) => valid(settings[name])) &&
    configs.every(
      (config) =>
        valid(config.activePoints ?? settings.defaultActivePoints) &&
        valid(config.expiredPoints ?? settings.defaultExpiredPoints)
    )
  );
}

// Whether a new max ban age counts bans an old one did not. 0 counts bans of any age.
function countsOlderBans(was, will) {
  if (will === was) return false;
  return will === 0 || (was !== 0 && will > was);
}

const defaultPoints = (settings) => ({
  active: points(settings.defaultActivePoints),
  expired: points(settings.defaultExpiredPoints)
});

// The points a ban on each ban list with a config gives, by ban list ID, with the first of its
// configs for the messages.
function banListPoints(settings, configs) {
  const banLists = new Map();
  for (const config of configs) {
    const banList = banLists.get(config.banList) ?? { active: 0, expired: 0, config };
    banList.active = Math.max(
      banList.active,
      points(config.activePoints, settings.defaultActivePoints)
    );
    banList.expired += points(config.expiredPoints, settings.defaultExpiredPoints);
    banLists.set(config.banList, banList);
  }
  return banLists;
}

// Points as the rules count them: a missing value takes the fallback, and anything that is not a
// number above 0 counts as 0.
function points(value, fallback) {
  const given = value ?? fallback;
  return typeof given === 'number' && given > 0 ? given : 0;
}

// The problems of a whole list under its type's points rules, worded for the change: change.kind
// is 'list' for a list's own settings, or 'add' or 'delete' for a config added or deleted, and
// change.before is the list before it.
function ruleProblems(type, list, limits, change = { kind: 'list' }) {
  if (!Object.hasOwn(TYPE_NAMES, type) || !limits?.[type])
    throw new TypeError(`There are no limits for export ban lists of type ${type}.`);
  const { minThreshold, neverEnough } = limits[type];
  const most = effectivePoints(list);
  const { threshold } = list.settings;

  // The most points that must not be enough, and so the lowest threshold within each rule.
  const enough = mustNotBeEnough(neverEnough, most);
  const needed = enough === undefined ? minThreshold : enough + 1;
  const lowest = Math.max(minThreshold, needed);
  if (Number.isInteger(threshold) && threshold >= lowest) return [];

  // Name the rule that sets the lowest threshold, so a threshold that meets it meets both.
  if (enough !== undefined && needed >= minThreshold)
    return [
      {
        rule: 'never-enough',
        field: 'threshold',
        message: neverEnoughMessage(neverEnough, most, threshold, lowest, change)
      }
    ];
  return [
    {
      rule: 'min-threshold',
      field: 'threshold',
      message: minThresholdMessage(type, minThreshold, change)
    }
  ];
}

// The most points the rule says must not be enough to put a player on a list: those one active ban
// plus one expired ban can give, or one ban, or undefined when the rule is off.
function mustNotBeEnough(rule, most) {
  if (rule === 'active-plus-expired') return most.active.points + most.expired.points;
  if (rule === 'one-ban') return Math.max(most.active.points, most.expired.points);
  return undefined;
}

// How the messages for adding or deleting a config start when the list is outside the rules
// whatever the config's points.
const OUTSIDE_THE_LIMITS = "This list's settings are outside today's limits.";

function neverEnoughMessage(rule, most, threshold, lowest, change) {
  const total = mustNotBeEnough(rule, most);
  const activeBan = `an active ban${on(most.active.config)}`;
  const expiredBan = `an expired ban${on(most.expired.config)}`;
  const activeIsMost = most.active.points >= most.expired.points;
  // What gives the points, as the messages for a list's own settings say it.
  const given =
    rule === 'active-plus-expired'
      ? `${formatNumber(most.active.points)} for ${activeBan}, plus ${formatNumber(most.expired.points)} for ${expiredBan}`
      : activeIsMost
        ? activeBan
        : expiredBan;

  if (change.kind === 'list' || !Number.isInteger(threshold)) {
    if (rule === 'active-plus-expired')
      return `One active ban plus one expired ban must not be enough to put a player on an export ban list. Here they can give ${pointsText(total)} (${given}), so the threshold must be ${formatNumber(lowest)} or more. Raise the threshold or lower the points.`;
    return `One ban must not be enough to put a player on an export ban list. Here one ban can give ${pointsText(total)} (${given}), so the threshold must be ${formatNumber(lowest)} or more. Raise the threshold or lower the points.`;
  }

  // A config added that raises these points is why they reach the threshold, so the message is
  // about its points.
  if (change.kind === 'add' && total > mustNotBeEnough(rule, effectivePoints(change.before))) {
    const bans =
      rule === 'active-plus-expired'
        ? `${activeBan} plus ${expiredBan}`
        : `one ${activeIsMost ? 'active' : 'expired'} ban${on((activeIsMost ? most.active : most.expired).config)}`;
    return `With these points, ${bans} could give ${pointsText(total)}, which reaches this list's threshold of ${formatNumber(threshold)}. Use fewer points, or raise the list's threshold to ${formatNumber(lowest)} or more first.`;
  }

  // Otherwise the list's other settings give these points already, whatever the config's points.
  // Deleting a config never raises them, as its ban list then gets the list's default points,
  // which are counted already, or those of its other configs.
  const already =
    rule === 'active-plus-expired'
      ? `One active ban plus one expired ban can already give ${pointsText(total)} (${given})`
      : `One ban can already give ${pointsText(total)} (${given})`;
  return `${OUTSIDE_THE_LIMITS} ${already}, which reaches the list's threshold of ${formatNumber(threshold)}. ${configInstead(change, lowest)}`;
}

function minThresholdMessage(type, minThreshold, change) {
  const rule = `A ${TYPE_NAMES[type]} export ban list's threshold must be at least ${formatNumber(minThreshold)}.`;
  if (change.kind === 'list') return rule;
  // Adding or deleting a config changes neither the threshold nor the minimum, so the list was
  // below the minimum already.
  return `${OUTSIDE_THE_LIMITS} ${rule} ${configInstead(change, minThreshold)}`;
}

// What to do instead of adding or deleting a config on a list that is outside the rules whatever
// the config's points: keep the config, or add one with points no higher than the list's defaults,
// which cannot make the list bigger, unless the list has values that are missing or below 0. Or
// raise the list's threshold first.
function configInstead({ kind, before }, lowest) {
  const threshold = `the list's threshold to ${formatNumber(lowest)} or more first.`;
  if (kind === 'delete') return `Keep this points setting, or raise ${threshold}`;
  if (!comparable(before)) return `Raise ${threshold}`;
  const { defaultActivePoints, defaultExpiredPoints } = before.settings;
  return `Use points no higher than the list's defaults (${formatNumber(defaultActivePoints)} for an active ban, ${formatNumber(defaultExpiredPoints)} for an expired ban), or raise ${threshold}`;
}

// " on" the ban list a config is for, as the site names ban lists, or nothing for the defaults.
function on(config) {
  if (!config) return '';
  if (!config.banListName) return ` on ban list ${config.banList}`;
  return config.organisationName
    ? ` on ${config.organisationName}'s ${config.banListName}`
    : ` on ${config.banListName}`;
}

// A number of points as the messages write it: 1 point, or 20 points.
function pointsText(value) {
  return `${formatNumber(value)} ${value === 1 ? 'point' : 'points'}`;
}

// A whole number as the messages write it, with commas: 20,000.
function formatNumber(value) {
  return Number.isInteger(value)
    ? String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    : String(value);
}

// A whole number from min to max written as digits, or undefined.
function wholeNumber(value, min, max) {
  if (!/^\d+$/.test(value)) return undefined;
  const number = Number(value);
  return number >= min && number <= max ? number : undefined;
}
