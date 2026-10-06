import { BanList, Organisation } from 'scbl-lib/db/models';
import { Op } from 'scbl-lib/db/sequelize';

import { checkBanListSource } from './ban-list-source.js';
import { formatBanListName } from './format.js';
import UserError from './user-error.js';

export function banListTypeOption(option) {
  return option
    .setName('type')
    .setDescription('Where the bans are fetched from.')
    .addChoices(
      { name: 'Remote (link to a ban list file)', value: 'remote' },
      { name: 'BattleMetrics', value: 'battlemetrics' }
    );
}

export function banListSourceOption(option) {
  return option
    .setName('source')
    .setDescription('Remote: link to the ban list file. BattleMetrics: ID of the ban list.');
}

export function skipCheckOption(option) {
  return option
    .setName('skip_check')
    .setDescription('Save without test fetching the ban list first.');
}

// Importing the same source twice would count each of its bans twice.
export async function checkBanListSourceUnused(type, source, banList = null) {
  const where = { type, source };
  if (banList) where.id = { [Op.ne]: banList.id };

  const existing = await BanList.findOne({ where, include: [Organisation] });
  if (!existing) return;

  const usedBy = formatBanListName(existing, existing.Organisation);
  throw new UserError(`That source is already used by ${usedBy} (#${existing.id}).`);
}

// Test fetch the source unless the skip_check option is set, and describe the result.
export async function checkBanListSourceOption(interaction, type, source) {
  if (interaction.options.getBoolean('skip_check')) return 'Skipped checking the source.';
  return checkBanListSource(type, source);
}
