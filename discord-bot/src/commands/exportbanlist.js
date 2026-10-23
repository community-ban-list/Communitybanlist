import { AttachmentBuilder, escapeMarkdown, SlashCommandBuilder } from 'discord.js';

import { sequelize } from 'scbl-lib/db';
import { ExportBanList } from 'scbl-lib/db/models';

import {
  audit,
  bold,
  confirm,
  formatBanListType,
  listEmbed,
  plural,
  ReplyUpdater,
  truncate,
  UserError
} from '../utils/index.js';

// Export ban lists are removed the way the website's Delete button removes them, with
// ExportBanList's deleteExportBanList, and their owners are not told. The lists outside today's
// limits are found with the website's own rules and the EXPORT_* settings, through ExportBanList's
// checkLimits, so the bot needs the same settings as the web server. A list given to another user
// changes only its owner, and neither owner is told either.
//
// A removal does not wait for the ban importer, as the website's Delete button does not: what a
// run, or a cycle of the importer service, does meanwhile to the list's export bans it could as
// well have done just before the removal (see README.md). Before each request to BattleMetrics for
// an export ban, the importer reads the export ban and its list again, so it adds no ban once the
// list is gone, or no longer records its BattleMetrics ban list. Until the list is gone, it may
// still delete a ban it recorded, as a deletion needs no ban list: that only takes CBL's own ban
// off the ban list being removed. It never adds an invite or a subscriber, and a removal takes
// those off the ban list before CBL's organisation leaves it, so a ban added meanwhile reaches no
// one once the removal is done. And the export bans the importer works out for a list that is gone
// cannot be saved, as their list must exist.

const data = new SlashCommandBuilder()
  .setName('exportbanlist')
  .setDescription("Remove users' export ban lists, or give one to another user.")
  // Only administrators see the command unless other roles are allowed in the server's settings.
  .setDefaultMemberPermissions(0)
  .addSubcommand((subcommand) =>
    subcommand
      .setName('remove')
      .setDescription('Remove an export ban list by its ID, whoever owns it, after a confirmation.')
      .addIntegerOption((option) =>
        option
          .setName('id')
          .setDescription('ID of the export ban list, as in its address: /export/ID.')
          .setRequired(true)
          .setMinValue(1)
      )
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('remove_outside_limits')
      .setDescription("Remove every export ban list outside today's limits, after a preview.")
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('transfer')
      .setDescription('Give an export ban list to another Steam user, after a confirmation.')
      .addIntegerOption((option) =>
        option
          .setName('id')
          .setDescription('ID of the export ban list, as in its address: /export/ID.')
          .setRequired(true)
          .setMinValue(1)
      )
      .addStringOption((option) =>
        option
          .setName('owner')
          .setDescription(
            "The new owner's SteamID64, 17 digits. CBL must know it: signing in to the website adds it."
          )
          .setRequired(true)
      )
  );

// Discord allows 2,000 characters in a message and 4,096 in an embed's description.
const MESSAGE_LENGTH = 2000;
const DESCRIPTION_LENGTH = 4096;

// The longest reason a message shows for one list. The attached files have them in full.
const REASON_LENGTH = 300;

// How long the admin has to read the preview of the lists outside the limits, which can be long
// and partly in an attached file, before confirming. Each list is read and checked again just
// before it is removed, so a list changed meanwhile is not removed as the preview showed it.
const REVIEW_TIMEOUT = 5 * 60 * 1000;

// The most export ban lists a user can have, as the website allows (hasRoomForList in
// web-server/src/graphql-api/mutation/resolver.js). A transfer checks it again just before it is
// made, and the bot makes one transfer at a time, so transfers cannot take a user past it. Only a
// list the new owner creates on the website at that same moment still can, as the website and the
// bot do not wait for each other.
const MAX_LISTS_PER_USER = 4;

// A SteamID64, as the website takes one from a Steam sign-in.
const STEAM_ID = /^[0-9]{17}$/;

// What happened on BattleMetrics, as deleteExportBanList gives it, for the log.
const OUTCOMES = {
  deleted: 'its BattleMetrics ban list was deleted',
  gone: 'BattleMetrics no longer had its ban list',
  none: 'there was nothing to delete on BattleMetrics'
};

// The rule each EXPORT_*_NEVER_ENOUGH setting stands for.
const NEVER_ENOUGH = {
  'active-plus-expired': 'one active ban plus one expired ban must never be enough',
  'one-ban': 'one ban must never be enough',
  none: 'any number of bans can be enough'
};

const hasBattlemetricsBanList = (exportBanList) =>
  exportBanList.type === 'battlemetrics' && Boolean(exportBanList.battlemetricsID);

// "1, 2 and 3".
function joinList(items) {
  return items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items.at(-1)}` : items.join('');
}

// "1 was" or "2 were".
const was = (count) => `${count.toLocaleString('en-US')} ${count === 1 ? 'was' : 'were'}`;

function formatName(exportBanList) {
  return `${bold(exportBanList.name || 'Unnamed')} (#${exportBanList.id})`;
}

// A Steam user: their Steam name, when they have one, and their Steam ID.
function formatSteamUser(id, name) {
  return name ? `${bold(name)} (\`${id}\`)` : `\`${id}\``;
}

// The list's owner, as formatSteamUser shows them.
const formatOwner = (exportBanList) =>
  formatSteamUser(exportBanList.owner, exportBanList.SteamUser?.name);

// Describe a Steam user for the audit log.
const describeSteamUser = (id, name) =>
  name ? `Steam user "${name}" (ID: ${id})` : `Steam user ${id}`;

// Describe the list for the audit log, with the BattleMetrics ban list it records, or the one given.
function describeExportBanList(exportBanList, battlemetricsID = exportBanList.battlemetricsID) {
  const battlemetrics = battlemetricsID ? `, BattleMetrics ID: ${battlemetricsID}` : '';
  const owner = describeSteamUser(exportBanList.owner, exportBanList.SteamUser?.name);
  const type = formatBanListType(exportBanList.type);
  return `export ban list "${exportBanList.name}" (ID: ${exportBanList.id}, ${type}${battlemetrics}) of ${owner}`;
}

// The BattleMetrics ban lists the given export ban lists record.
const recordedBanLists = (exportBanLists) =>
  exportBanLists
    .filter(hasBattlemetricsBanList)
    .map((exportBanList) => exportBanList.battlemetricsID);

// The BattleMetrics ban lists all of CBL's export ban lists record.
async function findRecordedBanLists() {
  const exportBanLists = await ExportBanList.findAll({
    attributes: ['id', 'type', 'battlemetricsID'],
    where: { type: 'battlemetrics' }
  });
  return recordedBanLists(exportBanLists);
}

// Which BattleMetrics ban lists CBL's BattleMetrics API key can see, compared with those CBL's
// export ban lists record (recorded). Deleting a list treats a ban list BattleMetrics does not know
// as already gone, so with a key from an account outside CBL's organisation, a list would be
// deleted while its ban list stayed on BattleMetrics. Gives { error } when BattleMetrics could not
// be asked, and otherwise the IDs of the ban lists the key can see, how many ban lists the export
// ban lists record, and how many of those it can see.
async function checkBattlemetricsAccess(recorded) {
  let visible;
  try {
    visible = await ExportBanList.findVisibleBattlemetricsBanLists();
  } catch (error) {
    return { error };
  }
  return {
    visible,
    recorded: recorded.length,
    seen: recorded.filter((id) => visible.has(id)).length
  };
}

// Whether CBL's BattleMetrics key could see the BattleMetrics ban list with this ID, as access
// (from checkBattlemetricsAccess) gives it.
const keySees = (battlemetricsID, access) =>
  Boolean(battlemetricsID && access?.visible?.has(battlemetricsID));

// "CBL's BattleMetrics key can see 2 of the 3 BattleMetrics ban lists CBL's export ban lists
// record".
const describeSeen = ({ seen, recorded }) =>
  `CBL's BattleMetrics key can see ${seen.toLocaleString('en-US')} of the ${plural(recorded, 'BattleMetrics ban list')} CBL's export ban lists record`;

// What removing the list deletes, for the confirmation. For a list with a BattleMetrics ban list,
// access says whether CBL's BattleMetrics key can see the ban list. A key that cannot see it gets
// the answer BattleMetrics gives for a ban list it does not have, so the deletion would take the
// ban list to be gone already and leave it on BattleMetrics, if it is still there.
function describeRemoval(exportBanList, access) {
  if (exportBanList.type !== 'battlemetrics')
    return 'This deletes the list, with its export bans and configs, so its address serves no players.';
  if (!exportBanList.battlemetricsID)
    return 'It has no BattleMetrics ban list, so this deletes only the list, with its export bans and configs.';
  const removal =
    'This deletes its BattleMetrics ban list, which the organisations subscribed to it lose, and then the list, with its export bans and configs.';
  if (keySees(exportBanList.battlemetricsID, access)) return removal;

  const unseen =
    'the removal takes it to be gone already: it deletes only the list, with its export bans and configs, and the ban list stays on BattleMetrics with its subscribers.';
  if (!access || access.error) {
    const why = access
      ? `**BattleMetrics could not be asked whether CBL's BattleMetrics key can see the ban list** (${truncate(access.error.message, REASON_LENGTH)})`
      : "**Whether CBL's BattleMetrics key can see the ban list was not checked**";
    return `${removal} ${why}. If the key cannot see it, ${unseen}`;
  }
  if (access.seen === 0)
    return `**${describeSeen(access)}**, so it may belong to an account outside CBL's organisation: check BATTLEMETRICS_API_KEY. If BattleMetrics still has this list's ban list, ${unseen}`;
  return `**CBL's BattleMetrics key cannot see its BattleMetrics ban list**, though it can see ${access.seen.toLocaleString('en-US')} of the ${plural(access.recorded, 'BattleMetrics ban list')} CBL's export ban lists record, so BattleMetrics may have deleted it already. If it has not, ${unseen} Check it on BattleMetrics first.`;
}

// Why a ban list BattleMetrics did not know when its list was removed may still be on BattleMetrics:
// CBL's BattleMetrics key was not shown to see it before the removal.
function unseenReason(access) {
  if (!access) return "whether CBL's BattleMetrics key could see it was not checked";
  if (access.error)
    return "BattleMetrics could not be asked whether CBL's BattleMetrics key could see it";
  return "CBL's BattleMetrics key could not see it before the removal";
}

// Why a list could not be removed. deleteExportBanList's error says which BattleMetrics step
// failed, or is the database's own, and its stage says which of the two it was.
function failureReason(error) {
  const message = error?.message || String(error);
  return error?.stage === 'database deletion'
    ? `Deleting it from the database failed: ${message}`
    : message;
}

// Why the list is outside today's limits, in the website's words, or that it was not checked.
function describeProblems({ problems, checked }) {
  if (!checked) return 'Not checked, as the limits do not cover its type.';
  if (problems.length === 0) return 'Within them.';
  return problems.map((problem) => problem.message).join(' ');
}

// The limits the lists were checked against, so the admin can see that they are the website's.
function describeLimits(limits) {
  const types = Object.entries(limits).map(([type, { maxPlayers, minThreshold, neverEnough }]) => {
    const name = type === 'battlemetrics' ? 'BattleMetrics' : type;
    const players =
      maxPlayers > 0 ? `at most ${plural(maxPlayers, 'player')}` : 'any number of players';
    const rule = NEVER_ENOUGH[neverEnough] ?? neverEnough;
    return `${name} lists have ${players} and a threshold of at least ${minThreshold}, and ${rule}`;
  });
  return `Limits used: ${types.join('; ')}. They come from the bot's EXPORT_* settings, which must match the website's.`;
}

// The list's BattleMetrics ban list, and whether CBL's BattleMetrics key can see it.
function describeBattlemetricsBanList(exportBanList, access) {
  if (!exportBanList.battlemetricsID) return 'None';
  const id = `\`${exportBanList.battlemetricsID}\``;
  if (!access) return id;
  if (access.error)
    return `${id}. Whether CBL's BattleMetrics key can see it was not checked, as BattleMetrics could not be asked.`;
  return `${id}, which CBL's BattleMetrics key ${keySees(exportBanList.battlemetricsID, access) ? 'can' : 'cannot'} see.`;
}

// An embed for the list, with its ID, type and players.
function listDetailsEmbed({ exportBanList, players }) {
  return listEmbed(truncate(exportBanList.name || 'Unnamed', 256), null).addFields(
    { name: 'ID', value: String(exportBanList.id), inline: true },
    { name: 'Type', value: formatBanListType(exportBanList.type), inline: true },
    { name: 'Players', value: players.toLocaleString('en-US'), inline: true }
  );
}

function exportBanListEmbed(check, access = null) {
  const { exportBanList } = check;
  const embed = listDetailsEmbed(check).addFields({
    name: 'Owner',
    value: truncate(formatOwner(exportBanList), 1024)
  });
  if (exportBanList.type === 'battlemetrics')
    embed.addFields({
      name: 'BattleMetrics ID',
      value: truncate(describeBattlemetricsBanList(exportBanList, access), 1024)
    });
  return embed.addFields({
    name: "Today's limits",
    value: escapeMarkdown(truncate(describeProblems(check), 1000))
  });
}

// Show entries in an embed. When they do not all fit, it shows as many as fit, and an attached text
// file has every one.
function entriesMessage(title, entries, fileName, fileText) {
  const description = (shown) => {
    const lines = entries.slice(0, shown);
    if (shown < entries.length)
      lines.push(`…and ${entries.length - shown} more, all in the attached file.`);
    return lines.join('\n');
  };
  let shown = entries.length;
  while (shown > 0 && description(shown).length > DESCRIPTION_LENGTH) shown--;

  const embeds = [listEmbed(title, description(shown))];
  if (shown === entries.length) return { embeds, files: [] };
  const file = new AttachmentBuilder(Buffer.from(fileText, 'utf8'), { name: fileName });
  return { embeds, files: [file] };
}

async function remove(interaction) {
  const id = interaction.options.getInteger('id', true);

  const {
    lists: [check]
  } = await ExportBanList.checkLimits({ ids: [id] });
  if (!check) throw new UserError(`There is no export ban list with ID ${id}.`);
  const { exportBanList, players } = check;
  const name = formatName(exportBanList);

  // Whether CBL's BattleMetrics key can see the list's ban list, so the admin knows before
  // confirming whether the removal can delete it. The list can be removed either way, as this is
  // how a list whose ban list BattleMetrics really no longer has is removed.
  const access = hasBattlemetricsBanList(exportBanList)
    ? await checkBattlemetricsAccess(await findRecordedBanLists())
    : null;

  const confirmed = await confirm(
    interaction,
    truncate(
      `Remove export ban list ${name}? ${describeRemoval(exportBanList, access)} Its owner is not told.`,
      MESSAGE_LENGTH
    ),
    'Remove export ban list',
    { embeds: [exportBanListEmbed(check, access)] }
  );
  if (!confirmed) return;

  // The list as it is now, which its owner may have changed or deleted meanwhile.
  const current = await ExportBanList.findByPk(id);
  if (!current) {
    await interaction.editReply({
      content: `Export ban list ${name} no longer exists, so nothing was changed.`,
      embeds: []
    });
    return;
  }

  // The list read again has no Steam user with it, so ExportBanList's lines about the deletion get
  // the owner's Steam name from the list as it was shown, unless someone else owns it now.
  if (current.owner === exportBanList.owner) current.SteamUser = exportBanList.SteamUser;

  // The ban list the removal deletes, which it clears from the list: the list's as it is now, which
  // differs from the one shown only when the list was still being made.
  const { battlemetricsID } = current;
  const description = `${describeExportBanList(exportBanList, battlemetricsID)}, which had ${plural(players, 'player')}`;
  let outcome;
  try {
    outcome = await current.deleteExportBanList();
  } catch (error) {
    const reason = failureReason(error);
    audit(interaction, `could not remove ${description}: ${reason}`);
    await interaction.editReply({
      content: truncate(`Could not remove export ban list ${name}. ${reason}`, MESSAGE_LENGTH),
      embeds: []
    });
    return;
  }

  // BattleMetrics not knowing the ban list only shows that it is gone when CBL's key could see it
  // before the removal. Otherwise the key may just not see it, and it may still be there.
  if (outcome === 'gone' && !keySees(battlemetricsID, access)) {
    const reason = unseenReason(access);
    audit(
      interaction,
      `removed ${description}: BattleMetrics did not know its ban list, and ${reason}, so it may still be on BattleMetrics: check it there.`
    );
    await interaction.editReply({
      content: truncate(
        `Removed export ban list ${name}, but BattleMetrics did not know its ban list, and ${reason}, so it may still be on BattleMetrics with its subscribers: check it there.`,
        MESSAGE_LENGTH
      ),
      embeds: []
    });
    return;
  }

  audit(interaction, `removed ${description}: ${OUTCOMES[outcome] ?? outcome}.`);
  let result = `Removed export ban list ${name}.`;
  if (outcome === 'deleted')
    result = `Removed export ban list ${name} and its BattleMetrics ban list.`;
  else if (outcome === 'gone')
    result += ' BattleMetrics no longer had its ban list, so there was nothing to delete there.';
  else if (current.type === 'battlemetrics') result += ' It had no BattleMetrics ban list.';
  await interaction.editReply({ content: truncate(result, MESSAGE_LENGTH), embeds: [] });
}

// Why a list outside the limits is left as it is, or null when it can be removed.
function leftReason(exportBanList, access) {
  if (!hasBattlemetricsBanList(exportBanList)) return null;
  if (!access) return 'its BattleMetrics ban list was not checked';
  if (access.error) return 'BattleMetrics could not be asked about its ban list';
  if (access.seen === 0) return "CBL's BattleMetrics key can see none of CBL's ban lists";
  if (!keySees(exportBanList.battlemetricsID, access))
    return "its BattleMetrics ban list is not among those CBL's BattleMetrics key can see";
  return null;
}

function describeAccess(access, left) {
  if (!access) return '';
  if (access.error)
    return `BattleMetrics could not be asked which ban lists CBL's BattleMetrics key can see (${access.error.message}), so the lists with BattleMetrics ban lists are left. Try again later.`;
  const seen = `${describeSeen(access)}.`;
  if (access.seen === 0)
    return `${seen} It may belong to an account outside CBL's organisation, so the lists with BattleMetrics ban lists are left. Check BATTLEMETRICS_API_KEY.`;
  if (left === 0) return seen;
  return `${seen} ${left === 1 ? 'The list whose ban list it cannot see is left: check it' : `The ${left} lists whose ban lists it cannot see are left: check them`} on BattleMetrics, then remove ${left === 1 ? 'it' : 'them one at a time'} with \`/exportbanlist remove\`.`;
}

// A list in the preview, with why it is outside the limits and whether it is left: a line for the
// embed, and the same in full for the attached file.
function previewLine({ check, left }) {
  const { exportBanList, players } = check;
  const type = formatBanListType(exportBanList.type);
  const reason = escapeMarkdown(truncate(describeProblems(check), REASON_LENGTH));
  const leftText = left ? ` **Left:** ${escapeMarkdown(left)}.` : '';
  return `${formatName(exportBanList)} · ${type} · owner ${formatOwner(exportBanList)} · ${plural(players, 'player')}\n↳ ${reason}${leftText}`;
}

function previewFileEntry({ check, left }) {
  const { exportBanList, configs, players } = check;
  const ownerName = exportBanList.SteamUser?.name;
  const owner = ownerName
    ? `${ownerName} (Steam ID ${exportBanList.owner})`
    : `Steam ID ${exportBanList.owner}`;
  const lines = [
    `#${exportBanList.id} ${formatBanListType(exportBanList.type)} list "${exportBanList.name}"`,
    `  Owner: ${owner}`,
    `  Players: ${players.toLocaleString('en-US')}`,
    `  Settings: threshold ${exportBanList.threshold}, ${exportBanList.defaultActivePoints} points for an active ban and ${exportBanList.defaultExpiredPoints} for an expired ban, max ban age ${exportBanList.maxBanAge} days (0 for any), ${plural(configs.length, 'config')}`
  ];
  if (exportBanList.type === 'battlemetrics')
    lines.push(`  BattleMetrics ban list: ${exportBanList.battlemetricsID || 'none'}`);
  lines.push(`  Outside the limits: ${describeProblems(check)}`);
  lines.push(left ? `  Left as it is: ${left}.` : '  To be removed.');
  return lines.join('\n');
}

// What happened to a list in the removal.
function describeResult({ status, outcome, reason }) {
  if (status === 'failed') return `failed: ${reason}`;
  if (status === 'skipped') return `not removed, as ${reason}`;
  if (outcome === 'deleted') return 'removed, with its BattleMetrics ban list';
  if (outcome === 'gone') return 'removed; BattleMetrics no longer had its ban list';
  return 'removed; there was nothing to delete on BattleMetrics';
}

// Remove one list outside the limits, as it is now: it is read and checked again first, as its
// owner may have changed or deleted it since the preview. Gives what happened, with the list
// described for the log as it was before it was removed, as removing it clears its BattleMetrics ID.
async function removeOne(check, access) {
  let current;
  try {
    ({
      lists: [current]
    } = await ExportBanList.checkLimits({ ids: [check.exportBanList.id] }));
  } catch (error) {
    return { check, status: 'failed', reason: `It could not be read again: ${error.message}` };
  }
  if (!current) return { check, status: 'skipped', reason: 'it no longer exists' };
  if (current.problems.length === 0)
    return { check: current, status: 'skipped', reason: "it is now within today's limits" };
  const left = leftReason(current.exportBanList, access);
  if (left) return { check: current, status: 'skipped', reason: left };

  const description = `${describeExportBanList(current.exportBanList)}, outside today's limits with ${plural(current.players, 'player')}`;
  try {
    // ExportBanList's lines are important, as the removal's own are, so they reach the log channel
    // in order with them, never after the summary.
    const outcome = await current.exportBanList.deleteExportBanList({ important: true });
    return { check: current, status: 'removed', outcome, description };
  } catch (error) {
    return { check: current, status: 'failed', reason: failureReason(error), description };
  }
}

// How many lists ended each way.
function countResults(results) {
  const counts = { removed: 0, deleted: 0, gone: 0, none: 0, failed: 0, skipped: 0 };
  for (const { status, outcome } of results) {
    counts[status]++;
    if (status === 'removed') counts[outcome in OUTCOMES ? outcome : 'none']++;
  }
  return counts;
}

function describeProgress(total, results) {
  const { removed, failed, skipped } = countResults(results);
  const parts = [
    removed > 0 && `${removed} removed`,
    failed > 0 && `${failed} failed`,
    skipped > 0 && `${skipped} not removed`
  ].filter(Boolean);
  return `Removing ${plural(total, 'export ban list')} outside today's limits: ${results.length} done${parts.length > 0 ? ` (${parts.join(', ')})` : ''}.\nThis reply can only be updated for 15 minutes after the command, so each result and the summary also go to the CBL log channel.`;
}

function describeSummary(total, results, notTried, left) {
  const counts = countResults(results);
  const ways = [
    counts.deleted > 0 &&
      `${counts.deleted} with ${counts.deleted === 1 ? 'its BattleMetrics ban list' : 'their BattleMetrics ban lists'}`,
    counts.gone > 0 &&
      `${counts.gone} whose BattleMetrics ban ${counts.gone === 1 ? 'list was' : 'lists were'} already gone`,
    counts.none > 0 && `${counts.none} with nothing to delete on BattleMetrics`
  ].filter(Boolean);
  // The lists not removed, a sentence each.
  const others = [
    counts.failed > 0 && `${counts.failed.toLocaleString('en-US')} failed.`,
    counts.skipped > 0 &&
      `${was(counts.skipped)} not removed, as ${counts.skipped === 1 ? 'it' : 'they'} had changed.`,
    notTried > 0 && `${was(notTried)} not tried, as the removal stopped.`,
    left > 0 && `${was(left)} left from the start.`
  ].filter(Boolean);
  const removed = `Removed ${counts.removed.toLocaleString('en-US')} of the ${plural(total, 'export ban list')} outside today's limits${ways.length > 0 ? `: ${joinList(ways)}` : ''}.`;
  return [removed, ...others].join(' ');
}

// Only one removal of the lists outside the limits runs at a time, so two admins never work through
// the same lists together.
let removingOutsideLimits = false;

async function removeOutsideLimits(interaction) {
  if (removingOutsideLimits)
    throw new UserError(
      'The export ban lists outside the limits are already being removed. Try again once that has finished.'
    );
  removingOutsideLimits = true;
  try {
    await removeAllOutsideLimits(interaction);
  } finally {
    removingOutsideLimits = false;
  }
}

async function removeAllOutsideLimits(interaction) {
  const { limits, lists } = await ExportBanList.checkLimits();
  const outside = lists.filter((check) => check.problems.length > 0);
  const unchecked = lists.filter((check) => !check.checked);
  const uncheckedNote =
    unchecked.length > 0
      ? ` ${was(unchecked.length)} not checked, as the limits do not cover ${unchecked.length === 1 ? 'its type' : 'their types'}: ${unchecked.map((check) => `#${check.exportBanList.id}`).join(', ')}.`
      : '';
  if (outside.length === 0) {
    await interaction.editReply(
      truncate(
        `No export ban list is outside today's limits, so nothing was changed.${uncheckedNote}\n${describeLimits(limits)}`,
        MESSAGE_LENGTH
      )
    );
    return;
  }

  // BattleMetrics is only asked which ban lists CBL's key can see when a list to remove has one.
  // The key must see some of the ban lists all of CBL's lists record, and each list's own.
  const access = outside.some(({ exportBanList }) => hasBattlemetricsBanList(exportBanList))
    ? await checkBattlemetricsAccess(
        recordedBanLists(lists.map(({ exportBanList }) => exportBanList))
      )
    : null;
  const plan = outside.map((check) => ({ check, left: leftReason(check.exportBanList, access) }));
  const removable = plan.filter((item) => !item.left).map((item) => item.check);
  const left = plan.length - removable.length;

  const title = `Export ban lists outside today's limits (${outside.length})`;
  const checkedAt = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const preview = entriesMessage(
    title,
    plan.map(previewLine),
    'export-ban-lists-outside-limits.txt',
    [
      `Export ban lists outside today's limits, checked ${checkedAt}: ${outside.length}`,
      describeLimits(limits),
      '',
      ...plan.map(previewFileEntry)
    ].join('\n')
  );
  const notes = [describeAccess(access, left), describeLimits(limits)].filter(Boolean).join('\n');
  const found = `**${plural(outside.length, 'export ban list')} ${outside.length === 1 ? 'is' : 'are'} outside today's limits.**`;

  if (removable.length === 0) {
    await interaction.editReply({
      content: truncate(
        `${found} None can be removed now, so nothing was changed.${uncheckedNote}\n${notes}`,
        MESSAGE_LENGTH
      ),
      ...preview
    });
    return;
  }

  let which = `${removable.length} of them`;
  if (removable.length === outside.length) which = outside.length === 1 ? 'it' : 'them';
  const confirmed = await confirm(
    interaction,
    truncate(
      `${found} Remove ${which}? This deletes each list with its export bans and configs, and a BattleMetrics list's ban list on BattleMetrics, which the organisations subscribed to it lose. Their owners are not told.${uncheckedNote}\n${notes}`,
      MESSAGE_LENGTH
    ),
    `Remove ${plural(removable.length, 'export ban list')}`,
    { ...preview, timeout: REVIEW_TIMEOUT }
  );
  if (!confirmed) return;

  audit(
    interaction,
    `started removing ${plural(removable.length, 'export ban list')} outside today's limits.`,
    { important: true }
  );

  // Removing a BattleMetrics list takes several requests within the bot's BattleMetrics budget, so
  // the removal can outlast the 15 minutes for which Discord lets the reply be edited. So each
  // list's result and the summary also go to the log channel, all as important lines, as the
  // start is and as ExportBanList's lines about each deletion are (see removeOne). Lines of the
  // same importance reach the channel in the order they were logged, so the summary never goes
  // ahead of a result still waiting to be sent, and none is dropped for other lines.
  const reply = new ReplyUpdater(interaction);
  reply.update({ content: describeProgress(removable.length, []) });

  const results = [];
  let stopped = null;
  for (const check of removable) {
    const result = await removeOne(check, access);
    results.push(result);
    const description = result.description ?? describeExportBanList(result.check.exportBanList);
    if (result.status === 'removed')
      audit(interaction, `removed ${description}: ${OUTCOMES[result.outcome] ?? result.outcome}.`, {
        important: true
      });
    else if (result.status === 'failed')
      audit(interaction, `could not remove ${description}: ${result.reason}`, { important: true });
    reply.update({ content: describeProgress(removable.length, results) });

    // BattleMetrics listed the list's ban list when the removal started, so its being gone now
    // means the ban list was deleted meanwhile, or CBL's key lost its access to CBL's ban lists.
    // Then every list after it would be deleted while its ban list stayed on BattleMetrics, so the
    // removal stops for the admin to look.
    if (result.outcome === 'gone') {
      stopped = `Stopped after #${result.check.exportBanList.id}, as BattleMetrics no longer had its ban list, which it listed when the removal started. CBL's BattleMetrics key may have lost its access, so check BATTLEMETRICS_API_KEY and BATTLEMETRICS_ORGANIZATION before running the command again.`;
      break;
    }
  }

  const notTried = removable.slice(results.length);
  const summary = describeSummary(outside.length, results, notTried.length, left);
  const logged = `${summary.charAt(0).toLowerCase()}${summary.slice(1)}`;
  audit(interaction, `${logged}${stopped ? ` ${stopped}` : ''}`, { important: true });

  const entries = [
    ...results.map((result) => [result.check.exportBanList, describeResult(result)]),
    ...notTried.map((check) => [check.exportBanList, 'not tried, as the removal stopped']),
    ...plan
      .filter((item) => item.left)
      .map((item) => [item.check.exportBanList, `left: ${item.left}`])
  ];
  await reply.finish({
    content: truncate(`${summary}${stopped ? `\n${stopped}` : ''}`, MESSAGE_LENGTH),
    ...entriesMessage(
      title,
      entries.map(
        ([exportBanList, text]) =>
          `${formatName(exportBanList)}: ${escapeMarkdown(truncate(text, REASON_LENGTH))}`
      ),
      'export-ban-list-removals.txt',
      entries
        .map(([exportBanList, text]) => `#${exportBanList.id} "${exportBanList.name}": ${text}`)
        .join('\n')
    ),
    attachments: []
  });
}

// The new owner's Steam ID as given, or a UserError when it is not a SteamID64.
function parseSteamID(value) {
  const id = value.trim();
  if (!STEAM_ID.test(id))
    throw new UserError(
      `${bold(truncate(id, 100))} is not a Steam ID. Give the new owner's SteamID64, which is 17 digits.`
    );
  return id;
}

// What a transfer leaves as it is, and what the new owner then sees with the list on the website.
// Only a BattleMetrics list has a BattleMetrics ban list and invite.
function transferTerms(exportBanList) {
  return exportBanList.type === 'battlemetrics'
    ? {
        kept: 'settings, configs, players, Discord webhook and BattleMetrics ban list',
        shown: 'its Discord webhook and BattleMetrics invite'
      }
    : { kept: 'settings, configs, players and Discord webhook', shown: 'its Discord webhook' };
}

// The new owner, pointing out one who has not signed in to the website yet. CBL also knows the
// Steam IDs of players who have been on its ban lists, so a Steam ID given wrongly can still be one
// CBL knows, and someone who has not signed in only sees the list once they do.
function formatNewOwner(newOwner) {
  const user = formatSteamUser(newOwner.id, newOwner.name);
  if (newOwner.isSCBLUser) return user;
  return `${user}\n**Has not signed in to the website yet**, so check the Steam ID is theirs. They see the list once they sign in.`;
}

// The list, its owner, the new owner and how many export ban lists the new owner has.
function transferEmbed(check, newOwner, listCount) {
  return listDetailsEmbed(check).addFields(
    { name: 'Current owner', value: truncate(formatOwner(check.exportBanList), 1024) },
    { name: 'New owner', value: truncate(formatNewOwner(newOwner), 1024) },
    {
      name: "New owner's export ban lists",
      value: `${listCount.toLocaleString('en-US')} now, and ${(listCount + 1).toLocaleString('en-US')} with this one. A user can have ${MAX_LISTS_PER_USER}.`
    }
  );
}

// Give the list to the new owner, as the admin confirmed it, if that can still be done: the list
// and the new owner's lists are read again first, as the list may have been deleted or given to
// someone else meanwhile, and the new owner may have made lists of their own. Gives null once the
// list is theirs, or why it was left as it is.
async function transferIfUnchanged(exportBanList, newOwner) {
  const name = formatName(exportBanList);
  const to = formatSteamUser(newOwner.id, newOwner.name);
  const current = await ExportBanList.findByPk(exportBanList.id);
  if (!current) return `Export ban list ${name} no longer exists`;
  if (current.owner === newOwner.id) return `Export ban list ${name} already belongs to ${to}`;
  if (current.owner !== exportBanList.owner)
    return `Export ban list ${name} now belongs to \`${current.owner}\`, not ${formatOwner(exportBanList)} as shown`;
  const listCount = await ExportBanList.count({ where: { owner: newOwner.id } });
  if (listCount >= MAX_LISTS_PER_USER)
    return `${to} now has ${plural(listCount, 'export ban list')}, and the website lets a user have at most ${MAX_LISTS_PER_USER}`;

  // Only the owner is written, and only while the list still has the owner shown, so a list
  // changed in the moment since it was read again is left as it is.
  const [updated] = await ExportBanList.update(
    { owner: newOwner.id },
    { where: { id: exportBanList.id, owner: exportBanList.owner } }
  );
  return updated === 0 ? `Export ban list ${name} changed as it was being transferred` : null;
}

// The last transfer, which the next waits for. The bot makes one transfer at a time, from reading
// the list and the new owner's lists again to writing the owner, so two confirmed at the same time
// cannot both find that the new owner has room for another list. The bot runs as a single process,
// so this is kept in memory, as the website keeps each user's changes in order (guard-changes.js
// in web-server/src/graphql-api/mutation).
let lastTransfer = Promise.resolve();

// Make a transfer once the last one has finished, whether or not that succeeded.
function afterLastTransfer(makeTransfer) {
  const result = lastTransfer.then(makeTransfer);
  lastTransfer = result.catch(() => {});
  return result;
}

// Give an export ban list to another Steam user. Only its owner changes, and the website reads a
// list's owner from the database on every request, so from then on the new owner sees the list,
// with its Discord webhook and BattleMetrics invite, and can change or delete it, and the old
// owner no longer can.
//
// A transfer does not wait for the ban importer either: nothing the importer or the exports do
// reads or writes a list's owner, so a run goes on the same whoever owns the list.
// Like the website's own changes, the update can wait for rows a run has locked, such as the new
// owner's Steam user while the run recalculates every player's reputation, which can take most of
// a minute after a big import, and transfers confirmed meanwhile wait for it in turn. If MySQL
// gives up waiting, nothing is changed.
async function transfer(interaction) {
  const id = interaction.options.getInteger('id', true);
  const owner = parseSteamID(interaction.options.getString('owner', true));

  const {
    lists: [check]
  } = await ExportBanList.checkLimits({ ids: [id] });
  if (!check) throw new UserError(`There is no export ban list with ID ${id}.`);
  const { exportBanList } = check;
  const name = formatName(exportBanList);
  const from = formatOwner(exportBanList);
  if (exportBanList.owner === owner)
    throw new UserError(`Export ban list ${name} already belongs to ${from}.`);

  // A list's owner must be one of CBL's Steam users. A player's first sign-in to the website adds
  // them, and so does the ban importer for each player on a ban list, so whether the new owner has
  // signed in is shown too. The model is taken from sequelize.models, as checkLimits takes it, so
  // the bot imports no more models by name than its tests stand in for.
  const newOwner = await sequelize.models.SteamUser.findByPk(owner, {
    attributes: ['id', 'name', 'isSCBLUser']
  });
  if (!newOwner)
    throw new UserError(
      `CBL has no Steam user with ID \`${owner}\`. The new owner must sign in to the website once first, which adds them.`
    );
  const to = formatSteamUser(newOwner.id, newOwner.name);
  const listCount = await ExportBanList.count({ where: { owner } });
  if (listCount >= MAX_LISTS_PER_USER)
    throw new UserError(
      `${to} already has ${plural(listCount, 'export ban list')}, and the website lets a user have at most ${MAX_LISTS_PER_USER}. One of them must be removed before they can be given another.`
    );

  const { kept, shown } = transferTerms(exportBanList);
  const confirmed = await confirm(
    interaction,
    truncate(
      `Transfer export ban list ${name} from ${from} to ${to}? Only its owner changes: its ${kept} stay as they are. From then on the new owner sees it on the website, with ${shown}, and can change or delete it, and the current owner no longer can. Neither is told.`,
      MESSAGE_LENGTH
    ),
    'Transfer export ban list',
    { embeds: [transferEmbed(check, newOwner, listCount)] }
  );
  if (!confirmed) return;

  const left = await afterLastTransfer(() => transferIfUnchanged(exportBanList, newOwner));
  if (left) {
    await interaction.editReply({
      content: truncate(`${left}, so nothing was changed.`, MESSAGE_LENGTH),
      embeds: []
    });
    return;
  }

  audit(
    interaction,
    `transferred ${describeExportBanList(exportBanList)} to ${describeSteamUser(newOwner.id, newOwner.name)}.`
  );
  await interaction.editReply({
    content: truncate(
      `Transferred export ban list ${name} from ${from} to ${to}. From now on the new owner sees it on the website, with ${shown}, and the old owner no longer does. Neither was told.`,
      MESSAGE_LENGTH
    ),
    embeds: []
  });
}

const subcommands = { remove, remove_outside_limits: removeOutsideLimits, transfer };

export default {
  data,
  execute: (interaction) => subcommands[interaction.options.getSubcommand()](interaction)
};
