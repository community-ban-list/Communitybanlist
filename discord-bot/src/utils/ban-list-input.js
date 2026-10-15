import { BanList, ExportBanList, Organisation } from 'scbl-lib/db/models';
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

// BattleMetrics ban list IDs are UUIDs, so compare them ignoring case, hyphens and spaces.
function isSameBattlemetricsID(a, b) {
  const normalise = (id) => id.replace(/[\s-]/g, '').toLowerCase();
  return normalise(a) !== '' && normalise(a) === normalise(b);
}

// CBL's own BattleMetrics export ban lists can be read like a partner's ban list, but importing one
// would feed the players CBL exports back in as new bans, which keeps them on the export ban lists.
async function checkNotExportBanList(source) {
  const exportBanLists = await ExportBanList.findAll({
    attributes: ['id', 'battlemetricsID'],
    where: { battlemetricsID: { [Op.ne]: null } }
  });
  const exportBanList = exportBanLists.find(({ battlemetricsID }) =>
    isSameBattlemetricsID(battlemetricsID, source)
  );
  if (!exportBanList) return;

  throw new UserError(
    `That source is one of CBL's own export ban lists (#${exportBanList.id}), not a partner's ban list. Importing it would feed the players CBL exports back in as new bans.`
  );
}

// Importing the same source twice would count each of its bans twice. These checks run even with
// skip_check, which only skips the test fetch.
export async function checkBanListSourceUnused(type, source, banList = null) {
  if (type === 'battlemetrics') await checkNotExportBanList(source);

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
