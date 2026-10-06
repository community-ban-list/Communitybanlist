import { SlashCommandBuilder } from 'discord.js';

import { BanList, Organisation } from 'scbl-lib/db/models';
import { Op } from 'scbl-lib/db/sequelize';

import {
  applyChanges,
  audit,
  banListEmbed,
  banListOption,
  bold,
  checkBanListSource,
  confirm,
  deleteBanLists,
  describeBanListDeletion,
  findBanList,
  findOrganisation,
  formatBanListType,
  organisationOption,
  parseBanListSource,
  suggestBanLists,
  suggestOrganisations,
  summariseBanListDeletion,
  UserError
} from '../utils/index.js';

function typeOption(option) {
  return option
    .setName('type')
    .setDescription('Where the bans are fetched from.')
    .addChoices(
      { name: 'Remote (link to a ban list file)', value: 'remote' },
      { name: 'BattleMetrics', value: 'battlemetrics' }
    );
}

function sourceOption(option) {
  return option
    .setName('source')
    .setDescription('Remote: link to the ban list file. BattleMetrics: ID of the ban list.');
}

function skipCheckOption(option) {
  return option
    .setName('skip_check')
    .setDescription('Save without test fetching the ban list first.');
}

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
      .addStringOption((option) => typeOption(option).setRequired(true))
      .addStringOption((option) => sourceOption(option).setRequired(true))
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
      .addStringOption(typeOption)
      .addStringOption(sourceOption)
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

// Importing the same source twice would count each of its bans twice.
async function checkSourceUnused(type, source, banList = null) {
  const where = { type, source };
  if (banList) where.id = { [Op.ne]: banList.id };

  const existing = await BanList.findOne({ where, include: [Organisation] });
  if (!existing) return;

  const usedBy = formatBanListName(existing, existing.Organisation);
  throw new UserError(`That source is already used by ${usedBy} (#${existing.id}).`);
}

async function checkSource(interaction, type, source) {
  if (interaction.options.getBoolean('skip_check')) return 'Skipped checking the source.';
  return checkBanListSource(type, source);
}

function formatBanListName(banList, organisation) {
  return `${bold(organisation.name)} / ${bold(banList.name)}`;
}

// Describe the ban list for the audit log.
function describeBanList(banList, organisation) {
  const owner = `organisation "${organisation.name}" (ID: ${organisation.id})`;
  return `ban list "${banList.name}" (ID: ${banList.id}) of ${owner}`;
}

async function add(interaction) {
  const organisation = await findOrganisation(interaction.options.getString('organisation', true));
  const name = interaction.options.getString('name', true).trim();
  const type = interaction.options.getString('type', true);
  const source = parseBanListSource(type, interaction.options.getString('source', true));

  await checkName(name, organisation);
  await checkSourceUnused(type, source);
  const check = await checkSource(interaction, type, source);

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
      await checkSourceUnused(type, source, banList);
      check = await checkSource(interaction, type, source);
    }
  }

  const description = describeBanList(banList, organisation);
  const changes = applyChanges(banList, { name, type, source });
  if (changes.length === 0)
    throw new UserError('Nothing to change. Give a new name, type or source.');

  await banList.save();
  audit(interaction, `updated ${description}: ${changes.join(', ')}.`);

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
