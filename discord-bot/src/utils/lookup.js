import { Ban, BanList, Organisation } from 'scbl-lib/db/models';
import { Op } from 'scbl-lib/db/sequelize';

import { truncate } from './format.js';
import UserError from './user-error.js';

// Discord shows at most 25 autocomplete suggestions.
const MAX_SUGGESTIONS = 25;

// Match names containing the text, treating any LIKE wildcards in it literally.
function nameContains(text) {
  return { [Op.like]: `%${text.replace(/[\\%_]/g, '\\$&')}%` };
}

export function organisationOption(option, description) {
  return option
    .setName('organisation')
    .setDescription(description)
    .setRequired(true)
    .setAutocomplete(true);
}

export function banListOption(option, description) {
  return option
    .setName('banlist')
    .setDescription(description)
    .setRequired(true)
    .setAutocomplete(true);
}

export async function suggestOrganisations(interaction) {
  const text = interaction.options.getFocused().trim();
  const organisations = await Organisation.findAll({
    where: text ? { name: nameContains(text) } : {},
    order: [['name', 'ASC']],
    limit: MAX_SUGGESTIONS
  });

  await interaction.respond(
    organisations.map((organisation) => ({
      name: truncate(organisation.name, 100),
      value: String(organisation.id)
    }))
  );
}

export async function suggestBanLists(interaction) {
  const text = interaction.options.getFocused().trim();
  const banLists = await BanList.findAll({
    include: [{ model: Organisation, required: true }],
    where: text
      ? { [Op.or]: [{ name: nameContains(text) }, { '$Organisation.name$': nameContains(text) }] }
      : {},
    order: [
      [Organisation, 'name', 'ASC'],
      ['name', 'ASC']
    ],
    limit: MAX_SUGGESTIONS
  });

  await interaction.respond(
    banLists.map((banList) => ({
      name: truncate(`${banList.Organisation.name} / ${banList.name}`, 100),
      value: String(banList.id)
    }))
  );
}

// Find an organisation by the ID picked from the suggestions, or by its exact name.
export async function findOrganisation(value) {
  let organisation = null;
  if (/^\d+$/.test(value)) organisation = await Organisation.findByPk(value);
  if (!organisation) organisation = await Organisation.findOne({ where: { name: value.trim() } });

  if (!organisation) throw new UserError(`Could not find an organisation called "${value}".`);
  return organisation;
}

// Find a ban list, along with its organisation, by the ID picked from the suggestions.
export async function findBanList(value) {
  const banList = /^\d+$/.test(value)
    ? await BanList.findByPk(value, { include: [{ model: Organisation, required: true }] })
    : null;

  if (!banList) throw new UserError('Could not find that ban list. Pick one from the suggestions.');
  return banList;
}

// Count the bans on each of the ban lists, keyed by ban list ID.
export async function countBans(banLists) {
  const counts = await Ban.count({
    where: { banList: banLists.map((banList) => banList.id) },
    group: ['banList']
  });
  return Object.fromEntries(counts.map(({ banList, count }) => [banList, count]));
}
