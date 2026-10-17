import { AttachmentBuilder, escapeMarkdown, SlashCommandBuilder } from 'discord.js';

import { isRunLockHeld } from 'scbl-lib/db';
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
// checkLimits, so the bot needs the same settings as the web server.

const data = new SlashCommandBuilder()
  .setName('exportbanlist')
  .setDescription("Remove users' export ban lists.")
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
  );

const IMPORTER_RUNNING =
  'The ban importer is running, so nothing was changed. Try again once the run has finished.';

// Discord allows 2,000 characters in a message and 4,096 in an embed's description.
const MESSAGE_LENGTH = 2000;
const DESCRIPTION_LENGTH = 4096;

// The longest reason a message shows for one list. The attached files have them in full.
const REASON_LENGTH = 300;

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

// A ban importer run could export bans to a list while it is being removed, so lists are not
// removed while a run holds its lock.
async function refuseWhileImporting() {
  if (await isRunLockHeld()) throw new UserError(IMPORTER_RUNNING);
}

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

// The list's owner: their Steam name, when they have one, and their Steam ID.
function formatOwner(exportBanList) {
  const name = exportBanList.SteamUser?.name;
  const id = `\`${exportBanList.owner}\``;
  return name ? `${bold(name)} (${id})` : id;
}

// Describe the list for the audit log.
function describeExportBanList(exportBanList) {
  const battlemetrics = exportBanList.battlemetricsID
    ? `, BattleMetrics ID: ${exportBanList.battlemetricsID}`
    : '';
  const name = exportBanList.SteamUser?.name;
  const owner = name
    ? `Steam user "${name}" (ID: ${exportBanList.owner})`
    : `Steam user ${exportBanList.owner}`;
  const type = formatBanListType(exportBanList.type);
  return `export ban list "${exportBanList.name}" (ID: ${exportBanList.id}, ${type}${battlemetrics}) of ${owner}`;
}

// What removing the list deletes, for the confirmation.
function describeRemoval(exportBanList) {
  if (exportBanList.type !== 'battlemetrics')
    return 'This deletes the list, with its export bans and configs, so its address serves no players.';
  if (!exportBanList.battlemetricsID)
    return 'It has no BattleMetrics ban list, so this deletes only the list, with its export bans and configs.';
  return 'This deletes its BattleMetrics ban list, which the organisations subscribed to it lose, and then the list, with its export bans and configs.';
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

function exportBanListEmbed(check) {
  const { exportBanList, players } = check;
  const embed = listEmbed(truncate(exportBanList.name || 'Unnamed', 256), null).addFields(
    { name: 'ID', value: String(exportBanList.id), inline: true },
    { name: 'Type', value: formatBanListType(exportBanList.type), inline: true },
    { name: 'Players', value: players.toLocaleString('en-US'), inline: true },
    { name: 'Owner', value: truncate(formatOwner(exportBanList), 1024) }
  );
  if (exportBanList.type === 'battlemetrics')
    embed.addFields({
      name: 'BattleMetrics ID',
      value: exportBanList.battlemetricsID
        ? truncate(`\`${exportBanList.battlemetricsID}\``, 1024)
        : 'None'
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
  await refuseWhileImporting();

  const {
    lists: [check]
  } = await ExportBanList.checkLimits({ ids: [id] });
  if (!check) throw new UserError(`There is no export ban list with ID ${id}.`);
  const { exportBanList, players } = check;
  const name = formatName(exportBanList);

  const confirmed = await confirm(
    interaction,
    truncate(
      `Remove export ban list ${name}? ${describeRemoval(exportBanList)} Its owner is not told.`,
      MESSAGE_LENGTH
    ),
    'Remove export ban list',
    { embeds: [exportBanListEmbed(check)] }
  );
  if (!confirmed) return;

  // A run may have started while the removal was confirmed.
  await refuseWhileImporting();

  // The list as it is now, which its owner may have changed or deleted meanwhile.
  const current = await ExportBanList.findByPk(id);
  if (!current) {
    await interaction.editReply({
      content: `Export ban list ${name} no longer exists, so nothing was changed.`,
      embeds: []
    });
    return;
  }

  const description = `${describeExportBanList(exportBanList)}, which had ${plural(players, 'player')}`;
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

  audit(interaction, `removed ${description}: ${OUTCOMES[outcome] ?? outcome}.`);
  let result = `Removed export ban list ${name}.`;
  if (outcome === 'deleted')
    result = `Removed export ban list ${name} and its BattleMetrics ban list.`;
  else if (outcome === 'gone')
    result += ' BattleMetrics no longer had its ban list, so there was nothing to delete there.';
  else if (current.type === 'battlemetrics') result += ' It had no BattleMetrics ban list.';
  await interaction.editReply({ content: truncate(result, MESSAGE_LENGTH), embeds: [] });
}

// Whether CBL's BattleMetrics API key can see the ban lists of the lists to remove. Deleting a list
// treats a ban list BattleMetrics does not know as already gone, so with a key from an account
// outside CBL's organisation, every list would be deleted while its ban list stayed on
// BattleMetrics. So the key must see at least one of the ban lists CBL's export ban lists record,
// and a list whose own ban list it cannot see is left. Gives null when no list to remove has a ban
// list, { error } when BattleMetrics could not be asked, and otherwise the IDs of the ban lists the
// key can see, how many ban lists the export ban lists record, and how many of those it can see.
async function checkBattlemetricsAccess(lists, outside) {
  if (!outside.some(({ exportBanList }) => hasBattlemetricsBanList(exportBanList))) return null;

  let visible;
  try {
    visible = await ExportBanList.findVisibleBattlemetricsBanLists();
  } catch (error) {
    return { error };
  }
  const recorded = lists
    .map(({ exportBanList }) => exportBanList)
    .filter(hasBattlemetricsBanList)
    .map((exportBanList) => exportBanList.battlemetricsID);
  return {
    visible,
    recorded: recorded.length,
    seen: recorded.filter((id) => visible.has(id)).length
  };
}

// Why a list outside the limits is left as it is, or null when it can be removed.
function leftReason(exportBanList, access) {
  if (!hasBattlemetricsBanList(exportBanList)) return null;
  if (!access) return 'its BattleMetrics ban list was not checked';
  if (access.error) return 'BattleMetrics could not be asked about its ban list';
  if (access.seen === 0) return "CBL's BattleMetrics key can see none of CBL's ban lists";
  if (!access.visible.has(exportBanList.battlemetricsID))
    return "its BattleMetrics ban list is not among those CBL's BattleMetrics key can see";
  return null;
}

function describeAccess(access, left) {
  if (!access) return '';
  if (access.error)
    return `BattleMetrics could not be asked which ban lists CBL's BattleMetrics key can see (${access.error.message}), so the lists with BattleMetrics ban lists are left. Try again later.`;
  const seen = `CBL's BattleMetrics key can see ${access.seen.toLocaleString('en-US')} of the ${plural(access.recorded, 'BattleMetrics ban list')} CBL's export ban lists record.`;
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
    const outcome = await current.exportBanList.deleteExportBanList();
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
  await refuseWhileImporting();

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

  const access = await checkBattlemetricsAccess(lists, outside);
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
    preview
  );
  if (!confirmed) return;

  // A run may have started while the removal was confirmed.
  if (await isRunLockHeld()) {
    await interaction.editReply({ content: IMPORTER_RUNNING, embeds: [], attachments: [] });
    return;
  }
  audit(
    interaction,
    `started removing ${plural(removable.length, 'export ban list')} outside today's limits.`,
    { important: true }
  );

  // Removing a BattleMetrics list takes several requests within the bot's BattleMetrics budget, so
  // the removal can outlast the 15 minutes for which Discord lets the reply be edited. So each
  // list's result and the summary also go to the log channel, all as important lines, as the
  // start is. Lines of the same importance reach the channel in the order they were logged, so the
  // summary never goes ahead of a result still waiting to be sent, and none is dropped for other
  // lines.
  const reply = new ReplyUpdater(interaction);
  reply.update({ content: describeProgress(removable.length, []) });

  const results = [];
  let stopped = null;
  for (const check of removable) {
    // A run that starts during the removal could export bans to a list being removed.
    let importing;
    try {
      importing = await isRunLockHeld();
    } catch (error) {
      stopped = `Stopped, as the bot could not check whether the ban importer is running: ${error.message}`;
      break;
    }
    if (importing) {
      stopped =
        'Stopped, as the ban importer started a run. Run the command again once it has finished.';
      break;
    }

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

const subcommands = { remove, remove_outside_limits: removeOutsideLimits };

export default {
  data,
  execute: (interaction) => subcommands[interaction.options.getSubcommand()](interaction)
};
