import {
  DEFAULT_LIMITS,
  DEFAULT_SETTINGS,
  MAX_BAN_AGE_MAX,
  POINTS_MAX,
  THRESHOLD_MAX,
  checkRules
} from 'scbl-lib/export-list-limits';

// The FAQ's answer about the limits on export ban lists, written from the limits the web server
// checks changes against (scbl-lib/export-list-limits.js), as /config.js gives them. This file has
// no JSX, so the web server's tests can load it too.

const TYPE_NAMES = { battlemetrics: 'BattleMetrics', remote: 'remote' };

// A whole number as the site writes it, with commas: 20,000.
const number = (value) => value.toLocaleString('en-US');

// The lowest threshold a list of a type with the default points is allowed by its points rules, or
// undefined if none is.
function lowestThreshold(type, limits) {
  for (let threshold = 1; threshold <= THRESHOLD_MAX; threshold++) {
    const list = { settings: { ...DEFAULT_SETTINGS, threshold }, configs: [] };
    if (checkRules(type, list, limits).length === 0) return threshold;
  }
  return undefined;
}

// The points rules: what must never be enough to put a player on a list, and the lowest threshold.
// They are said once for both types when they are the same.
function rules(types, limits) {
  const groups = [];
  for (const type of types) {
    const { neverEnough, minThreshold } = limits[type];
    const group = groups.find(
      (other) => other.neverEnough === neverEnough && other.minThreshold === minThreshold
    );
    if (group) group.types.push(type);
    else groups.push({ neverEnough, minThreshold, types: [type] });
  }

  return groups.flatMap(({ neverEnough, minThreshold, types: groupTypes }) => {
    const list =
      groupTypes.length === Object.keys(DEFAULT_LIMITS).length
        ? 'an export ban list'
        : `a ${TYPE_NAMES[groupTypes[0]]} export ban list`;
    const atLeast = minThreshold > 1 ? `, and at least ${number(minThreshold)}` : '';
    // What the rules mean for the points a new list starts with.
    const example = () => {
      const lowest = lowestThreshold(groupTypes[0], limits);
      if (lowest === undefined) return [];
      return [
        `With the default points of ${number(DEFAULT_SETTINGS.defaultActivePoints)} for an active ban and ${number(DEFAULT_SETTINGS.defaultExpiredPoints)} for an expired ban, that is a threshold of ${number(lowest)} or more.`
      ];
    };

    if (neverEnough === 'active-plus-expired')
      return [
        `So that one active ban and one expired ban are never enough to put a player on ${list}, its threshold must be higher than the most points they can give together, whichever ban lists they are on${atLeast}.`,
        ...example()
      ];
    if (neverEnough === 'one-ban')
      return [
        `So that one ban is never enough to put a player on ${list}, its threshold must be higher than the most points one ban can give, whichever ban list it is on${atLeast}.`,
        ...example()
      ];
    if (minThreshold > 1) {
      const owner = list.replace(/^a/, 'A');
      return [`${owner}'s threshold must be at least ${number(minThreshold)}.`];
    }
    return [];
  });
}

// The most players a list of each type can be given. They limit new lists and changes that make a
// list bigger, but a list is never cut down to them, so lists saved before them, or that grow as
// new bans are added, can have more. Each player on a BattleMetrics list is added to BattleMetrics
// separately, which is why those lists can be kept smaller.
function caps(limits) {
  const cap = (type) => (limits[type]?.maxPlayers > 0 ? limits[type].maxPlayers : 0);
  const battlemetrics = cap('battlemetrics');
  const remote = cap('remote');
  const why =
    'as each player on a BattleMetrics export ban list is added to BattleMetrics separately';

  let refused;
  if (battlemetrics && remote) {
    const most =
      battlemetrics === remote
        ? `${number(remote)} players`
        : `${number(remote)} players, or ${number(battlemetrics)} for a BattleMetrics export ban list`;
    refused = `A new export ban list, or a change that makes a list bigger, is refused if the list would then have more than ${most}${battlemetrics < remote ? `, ${why}` : ''}.`;
  } else if (battlemetrics)
    refused = `A new BattleMetrics export ban list, or a change that makes one bigger, is refused if the list would then have more than ${number(battlemetrics)} players, ${why}.`;
  else if (remote)
    refused = `A new remote export ban list, or a change that makes one bigger, is refused if the list would then have more than ${number(remote)} players.`;
  else return [];
  return [
    refused,
    'Lists are never cut down to fit, so a list can still grow past its limit as new bans are added.'
  ];
}

export default function exportListLimitsAnswer(limits) {
  const types = Object.keys(DEFAULT_LIMITS).filter(
    (type) => limits != null && Object.hasOwn(limits, type) && limits[type] != null
  );
  return [
    ...rules(types, limits),
    ...caps(Object.fromEntries(types.map((type) => [type, limits[type]]))),
    `Points can be whole numbers from 0 to ${number(POINTS_MAX)}, thresholds from 1 to ${number(THRESHOLD_MAX)}, and max ban ages from 0 to ${number(MAX_BAN_AGE_MAX)} days, where 0 counts bans of any age.`,
    "Export ban lists saved before these limits keep working as they are, and you can always rename them or change their webhooks. Changes that make one smaller, for example raising its threshold, are allowed too, as long as each value set is within these ranges and none of the list's settings or points is empty or below 0. Other changes must bring the whole list within the limits."
  ].join(' ');
}
