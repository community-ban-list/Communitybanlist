import { EmbedBuilder, escapeMarkdown, time, TimestampStyles } from 'discord.js';

import { logText } from 'scbl-lib/utils';

// The CBL brand colour used in its Discord webhook messages.
const COLOR = 0xffc40b;

const BAN_LIST_TYPES = {
  remote: 'Remote',
  battlemetrics: 'BattleMetrics'
};

export function bold(text) {
  return `**${escapeMarkdown(text)}**`;
}

export function truncate(text, length) {
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

export function plural(count, noun) {
  return `${count.toLocaleString('en-US')} ${noun}${count === 1 ? '' : 's'}`;
}

// The most characters of an organisation's or a ban list's name that formatBanListName gives, by
// which most of /banlist's replies, and the lines of /banlist status's list of every list, name a
// ban list: as many as /org and /banlist let an admin give. A name written outside the bot, e.g. by
// hand before the bot existed, can be longer, as the columns take 255, so it is cut to that many,
// counted as Unicode code points, so no code point is cut in half, though a character of several
// code points, such as a flag, can be cut short. Those texts are measured against Discord's limits
// with names of that length, escaped, which escapeMarkdown can make twice as long, e.g. the
// question of /banlist confirm-removal, which gives the list's name twice and must stay within the
// 2,000 characters Discord takes in a message. Embed titles are cut to the 256 characters Discord
// takes in one (see banListEmbed), and the audit log gives names whole (see quote).
const MAX_NAME_LENGTH = 100;
function cutName(name) {
  const characters = Array.from(name);
  return characters.length > MAX_NAME_LENGTH
    ? `${characters.slice(0, MAX_NAME_LENGTH - 1).join('')}…`
    : name;
}

export function formatBanListName(banList, organisation) {
  return `${bold(cutName(organisation.name))} / ${bold(cutName(banList.name))}`;
}

// A name, or other text someone chose, in quotes, as the audit log gives it: kept on one line and
// shown as written (logText), as the website's lines give names, so it cannot start a line that
// looks like another one, or hide part of its line. Only for the log: replies escape names with
// bold.
export const quote = (text) => `"${logText(text)}"`;

// Describe the organisation for the audit log.
export function describeOrganisation(organisation) {
  return `organisation ${quote(organisation.name)} (ID: ${organisation.id})`;
}

// Describe the ban list for the audit log.
export function describeBanList(banList, organisation) {
  return `ban list ${quote(banList.name)} (ID: ${banList.id}) of ${describeOrganisation(organisation)}`;
}

export function formatBanListType(type) {
  return BAN_LIST_TYPES[type] || type;
}

// How a paused ban list's row (see scbl-lib/db/ban-list-suspensions.js) is shown: suspended, as
// its import is stopped and its bans count for nothing, or resuming, as it is imported again while
// its bans still count for nothing, until the ban importer has caught up with it.
export function pauseState(paused) {
  if (!paused) return null;
  return paused.resumedAt === null || paused.resumedAt === undefined ? 'suspended' : 'resuming';
}

// What a paused ban list's row says, on a few lines: since when it is suspended or resuming, by
// whom, and why. Who and why are as the admin gave them, so they are escaped.
export function describePause(paused) {
  const state = pauseState(paused);
  if (!state) return 'Not paused: it is imported, and its bans count.';
  const since = time(paused.suspendedAt, TimestampStyles.ShortDateTime);
  const lines = [
    state === 'suspended'
      ? `Suspended since ${since} by ${escapeMarkdown(paused.suspendedBy)}: it is not imported, and its bans count for nothing.`
      : `Resuming since ${time(paused.resumedAt, TimestampStyles.ShortDateTime)}, after being suspended since ${since} by ${escapeMarkdown(paused.suspendedBy)}: it is imported again, and its bans count again once the ban importer has read it in full and confirmed the bans it no longer has.`
  ];
  if (paused.reason) lines.push(`Reason: ${escapeMarkdown(paused.reason)}`);
  return lines.join('\n');
}

export function formatBanListSource(banList) {
  if (banList.type === 'battlemetrics')
    return `[${banList.source}](https://www.battlemetrics.com/rcon/ban-lists/${banList.source})`;
  return banList.source;
}

// The organisation and its ban lists, each with its number of bans, and marked when it is paused,
// by the paused lists' rows, by ban list ID (paused).
export function organisationEmbed(organisation, banLists, banCounts, paused = new Map()) {
  const description = banLists
    .map((banList) => {
      const state = pauseState(paused.get(banList.id));
      return `${bold(banList.name)} (#${banList.id}) · ${formatBanListType(banList.type)} · ${plural(
        banCounts[banList.id] || 0,
        'ban'
      )}${state ? ` · ${state}` : ''}\n${formatBanListSource(banList)}`;
    })
    .join('\n\n');

  return new EmbedBuilder()
    .setColor(COLOR)
    .setTitle(truncate(organisation.name, 256))
    .setDescription(truncate(description || 'No ban lists yet. Add one with `/banlist add`.', 4096))
    .addFields(
      { name: 'ID', value: String(organisation.id), inline: true },
      { name: 'Discord', value: truncate(organisation.discord || 'None', 1024), inline: true },
      {
        name: 'Added',
        value: time(organisation.createdAt, TimestampStyles.ShortDate),
        inline: true
      }
    );
}

// The ban list, with what its paused row says, when it is given and the list is paused.
export function banListEmbed(banList, organisation, paused = null) {
  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle(truncate(`${organisation.name} / ${banList.name}`, 256))
    .addFields(
      { name: 'ID', value: String(banList.id), inline: true },
      { name: 'Type', value: formatBanListType(banList.type), inline: true },
      { name: 'Source', value: truncate(formatBanListSource(banList), 1024) }
    );
  if (pauseState(paused))
    embed.addFields({ name: 'Paused', value: truncate(describePause(paused), 1024) });
  return embed;
}

// The states of a list's import, as the ban importer keeps them in its BanListSyncs row.
const IMPORT_STATES = {
  ok: 'OK',
  failing: 'Failing',
  held: 'Imported, with removals held until they are confirmed',
  access_lost: 'CBL cannot read it on BattleMetrics',
  self_import: "Not imported, as its source is one of CBL's own export ban lists"
};

// What a list's status says when its type or source was changed and the ban importer has not read
// it since, or not finished switching it to its new source (see readStatus), on its own line and
// in short, for a list of lists.
const SOURCE_CHANGES = {
  unread: {
    line: 'Its type or source was changed, and the ban importer has not read it since.',
    short: 'type or source changed, not read since'
  },
  replacing: {
    line: 'Its type or source was changed, and the ban importer has not finished switching it to the new source yet.',
    short: 'type or source changed, switch not finished yet'
  }
};

// A time, as Discord shows it in each reader's own time zone, relative to now, or never, and as a
// date and time.
const when = (value) => (value ? time(new Date(value), TimestampStyles.RelativeTime) : 'never');
export const formatDateTime = (value) => time(new Date(value), TimestampStyles.ShortDateTime);
const at = formatDateTime;
const count = (value) =>
  value === null || value === undefined ? 'unknown' : plural(Number(value), 'ban');
// A time from a row, in milliseconds since 1970, or null for none.
const timeOf = (value) =>
  value === null || value === undefined ? null : new Date(value).getTime();
// A count of bans from a row, or null for none.
const countOf = (value) => (value === null || value === undefined ? null : Number(value));

// What a list's status says first, from its BanListSyncs row (sync), when its type or source was
// changed and the ban importer has not read it since, or not finished switching it to its new
// source, or null.
export function describeSourceChange(sync) {
  return SOURCE_CHANGES[sync?.sourceChange]?.line ?? null;
}

// Until when an admin's confirmation of a removal lasts, by the list's BanListSyncs row (sync), in
// milliseconds since 1970, or null when it has run out, at now, or none was given (see
// markRemovalConfirmed).
export function confirmedUntil(sync, now = Date.now()) {
  const until = timeOf(sync?.allowFullRemovalUntil);
  return until !== null && until > now ? until : null;
}

// When the ban importer next reads a ban list in full, as its BanListSyncs row (sync), paused row
// (paused) and records (removals) say at now (see planRead and removalDue in
// ban-importer/src/planner.js, and lastFile in ban-importer/src/ban-importer.js). The bans that
// wait for a confirming read are given as the reason only while the records show some, and not for
// a row whose state is access_lost.
function describeNextRead(
  banList,
  sync,
  { paused = null, removals = { waiting: 0 }, now = Date.now() } = {}
) {
  const state = pauseState(paused);
  if (banList.type !== 'battlemetrics')
    return sync.remoteEtag || sync.remoteLastModified || sync.remoteBodyHash
      ? 'on the next cycle, which reads its file again only if it has changed'
      : 'on the next cycle';
  const next = timeOf(sync.nextFullScanAt);
  const lastFull = timeOf(sync.lastFullScanAt);
  const resumed = state === 'resuming' ? timeOf(paused.resumedAt) : null;
  if (
    sync.sourceChange ||
    lastFull === null ||
    next === null ||
    next <= now ||
    typeof sync.headUids !== 'string' ||
    !Number.isInteger(countOf(sync.headTotal)) ||
    (resumed !== null && lastFull < resumed)
  )
    return 'on the next cycle';
  const confirming =
    sync.scanReason === 'removal' && sync.state !== 'access_lost' && removals.waiting > 0;
  return `due ${when(next)}${confirming ? ', for the bans that wait for a confirming read' : ''}`;
}

// How the ban importer last imported a list, on a few lines, from its BanListSyncs row (sync), or
// that it has not imported it yet, and the bans it holds back from removing (removals: waiting for a
// confirming read, and held for an admin). A list whose type or source was changed says so first
// (see describeSourceChange): with nothing else when its sourceChange is 'unread' (see readStatus),
// and with the rest when it is 'replacing'. A list being switched to a new source gives none of its
// bans as held (see planRemovals in ban-importer/src/apply-list.js). Given the list itself
// (banList), it also gives its next read in full (see describeNextRead), but not for a row whose
// state is self_import or for a suspended list, and until when an admin's confirmation of a removal
// lasts, while it does, at now, with "once CBL can read it again" for a row whose state is
// access_lost (see importBanList in ban-importer/src/ban-importer.js). For an 'empty' hold (hold,
// see holdOf), it labels the list's records as recorded before its last complete read.
export function describeImport(sync, removals = { waiting: 0, held: 0 }, extra = {}) {
  if (!sync) return 'Not imported yet.';
  const changed = describeSourceChange(sync);
  if (sync.sourceChange === 'unread') return changed;
  const { banList = null, hold = null, now = Date.now() } = extra;
  const lines = [
    `${IMPORT_STATES[sync.state] ?? escapeMarkdown(String(sync.state))} · last imported ${when(sync.lastSuccessAt)} · last read in full ${when(sync.lastFullScanAt)}`
  ];
  if (banList && sync.state !== 'self_import' && pauseState(extra.paused) !== 'suspended')
    lines.push(`Next read in full: ${describeNextRead(banList, sync, { ...extra, removals })}`);
  lines.push(
    `${count(sync.storedCount)} stored${sync.headTotal === null || sync.headTotal === undefined ? '' : ` · ${count(sync.headTotal)} on BattleMetrics`}`
  );
  if (changed) lines.unshift(changed);
  const held = sync.sourceChange ? 0 : removals.held;
  if (removals.waiting > 0 || held > 0)
    lines.push(
      `${hold?.kind === 'empty' ? 'Removals recorded before its last complete read' : 'Removals'}: ${plural(removals.waiting, 'ban')} waiting for a confirming read${held > 0 ? `, ${plural(held, 'ban')} held for an admin` : ''}`
    );
  const until = banList ? confirmedUntil(sync, now) : null;
  if (until)
    lines.push(
      `Removal confirmed by an admin until ${at(until)}: until then, ${sync.state === 'access_lost' ? 'once CBL can read it again, ' : ''}complete reads of it can remove every ban they do not find, at once.`
    );
  if (sync.lastError) lines.push(`Last error: ${escapeMarkdown(sync.lastError)}`);
  return lines.join('\n');
}

// Why the ban importer holds a list's bans for an admin, by the kind of its hold (see holdOf in
// ban-list-status.js), as a list's status and the confirmation of its removal say it (why), in
// short, for a list of lists (short) and for the log (log), what keeps the hold (ends), and what an
// admin is to have checked before confirming the removal (confirmIf), and for a hold that is
// recorded, until when it keeps its bans by itself (kept): see planRemovals and countFetched in
// ban-importer/src/apply-list.js, and Confirming a removal in ban-importer/README.md. 'empty, up
// to' is for an 'empty' hold with upTo (see describeHeld).
const HOLDS = {
  full: {
    why: 'as a complete read found none of the bans it had then, which more likely means that its source broke',
    short: 'as it lost all of them',
    log: 'as a complete read found none of its bans',
    ends: 'They are kept until one of those the hold began with comes back, or an admin confirms the removal.',
    confirmIf:
      'the list really lost them, or really gives them for other accounts, e.g. without a SteamID',
    kept: 'until one of those the hold began with comes back'
  },
  large: {
    why: 'as a complete read lost a large part of its bans at once, which more likely means that its source broke, or leaves them out',
    short: 'as it lost a large part at once',
    log: 'as a complete read lost a large part of its bans at once',
    ends: 'They are kept until enough of them come back, or an admin confirms the removal.',
    confirmIf:
      'the list really lost them, or really gives them for other accounts, e.g. without a SteamID',
    kept: 'until enough of them come back'
  },
  empty: {
    why: 'as its last complete read gave none of them, which more likely means that the list is broken',
    short: 'as it gave none',
    log: 'as its last complete read gave none',
    ends: 'Every complete read with no bans keeps them, unless an admin confirms the removal. One that gives bans can end the hold, and the usual rules can then remove the bans it does not find, at once.',
    confirmIf: 'the list really lost them'
  },
  'empty, up to': {
    why: 'those its last complete read did not find, or found without their SteamIDs, as it gave none of them, or for a small list none with a SteamID, which more likely means that the list is broken',
    short: 'as it gave none, or none with a SteamID',
    log: 'as its last complete read gave none, or for a small list none with a SteamID',
    ends: 'Every complete read with no bans keeps them, unless an admin confirms the removal. One that gives bans can end the hold, and the usual rules can then remove the bans it does not find, at once.',
    confirmIf: 'the list really lost them, or really has no bans with a SteamID'
  }
};

// What a list's status, the confirmation of its removal and the log say of the ban importer's hold
// of its bans for an admin (hold, see holdOf), by its kind (see HOLDS).
const holdTexts = (hold) => HOLDS[hold.kind === 'empty' && hold.upTo ? 'empty, up to' : hold.kind];

// How many of a list's bans the ban importer holds for an admin (hold, see holdOf), and since when,
// or, for an 'empty' hold, all of them, or up to all of them with upTo.
function describeHeld(hold) {
  if (hold.kind !== 'empty') return `${plural(hold.held, 'ban')} since ${at(hold.since)}`;
  return `${hold.upTo ? 'up to' : 'all'} ${plural(hold.held, 'ban')}`;
}

// The recorded hold of an 'empty' hold (recorded, see holdOf), as its status says it: how many bans
// it held, since when and why, and what keeps them (kept, see HOLDS). It names the last complete
// read again, as the status's sentence before it is of the reads to come.
function describeHeldBefore(recorded) {
  const { log, kept } = HOLDS[recorded.kind];
  return ` Before its last complete read, it held ${recorded.held.toLocaleString('en-US')} of them since ${at(recorded.since)}, ${log}, and holds those again once a read gives bans, ${kept}, or an admin confirms the removal.`;
}

// The ban importer's hold of a list's bans for an admin (hold, see holdOf), on a few lines, for its
// status: how many bans, since when and why, what ends the hold, the recorded hold of an 'empty'
// hold, and the command that confirms it, with what the admin is to have checked first, by the kind
// of the hold (see HOLDS). The command refuses a list that is suspended, by its paused row
// (paused), or that CBL cannot read, by its BanListSyncs row (sync), so for such a list it says
// when it can be used: once it is resumed, once CBL can read it again, or, for a list that is both,
// once both are so, as a list resumed while CBL still cannot read it is refused as one CBL cannot
// read. What ends the hold is left out for a row whose state is access_lost (see importBanList in
// ban-importer/src/ban-importer.js).
export function describeHold(hold, { paused = null, sync = null } = {}) {
  const { why, ends, confirmIf } = holdTexts(hold);
  const held = describeHeld(hold);
  const before = hold.recorded ? describeHeldBefore(hold.recorded) : '';
  const lost = sync?.state === 'access_lost';
  const once = [
    pauseState(paused) === 'suspended' ? 'it is resumed' : null,
    lost ? 'CBL can read it again' : null
  ].filter(Boolean);
  const confirm = `${once.length > 0 ? `Once ${once.join(' and ')}, if` : 'If'} ${confirmIf}, confirm it with /banlist confirm-removal.`;
  return `${held[0].toUpperCase()}${held.slice(1)}, ${why}.${lost ? '' : ` ${ends}`}${before}\n${confirm}`;
}

// The ban importer's hold of a list's bans for an admin (hold), in short, for a list of lists.
export function summariseHold(hold) {
  const held = hold.kind === 'empty' ? describeHeld(hold) : plural(hold.held, 'ban');
  return `${held} held for an admin, ${holdTexts(hold).short}`;
}

// The ban importer's hold of a list's bans for an admin (hold), for the log: how many, since when,
// as a time in UTC, and why, and how many other bans wait for a confirming read, and how many bans
// the list has stored, by its BanListSyncs row (stored), when that is known. For an 'empty' hold
// (see describeHeld), the recorded hold, if any, instead.
export function describeHoldForLog(hold, stored = null) {
  if (hold.kind === 'empty') {
    const before = hold.recorded
      ? `, after ${plural(hold.recorded.held, 'ban')} held since ${new Date(hold.recorded.since).toISOString()}, ${HOLDS[hold.recorded.kind].log}`
      : '';
    return `${describeHeld(hold)} held, ${holdTexts(hold).log}${before}`;
  }
  const waiting =
    hold.waiting > 0
      ? `, and ${plural(hold.waiting, 'other ban')} waiting for a confirming read`
      : '';
  const total = countOf(stored) === null ? '' : `; ${plural(countOf(stored), 'ban')} stored`;
  return `${plural(hold.held, 'ban')} held since ${new Date(hold.since).toISOString()}, ${HOLDS[hold.kind].log}${waiting}${total}`;
}

// The question that asks an admin to confirm the removal of a list's held bans, from its hold
// (hold), its row (sync), at now, and CONFIRM_HOURS (hours), with an earlier confirmation that
// lasts still (see Confirming a removal in ban-importer/README.md, and planRemovals and placeBan in
// ban-importer/src/apply-list.js).
export function describeConfirmation(listName, hold, sync, hours, now = Date.now()) {
  const { why } = holdTexts(hold);
  let held;
  let removes;
  if (hold.kind === 'empty') {
    const before = hold.recorded
      ? ` Before that read, it held ${hold.recorded.held.toLocaleString('en-US')} of them since ${at(hold.recorded.since)}, ${HOLDS[hold.recorded.kind].log}.`
      : '';
    held = `The ban importer keeps ${describeHeld(hold)} of ${listName} for an admin, ${why}.${before}`;
    removes = `all ${plural(hold.held, 'ban')}, and any saved since, if it still gives none of them, and otherwise those it does not give`;
  } else {
    const waiting =
      hold.waiting > 0
        ? ` ${plural(hold.waiting, 'other ban')} ${hold.waiting === 1 ? 'waits' : 'wait'} for a confirming read.`
        : '';
    held = `The ban importer has held ${plural(hold.held, 'ban')} of ${listName} for an admin since ${at(hold.since)}, ${why}.${waiting}`;
    const these = hold.held + hold.waiting;
    const stored = countOf(sync?.storedCount);
    const all =
      stored === null
        ? 'all of its stored bans'
        : `all of its ${plural(Math.max(stored, these), 'stored ban')}, and any saved since,`;
    removes = `these ${plural(these, 'ban')} if it still does not have them, and any other ban it no longer has, up to ${all} if it gives none of them`;
  }
  const until = confirmedUntil(sync, now);
  const earlier = until ? ` An earlier confirmation lasts until ${at(until)}.` : '';
  return `Confirm the removal for ${listName}? ${held} Once you confirm, the ban importer reads it in full on its next cycle, or, if a cycle under way reads it in full first, at its next full read, and, if that is within ${plural(hours, 'hour')}, can remove every ban that read does not find, at once: ${removes}. For ${plural(hours, 'hour')}, complete reads of it can do the same, without holding any. A ban whose account changed, other than by a corrected SteamID, can move to its new account instead, but one it gives without a SteamID only to an EOS ID, on a BattleMetrics list whose EOS IDs are imported (IMPORTER_EOS_IMPORT), and can otherwise be removed.${earlier}`;
}

// How the ban importer last imported a list, on one line, for a list of lists: its state and when,
// and for a list whose type or source was changed, that first, or only that while the importer has
// not read it since (see describeImport).
export function summariseImport(sync) {
  if (!sync) return 'not imported yet';
  const changed = SOURCE_CHANGES[sync.sourceChange]?.short;
  if (sync.sourceChange === 'unread') return changed;
  const imported = `${IMPORT_STATES[sync.state] ?? escapeMarkdown(String(sync.state))} · last imported ${when(sync.lastSuccessAt)}`;
  return changed ? `${changed} · ${imported}` : imported;
}

// A ban list's status: whether it is paused, how the ban importer last imported it and next reads
// it in full, and its hold of the list's bans for an admin, if any (hold, see holdOf), at now.
export function banListStatusEmbed(
  banList,
  organisation,
  { paused = null, sync = null, removals, hold = null, now = Date.now() } = {}
) {
  const embed = banListEmbed(banList, organisation).addFields(
    { name: 'Paused', value: truncate(describePause(paused), 1024) },
    {
      name: 'Import',
      value: truncate(describeImport(sync, removals, { banList, paused, hold, now }), 1024)
    }
  );
  if (hold)
    embed.addFields({
      name: 'Held for an admin',
      value: truncate(describeHold(hold, { paused, sync }), 1024)
    });
  return embed;
}

export function listEmbed(title, description, footer) {
  return new EmbedBuilder()
    .setColor(COLOR)
    .setTitle(title)
    .setDescription(description)
    .setFooter(footer ? { text: footer } : null);
}
