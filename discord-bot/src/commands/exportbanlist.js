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
  readPaused,
  ReplyUpdater,
  truncate,
  UserError
} from '../utils/index.js';

// Export ban lists are removed the way the website's Delete button removes them, with
// ExportBanList's deleteExportBanList, and their owners are not told. Like the website, a removal
// holds the list's deletion lock while it deletes the list (ExportBanList.whileDeleting), so the
// two never delete a list at once, and meanwhile the website refuses changes to the list and a
// transfer leaves it as it is. The lists outside today's limits are found with the website's own
// rules and the EXPORT_* settings, through ExportBanList's checkLimits, so the bot needs the same
// settings as the web server. A list given to another user changes only its owner, and neither
// owner is told either.
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

// The most lists a note at the end of a reply names (see namedListsNote), so a long list of them
// leaves room for the rest of the reply. When there are more, or the reply would be too long with
// them, an attached file names them all: one for the lists within the cap by their settings now,
// though their export bans are over it, and one for those whose players could not be counted by
// their settings now.
const NAMED_LISTS = 5;
const UPDATING_FILE = 'export-ban-lists-awaiting-the-importer.txt';
const UNCOUNTED_FILE = 'export-ban-lists-not-counted.txt';

// The longest error a note gives for a list whose players could not be counted. A note that cuts
// one short attaches its file, which has them in full.
const COUNT_ERROR_LENGTH = 100;

// How long the admin has to read the preview of the lists outside the limits, which can be long
// and partly in an attached file, before confirming. Each list is read and checked again just
// before it is removed, so a list changed meanwhile is not removed as the preview showed it.
const REVIEW_TIMEOUT = 5 * 60 * 1000;

// The most export ban lists a user can have, as the website allows (hasRoomForList in
// web-server/src/graphql-api/mutation/resolver.js). A transfer checks it again just before it is
// made, with the new owner's lists locked, as the website locks them to create a list, so neither
// transfers nor a list the new owner creates on the website at the same moment can take a user
// past it.
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

// For a list counted again by its settings and configs now, as its export bans are over its type's
// cap (checkLimits' recount), what follows the number of its players, so both are shown: " by its
// export bans, 1,554 by its settings now". The two differ when the list has changed since the
// importer last updated its export bans, e.g. as its owner raised its threshold, and while ban
// lists are paused, whose bans its export bans leave out and the count includes (see
// describePaused). For a list whose count failed (recountError), it says so. Nothing for a list
// not counted again.
function describeRecount({ recount, recountError }) {
  if (recountError) return ' by its export bans; they could not be counted by its settings now';
  return recount == null
    ? ''
    : ` by its export bans, ${recount.toLocaleString('en-US')} by its settings now`;
}

// Why the list is outside today's limits, in the website's words, or that it was not checked. For
// a list whose count by its settings now failed, whether it is over the cap is not known.
function describeProblems({ problems, checked, recountError }) {
  if (!checked) return 'Not checked, as the limits do not cover its type.';
  const unknown = recountError
    ? ` Whether it is within its type's cap is not known: its export bans are over it, and its players could not be counted by its settings now (${recountError.message}).`
    : '';
  if (problems.length === 0)
    return recountError ? `Within the points rules.${unknown}` : 'Within them.';
  return `${problems.map((problem) => problem.message).join(' ')}${unknown}`;
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

// The IDs of the ban lists paused now (see /banlist suspend), in order, or none until the ban
// importer has made its table of them.
async function readPausedIDs() {
  return [...(await readPaused()).keys()].sort((a, b) => a - b);
}

// What the numbers of a list's players mean while ban lists are paused, as remove_outside_limits
// says after the limits used, or nothing when none is. Their bans count for nothing for now, so the
// importer leaves them out of export bans, but a count by a list's settings now (checkLimits'
// recount) includes them, as the website's size check does, so that the list's cap holds once they
// count again. Only a list over the cap by its export bans is counted again, so one within it only
// while a ban list is paused is left, until that list counts again and the importer has updated
// the list's export bans.
function describePaused(paused) {
  if (paused.length === 0) return '';
  const lists = joinList(paused.map((id) => `#${id}`));
  const one = paused.length === 1;
  return `${one ? `Ban list ${lists} is` : `Ban lists ${lists} are`} paused: ${one ? 'its' : 'their'} bans count for nothing for now. The ban importer leaves them out of export bans, but a count by settings now includes them, as the website's size check does, so that a list's cap holds once they count again. So a list within the cap by its export bans only while ${one ? 'it is' : 'they are'} paused is not counted again, and is left until then.`;
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

// An embed for the list, with its ID, type and players. For a list counted again by its settings
// now while ban lists are paused (paused, their IDs), it says what its two numbers mean (see
// describePaused).
function listDetailsEmbed(check, paused = []) {
  const { exportBanList, players } = check;
  const embed = listEmbed(truncate(exportBanList.name || 'Unnamed', 256), null).addFields(
    { name: 'ID', value: String(exportBanList.id), inline: true },
    { name: 'Type', value: formatBanListType(exportBanList.type), inline: true },
    {
      name: 'Players',
      value: `${players.toLocaleString('en-US')}${describeRecount(check)}`,
      inline: true
    }
  );
  if (check.recount != null && paused.length > 0)
    embed.addFields({
      name: 'Paused ban lists',
      value: truncate(
        `${joinList(paused.map((id) => `#${id}`))}, whose bans count for nothing for now. The ban importer leaves them out of the list's export bans, but its count by its settings now includes them, as the website's size check does.`,
        1024
      )
    });
  return embed;
}

// The ban lists paused now, for the embed of a list counted again by its settings now, or none for
// another list, whose embed does not need them.
const pausedFor = async (check) => (check.recount == null ? [] : readPausedIDs());

function exportBanListEmbed(check, access = null, paused = []) {
  const { exportBanList } = check;
  const embed = listDetailsEmbed(check, paused).addFields({
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

  // The list's limits are only shown, as it can be removed either way, so one over its type's cap
  // whose players could not be counted by its settings now is shown saying so.
  const {
    lists: [check]
  } = await ExportBanList.checkLimits({ ids: [id], keepRecountErrors: true });
  if (!check) throw new UserError(`There is no export ban list with ID ${id}.`);
  const { exportBanList } = check;
  const name = formatName(exportBanList);

  // Whether CBL's BattleMetrics key can see the list's ban list, so the admin knows before
  // confirming whether the removal can delete it. The list can be removed either way, as this is
  // how a list whose ban list BattleMetrics really no longer has is removed.
  const access = hasBattlemetricsBanList(exportBanList)
    ? await checkBattlemetricsAccess(await findRecordedBanLists())
    : null;
  const paused = await pausedFor(check);

  const confirmed = await confirm(
    interaction,
    truncate(
      `Remove export ban list ${name}? ${describeRemoval(exportBanList, access)} Its owner is not told.`,
      MESSAGE_LENGTH
    ),
    'Remove export ban list',
    { embeds: [exportBanListEmbed(check, access, paused)] }
  );
  if (!confirmed) return;

  // The list is deleted while the bot holds its deletion lock, as the website's Delete button does,
  // so the two never delete a list at once, and meanwhile the website refuses changes to it and a
  // transfer leaves it as it is. A list whose deletion lock is held already, as its owner is
  // deleting it on the website or another removal is under way, is left as it is.
  try {
    await ExportBanList.whileDeleting(id, () => removeConfirmed(interaction, check, access));
  } catch (error) {
    if (error?.beingDeleted !== true) throw error;
    await interaction.editReply({
      content: truncate(
        `Export ban list ${name} is already being deleted, so nothing was changed.`,
        MESSAGE_LENGTH
      ),
      embeds: []
    });
  }
}

// Remove the list the admin confirmed, while the bot holds its deletion lock (see remove), as it is
// now, which its owner may have changed or deleted meanwhile.
async function removeConfirmed(interaction, { exportBanList, players }, access) {
  const { id } = exportBanList;
  const name = formatName(exportBanList);
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
    return `BattleMetrics could not be asked which ban lists CBL's BattleMetrics key can see (${truncate(access.error.message, REASON_LENGTH)}), so the lists with BattleMetrics ban lists are left. Try again later.`;
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
  return `${formatName(exportBanList)} · ${type} · owner ${formatOwner(exportBanList)} · ${plural(players, 'player')}${describeRecount(check)}\n↳ ${reason}${leftText}`;
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
    `  Players: ${players.toLocaleString('en-US')}${describeRecount(check)}`,
    `  Settings: threshold ${exportBanList.threshold}, ${exportBanList.defaultActivePoints} points for an active ban and ${exportBanList.defaultExpiredPoints} for an expired ban, max ban age ${exportBanList.maxBanAge} days (0 for any), ${plural(configs.length, 'config')}`
  ];
  if (exportBanList.type === 'battlemetrics')
    lines.push(`  BattleMetrics ban list: ${exportBanList.battlemetricsID || 'none'}`);
  lines.push(`  Outside the limits: ${describeProblems(check)}`);
  lines.push(left ? `  Left as it is: ${left}.` : '  To be removed.');
  return lines.join('\n');
}

// A note on a line of its own at the end of a reply that names some of the lists checked: at most
// NAMED_LISTS of them, and when there are more, an attached file names them all, so that however
// many there are, the limits used before the note are never cut off. sentence(count, named) gives
// the note's text, with the lists as entry(check) names them, and the file gives title and then a
// line for each list, as fileEntry(check) gives it. When entry cuts short what it says of a list it
// names (shortened(check)), the note attaches the file too, so nothing is lost. Gives the note, if
// any, and the files to attach, and a brief form of them, which names the lists by ID only and
// always attaches the file, for a reply that would be too long with the full note (see
// withListNotes).
function namedListsNote(
  checks,
  { sentence, entry, fileName, title, fileEntry, shortened = () => false }
) {
  if (checks.length === 0) return { note: '', files: [], brief: { note: '', files: [] } };
  const named = (format, inFile) => {
    const names = checks.slice(0, NAMED_LISTS).map(format);
    const more = checks.length - names.length;
    if (more > 0)
      names.push(`${more.toLocaleString('en-US')} more, all in the attached ${fileName}`);
    else if (inFile)
      names[names.length - 1] +=
        `, ${checks.length === 1 ? '' : 'all '}in the attached ${fileName}`;
    return `\n${sentence(checks.length, joinList(names))}`;
  };

  const text = [`${title}: ${checks.length}`, ...checks.map(fileEntry)].join('\n');
  const file = new AttachmentBuilder(Buffer.from(text, 'utf8'), { name: fileName });
  const brief = { note: named(({ exportBanList }) => `#${exportBanList.id}`, true), files: [file] };
  const inFile = checks.length > NAMED_LISTS || checks.slice(0, NAMED_LISTS).some(shortened);
  return { note: named(entry, inFile), files: inFile ? [file] : [], brief };
}

// The reply's text, followed by the notes (from namedListsNote) and with their files. When the
// notes in full would take the reply past Discord's limit, they are given in brief, with every list
// in its attached file, so the text before them, with the limits used, is never cut off, and no
// list in the notes is lost.
function withListNotes(text, notes) {
  const full = `${text}${notes.map(({ note }) => note).join('')}`;
  if (full.length <= MESSAGE_LENGTH)
    return { content: full, files: notes.flatMap(({ files }) => files) };
  return {
    content: truncate(`${text}${notes.map(({ brief }) => brief.note).join('')}`, MESSAGE_LENGTH),
    files: notes.flatMap(({ brief }) => brief.files)
  };
}

// A list as an attached file names it.
const nameInFile = ({ exportBanList }) =>
  `#${exportBanList.id} ${formatBanListType(exportBanList.type)} list "${exportBanList.name}"`;

// The lists whose export bans are over their type's cap but whose settings now give no more players
// than it, so they are within the limits: they have shrunk since the importer last updated their
// export bans, e.g. as their owners raised their thresholds. The reply names them, so the admin
// knows why they are not removed (see namedListsNote).
function describeUpdating(lists, checkedAt) {
  const playersOf = (check) => `${plural(check.players, 'player')}${describeRecount(check)}`;
  return namedListsNote(
    lists.filter((check) => check.recount != null && check.problems.length === 0),
    {
      sentence: (count, named) => {
        const one = count === 1;
        return `${plural(count, 'export ban list')} ${one ? 'is' : 'are'} within the cap by ${one ? 'its' : 'their'} settings now, though ${one ? 'its' : 'their'} export bans are over it until the importer updates them: ${named}.`;
      },
      entry: (check) => `#${check.exportBanList.id} (${playersOf(check)})`,
      fileName: UPDATING_FILE,
      title: `Export ban lists within the cap by their settings now, though their export bans are over it until the importer updates them, checked ${checkedAt}`,
      fileEntry: (check) => `${nameInFile(check)}: ${playersOf(check)}`
    }
  );
}

// The lists whose export bans are over their type's cap, whose players could not be counted by
// their settings now, and which are within the points rules. Whether they are outside the limits is
// not known, so they are left, and the reply names them, with why the count failed (see
// namedListsNote). A list whose count failed but which breaks the points rules, which need no
// count, is outside the limits all the same, and its line in the preview says the count failed.
function describeUncounted(lists, checkedAt) {
  return namedListsNote(
    lists.filter((check) => check.recountError && check.problems.length === 0),
    {
      sentence: (count, named) => {
        const one = count === 1;
        return `${plural(count, 'export ban list')} over the cap by ${one ? 'its' : 'their'} export bans could not be counted by ${one ? 'its' : 'their'} settings now, so whether ${one ? 'it is' : 'they are'} within the cap is not known, and ${one ? 'it is' : 'they are'} left: ${named}. Run the command again later to check ${one ? 'it' : 'them'}.`;
      },
      entry: (check) =>
        `#${check.exportBanList.id} (${truncate(check.recountError.message, COUNT_ERROR_LENGTH)})`,
      shortened: (check) => check.recountError.message.length > COUNT_ERROR_LENGTH,
      fileName: UNCOUNTED_FILE,
      title: `Export ban lists over the cap by their export bans that could not be counted by their settings now, and so are left, checked ${checkedAt}`,
      fileEntry: (check) =>
        `${nameInFile(check)}: ${plural(check.players, 'player')} by its export bans; the count failed: ${check.recountError.message}`
    }
  );
}

// What happened to a list in the removal.
function describeResult({ status, outcome, reason }) {
  if (status === 'failed') return `failed: ${reason}`;
  if (status === 'skipped') return `not removed, as ${reason}`;
  if (outcome === 'deleted') return 'removed, with its BattleMetrics ban list';
  if (outcome === 'gone') return 'removed; BattleMetrics no longer had its ban list';
  return 'removed; there was nothing to delete on BattleMetrics';
}

// A list that could not be checked again just before its removal, which is left, as failed.
function notCheckedAgain(check, error) {
  return { check, status: 'failed', reason: `It could not be checked again: ${error.message}` };
}

// Remove one list outside the limits, as it is now: it is read and checked again first, as its
// owner may have changed or deleted it since the preview. Gives what happened, with the list
// described for the log as it was before it was removed, as removing it clears its BattleMetrics ID.
async function removeOne(check, access) {
  let current;
  try {
    ({
      lists: [current]
    } = await ExportBanList.checkLimits({
      ids: [check.exportBanList.id],
      keepRecountErrors: true
    }));
  } catch (error) {
    // Reading it failed, so it is left.
    return notCheckedAgain(check, error);
  }
  if (!current) return { check, status: 'skipped', reason: 'it no longer exists' };
  if (current.problems.length === 0) {
    // Its players could not be counted by its settings now, and it is within the points rules, so
    // whether it is still over its type's cap is not known, and it is left. One that breaks the
    // points rules, which need no count, is removed all the same.
    if (current.recountError) return notCheckedAgain(current, current.recountError);
    return { check: current, status: 'skipped', reason: "it is now within today's limits" };
  }
  const left = leftReason(current.exportBanList, access);
  if (left) return { check: current, status: 'skipped', reason: left };

  // From here until the list is gone, the bot holds its deletion lock, as the website's Delete
  // button does, so the two never delete a list at once, and meanwhile the website refuses changes
  // to it and a transfer leaves it as it is. A list whose deletion lock is held already, as its
  // owner is deleting it on the website or another removal is under way, is left as it is. The
  // lock is taken once the list has been checked, so the website is not held up while its players
  // are counted again. A lock that cannot be taken, e.g. as its connection cannot be opened, leaves
  // the list as it is, as failed.
  let locked = false;
  try {
    return await ExportBanList.whileDeleting(current.exportBanList.id, () => {
      locked = true;
      return removeUnchanged(current);
    });
  } catch (error) {
    if (error?.beingDeleted === true)
      return {
        check: current,
        status: 'skipped',
        reason: 'it is already being deleted',
        beingDeleted: true
      };
    if (!locked)
      return {
        check: current,
        status: 'failed',
        reason: `Its deletion lock could not be taken: ${error.message}`
      };
    return { check: current, status: 'failed', reason: failureReason(error) };
  }
}

// Remove a list outside the limits that was just checked again, as current gives it, while the bot
// holds its deletion lock (see removeOne), unless it has changed since. Checking the list takes a
// moment, longer when its players are counted again, and its owner may have changed it on the
// website meanwhile, so it is read once more, with its row locked, which waits for a change the
// website is saving, and left if it has changed since it was checked. From then on the website
// refuses changes to it, as the bot holds its deletion lock.
async function removeUnchanged(current) {
  let change;
  try {
    change = await ExportBanList.changeSince(current);
  } catch (error) {
    return notCheckedAgain(current, error);
  }
  if (change === 'deleted')
    return { check: current, status: 'skipped', reason: 'it no longer exists' };
  if (change)
    return { check: current, status: 'skipped', reason: 'it changed while it was being checked' };

  const description = `${describeExportBanList(current.exportBanList)}, outside today's limits with ${plural(current.players, 'player')}${describeRecount(current)}`;
  try {
    // ExportBanList's lines are important, as the removal's own are, so they reach the log channel
    // in order with them, never after the summary.
    const outcome = await current.exportBanList.deleteExportBanList({ important: true });
    return { check: current, status: 'removed', outcome, description };
  } catch (error) {
    return { check: current, status: 'failed', reason: failureReason(error), description };
  }
}

// How many lists ended each way. Of the lists not removed (skipped), beingDeleted counts those left
// as their deletion lock was held already.
function countResults(results) {
  const counts = {
    removed: 0,
    deleted: 0,
    gone: 0,
    none: 0,
    failed: 0,
    skipped: 0,
    beingDeleted: 0
  };
  for (const { status, outcome, beingDeleted } of results) {
    counts[status]++;
    if (status === 'removed') counts[outcome in OUTCOMES ? outcome : 'none']++;
    if (beingDeleted) counts.beingDeleted++;
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
  const changed = counts.skipped - counts.beingDeleted;
  const others = [
    counts.failed > 0 && `${counts.failed.toLocaleString('en-US')} failed.`,
    changed > 0 && `${was(changed)} not removed, as ${changed === 1 ? 'it' : 'they'} had changed.`,
    counts.beingDeleted > 0 &&
      `${was(counts.beingDeleted)} not removed, as ${counts.beingDeleted === 1 ? 'it was' : 'they were'} already being deleted.`,
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
  // A list whose players could not be counted by its settings now may be over its type's cap or
  // not, so it is never removed for the cap: it comes with the count's error, and it is outside the
  // limits only when it breaks the points rules. Otherwise it is left, and the reply names it, so a
  // count that fails holds up no other list (see describeUncounted).
  const { limits, lists } = await ExportBanList.checkLimits({ keepRecountErrors: true });
  const checkedAt = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  // The limits used, and what the numbers of players mean while ban lists are paused, which every
  // reply and the preview's file give in full.
  const limitsUsed = [describeLimits(limits), describePaused(await readPausedIDs())]
    .filter(Boolean)
    .join('\n');
  const outside = lists.filter((check) => check.problems.length > 0);
  const unchecked = lists.filter((check) => !check.checked);
  const uncheckedNote =
    unchecked.length > 0
      ? ` ${was(unchecked.length)} not checked, as the limits do not cover ${unchecked.length === 1 ? 'its type' : 'their types'}: ${unchecked.map((check) => `#${check.exportBanList.id}`).join(', ')}.`
      : '';
  const uncounted = describeUncounted(lists, checkedAt);
  const listNotes = [uncounted, describeUpdating(lists, checkedAt)];
  if (outside.length === 0) {
    // With lists that could not be counted, it is not known that none is outside the limits.
    const none = uncounted.note
      ? "No export ban list was found outside today's limits"
      : "No export ban list is outside today's limits";
    await interaction.editReply(
      withListNotes(`${none}, so nothing was changed.${uncheckedNote}\n${limitsUsed}`, listNotes)
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
  const preview = entriesMessage(
    title,
    plan.map(previewLine),
    'export-ban-lists-outside-limits.txt',
    [
      `Export ban lists outside today's limits, checked ${checkedAt}: ${outside.length}`,
      limitsUsed,
      '',
      ...plan.map(previewFileEntry)
    ].join('\n')
  );
  const notes = [describeAccess(access, left), limitsUsed].filter(Boolean).join('\n');
  const found = `**${plural(outside.length, 'export ban list')} ${outside.length === 1 ? 'is' : 'are'} outside today's limits.**`;

  if (removable.length === 0) {
    const reply = withListNotes(
      `${found} None can be removed now, so nothing was changed.${uncheckedNote}\n${notes}`,
      listNotes
    );
    await interaction.editReply({
      ...preview,
      ...reply,
      files: [...preview.files, ...reply.files]
    });
    return;
  }

  let which = `${removable.length} of them`;
  if (removable.length === outside.length) which = outside.length === 1 ? 'it' : 'them';
  const question = withListNotes(
    `${found} Remove ${which}? This deletes each list with its export bans and configs, and a BattleMetrics list's ban list on BattleMetrics, which the organisations subscribed to it lose. Their owners are not told.${uncheckedNote}\n${notes}`,
    listNotes
  );
  const confirmed = await confirm(
    interaction,
    question.content,
    `Remove ${plural(removable.length, 'export ban list')}`,
    { ...preview, files: [...preview.files, ...question.files], timeout: REVIEW_TIMEOUT }
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

// The list, its owner, the new owner and how many export ban lists the new owner has, with the ban
// lists paused now for a list counted again by its settings now (see listDetailsEmbed).
function transferEmbed(check, newOwner, listCount, paused = []) {
  return listDetailsEmbed(check, paused).addFields(
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
// someone else meanwhile, or its deletion may have started, on the website or by a removal here,
// and the new owner may have made lists of their own. Gives null once the list is theirs, or why it
// was left as it is.
//
// The website changes lists from its own process, so the transfer is one short transaction that
// locks what it reads: the new owner's lists first (ExportBanList.lockListsOf), as a creation on
// the website locks its user's lists, so a list they create on the website meanwhile waits for the
// transfer, or the transfer for it, and is counted, and then the list itself, so a change its owner
// is saving on the website lands before the transfer or not at all. A few of these can still meet
// in a deadlock, such as a list its old owner creates at the same moment, which
// ExportBanList.inTransaction runs again (see there). A list being deleted, on the website or by a
// removal here, which holds its deletion lock, is left as it is, as the deletion goes on.
function transferIfUnchanged(exportBanList, newOwner) {
  const name = formatName(exportBanList);
  const to = formatSteamUser(newOwner.id, newOwner.name);
  return ExportBanList.inTransaction(async (transaction) => {
    const listCount = await ExportBanList.lockListsOf(newOwner.id, { transaction });
    const current = await ExportBanList.findByPk(exportBanList.id, { lock: true, transaction });
    if (!current) return `Export ban list ${name} no longer exists`;
    if (current.owner === newOwner.id) return `Export ban list ${name} already belongs to ${to}`;
    if (current.owner !== exportBanList.owner)
      return `Export ban list ${name} now belongs to \`${current.owner}\`, not ${formatOwner(exportBanList)} as shown`;
    if (await ExportBanList.isBeingDeleted(exportBanList.id, { transaction }))
      return `Export ban list ${name} is being deleted`;
    if (listCount >= MAX_LISTS_PER_USER)
      return `${to} now has ${plural(listCount, 'export ban list')}, and the website lets a user have at most ${MAX_LISTS_PER_USER}`;

    // Only the owner is written, and only while the list still has the owner shown.
    const [updated] = await ExportBanList.update(
      { owner: newOwner.id },
      { where: { id: exportBanList.id, owner: exportBanList.owner }, transaction }
    );
    return updated === 0 ? `Export ban list ${name} changed as it was being transferred` : null;
  });
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
// Like a list created on the website, the transfer can wait for rows a run has locked, such as the
// new owner's Steam user while the run recalculates every player's reputation, which can take most
// of a minute after a big import, and transfers confirmed meanwhile wait for it in turn. It waits
// for that before it locks any list, so changes to lists on the website are not held up behind it.
// If MySQL gives up waiting, nothing is changed, and the admin is told to try again. It also waits
// for a change being saved on the website to the list or the new owner's lists, which takes a
// moment (see transferIfUnchanged).
async function transfer(interaction) {
  const id = interaction.options.getInteger('id', true);
  const owner = parseSteamID(interaction.options.getString('owner', true));

  // The list's players are only shown, so a count of them that fails does not stop the transfer.
  const {
    lists: [check]
  } = await ExportBanList.checkLimits({ ids: [id], keepRecountErrors: true });
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
  const paused = await pausedFor(check);
  const confirmed = await confirm(
    interaction,
    truncate(
      `Transfer export ban list ${name} from ${from} to ${to}? Only its owner changes: its ${kept} stay as they are. From then on the new owner sees it on the website, with ${shown}, and can change or delete it, and the current owner no longer can. Neither is told.`,
      MESSAGE_LENGTH
    ),
    'Transfer export ban list',
    { embeds: [transferEmbed(check, newOwner, listCount, paused)] }
  );
  if (!confirmed) return;

  let left;
  try {
    left = await afterLastTransfer(() => transferIfUnchanged(exportBanList, newOwner));
  } catch (error) {
    // MySQL could not make the transfer, as other changes held the rows it needed (see
    // ExportBanList.inTransaction). Nothing was changed, so the admin is told plainly, to try again.
    if (error?.busy === true)
      throw new UserError(
        truncate(
          `Export ban list ${name} was not transferred, as the database was busy with other changes, so nothing was changed. Try again in a minute.`,
          MESSAGE_LENGTH
        )
      );
    throw error;
  }
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
