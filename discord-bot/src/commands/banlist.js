import { SlashCommandBuilder } from 'discord.js';

import { isRunLockHeld, sequelize } from 'scbl-lib/db';
import { BanList } from 'scbl-lib/db/models';
import { Op } from 'scbl-lib/db/sequelize';

import {
  applyChanges,
  audit,
  banListEmbed,
  banListOption,
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
  formatBanListName,
  formatBanListType,
  organisationOption,
  parseBanListSource,
  skipCheckOption,
  suggestBanLists,
  suggestOrganisations,
  summariseBanListBans,
  summariseBanListDeletion,
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
  );

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
  // source's bans are imported on the next ban importer run. Left to the importer, most of them
  // would be kept, as it holds back removing many of a list's bans at once.
  let deletion = null;
  if (check !== undefined) {
    const bans = await summariseBanListBans([banList.id]);
    if (bans.bans > 0) {
      deletion = describeBanListDeletion(bans);
      const confirmed = await confirm(
        interaction,
        `Change the source of ${currentName}? This deletes its ${deletion}, and the new source's bans are imported on the next ban importer run.`,
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

  await sequelize.transaction(async (transaction) => {
    if (deletion) await deleteBansOfBanLists([banList.id], transaction);
    await banList.save({ transaction });
  });
  const deleted = deletion ? `, deleting ${deletion}` : '';
  audit(interaction, `updated ${description}: ${changes.join(', ')}${deleted}.`);

  const listName = formatBanListName(banList, organisation);
  await interaction.editReply({
    content: check
      ? `Updated ${listName}. ${check} Its bans are re-imported on the next ban importer run.`
      : `Updated ${listName}.`,
    embeds: [banListEmbed(banList, organisation)]
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

  await deleteBanLists([banList.id]);
  audit(interaction, `removed ${describeBanList(banList, organisation)}, deleting ${deletion}.`);

  await interaction.editReply(
    `Removed ${listName}. Affected players' reputation is recalculated on the next ban importer run.`
  );
}

const subcommands = { add, update, remove };

export default {
  data,
  autocomplete: (interaction) =>
    interaction.options.getFocused(true).name === 'organisation'
      ? suggestOrganisations(interaction)
      : suggestBanLists(interaction),
  execute: (interaction) => subcommands[interaction.options.getSubcommand()](interaction)
};
