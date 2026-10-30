import Sequelize from 'sequelize';

import { battlemetrics } from '../../apis/index.js';
import readBattlemetricsPages from '../../apis/read-battlemetrics-pages.js';
import { BATTLEMETRICS_ORGANIZATION } from '../../config.js';
import { Logger } from '../../utils/index.js';

import sequelize from '../sequelize.js';

const { DataTypes, Op } = Sequelize;

// While an export ban's BattleMetrics ban is being made, its battlemetricsID is 'pending'. That
// claims the export ban, so no other run makes a ban for it too, although another run that finds
// the ban by its note may record it first. When the request fails but BattleMetrics may have made
// the ban anyway, the claim is kept, so the ban is looked for before another is made.
// BattleMetrics' own IDs are numbers.
const PENDING = 'pending';

// A claim this recent may belong to a request BattleMetrics is still carrying out, so a claimed
// export ban whose ban cannot be found is only made again once its claim is older than this.
const CLAIM_AGE = 10 * 60 * 1000;

// With IMPORTER_BM_SEARCH_LOOKUP=1, a claimed export ban's ban is looked for by searching its
// BattleMetrics ban list for the player, one request, rather than by reading the whole list once a
// run. Whether BattleMetrics' search finds them has not been checked yet, so it is off by default.
const SEARCH_LOOKUP = process.env.IMPORTER_BM_SEARCH_LOOKUP === '1';

// A ban list's bans are looked for whether they have expired or not. CBL makes its bans with no
// expiry, but one that was given an expiry on BattleMetrics that has passed is still the export
// ban's. BattleMetrics' API documentation says that GET /bans hides expired bans unless
// filter[expired] is true, although without the filter it gives them too, so the filter is sent.
const EXPIRED_BANS = { 'filter[expired]': 'true' };

// The note on the BattleMetrics ban made for an export ban, by which the ban is found again.
function battlemetricsNote(exportBan) {
  return `CBL export ${exportBan.id}`;
}

// The IDs of the bans with each note.
function bansByNote(bans) {
  const notes = new Map();
  for (const ban of bans) {
    const note = ban && ban.attributes && ban.attributes.note;
    if (typeof note !== 'string' || !ban.id) continue;
    notes.set(note.trim(), [...(notes.get(note.trim()) || []), String(ban.id)]);
  }
  return notes;
}

// Find the bans with an export ban's note on its BattleMetrics ban list. Resolves with their IDs and
// when the list's bans were read. Unless IMPORTER_BM_SEARCH_LOOKUP is 1, a list's bans are read the
// first time one of its export bans is looked for, and kept in bansByList for the rest of the run.
// A list whose bans could not be read is not read again in the run either: the lookup that read it
// fails, and the others resolve with null, so their export bans wait for a later run rather than
// each counting as another failure of the list.
async function findBattlemetricsBans(exportBan, battlemetricsBanList, bansByList) {
  let found;
  if (SEARCH_LOOKUP) {
    const readAt = Date.now();
    const bans = await readBattlemetricsPages('bans', {
      'filter[banList]': battlemetricsBanList,
      ...EXPIRED_BANS,
      'filter[search]': exportBan.steamUser
    });
    found = { readAt, notes: bansByNote(bans) };
  } else if (!bansByList.has(battlemetricsBanList)) {
    const readAt = Date.now();
    const read = readBattlemetricsPages('bans', {
      'filter[banList]': battlemetricsBanList,
      ...EXPIRED_BANS
    }).then((bans) => ({ readAt, notes: bansByNote(bans) }));
    const kept = read.catch(() => null);
    bansByList.set(battlemetricsBanList, kept);
    found = await read;
  } else {
    found = await bansByList.get(battlemetricsBanList);
    if (!found) return null;
  }
  return { readAt: found.readAt, ids: found.notes.get(battlemetricsNote(exportBan)) || [] };
}

// Whether an export ban's claim was older than CLAIM_AGE when its list's bans were read, so a ban
// made under it would have been among them.
function claimWasOld(exportBan, readAt) {
  return new Date(exportBan.updatedAt).getTime() <= readAt - CLAIM_AGE;
}

class ExportBan extends Sequelize.Model {
  // Make the export ban's BattleMetrics ban and mark the export ban as created, unless a ban was
  // made for it already, which is then only recorded. bansByList keeps each BattleMetrics ban
  // list's bans for the rest of the run once they have been read to look for a ban.
  //
  // Resolves with 'created' when it made the ban, 'found' when it recorded one made before, and
  // 'waiting' or 'skipped' when it left the export ban for a later run, or found that another run
  // or a change had dealt with it. A failed request throws, after keeping the claim when
  // BattleMetrics may have made the ban, or releasing it when BattleMetrics did not.
  async createBattlemetricsBan(bansByList = new Map()) {
    const exportBanList = this.ExportBanList || (await this.getExportBanList());

    // There is nowhere to add the ban while the list has no BattleMetrics ban list, e.g. while it
    // is being deleted.
    if (!exportBanList.battlemetricsID) return 'skipped';

    // A ban made by an earlier run that could not mark the export ban as created.
    if (this.battlemetricsID && this.battlemetricsID !== PENDING) {
      Logger.verbose('ExportBan', 2, 'Marking an earlier Battlemetrics ban as created...');
      const [marked] = await ExportBan.update(
        { status: 'CREATED' },
        { where: { id: this.id, status: 'TO_BE_CREATED', battlemetricsID: this.battlemetricsID } }
      );
      return marked === 1 ? 'found' : 'skipped';
    }

    if (this.battlemetricsID === PENDING) {
      // An earlier attempt may have made the ban, so it is looked for before another is made.
      const lookup = await findBattlemetricsBans(this, exportBanList.battlemetricsID, bansByList);
      if (!lookup) return 'waiting';
      const { readAt, ids } = lookup;
      if (ids.length > 0) {
        const [adopted] = await ExportBan.update(
          { battlemetricsID: ids[0], status: 'CREATED' },
          { where: { id: this.id, status: 'TO_BE_CREATED', battlemetricsID: PENDING } }
        );
        if (adopted !== 1) return 'skipped';
        Logger.verbose(
          'ExportBan',
          1,
          `Recorded the Battlemetrics ban (ID: ${ids[0]}) of export ban (ID: ${this.id}), made by an earlier attempt that failed.`
        );
        if (ids.length > 1)
          Logger.verbose(
            'ExportBan',
            1,
            `Export ban (ID: ${this.id}) has more Battlemetrics bans, which nothing records: ${ids.slice(1).join(', ')}.`
          );
        return 'found';
      }

      // A ban could still be being made for a recent claim.
      if (!claimWasOld(this, readAt)) {
        Logger.verbose(
          'ExportBan',
          2,
          `Export ban (ID: ${this.id}) waits for its Battlemetrics ban, which may still be being made.`
        );
        return 'waiting';
      }

      // No ban was made, so the export ban is claimed again, for this attempt, and its ban made.
      const [reclaimed] = await ExportBan.update(
        { battlemetricsID: PENDING },
        {
          where: {
            id: this.id,
            status: 'TO_BE_CREATED',
            battlemetricsID: PENDING,
            updatedAt: { [Op.lte]: new Date(readAt - CLAIM_AGE) }
          }
        }
      );
      if (reclaimed !== 1) return 'skipped';
    } else {
      // Claim the export ban before its ban is made, so that it is never made twice.
      const [claimed] = await ExportBan.update(
        { battlemetricsID: PENDING },
        { where: { id: this.id, status: 'TO_BE_CREATED', battlemetricsID: null } }
      );
      if (claimed !== 1) return 'skipped';
    }

    Logger.verbose('ExportBan', 2, 'Creating Battlemetrics ban...');
    let banData;
    try {
      ({
        data: { data: banData }
      } = await battlemetrics(
        'post',
        'bans',
        {},
        {
          data: {
            type: 'ban',
            attributes: {
              autoAddEnabled: true,
              expires: null,
              identifiers: [
                {
                  type: 'steamID',
                  identifier: this.steamUser,
                  manual: true
                }
              ],
              nativeEnabled: null,
              note: battlemetricsNote(this),
              reason: `Kicked via communitybanlist.com/banned`
            },
            relationships: {
              organization: {
                data: {
                  type: 'organization',
                  id: BATTLEMETRICS_ORGANIZATION
                }
              },
              banList: {
                data: {
                  type: 'banList',
                  id: exportBanList.battlemetricsID
                }
              }
            }
          }
        }
      ));
      // An answer without the ban's ID fails like one BattleMetrics may have carried out, as it
      // most likely made the ban, so the claim is kept.
      if (!banData || !banData.id) throw new Error('Invalid BattleMetrics ban response.');
    } catch (err) {
      // BattleMetrics did not make the ban, so the claim is released for a later attempt. When it
      // may have, the claim is kept, and the ban is looked for before another is made.
      if (err.ambiguous === false) await this.releaseClaim();
      throw err;
    }

    // Record the ban and mark the export ban as created in one write, while the claim holds.
    const [recorded] = await ExportBan.update(
      { battlemetricsID: banData.id, status: 'CREATED' },
      { where: { id: this.id, battlemetricsID: PENDING } }
    );
    if (recorded === 1) return 'created';

    // The claim no longer holds. Another run may have found this ban by its note while it was being
    // made, and recorded it, and it is then kept.
    const current = await ExportBan.findByPk(this.id, { attributes: ['battlemetricsID'] });
    if (current && current.battlemetricsID === String(banData.id)) {
      Logger.verbose(
        'ExportBan',
        2,
        `Another run recorded the Battlemetrics ban (ID: ${banData.id}) of export ban (ID: ${this.id}) while it was being made.`
      );
      return 'skipped';
    }

    // Otherwise the export ban was deleted while its ban was being made, e.g. along with its list,
    // or another run recorded another ban for it, so nothing would ever delete this one.
    try {
      await battlemetrics('delete', `bans/${banData.id}`);
    } catch (err) {
      Logger.verbose(
        'ExportBan',
        1,
        `Failed to delete the Battlemetrics ban (ID: ${banData.id}) made for export ban (ID: ${this.id}), which nothing records: `,
        err
      );
    }
    return 'skipped';
  }

  // Release the claim on an export ban whose ban BattleMetrics did not make, so a later attempt can
  // make it.
  async releaseClaim() {
    try {
      await ExportBan.update(
        { battlemetricsID: null },
        { where: { id: this.id, battlemetricsID: PENDING } }
      );
    } catch (err) {
      // Still claimed, the export ban's ban is looked for, and then made, by a later run.
      Logger.verbose(
        'ExportBan',
        1,
        `Failed to release the claim on export ban (ID: ${this.id}): `,
        err
      );
    }
  }

  // Delete the export ban's BattleMetrics ban, if it has one, and then the export ban. A claimed
  // export ban may or may not have a ban, so it is looked for first.
  //
  // Resolves with 'deleted', or 'gone' when BattleMetrics had deleted the ban already, once the
  // export ban is deleted, and with 'cleared' when BattleMetrics had no ban for it, so only the
  // export ban was deleted. Resolves with 'waiting' or 'skipped' when it left the export ban for a
  // later run, or found it already deleted. A failed request throws, and leaves the export ban for
  // a later run to delete.
  async deleteBattlemetricsBan(bansByList = new Map()) {
    let banIDs = this.battlemetricsID ? [this.battlemetricsID] : [];

    if (this.battlemetricsID === PENDING) {
      const exportBanList = this.ExportBanList || (await this.getExportBanList());
      if (!exportBanList.battlemetricsID) return 'waiting';

      const lookup = await findBattlemetricsBans(this, exportBanList.battlemetricsID, bansByList);
      if (!lookup) return 'waiting';
      // A ban could still be being made for a recent claim.
      if (lookup.ids.length === 0 && !claimWasOld(this, lookup.readAt)) return 'waiting';
      banIDs = lookup.ids;
    }

    let gone = false;
    for (const banID of banIDs) {
      Logger.verbose('ExportBan', 2, 'Deleting Battlemetrics ban...');
      try {
        await battlemetrics('delete', `bans/${banID}`);
      } catch (err) {
        // A ban that is already gone is what the deletion wants.
        if (!err.response || err.response.status !== 404) throw err;
        gone = true;
      }
    }

    const deleted = await ExportBan.destroy({ where: { id: this.id, status: 'TO_BE_DELETED' } });
    if (deleted !== 1) return 'skipped';
    if (banIDs.length === 0) return 'cleared';
    return gone ? 'gone' : 'deleted';
  }
}

ExportBan.init(
  {
    id: {
      type: DataTypes.STRING,
      primaryKey: true
    },
    status: {
      type: DataTypes.ENUM('TO_BE_CREATED', 'CREATED', 'TO_BE_DELETED'),
      notNull: true,
      defaultValue: 'TO_BE_CREATED'
    },

    battlemetricsID: {
      type: DataTypes.STRING
    }
  },
  { sequelize }
);

export default ExportBan;
