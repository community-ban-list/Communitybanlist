import { SlashCommandBuilder } from 'discord.js';

import { sequelize } from 'scbl-lib/db';
import { BanList, Organisation } from 'scbl-lib/db/models';
import { Op } from 'scbl-lib/db/sequelize';

import {
  applyChanges,
  audit,
  banListSourceOption,
  banListTypeOption,
  bold,
  checkBanListSourceOption,
  checkBanListSourceUnused,
  confirm,
  countBans,
  deleteBanLists,
  describeBanListDeletion,
  describeOrganisation,
  findOrganisation,
  formatBanListType,
  organisationEmbed,
  organisationOption,
  paginate,
  parseBanListSource,
  plural,
  skipCheckOption,
  suggestOrganisations,
  summariseBanListDeletion,
  UserError
} from '../utils/index.js';

const data = new SlashCommandBuilder()
  .setName('org')
  .setDescription('Manage partner organisations.')
  // Only administrators see the command unless other roles are allowed in the server's settings.
  .setDefaultMemberPermissions(0)
  .addSubcommand((subcommand) =>
    subcommand
      .setName('add')
      .setDescription('Add a partner organisation along with its first ban list.')
      .addStringOption((option) =>
        option
          .setName('name')
          .setDescription('Name of the organisation.')
          .setRequired(true)
          .setMaxLength(100)
      )
      .addStringOption((option) =>
        option
          .setName('banlist_name')
          .setDescription('Name of its ban list, e.g. "Main".')
          .setRequired(true)
          .setMaxLength(100)
      )
      .addStringOption((option) => banListTypeOption(option).setRequired(true))
      .addStringOption((option) => banListSourceOption(option).setRequired(true))
      .addStringOption((option) =>
        option.setName('discord').setDescription("Invite link to the organisation's Discord.")
      )
      .addBooleanOption(skipCheckOption)
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('update')
      .setDescription("Change a partner organisation's name or Discord link.")
      .addStringOption((option) => organisationOption(option, 'Organisation to update.'))
      .addStringOption((option) =>
        option.setName('name').setDescription('New name for the organisation.').setMaxLength(100)
      )
      .addStringOption((option) =>
        option
          .setName('discord')
          .setDescription('New invite link to the organisation\'s Discord, or "none" to remove it.')
      )
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('remove')
      .setDescription('Remove a partner organisation along with its ban lists and bans.')
      .addStringOption((option) => organisationOption(option, 'Organisation to remove.'))
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('info')
      .setDescription('Show a partner organisation and its ban lists.')
      .addStringOption((option) => organisationOption(option, 'Organisation to show.'))
  )
  .addSubcommand((subcommand) =>
    subcommand.setName('list').setDescription('List the partner organisations.')
  );

// Parse the Discord link option: undefined if it was not given, or null to remove the link.
function parseDiscordLink(value) {
  if (value === null) return undefined;

  const link = value.trim();
  if (link.toLowerCase() === 'none') return null;

  const url = /^https?:\/\//i.test(link) ? link : `https://${link}`;
  if (!URL.canParse(url) || !new URL(url).hostname.includes('.'))
    throw new UserError(`"${link}" is not a valid link.`);
  return url;
}

async function checkName(name, organisation = null) {
  if (!name) throw new UserError('The name cannot be blank.');

  const where = { name };
  if (organisation) where.id = { [Op.ne]: organisation.id };
  if (await Organisation.findOne({ where }))
    throw new UserError(`There is already an organisation called "${name}".`);
}

async function getBanLists(organisation) {
  return BanList.findAll({ where: { organisation: organisation.id }, order: [['name', 'ASC']] });
}

async function organisationDetails(organisation) {
  const banLists = await getBanLists(organisation);
  return organisationEmbed(organisation, banLists, await countBans(banLists));
}

async function add(interaction) {
  const name = interaction.options.getString('name', true).trim();
  const discord = parseDiscordLink(interaction.options.getString('discord'));
  const banListName = interaction.options.getString('banlist_name', true).trim();
  const type = interaction.options.getString('type', true);
  const source = parseBanListSource(type, interaction.options.getString('source', true));

  await checkName(name);
  if (!banListName) throw new UserError('The ban list name cannot be blank.');
  await checkBanListSourceUnused(type, source);
  const check = await checkBanListSourceOption(interaction, type, source);

  // Create both or neither, so an organisation is never added without its ban list.
  const { organisation, banList } = await sequelize.transaction(async (transaction) => {
    const newOrganisation = await Organisation.create(
      { name, discord: discord || null },
      { transaction }
    );
    const newBanList = await BanList.create(
      { name: banListName, type, source, organisation: newOrganisation.id },
      { transaction }
    );
    return { organisation: newOrganisation, banList: newBanList };
  });

  const description = describeOrganisation(organisation);
  const banListDescription = `ban list "${banList.name}" (ID: ${banList.id})`;
  const sourceDescription = `${formatBanListType(type)} source "${source}"`;
  audit(interaction, `added ${description} with ${banListDescription} and ${sourceDescription}.`);

  const added = `Added ${bold(organisation.name)} with its ban list ${bold(banList.name)}.`;
  await interaction.editReply({
    content: `${added} ${check} Its bans are imported on the next ban importer run.`,
    embeds: [await organisationDetails(organisation)]
  });
}

async function update(interaction) {
  const organisation = await findOrganisation(interaction.options.getString('organisation', true));
  const name = interaction.options.getString('name')?.trim();
  const discord = parseDiscordLink(interaction.options.getString('discord'));
  if (name !== undefined) await checkName(name, organisation);

  const description = describeOrganisation(organisation);
  const changes = applyChanges(organisation, { name, discord });
  if (changes.length === 0)
    throw new UserError('Nothing to change. Give a new name or Discord link.');

  await organisation.save();
  audit(interaction, `updated ${description}: ${changes.join(', ')}.`);

  await interaction.editReply({
    content: `Updated ${bold(organisation.name)}.`,
    embeds: [await organisationDetails(organisation)]
  });
}

async function remove(interaction) {
  const organisation = await findOrganisation(interaction.options.getString('organisation', true));
  const banLists = await getBanLists(organisation);
  const banListIDs = banLists.map((banList) => banList.id);
  const name = bold(organisation.name);
  const description = describeOrganisation(organisation);

  let prompt = `Remove ${name}? It has no ban lists.`;
  let change = `removed ${description}.`;
  let reply = `Removed ${name}.`;
  if (banLists.length > 0) {
    const banListCount = plural(banLists.length, 'ban list');
    const banListNames = banLists.map((banList) => bold(banList.name)).join(', ');
    const deletion = describeBanListDeletion(await summariseBanListDeletion(banListIDs));

    prompt = `Remove ${name} and its ${banListCount} (${banListNames})? This permanently deletes ${deletion}.`;
    change = `removed ${description} and its ${banListCount}, deleting ${deletion}.`;
    reply += " Affected players' reputation is recalculated on the next ban importer run.";
  }

  if (!(await confirm(interaction, prompt, 'Remove organisation'))) return;

  await deleteBanLists(banListIDs, organisation);
  audit(interaction, change);
  await interaction.editReply(reply);
}

async function info(interaction) {
  const organisation = await findOrganisation(interaction.options.getString('organisation', true));
  await interaction.editReply({ embeds: [await organisationDetails(organisation)] });
}

async function list(interaction) {
  const organisations = await Organisation.findAll({ order: [['name', 'ASC']] });
  const banListCounts = Object.fromEntries(
    (await BanList.count({ group: ['organisation'] })).map(({ organisation, count }) => [
      organisation,
      count
    ])
  );

  await paginate(
    interaction,
    `Partner Organisations (${organisations.length})`,
    organisations.map((organisation) => {
      const banListCount = plural(banListCounts[organisation.id] || 0, 'ban list');
      return `${bold(organisation.name)} (#${organisation.id}) · ${banListCount}`;
    })
  );
}

const subcommands = { add, update, remove, info, list };

export default {
  data,
  autocomplete: suggestOrganisations,
  execute: (interaction) => subcommands[interaction.options.getSubcommand()](interaction)
};
