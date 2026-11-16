import { SlashCommandBuilder } from 'discord.js';

import { isRunLockHeld, sequelize } from 'scbl-lib/db';
import {
  isMissingTable,
  MAX_REASON_LENGTH,
  resumeBanList,
  suspendBanList
} from 'scbl-lib/db/ban-list-suspensions';
import { BanList, Organisation } from 'scbl-lib/db/models';
import { Op } from 'scbl-lib/db/sequelize';

import {
  applyChanges,
  audit,
  banListEmbed,
  banListOption,
  banListStatusEmbed,
  banListSourceOption,
  banListTypeOption,
  bold,
  checkBanListSourceOption,
  checkBanListSourceUnused,
  confirm,
  deleteBanLists,
  deleteBansOfBanLists,
  describeBanList,
  describeBanListDeletion,
  findBanList,
  findOrganisation,
  describePause,
  describeSourceChange,
  formatBanListName,
  formatBanListType,
  markSourceChanged,
  NO_TABLES,
  organisationOption,
  paginate,
  parseBanListSource,
  pauseState,
  plural,
  quote,
  readPause,
  readQueueSkips,
  readStatus,
  skipCheckOption,
  suggestBanLists,
  suggestOrganisations,
  summariseBanListBans,
  summariseBanListDeletion,
  summariseImport,
  UserError
} from '../utils/index.js';

const data = new SlashCommandBuilder()
  .setName('banlist')
  .setDescription("Manage partner organisations' ban lists.")
  // Only administrators see the command unless other roles are allowed in the server's settings.
  .setDefaultMemberPermissions(0)
  .addSubcommand((subcommand) =>
    subcommand
      .setName('add')
      .setDescription('Add a ban list to a partner organisation.')
      .addStringOption((option) =>
        organisationOption(option, 'Organisation the ban list belongs to.')
      )
      .addStringOption((option) =>
        option
          .setName('name')
          .setDescription('Name of the ban list, e.g. "Main".')
          .setRequired(true)
          .setMaxLength(100)
      )
      .addStringOption((option) => banListTypeOption(option).setRequired(true))
      .addStringOption((option) => banListSourceOption(option).setRequired(true))
      .addBooleanOption(skipCheckOption)
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('update')
      .setDescription("Change a ban list's name, type or source.")
      .addStringOption((option) => banListOption(option, 'Ban list to update.'))
      .addStringOption((option) =>
        option.setName('name').setDescription('New name for the ban list.').setMaxLength(100)
      )
      .addStringOption(banListTypeOption)
      .addStringOption(banListSourceOption)
      .addBooleanOption(skipCheckOption)
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('remove')
      .setDescription('Remove a ban list along with its bans.')
      .addStringOption((option) => banListOption(option, 'Ban list to remove.'))
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('suspend')
      .setDescription(
        'Stop importing a ban list, and stop its bans counting anywhere, until resumed.'
      )
      .addStringOption((option) => banListOption(option, 'Ban list to suspend.'))
      .addStringOption((option) =>
        option
          .setName('reason')
          .setDescription('Why it is suspended, for the log and /banlist status.')
          .setMaxLength(MAX_REASON_LENGTH)
      )
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('resume')
      .setDescription('Import a suspended ban list again, so its bans count again.')
      .addStringOption((option) => banListOption(option, 'Ban list to resume.'))
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('status')
      .setDescription('Show whether ban lists are paused, and how they were last imported.')
      .addStringOption((option) =>
        banListOption(option, 'Ban list to show. Leave out for every ban list.', {
          required: false
        })
      )
  );

// The ban importer recalculates players' reputation points at most this many players a cycle when
// a list is paused or counts again (see ban-importer/src/reputation-check.js).
const SETTLED_PER_CYCLE = 1000;

// How long a change to a list's bans counting takes to reach the players of a list with this many
// players, from the ban importer cycle at which it changes.
function settles(steamUsers, from = 'the next ban importer cycle') {
  const cycles = Math.max(1, Math.ceil(steamUsers / SETTLED_PER_CYCLE));
  return `Export bans follow from ${from}, and players' reputation points within ${plural(cycles, 'cycle')} of it.`;
}

// Ban lists are shown by name next to their organisation, so names must be unique within one.
async function checkName(name, organisation, banList = null) {
  if (!name) throw new UserError('The name cannot be blank.');

  const where = { name, organisation: organisation.id };
  if (banList) where.id = { [Op.ne]: banList.id };
  if (await BanList.findOne({ where }))
    throw new UserError(`${bold(organisation.name)} already has a ban list called "${name}".`);
}

async function add(interaction) {
  const organisation = await findOrganisation(interaction.options.getString('organisation', true));
  const name = interaction.options.getString('name', true).trim();
  const type = interaction.options.getString('type', true);
  const source = parseBanListSource(type, interaction.options.getString('source', true));

  await checkName(name, organisation);
  await checkBanListSourceUnused(type, source);
  const check = await checkBanListSourceOption(interaction, type, source);

  const banList = await BanList.create({ name, type, source, organisation: organisation.id });
  const sourceDescription = `${formatBanListType(type)} source "${source}"`;
  audit(interaction, `added ${describeBanList(banList, organisation)} with ${sourceDescription}.`);

  const listName = formatBanListName(banList, organisation);
  await interaction.editReply({
    content: `Added ${listName}. ${check} Its bans are imported on the next ban importer run.`,
    embeds: [banListEmbed(banList, organisation)]
  });
}

async function update(interaction) {
  const banList = await findBanList(interaction.options.getString('banlist', true));
  const organisation = banList.Organisation;
  const name = interaction.options.getString('name')?.trim();
  const typeInput = interaction.options.getString('type');
  const sourceInput = interaction.options.getString('source');
  if (name !== undefined) await checkName(name, organisation, banList);

  // Only validate the source when it is being changed, so lists can always be renamed.
  let type, source, check;
  if (typeInput !== null || sourceInput !== null) {
    type = typeInput || banList.type;
    source = parseBanListSource(type, sourceInput || banList.source);

    if (type !== banList.type || source !== banList.source) {
      await checkBanListSourceUnused(type, source, banList);
      check = await checkBanListSourceOption(interaction, type, source);
    }
  }

  const description = describeBanList(banList, organisation);
  const currentName = formatBanListName(banList, organisation);
  const changes = applyChanges(banList, { name, type, source });
  if (changes.length === 0)
    throw new UserError('Nothing to change. Give a new name, type or source.');

  // The list's bans came from its old source, so a new type or source deletes them, and the new
  // source's bans are imported on the next ban importer run, or once the list is resumed, if it is
  // suspended. The importer would replace them itself, as it does for a source changed by hand, but
  // a list of 10 or more bans would keep them counting until a read confirmed them gone, at least
  // 10 minutes after its first read of the new source, so deleting them here makes them stop
  // counting at once. The question gives what the check found of the new source, as it may warn of
  // something the admin would rather not delete the bans for.
  let deletion = null;
  let paused = null;
  if (check !== undefined) {
    paused = (await readPause(banList.id).catch(ignoreMissingTables)) ?? null;
    const imported =
      pauseState(paused) === 'suspended'
        ? 'imported once it is resumed'
        : 'imported on the next ban importer run';
    const bans = await summariseBanListBans([banList.id]);
    if (bans.bans > 0) {
      deletion = describeBanListDeletion(bans);
      const confirmed = await confirm(
        interaction,
        `Change the source of ${currentName}? This deletes its ${deletion}, and the new source's bans are ${imported}. ${check}`,
        'Change source'
      );
      if (!confirmed) return;
    }

    // A ban importer run may be importing the list from its old source, and would save that
    // source's bans again after they are deleted, so the change is refused while a run is under
    // way. This is checked once the change is confirmed, just before it is saved: a run that
    // starts after that reads the new source.
    if (await isRunLockHeld())
      throw new UserError(
        'The ban importer is running, so nothing was changed. Change the type or source again once the run has finished; renaming still works meanwhile.'
      );
  }

  // A paused list's bans count for nothing, so its players are not queued once the importer has
  // settled them (see readQueueSkips), as read once the change is confirmed. A new type or source
  // also marks the list's row of the importer's, so the importer reads the new source in full
  // afresh, also when it had no bans to delete, e.g. as the source is changed back before the
  // importer read the one it was changed to (see markSourceChanged). A rename alone leaves the
  // list's updatedAt as it was, as /banlist status takes that for when its type or source was last
  // changed (see readStatus).
  const skips = deletion ? await readQueueSkips([banList.id]) : [];
  await sequelize.transaction(async (transaction) => {
    if (deletion) await deleteBansOfBanLists([banList.id], transaction, { paused: skips });
    await banList.save({ transaction, silent: check === undefined });
    if (check !== undefined) await markSourceChanged(banList.id, transaction);
  });
  const deleted = deletion ? `, deleting ${deletion}` : '';
  audit(interaction, `updated ${description}: ${changes.join(', ')}${deleted}.`);

  const listName = formatBanListName(banList, organisation);
  const reimported =
    pauseState(paused) === 'suspended'
      ? 'Its bans are imported from the new source once it is resumed.'
      : 'Its bans are re-imported on the next ban importer run.';
  await interaction.editReply({
    content: check ? `Updated ${listName}. ${check} ${reimported}` : `Updated ${listName}.`,
    embeds: [banListEmbed(banList, organisation, paused)]
  });
}

async function remove(interaction) {
  const banList = await findBanList(interaction.options.getString('banlist', true));
  const organisation = banList.Organisation;
  const listName = formatBanListName(banList, organisation);
  const deletion = describeBanListDeletion(await summariseBanListDeletion([banList.id]));

  const confirmed = await confirm(
    interaction,
    `Remove ${listName}? This permanently deletes ${deletion}.`,
    'Remove ban list'
  );
  if (!confirmed) return;

  // A paused list's players are not queued once the importer has settled them without its bans
  // (see readQueueSkips), as read once the removal is confirmed.
  const skips = await readQueueSkips([banList.id]);
  await deleteBanLists([banList.id], null, { paused: skips });
  audit(interaction, `removed ${describeBanList(banList, organisation)}, deleting ${deletion}.`);

  await interaction.editReply(
    skips.length > 0
      ? `Removed ${listName}. It was paused, so its bans already counted for nothing.`
      : `Removed ${listName}. Affected players' reputation is recalculated on the next ban importer run.`
  );
}

// A paused list is read as not paused while the ban importer has not made its tables, as none can
// be paused then.
function ignoreMissingTables(err) {
  if (err?.message === NO_TABLES || isMissingTable(err)) return null;
  throw err;
}

// Who made a change, as the audit line names them.
const describeUser = (interaction) => `${interaction.user.tag} (${interaction.user.id})`;

async function suspend(interaction) {
  const banList = await findBanList(interaction.options.getString('banlist', true));
  const organisation = banList.Organisation;
  const listName = formatBanListName(banList, organisation);
  const reason = interaction.options.getString('reason')?.trim() || null;

  const before = await readPause(banList.id);
  if (pauseState(before) === 'suspended')
    throw new UserError(`${listName} is suspended already.\n${describePause(before)}`);

  const bans = await summariseBanListBans([banList.id]);
  const resuming = pauseState(before) === 'resuming' ? ' It stops resuming.' : '';
  const confirmed = await confirm(
    interaction,
    `Suspend ${listName}? Its ${describeBanListDeletion(bans)} stop counting toward reputation and export ban lists, and are left out of the website's lists of bans. The ban importer stops importing it until it is resumed.${resuming} ${settles(bans.steamUsers)}`,
    'Suspend ban list'
  );
  if (!confirmed) return;

  const { outcome, row } = await suspendBanList(banList.id, {
    by: describeUser(interaction),
    reason
  }).catch((err) => {
    if (isMissingTable(err)) throw new UserError(NO_TABLES);
    throw err;
  });
  if (outcome === 'gone')
    throw new UserError(`${listName} was removed meanwhile, so nothing was suspended.`);
  if (outcome === 'already') {
    await interaction.editReply({
      content: `${listName} was suspended meanwhile, so nothing was changed.`,
      embeds: [banListEmbed(banList, organisation, row)]
    });
    return;
  }

  audit(
    interaction,
    `suspended ${describeBanList(banList, organisation)}${reason ? `, for the reason ${quote(reason)}` : ''}.`
  );
  await interaction.editReply({
    content: `Suspended ${listName}. Resume it with /banlist resume.`,
    embeds: [banListEmbed(banList, organisation, row)]
  });
}

async function resume(interaction) {
  const banList = await findBanList(interaction.options.getString('banlist', true));
  const organisation = banList.Organisation;
  const listName = formatBanListName(banList, organisation);

  const before = await readPause(banList.id);
  if (!pauseState(before)) throw new UserError(`${listName} is not suspended.`);
  if (pauseState(before) === 'resuming')
    throw new UserError(`${listName} is resuming already.\n${describePause(before)}`);

  // A list given a new type or source whose old bans the importer has yet to finish replacing (see
  // readStatus) has them replaced by the new source's, which the importer never holds for an admin,
  // however many it loses, so the question says only that the list counts again once the importer
  // has caught up with it. While the list has bans, that can wait for the importer's reads to
  // confirm those the new source does not have, as for any list (only when at least 10 of them, and
  // 5% of the list, are missing; fewer are removed at once), which the question says too: a source
  // changed by hand keeps its old bans, and the importer may have saved some of the new source's
  // already. /banlist update deletes the old bans with the change, so a list it changed that the
  // importer has not read since has none.
  const bans = await summariseBanListBans([banList.id]);
  const { syncs } = await readStatus([banList]);
  const changed = describeSourceChange(syncs.get(banList.id));
  const confirming =
    bans.bans > 0
      ? `: once its reads have confirmed which of its ${describeBanListDeletion(bans)} the new source does not have, which takes at least 10 more minutes when at least 10 of them, and 5% of the list, are missing`
      : '';
  const catchUp = changed
    ? `${changed} The ban importer reads it in full on its next cycle, and the list counts again once it has caught up with it${confirming}.`
    : `The ban importer reads it in full on its next cycle, and its ${describeBanListDeletion(bans)} count again once it has caught up with it: once its reads have confirmed the bans its owner removed meanwhile, which takes at least 10 more minutes when at least 10 of them, and 5% of the list, are missing, and longer when it seems to have lost all of them, or a large part of them at once.`;
  const confirmed = await confirm(
    interaction,
    `Resume ${listName}? ${catchUp} /banlist status shows when. ${settles(bans.steamUsers, 'the cycle after it counts again')}`,
    'Resume ban list'
  );
  if (!confirmed) return;

  const { outcome, row } = await resumeBanList(banList.id).catch((err) => {
    if (isMissingTable(err)) throw new UserError(NO_TABLES);
    throw err;
  });
  if (outcome !== 'resuming') {
    await interaction.editReply({
      content: `${listName} was ${outcome === 'already' ? 'resumed' : 'no longer suspended'} meanwhile, so nothing was changed.`,
      embeds: [banListEmbed(banList, organisation, row)]
    });
    return;
  }

  audit(interaction, `resumed ${describeBanList(banList, organisation)}.`);
  await interaction.editReply({
    content: `Resumed ${listName}. It counts again once the ban importer has caught up with it, which /banlist status shows.`,
    embeds: [banListEmbed(banList, organisation, row)]
  });
}

async function status(interaction) {
  const value = interaction.options.getString('banlist');
  if (value) {
    const banList = await findBanList(value);
    const { paused, syncs, removals } = await readStatus([banList]);
    await interaction.editReply({
      embeds: [
        banListStatusEmbed(banList, banList.Organisation, {
          paused: paused.get(banList.id) ?? null,
          sync: syncs.get(banList.id) ?? null,
          removals: removals.get(banList.id)
        })
      ]
    });
    return;
  }

  const banLists = await BanList.findAll({
    include: [{ model: Organisation, required: true }],
    order: [
      [Organisation, 'name', 'ASC'],
      ['name', 'ASC']
    ]
  });
  const { paused, syncs, removals } = await readStatus(banLists);
  const lines = banLists.map((banList) => {
    const state = pauseState(paused.get(banList.id));
    const held = removals.get(banList.id);
    const holding =
      held && held.waiting + held.held > 0
        ? ` · ${plural(held.waiting + held.held, 'removal')} held`
        : '';
    return `${formatBanListName(banList, banList.Organisation)} (#${banList.id})${state ? ` · **${state}**` : ''} · ${summariseImport(syncs.get(banList.id))}${holding}`;
  });
  const pausedCount = banLists.filter((banList) => paused.has(banList.id)).length;
  await paginate(
    interaction,
    `Ban lists: ${plural(banLists.length, 'list')}, ${pausedCount} paused`,
    lines
  );
}

const subcommands = { add, update, remove, suspend, resume, status };

export default {
  data,
  autocomplete: (interaction) =>
    interaction.options.getFocused(true).name === 'organisation'
      ? suggestOrganisations(interaction)
      : suggestBanLists(interaction),
  execute: (interaction) => subcommands[interaction.options.getSubcommand()](interaction)
};
