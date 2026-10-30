import Sequelize from 'sequelize';

import sequelize from '../sequelize.js';
import { countMembers } from '../export-membership.js';

import { battlemetrics } from '../../apis/index.js';
import {
  checkOwnership,
  findVisibleBanLists,
  removeInvitesAndSubscribers,
  removeOwner
} from '../../apis/delete-battlemetrics-ban-list.js';
import { checkRules, DEFAULT_SETTINGS } from '../../export-list-limits.js';
import { Logger } from '../../utils/index.js';
import logText from '../../utils/log-text.js';
import { BATTLEMETRICS_ORGANIZATION, EXPORT_LIST_LIMITS } from '../../config.js';

const { DataTypes } = Sequelize;

// The settings that decide who is on a list, with its configs.
const SETTINGS = Object.keys(DEFAULT_SETTINGS);

// The columns of a config that decide who is on its list.
const CONFIG_SETTINGS = ['banList', 'activePoints', 'expiredPoints'];

// The export bans of the players on a list: those waiting to be added and those already added.
// /export/:id serves these, and a BattleMetrics list holds them once the importer has added them.
const PLAYER_STATUSES = ['TO_BE_CREATED', 'CREATED'];

// How the messages name each type of list, as export-list-limits.js names them.
const TYPE_NAMES = { battlemetrics: 'BattleMetrics', remote: 'remote' };

// A whole number as the messages write it, with commas: 20,000.
const formatNumber = (value) => value.toLocaleString('en-US');

// The list a line in the log channel is about, as the importer names lists (ban-importer's
// core.js), with its type and owner: the owner's Steam ID, and their Steam name when the list was
// loaded with its SteamUser, as checkLimits loads it. Nothing is looked up for a line, so a line can
// never fail or hold up a change. The names are their owners' to choose, so they are kept on one
// line and shown as written (logText). The channel is for CBL's admins only, but a line never
// gives the list's Discord webhook or BattleMetrics invite, as anyone with either can use it.
function describeList(exportBanList) {
  const { id, name, server, type, owner } = exportBanList;
  const ownerName = exportBanList.SteamUser?.name;
  const steamUser = ownerName
    ? `Steam user "${logText(ownerName)}" (ID: ${owner})`
    : `Steam user ${owner}`;
  return `${logText(server)}'s List "${logText(name)}" (ID: ${id}, ${TYPE_NAMES[type] ?? type}) of ${steamUser}`;
}

// A stored list's settings, as the rules and countMembers take them.
const settingsOf = (exportBanList) =>
  Object.fromEntries(SETTINGS.map((name) => [name, exportBanList[name]]));

// The most players a list of this type can have under the limits, or 0 for no limit, as for a type
// the limits do not cover.
const maxPlayersOf = (type, limits) =>
  (Object.hasOwn(TYPE_NAMES, type) && limits?.[type]?.maxPlayers) || 0;

// The problems of a stored list under today's limits, or null when its type has none to check it
// against: those of its settings and configs under its type's points rules, for the whole list, as
// checkRules gives them, and one when it has more players than its type's cap (0 for none), both by
// its export bans (players) and by its settings now (recount, see checkLimits).
function limitProblems(exportBanList, configs, { players, recount }, limits) {
  const { type } = exportBanList;
  if (!Object.hasOwn(TYPE_NAMES, type) || !limits?.[type]) return null;

  const problems = [...checkRules(type, { settings: settingsOf(exportBanList), configs }, limits)];
  const maxPlayers = maxPlayersOf(type, limits);
  if (maxPlayers > 0 && players > maxPlayers && recount > maxPlayers) {
    const counts =
      recount === players
        ? `${formatNumber(players)} players,`
        : `${formatNumber(players)} players by its export bans and ${formatNumber(recount)} by its settings now, both`;
    problems.push({
      rule: 'max-players',
      field: 'players',
      message: `It has ${counts} more than the ${formatNumber(maxPlayers)} a ${TYPE_NAMES[type]} export ban list can have.`
    });
  }
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

// Throw an error with the stage of a list's creation it failed in, for the caller to say what
// failed, as deleteExportBanList's errors give theirs.
const failedAt = (stage) => (error) => {
  error.stage = stage;
  throw error;
};

// Create the invite other organisations accept to use a list's BattleMetrics ban list, and save it
// to the list. A second invite does no harm, as it is never shown and is deleted with the list, so
// the request is made again after a timeout or a 5xx.
async function addBattlemetricsInvite(exportBanList) {
  const {
    data: { data: inviteData }
  } = await battlemetrics(
    'post',
    `ban-lists/${exportBanList.battlemetricsID}/relationships/invites`,
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

  exportBanList.battlemetricsInvite = `https://www.battlemetrics.com/rcon/ban-lists/accept-invite?code=${inviteData.id}`;

  await exportBanList.save();
}

class ExportBanList extends Sequelize.Model {
  // Check stored export ban lists against today's limits on export ban lists, those the website
  // checks changes to lists against (export-list-limits.js, with the EXPORT_* settings in
  // EXPORT_LIST_LIMITS), e.g. for the Discord bot to remove the lists outside them. Checks every
  // list, or those with the given IDs, and gives the limits and the lists, in ID order, each as
  // { exportBanList, configs, players, recount, recountError, problems, checked }, with the list's
  // owner as exportBanList.SteamUser.
  //
  // A list is outside the limits when it has problems: those of its stored settings and configs
  // under its type's points rules, as checkRules gives them for the whole list, and one when it has
  // more players than its type's cap. Its configs are loaded as the website loads them to check a
  // change, with their ban lists' and organisations' names for the messages. players counts its
  // export bans waiting to be added or already added (TO_BE_CREATED or CREATED), which
  // /export/:id serves. A list with more of them than its type's cap is counted again by its
  // settings and configs now, and recount is that count, or null for a list not counted again. It
  // is only over the cap when both are. While ban lists are paused, the importer leaves their bans
  // out of export bans, and the count includes them, as the website's size check does (see below).
  // A list of a type the limits do not cover is not checked, and has no problems.
  //
  // A count that fails fails the check, as whether the list is over the cap is then not known. A
  // caller that deals with such a list itself, as the Discord bot does, can pass keepRecountErrors
  // instead: a list whose count failed then comes with the error as recountError, a null recount
  // and no problem for the cap, so it has problems only when it breaks the points rules.
  // recountError is null for every other list.
  static async checkLimits({ ids, limits = EXPORT_LIST_LIMITS, keepRecountErrors = false } = {}) {
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

    // Only the importer brings a list's export bans into line with its settings and configs. So a
    // list its owner has just made smaller on the website, e.g. by raising its threshold, which
    // the website saves without counting its players, keeps its old export bans until then. A list
    // with more of them than its type's cap is therefore counted again, as the website counts the
    // players a list would hold (countMembers), with its settings and configs as they are now. Only
    // those lists are counted, one at a time, as each count reads every ban.
    // Like the website's size check, the count leaves out no ban list: the bans of paused ban lists
    // count too, so that a list's cap holds once they count again, though the importer leaves them
    // out of export bans (see export-membership.js). So while a ban list is paused, a list's two
    // numbers can differ with no change to it, and a list within the cap by its export bans only
    // while one is paused is not counted again, so it has no problem for the cap until that ban
    // list counts again.
    const recounts = new Map();
    const recountErrors = new Map();
    for (const exportBanList of exportBanLists) {
      const maxPlayers = maxPlayersOf(exportBanList.type, limits);
      if (maxPlayers === 0 || (players.get(exportBanList.id) ?? 0) <= maxPlayers) continue;
      try {
        recounts.set(
          exportBanList.id,
          await countMembers(settingsOf(exportBanList), configs.get(exportBanList.id))
        );
      } catch (error) {
        if (!keepRecountErrors) throw error;
        recountErrors.set(exportBanList.id, error);
      }
    }

    return {
      limits,
      lists: exportBanLists.map((exportBanList) => {
        const listConfigs = configs.get(exportBanList.id);
        const listPlayers = {
          players: players.get(exportBanList.id) ?? 0,
          recount: recounts.get(exportBanList.id) ?? null
        };
        const problems = limitProblems(exportBanList, listConfigs, listPlayers, limits);
        return {
          exportBanList,
          configs: listConfigs,
          ...listPlayers,
          recountError: recountErrors.get(exportBanList.id) ?? null,
          problems: problems ?? [],
          checked: problems !== null
        };
      })
    };
  }

  // What has changed in a list since checkLimits checked it, given the check it gave for the list:
  // 'deleted' when the list is gone, 'changed' when its settings, its configs or its BattleMetrics
  // ban list differ from those it was checked with, or null when none of them has. A check takes a
  // moment, longer for a list whose players it counts again, and the list's owner can change it on
  // the website meanwhile, so the Discord bot asks this just before it removes a list outside the
  // limits. Nothing is locked, so a change saved in the moment after this is not seen.
  static async changeSince({ exportBanList, configs }) {
    const { ExportBanListConfig } = sequelize.models;
    const columns = ['battlemetricsID', ...SETTINGS];
    const current = await ExportBanList.findByPk(exportBanList.id, {
      attributes: ['id', ...columns]
    });
    if (!current) return 'deleted';
    const currentConfigs = await ExportBanListConfig.findAll({
      attributes: ['id', ...CONFIG_SETTINGS],
      where: { exportBanList: exportBanList.id },
      order: [['id', 'ASC']]
    });
    const unchanged =
      columns.every((name) => current[name] === exportBanList[name]) &&
      currentConfigs.length === configs.length &&
      currentConfigs.every((config, index) =>
        ['id', ...CONFIG_SETTINGS].every((name) => config[name] === configs[index][name])
      );
    return unchanged ? null : 'changed';
  }

  // The IDs of every BattleMetrics ban list CBL's API key can see. Deleting a list treats a ban
  // list BattleMetrics does not know as already gone, so anything that deletes many lists at once
  // can check first that the key sees CBL's ban lists. See findVisibleBanLists.
  static findVisibleBattlemetricsBanLists() {
    return findVisibleBanLists();
  }

  // The name the list's BattleMetrics ban list is given, by which an admin can find it among CBL's
  // ban lists on BattleMetrics, e.g. one BattleMetrics may have made without saying so.
  battlemetricsBanListName() {
    return `Community Ban List - ${this.name} (ID: ${this.id})`;
  }

  // Create the BattleMetrics ban list and its invite. That takes two requests, each with a time
  // limit, so the log channel gets one line, once both are made, rather than one as it starts too.
  // When either fails, the error is thrown with its stage, for the caller to say what failed and
  // what it did about it, as the website does: 'battlemetrics' when BattleMetrics did not create the
  // ban list, or may have without saying so, and the list does not record one; 'saving' when it
  // created the ban list but the list could not be saved with it, so the database does not record
  // it, though this.battlemetricsID does; or 'invite' when the list records its ban list but its
  // invite could not be made, which saving the list makes again.
  async createBattlemetricsBanList() {
    // A list whose ban list was created but not its invite only needs the invite.
    if (this.battlemetricsID) return this.createBattlemetricsInvite();

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
            name: this.battlemetricsBanListName(),
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
    ).catch(failedAt('battlemetrics'));

    this.battlemetricsID = dataBanList.id;

    await this.save().catch(failedAt('saving'));

    await addBattlemetricsInvite(this).catch(failedAt('invite'));

    Logger.verbose(
      'ExportBanList',
      1,
      `Created BattleMetrics ban list ${this.battlemetricsID} for ${describeList(this)}, with its invite.`
    );
  }

  // Create the invite other organisations accept to use the BattleMetrics ban list, unless the list
  // has one. Nothing else creates a missing invite, so this is also called when the list is saved.
  // The log channel gets one line once it is made. An error is thrown with the stage 'invite', as
  // createBattlemetricsBanList gives it.
  async createBattlemetricsInvite() {
    if (this.type !== 'battlemetrics' || !this.battlemetricsID || this.battlemetricsInvite) return;

    await addBattlemetricsInvite(this).catch(failedAt('invite'));

    Logger.verbose(
      'ExportBanList',
      1,
      `Created the invite to BattleMetrics ban list ${this.battlemetricsID} for ${describeList(this)}.`
    );
  }

  // Delete the export ban list: its BattleMetrics ban list, for a BattleMetrics list that has one,
  // and then its row, which takes its export bans and configs with it. No one is told. The
  // website's Delete button uses this, and the Discord bot can delete any list the same way. It
  // gives what happened on BattleMetrics: 'deleted', 'gone' when BattleMetrics no longer had the
  // ban list, or 'none' when there was none to delete. When it fails, the list is kept, so it can
  // be deleted again, and the error's stage says what failed: 'battlemetrics' while deleting the
  // BattleMetrics ban list, or 'database deletion' while deleting the row.
  //
  // The log channel gets the BattleMetrics side, as deleteBattlemetricsBanList says. A remote list
  // has none, so it gets no line here. The caller posts who deleted the list and how it ended, or
  // why it failed, as the website and the bot both do, so a failure is only thrown. A caller that
  // posts its lines as important ones, as the bot does when it removes many lists, passes
  // important, so these lines are posted that way too and reach the channel in order with its own.
  async deleteExportBanList({ important = false } = {}) {
    let stage = 'battlemetrics';
    try {
      const outcome =
        this.type === 'battlemetrics'
          ? await this.deleteBattlemetricsBanList({ important })
          : 'none';
      stage = 'database deletion';
      await this.destroy();
      return outcome;
    } catch (error) {
      error.stage = stage;
      throw error;
    }
  }

  // Delete the list's BattleMetrics ban list, and save the list without it. Gives 'deleted', 'gone'
  // or 'none', as deleteExportBanList does. The log channel gets a line when it starts, as it takes
  // a request for each of the ban list's invites and subscribers, within the BattleMetrics budget,
  // so it can take minutes, and a line when the ban list is deleted or found to be gone. A list
  // with no ban list makes no request, so it gets one line, saying so. With important, the lines
  // are posted as important ones (see deleteExportBanList).
  async deleteBattlemetricsBanList({ important = false } = {}) {
    const post = (text, ...errors) =>
      important
        ? Logger.important('ExportBanList', text, ...errors)
        : Logger.verbose('ExportBanList', 1, text, ...errors);
    const { battlemetricsID: id, battlemetricsInvite: invite } = this;
    const list = describeList(this);
    if (!id) {
      post(`${list} has no BattleMetrics ban list to delete.`);
      return 'none';
    }

    post(`Deleting BattleMetrics ban list ${id} for ${list}, which can take minutes.`);
    if (!(await checkOwnership(id))) {
      // Without this, a list whose ban list is gone could never be deleted, e.g. one whose
      // deletion lost BattleMetrics' answer to its last step.
      await saveBattlemetricsBanList(this, null, null);
      post(
        `BattleMetrics does not know ban list ${id} for ${list} (HTTP 404, Unknown ban list), so it is taken to be deleted already.`
      );
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
        post(
          `${list} no longer records BattleMetrics ban list ${id}, which CBL's organisation may still own, as removing the organisation failed and the list could not be saved with it again. Remove the ban list on BattleMetrics by hand.`,
          saveError
        );
      }
      throw error;
    }
    post(`Deleted BattleMetrics ban list ${id} for ${list}, with its invites and subscribers.`);
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
