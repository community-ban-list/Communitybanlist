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
  CONFIRM_HOURS,
  confirmedUntil,
  deleteBanLists,
  deleteBansOfBanLists,
  describeBanList,
  describeBanListDeletion,
  describeConfirmation,
  describeHoldForLog,
  findBanList,
  findOrganisation,
  describePause,
  describeSourceChange,
  formatBanListName,
  formatBanListType,
  formatDateTime,
  markFullRead,
  markRemovalConfirmed,
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
  summariseHold,
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
      .setDescription(
        'Show whether ban lists are paused or held, how they were last imported, and when next.'
      )
      .addStringOption((option) =>
        banListOption(option, 'Ban list to show. Leave out for every ban list.', {
          required: false
        })
      )
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('resync')
      .setDescription('Have the ban importer read a ban list in full on its next cycle.')
      .addStringOption((option) => banListOption(option, 'Ban list to read in full.'))
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('confirm-removal')
      .setDescription(
        'Confirm that a held ban list really lost its bans, so the ban importer removes them.'
      )
      .addStringOption((option) => banListOption(option, 'Held ban list to confirm.'))
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

  // A list given a new type or source that the importer has yet to finish switching it to (see
  // readStatus) has its old bans, if any, replaced by the new source's, which the importer never
  // holds for an admin, however many it loses, so the question says only that the list counts again
  // once the importer has caught up with it. While the list has bans, that can wait for a later read
  // to confirm those the new source does not have, as for any list: one at least 10 minutes after
  // the first read that missed them, and only when at least 10 of them, and 5% of the list, are
  // missing, as fewer are removed at once. The wait runs from that first read, which may have come
  // before the list was suspended, not from the resume. The question says so too: a source changed
  // by hand keeps its old bans, and the importer may have saved some of the new source's already.
  // /banlist update deletes the old bans with the change, so a list it changed that the importer has
  // not read since has none.
  const bans = await summariseBanListBans([banList.id]);
  const { syncs } = await readStatus([banList]);
  const changed = describeSourceChange(syncs.get(banList.id));
  const confirming =
    bans.bans > 0
      ? `: once its reads have confirmed which of its ${describeBanListDeletion(bans)} the new source does not have, which takes a later read, at least 10 minutes after the first read that missed them, when at least 10 of them, and 5% of the list, are missing`
      : '';
  const catchUp = changed
    ? `${changed} The ban importer reads it in full on its next cycle, and the list counts again once it has caught up with it${confirming}.`
    : `The ban importer reads it in full on its next cycle, and its ${describeBanListDeletion(bans)} count again once it has caught up with it: once its reads have confirmed the bans its owner removed meanwhile, which takes a later read, at least 10 minutes after the first read that missed them, when at least 10 of them, and 5% of the list, are missing, and longer when it seems to have lost all of them, or a large part of them at once.`;
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
  const now = Date.now();
  if (value) {
    const banList = await findBanList(value);
    const { paused, syncs, removals, holds } = await readStatus([banList]);
    await interaction.editReply({
      embeds: [
        banListStatusEmbed(banList, banList.Organisation, {
          paused: paused.get(banList.id) ?? null,
          sync: syncs.get(banList.id) ?? null,
          removals: removals.get(banList.id),
          hold: holds.get(banList.id) ?? null,
          now
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
  const { paused, syncs, removals, holds } = await readStatus(banLists);
  const lines = banLists.map((banList) => {
    const state = pauseState(paused.get(banList.id));
    const hold = holds.get(banList.id);
    // The bans that wait for a confirming read, by the list's records, or none for an 'empty' hold,
    // which gives the list's stored bans as held (see holdOf).
    const waiting = hold?.kind === 'empty' ? 0 : (removals.get(banList.id)?.waiting ?? 0);
    // A row whose sourceChange is 'unread' (see readStatus) is shown only as that change, as
    // describeImport and summariseImport show it, so an admin's confirmation in it is not shown.
    const sync = syncs.get(banList.id);
    const until = sync?.sourceChange === 'unread' ? null : confirmedUntil(sync, now);
    return [
      `${formatBanListName(banList, banList.Organisation)} (#${banList.id})`,
      state ? `**${state}**` : null,
      summariseImport(sync),
      hold ? `**${summariseHold(hold)}**` : null,
      waiting > 0 ? `${plural(waiting, 'removal')} waiting for a confirming read` : null,
      until ? `removal confirmed until ${formatDateTime(until)}` : null
    ]
      .filter(Boolean)
      .join(' · ');
  });
  const pausedCount = banLists.filter((banList) => paused.has(banList.id)).length;
  await paginate(
    interaction,
    `Ban lists: ${plural(banLists.length, 'list')}, ${pausedCount} paused`,
    lines
  );
}

// The ban list given, and what the ban importer's tables say of it, for /banlist resync and
// confirm-removal: its paused row, its BanListSyncs row, the bans held back from removing it and its
// hold of them for an admin, if any.
async function readListStatus(interaction) {
  const banList = await findBanList(interaction.options.getString('banlist', true));
  const { paused, syncs, removals, holds } = await readStatus([banList]);
  return {
    banList,
    organisation: banList.Organisation,
    listName: formatBanListName(banList, banList.Organisation),
    paused: paused.get(banList.id) ?? null,
    sync: syncs.get(banList.id) ?? null,
    removals: removals.get(banList.id) ?? null,
    hold: holds.get(banList.id) ?? null
  };
}

// Mark a list's BanListSyncs row to be read in full (see markFullRead), as after fixing something
// by hand. A list that is suspended, that has no row, whose row's state is self_import, or whose
// type or source was changed (see readStatus), is left as it is, which the reply says, and so is a
// remote list while the importer's run lock is held.
async function resync(interaction) {
  const { banList, organisation, listName, paused, sync } = await readListStatus(interaction);
  if (pauseState(paused) === 'suspended')
    throw new UserError(
      `${listName} is suspended, so nothing was changed. Ask again once it is resumed.`
    );
  if (!sync)
    throw new UserError(
      `/banlist status shows ${listName} as not imported yet, so nothing was changed.`
    );
  // A row whose state is self_import (see findExportBanList in ban-importer/src/ban-importer.js) is
  // not taken for the list's source when its sourceChange is 'unread' (see readStatus).
  if (sync.state === 'self_import' && sync.sourceChange !== 'unread')
    throw new UserError(
      `The ban importer does not read ${listName}, as its source is one of CBL's own export ban lists. Remove it with /banlist remove.`
    );
  if (sync.sourceChange)
    throw new UserError(
      `The type or source of ${listName} was changed, so the ban importer reads it in full anyway.`
    );
  // A remote list is left as it is while the importer's run lock is held (see lastFile and saveSync
  // in ban-importer/src/ban-importer.js).
  if (banList.type !== 'battlemetrics' && (await isRunLockHeld()))
    throw new UserError(
      `The ban importer is running, so nothing was changed: the cycle under way may still check the file of ${listName} as it did before, and keep it. Ask again once the cycle has finished.`
    );

  if (!(await markFullRead(banList)))
    throw new UserError(
      `${listName} was removed, or given a new type or source, meanwhile, so nothing was changed.`
    );
  audit(
    interaction,
    `asked for ${describeBanList(banList, organisation)} to be read in full on the ban importer's next cycle.`
  );
  const read =
    banList.type === 'battlemetrics'
      ? `The ban importer reads ${listName} in full on its next cycle, unless a cycle under way reads it in full first.`
      : `The ban importer downloads the file of ${listName} whole on its next cycle, even if the file has not changed.`;
  // The reply's sentence for a row whose state is access_lost (see importBanList in
  // ban-importer/src/ban-importer.js).
  const lost =
    sync.state === 'access_lost'
      ? ' If CBL still cannot read it on BattleMetrics by then, that read saves any new bans it finds, but removes none.'
      : '';
  // An admin's confirmation that still lasts (see confirmedUntil), as /banlist status gives it (see
  // describeImport), but not what the read it asks for removes (see fullRemovalAllowed in
  // ban-importer/src/ban-importer.js).
  const until = confirmedUntil(sync);
  const confirmed = until
    ? ` Removal confirmed by an admin until ${formatDateTime(until)}: until then, ${sync.state === 'access_lost' ? 'once CBL can read it again, ' : ''}complete reads of it can remove every ban they do not find, at once.`
    : '';
  await interaction.editReply(
    `${read}${lost}${confirmed} /banlist status shows when it was last read in full.`
  );
}

// What the ban importer holds back from removing a list, for /banlist confirm-removal, from what
// readListStatus gives: its hold of the list's bans for an admin (see holdOf), or a UserError that
// says why the command confirms nothing (see Confirming a removal in ban-importer/README.md): the
// list is suspended; it has no row; its row's state is self_import or access_lost; its type or
// source was changed (see readStatus); or it has no hold. A suspended list's refusal adds "and CBL
// can read it again" when its row's state is access_lost. A row whose sourceChange is 'unread' is
// not taken for CBL's access or an export ban list.
function holdToConfirm({ listName, paused, sync, removals, hold }) {
  if (pauseState(paused) === 'suspended')
    throw new UserError(
      `${listName} is suspended. Confirm the removal once it is resumed${sync?.state === 'access_lost' && sync.sourceChange !== 'unread' ? ' and CBL can read it again' : ''}, if it is still held.`
    );
  if (!sync)
    throw new UserError(`Cannot confirm: /banlist status shows ${listName} as not imported.`);
  if (sync.state === 'self_import' && sync.sourceChange !== 'unread')
    throw new UserError(
      `Nothing to confirm: the ban importer does not read ${listName}, as its source is one of CBL's own export ban lists, so it removes none of its bans. Remove it with /banlist remove, which removes its bans too.`
    );
  if (sync.sourceChange)
    throw new UserError(
      `Nothing to confirm: its type or source was changed, and the ban importer replaces the bans of its old source with those of the new one without holding them for an admin.`
    );
  if (sync.state === 'access_lost')
    throw new UserError(
      `/banlist status shows that CBL cannot read ${listName} on BattleMetrics. The ban importer removes none of its bans while CBL cannot read it, confirmed or not. Confirm the removal once CBL can read it, if it is still held.`
    );
  if (hold) return hold;
  // A list that is not held is refused by its records: by its waiting bans, if any, also when its
  // row's state is failing, and otherwise by its row's state. The refusals for waiting bans and for
  // a failing row point to the importer's line about the list (see holdOf). The one for waiting
  // bans says neither what a confirming read removes or moves, nor when it is (see planRemovals in
  // ban-importer/src/apply-list.js).
  const waiting = removals?.waiting ?? 0;
  if (waiting > 0)
    throw new UserError(
      `Nothing to confirm: the ban importer's records hold none of the bans of ${listName} for an admin. ${plural(waiting, 'ban')} ${waiting === 1 ? 'waits' : 'wait'} for a confirming read, which needs no admin's confirmation. If the importer's line about the list in the log channel says instead that it returned no bans, or none with a SteamID, so its stored bans were kept, which its records do not show, set IMPORTER_ALLOW_MASS_REMOVAL to the list's ID for one run.`
    );
  if (sync.state === 'failing')
    throw new UserError(
      `Nothing to confirm: the ban importer's records hold none of the bans of ${listName}. If its line about the list's last complete read says that it returned no bans, or none with a SteamID, so its stored bans were kept, confirm the removal once /banlist status shows them held.`
    );
  throw new UserError(
    `Nothing to confirm: the ban importer's records hold none of the bans of ${listName}.`
  );
}

// A time from a row, in milliseconds since 1970, or null for none, and a count, or null for none.
const timeOf = (value) =>
  value === null || value === undefined ? null : new Date(value).getTime();
const countOf = (value) => (value === null || value === undefined ? null : Number(value));

// Whether two holds of a list's bans (see holdOf), or none (null), are the same: the same kind, as
// many bans held since the same time, as many waiting, and the same recorded hold, or none.
function sameHold(a, b) {
  if (a === null || b === null) return a === b;
  return (
    a.kind === b.kind &&
    a.held === b.held &&
    a.waiting === b.waiting &&
    timeOf(a.since) === timeOf(b.since) &&
    sameHold(a.recorded ?? null, b.recorded ?? null)
  );
}

// Whether a list's BanListSyncs row, as read before the question and after it (a, b), has the same
// lastAttemptAt (see nextSync in ban-importer/src/ban-list-sync.js) and the same counts of its
// bans, stored and on BattleMetrics.
const sameRead = (a, b) =>
  timeOf(a.lastAttemptAt) === timeOf(b.lastAttemptAt) &&
  countOf(a.storedCount) === countOf(b.storedCount) &&
  countOf(a.headTotal) === countOf(b.headTotal);

// Confirm the removal of a list's held bans (see markRemovalConfirmed). The question gives the
// list, its hold, and what the next read can remove (see describeConfirmation), and only the admin
// who asked can answer it, within the time confirm gives. The hold and the list's row are read
// again once it is confirmed, and nothing is changed if the hold is not the one the question gave
// (see sameHold), or the row's lastAttemptAt or counts changed (see sameRead).
async function confirmRemoval(interaction) {
  const status = await readListStatus(interaction);
  const { banList, organisation, listName, sync } = status;
  const hold = holdToConfirm(status);

  const confirmed = await confirm(
    interaction,
    describeConfirmation(listName, hold, sync, CONFIRM_HOURS),
    'Confirm removal'
  );
  if (!confirmed) return;

  let after;
  let current;
  try {
    after = await readListStatus(interaction);
    current = holdToConfirm(after);
  } catch (err) {
    if (err instanceof UserError)
      throw new UserError(`Nothing was confirmed, as it changed meanwhile. ${err.message}`);
    throw err;
  }
  if (!sameHold(hold, current) || !sameRead(sync, after.sync))
    throw new UserError(
      `The ban importer tried to read ${listName}, or its hold of it changed, while you were asked, so nothing was confirmed. Run /banlist confirm-removal again to see it as it is now.`
    );

  const until = await markRemovalConfirmed(banList);
  if (!until)
    throw new UserError(
      `${listName} was removed, or given a new type or source, meanwhile, so nothing was confirmed.`
    );
  audit(
    interaction,
    `confirmed the removal of the bans the ban importer holds back from ${describeBanList(banList, organisation)} (${describeHoldForLog(hold, sync.storedCount)}): until ${until.toISOString()}, complete reads of it can remove every ban they do not find at once.`,
    { important: true }
  );
  await interaction.editReply(
    `Confirmed the removal for ${listName}. The ban importer reads it in full on its next cycle, or, if a cycle under way reads it in full first, at its next full read, and, if that is by ${formatDateTime(until)}, can remove any ban it still does not find. Until then, complete reads of it can remove every ban they do not find, at once.`
  );
}

const subcommands = {
  add,
  update,
  remove,
  suspend,
  resume,
  status,
  resync,
  'confirm-removal': confirmRemoval
};

export default {
  data,
  autocomplete: (interaction) =>
    interaction.options.getFocused(true).name === 'organisation'
      ? suggestOrganisations(interaction)
      : suggestBanLists(interaction),
  execute: (interaction) => subcommands[interaction.options.getSubcommand()](interaction)
};
