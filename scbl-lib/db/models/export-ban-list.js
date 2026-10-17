import Sequelize from 'sequelize';

import sequelize from '../sequelize.js';

import { battlemetrics } from '../../apis/index.js';
import {
  checkOwnership,
  findVisibleBanLists,
  removeInvitesAndSubscribers,
  removeOwner
} from '../../apis/delete-battlemetrics-ban-list.js';
import { checkRules, DEFAULT_SETTINGS } from '../../export-list-limits.js';
import { Logger } from '../../utils/index.js';
import { BATTLEMETRICS_ORGANIZATION, EXPORT_LIST_LIMITS } from '../../config.js';

const { DataTypes } = Sequelize;

// The settings that decide who is on a list, with its configs.
const SETTINGS = Object.keys(DEFAULT_SETTINGS);

// The export bans of the players on a list: those being added and those added. /export/:id serves
// these, and a BattleMetrics list holds them once the importer has added them.
const PLAYER_STATUSES = ['TO_BE_CREATED', 'CREATED'];

// How the messages name each type of list, as export-list-limits.js names them.
const TYPE_NAMES = { battlemetrics: 'BattleMetrics', remote: 'remote' };

// A whole number as the messages write it, with commas: 20,000.
const formatNumber = (value) => value.toLocaleString('en-US');

// The problems of a stored list under today's limits, or null when its type has none to check it
// against: those of its settings and configs under its type's points rules, for the whole list, as
// checkRules gives them, and one when it has more players than its type's cap (0 for none).
function limitProblems(exportBanList, configs, players, limits) {
  const { type } = exportBanList;
  if (!Object.hasOwn(TYPE_NAMES, type) || !limits?.[type]) return null;

  const settings = Object.fromEntries(SETTINGS.map((name) => [name, exportBanList[name]]));
  const problems = [...checkRules(type, { settings, configs }, limits)];
  const { maxPlayers } = limits[type];
  if (maxPlayers > 0 && players > maxPlayers)
    problems.push({
      rule: 'max-players',
      field: 'players',
      message: `It has ${formatNumber(players)} players, more than the ${formatNumber(maxPlayers)} a ${TYPE_NAMES[type]} export ban list can have.`
    });
  return problems;
}

// Record an export ban list's BattleMetrics ban list and invite, or null for none, and save them.
// A list that fails to save is left as it was, as the database still has it.
async function saveBattlemetricsBanList(exportBanList, battlemetricsID, battlemetricsInvite) {
  const previous = {
    battlemetricsID: exportBanList.battlemetricsID,
    battlemetricsInvite: exportBanList.battlemetricsInvite
  };
  exportBanList.battlemetricsID = battlemetricsID;
  exportBanList.battlemetricsInvite = battlemetricsInvite;
  try {
    await exportBanList.save();
  } catch (error) {
    exportBanList.battlemetricsID = previous.battlemetricsID;
    exportBanList.battlemetricsInvite = previous.battlemetricsInvite;
    throw error;
  }
}

class ExportBanList extends Sequelize.Model {
  // Check stored export ban lists against today's limits on export ban lists, those the website
  // checks changes to lists against (export-list-limits.js, with the EXPORT_* settings in
  // EXPORT_LIST_LIMITS), e.g. for the Discord bot to remove the lists outside them. Checks every
  // list, or those with the given IDs, and gives the limits and the lists, in ID order, each as
  // { exportBanList, configs, players, problems, checked }, with the list's owner as
  // exportBanList.SteamUser.
  //
  // A list is outside the limits when it has problems: those of its stored settings and configs
  // under its type's points rules, as checkRules gives them for the whole list, and one when it has
  // more players than its type's cap. Its configs are loaded as the website loads them to check a
  // change, with their ban lists' and organisations' names for the messages. players counts its
  // export bans being added or added, which /export/:id serves. A list of a type the limits do not
  // cover is not checked, and has no problems.
  static async checkLimits({ ids, limits = EXPORT_LIST_LIMITS } = {}) {
    if (ids !== undefined && ids.length === 0) return { limits, lists: [] };
    const { BanList, ExportBan, ExportBanListConfig, Organisation, SteamUser } = sequelize.models;

    const exportBanLists = await ExportBanList.findAll({
      ...(ids === undefined ? {} : { where: { id: ids } }),
      include: [{ model: SteamUser, attributes: ['id', 'name'] }],
      order: [['id', 'ASC']]
    });
    if (exportBanLists.length === 0) return { limits, lists: [] };
    const listIDs = exportBanLists.map((exportBanList) => exportBanList.id);

    const configs = new Map(listIDs.map((id) => [id, []]));
    const configRows = await ExportBanListConfig.findAll({
      where: { exportBanList: listIDs },
      include: [{ model: BanList, include: [Organisation] }],
      order: [['id', 'ASC']]
    });
    for (const config of configRows)
      configs.get(config.exportBanList)?.push({
        id: config.id,
        banList: config.banList,
        activePoints: config.activePoints,
        expiredPoints: config.expiredPoints,
        banListName: config.BanList?.name,
        organisationName: config.BanList?.Organisation?.name
      });

    const counts = await ExportBan.count({
      where: { exportBanList: listIDs, status: PLAYER_STATUSES },
      group: ['exportBanList']
    });
    const players = new Map(
      counts.map(({ exportBanList, count }) => [exportBanList, Number(count)])
    );

    return {
      limits,
      lists: exportBanLists.map((exportBanList) => {
        const listConfigs = configs.get(exportBanList.id);
        const listPlayers = players.get(exportBanList.id) ?? 0;
        const problems = limitProblems(exportBanList, listConfigs, listPlayers, limits);
        return {
          exportBanList,
          configs: listConfigs,
          players: listPlayers,
          problems: problems ?? [],
          checked: problems !== null
        };
      })
    };
  }

  // The IDs of every BattleMetrics ban list CBL's API key can see. Deleting a list takes a ban
  // list that BattleMetrics does not know to be gone, so anything that deletes many lists at once
  // can check first that the key sees CBL's ban lists. See findVisibleBanLists.
  static findVisibleBattlemetricsBanLists() {
    return findVisibleBanLists();
  }

  // Create the BattleMetrics ban list and its invite.
  async createBattlemetricsBanList() {
    // A list whose ban list was created but not its invite only needs the invite.
    if (this.battlemetricsID) return this.createBattlemetricsInvite();

    Logger.verbose('ExportBanList', 1, 'Creating Battlemetrics ban list...');
    // Not made again after a timeout or a 5xx, as BattleMetrics may have created the list, and a
    // second list would never be deleted.
    const {
      data: { data: dataBanList }
    } = await battlemetrics(
      'post',
      'ban-lists',
      {},
      {
        data: {
          type: 'banList',
          attributes: {
            name: `Community Ban List - ${this.name} (ID: ${this.id})`,
            action: 'none',
            defaultIdentifiers: ['steamID'],
            defaultReasons: ['Banned by the Community Ban List (communitybanlist.com)'],
            defaultAutoAddEnabled: true
          },
          relationships: {
            organization: {
              data: {
                type: 'organization',
                id: BATTLEMETRICS_ORGANIZATION
              }
            },
            owner: {
              data: {
                type: 'organization',
                id: BATTLEMETRICS_ORGANIZATION
              }
            }
          }
        }
      }
    );

    this.battlemetricsID = dataBanList.id;

    await this.save();

    await this.createBattlemetricsInvite();
  }

  // Create the invite other organisations accept to use the BattleMetrics ban list, unless the list
  // has one. Nothing else creates a missing invite, so this is also called when the list is saved.
  async createBattlemetricsInvite() {
    if (this.type !== 'battlemetrics' || !this.battlemetricsID || this.battlemetricsInvite) return;

    Logger.verbose('ExportBanList', 1, ' Creating Battlemetrics ban list invite...');
    // A second invite does no harm, as it is never shown and is deleted with the list, so the
    // request is made again after a timeout or a 5xx.
    const {
      data: { data: inviteData }
    } = await battlemetrics(
      'post',
      `ban-lists/${this.battlemetricsID}/relationships/invites`,
      {},
      {
        data: {
          type: 'banListInvite',
          attributes: {
            limit: null,
            permManage: false,
            permCreate: false,
            permUpdate: false,
            permDelete: false
          },
          relationships: {
            organization: {
              data: {
                type: 'organization',
                id: BATTLEMETRICS_ORGANIZATION
              }
            }
          }
        }
      },
      5,
      { repeatable: true }
    );

    this.battlemetricsInvite = `https://www.battlemetrics.com/rcon/ban-lists/accept-invite?code=${inviteData.id}`;

    await this.save();
  }

  // Delete the export ban list: its BattleMetrics ban list, for a BattleMetrics list that has one,
  // and then its row, which takes its export bans and configs with it. No one is told. The
  // website's Delete button uses this, and the Discord bot can delete any list the same way. It
  // gives what happened on BattleMetrics: 'deleted', 'gone' when BattleMetrics no longer had the
  // ban list, or 'none' when there was none to delete. When it fails, the list is kept, so it can
  // be deleted again, and the error's stage says what failed: 'battlemetrics' while deleting the
  // BattleMetrics ban list, or 'database deletion' while deleting the row.
  async deleteExportBanList() {
    let stage = 'battlemetrics';
    try {
      const outcome =
        this.type === 'battlemetrics' ? await this.deleteBattlemetricsBanList() : 'none';
      stage = 'database deletion';
      await this.destroy();
      return outcome;
    } catch (error) {
      error.stage = stage;
      throw error;
    }
  }

  // Delete the list's BattleMetrics ban list, and save the list without it. Gives 'deleted', 'gone'
  // or 'none', as deleteExportBanList does.
  async deleteBattlemetricsBanList() {
    const { battlemetricsID: id, battlemetricsInvite: invite } = this;
    if (!id) {
      Logger.verbose('ExportBanList', 1, 'No Battlemetrics ban list to delete.');
      return 'none';
    }

    Logger.verbose('ExportBanList', 1, 'Deleting Battlemetrics ban list...');
    if (!(await checkOwnership(id))) {
      // Without this, a list whose ban list is gone could never be deleted, e.g. one whose
      // deletion lost BattleMetrics' answer to its last step.
      Logger.verbose(
        'ExportBanList',
        1,
        `BattleMetrics does not know ban list ${id} of export ban list ${this.id} (HTTP 404, Unknown ban list), so it is taken to be deleted already.`
      );
      await saveBattlemetricsBanList(this, null, null);
      return 'gone';
    }

    await removeInvitesAndSubscribers(id);

    // The list is saved without its ban list before the last step, after which CBL can no longer
    // reach the ban list. So nothing that fails after that step leaves the list recording a ban
    // list it can never delete, and if this save fails, deleting the list again takes the step.
    await saveBattlemetricsBanList(this, null, null);
    try {
      await removeOwner(id);
    } catch (error) {
      // CBL's organisation may still own the ban list, so the list records it again, and deleting
      // the list again removes it.
      try {
        await saveBattlemetricsBanList(this, id, invite);
      } catch (saveError) {
        Logger.verbose(
          'ExportBanList',
          1,
          `Export ban list ${this.id} no longer records BattleMetrics ban list ${id}, which CBL's organisation may still own, as removing the organisation failed and the list could not be saved with it again. Remove the ban list on BattleMetrics by hand.`,
          saveError
        );
      }
      throw error;
    }
    return 'deleted';
  }
}

ExportBanList.init(
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    name: {
      type: DataTypes.STRING
    },
    server: {
      type: DataTypes.STRING
    },

    type: {
      type: DataTypes.ENUM('remote', 'battlemetrics'),
      defaultValue: 'remote'
    },

    threshold: {
      type: DataTypes.INTEGER,
      defaultValue: 9
    },
    defaultActivePoints: {
      type: DataTypes.INTEGER,
      defaultValue: 3
    },
    defaultExpiredPoints: {
      type: DataTypes.INTEGER,
      defaultValue: 1
    },
    maxBanAge: {
      type: DataTypes.INTEGER,
      defaultValue: 0
    },

    discordWebhook: {
      type: DataTypes.STRING
    },

    generated: {
      type: DataTypes.BOOLEAN,
      defaultValue: false
    },

    battlemetricsID: {
      type: DataTypes.STRING
    },
    battlemetricsInvite: {
      type: DataTypes.STRING
    }
  },
  { sequelize }
);

export default ExportBanList;
