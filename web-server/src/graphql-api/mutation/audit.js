import { Logger, logText } from 'scbl-lib/utils';

// The changes users make to their export ban lists on the website are posted to the CBL log
// channel, as the Discord bot posts its own changes (discord-bot/src/utils/audit.js): who made each
// one, the signed-in Steam user, and what it was, or what failed. The channel is for CBL's admins
// only, so Steam IDs, Steam names, list names and BattleMetrics ban list IDs are given, but never a
// list's Discord webhook, as anyone with its address can post to the channel, nor its BattleMetrics
// invite, with which any organisation can use its ban list. An error is passed to the logger, which
// describes it in a line (describeError), never whole, as an API client's error holds its request,
// with the API key. ExportBanList posts the BattleMetrics side of a change itself.
//
// Names are their users' to choose, so each is kept on one line and shown as written (logText):
// a name cannot start a line that looks like another one, or hide part of its line.

// How many lines each user's changes can post a minute, not counting failures. The channel's
// webhook takes about 5 messages every 2 seconds from all of CBL's services together, and nothing
// limits how often a user can save a list or change its configs, so a user doing that over and over
// could otherwise keep the importer's and the bot's messages from the channel. Setting up a list
// by hand, with a config for each of CBL's ban lists, posts about 20. Lines over the limit are
// printed in the web server's console only: the first of them posts a line saying so, and the
// user's next line once there is room again says how many there were.
//
// A failure is always posted, and does not count. Failures come from BattleMetrics or the database,
// not from how often a user saves, and the lines that leave something for an admin to clean up by
// hand come from creating and deleting lists, which guard-changes.js limits to 3 a minute.
// ExportBanList's own lines are not counted either: they come with those creations and deletions,
// and with the invite a save makes for a list that lacks one, once.
export const LINES_PER_MINUTE = 30;

const MINUTE = 60 * 1000;

// When each user's lines in the last minute were posted, oldest first, by Steam ID, and how many
// lines of each user over the limit went to the console only, until their next line is posted.
// They are only kept in memory, so the limit starts afresh when the web server restarts, as the
// limits on changes do (guard-changes.js).
const recentLines = new Map();
const heldBack = new Map();

// How each type of list is named, as scbl-lib names them.
const TYPE_NAMES = { battlemetrics: 'BattleMetrics', remote: 'remote' };

// "1 point" or "2 points".
const plural = (count, noun) => `${count} ${noun}${count === 1 ? '' : 's'}`;

// A name in quotes, as the lines give names.
export const quote = (text) => `"${logText(text)}"`;

// A Steam user, as the bot names one: their Steam name, when CBL has one, and their Steam ID.
export function describeSteamUser({ id, name }) {
  return name ? `Steam user ${quote(name)} (ID: ${id})` : `Steam user ${id}`;
}

// An export ban list, as the importer and ExportBanList name one, with its type. A list that could
// not be created has no ID.
export function describeList({ id, name, server, type }) {
  const typeName = TYPE_NAMES[type] ?? type;
  const details = id === undefined || id === null ? typeName : `ID: ${id}, ${typeName}`;
  return `${logText(server)}'s List ${quote(name)} (${details})`;
}

const describeMaxBanAge = (days) => (days > 0 ? plural(days, 'day') : 'none');

// The settings that decide who is on a list, and whether it has a Discord webhook.
export function describeSettings({
  threshold,
  defaultActivePoints,
  defaultExpiredPoints,
  maxBanAge,
  discordWebhook
}) {
  return [
    `threshold ${threshold}`,
    `${plural(defaultActivePoints, 'point')} for an active ban and ${defaultExpiredPoints} for an expired ban`,
    `max ban age ${describeMaxBanAge(maxBanAge)}`,
    discordWebhook ? 'Discord webhook set' : 'no Discord webhook'
  ].join(', ');
}

// The values a change to a list can set, each with how it is named and shown.
const VALUES = [
  ['name', 'name', quote],
  ['server', 'server', quote],
  ['threshold', 'threshold', String],
  ['defaultActivePoints', 'points for an active ban', String],
  ['defaultExpiredPoints', 'points for an expired ban', String],
  ['maxBanAge', 'max ban age', describeMaxBanAge]
];

// The values a change to a list changed, each as "old → new", as the Discord bot gives its
// changes (discord-bot/src/utils/apply-changes.js), from the list before and after it. A Discord
// webhook is only said to be set or not, or changed.
export function describeChanges(before, after) {
  const changes = VALUES.filter(([field]) => before[field] !== after[field]).map(
    ([field, label, format]) => `${label} ${format(before[field])} → ${format(after[field])}`
  );
  const had = Boolean(before.discordWebhook);
  const has = Boolean(after.discordWebhook);
  if (had !== has)
    changes.push(`Discord webhook ${had ? 'set' : 'none'} → ${has ? 'set' : 'none'}`);
  else if (has && before.discordWebhook !== after.discordWebhook)
    changes.push('Discord webhook changed');
  return changes;
}

// A list's config: the ban list it is for, with its organisation, and the points it gives, from
// what the resolvers load for their checks.
export function describeConfig({
  banList,
  banListName,
  organisationName,
  activePoints,
  expiredPoints
}) {
  const banListText = banListName
    ? `ban list ${quote(banListName)} (ID: ${banList})`
    : `ban list ${banList}`;
  const organisation = organisationName ? ` of organisation ${quote(organisationName)}` : '';
  return `${banListText}${organisation}, ${plural(activePoints, 'point')} for an active ban and ${expiredPoints} for an expired ban`;
}

// Post a change the signed-in user made, or one that failed, with the errors it failed with.
export default function audit(context, change, ...errors) {
  const user = describeSteamUser(context.user);
  const line = `${user} ${change}`;
  if (errors.length > 0) {
    Logger.verbose('WebServer', 1, line, ...errors);
    return;
  }

  const id = context.user.id;
  const held = heldBack.get(id);
  if (roomForLine(id, Date.now())) {
    if (held !== undefined) {
      heldBack.delete(id);
      Logger.verbose(
        'WebServer',
        1,
        `${user}'s changes have room in the log channel again, after ${plural(held, 'line')} of theirs went to the web server's console only.`
      );
    }
    Logger.verbose('WebServer', 1, line);
    return;
  }
  if (held === undefined)
    Logger.verbose(
      'WebServer',
      1,
      `${user}'s changes have posted ${LINES_PER_MINUTE} lines in the last minute, the most for one user, so their next ones are only in the web server's console until there is room again. Failures are still posted.`
    );
  heldBack.set(id, (held ?? 0) + 1);
  Logger.verbose('WebServer', 2, line);
}

// Post a failure that leaves something for an admin to clean up by hand, such as a BattleMetrics
// ban list that nothing records. Like every failure it is always posted, and it goes ahead of the
// channel's other messages and is never dropped for them, as Logger.important's lines are.
export function auditCleanup(context, change, ...errors) {
  Logger.important('WebServer', `${describeSteamUser(context.user)} ${change}`, ...errors);
}

// Whether a user's change can post a line now, which then counts towards their limit.
function roomForLine(user, now) {
  // Forget lines from over a minute ago, and the users with none left, so the map stays small.
  for (const [id, times] of recentLines) {
    const recent = times.filter((time) => now - time < MINUTE);
    if (recent.length > 0) recentLines.set(id, recent);
    else recentLines.delete(id);
  }

  const times = recentLines.get(user) || [];
  if (times.length >= LINES_PER_MINUTE) return false;
  recentLines.set(user, [...times, now]);
  return true;
}
