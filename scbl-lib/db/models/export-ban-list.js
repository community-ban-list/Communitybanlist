import Sequelize from 'sequelize';

import openConnection from '../open-connection.js';
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

// MySQL's error numbers for a statement that waited too long for a lock another transaction held,
// and for a deadlock, after which it has rolled back the whole transaction.
const LOCK_WAIT_TIMEOUT = 1205;
const DEADLOCK = 1213;

// How many times inTransaction runs a transaction MySQL ends in a deadlock, in all, and the most it
// waits before the second, in milliseconds. The wait is random, so transactions that met in a
// deadlock run again at different times, and its most doubles each time: 0.1, 0.2 and 0.4 s.
const DEADLOCK_ATTEMPTS = 4;
const DEADLOCK_WAIT = 100;

// MySQL's error number for an error Sequelize gives, which holds MySQL's own error.
const errorNumber = (error) => (error?.original ?? error?.parent)?.errno;

// The name of a list's deletion lock, in SQL, from the list's ID, given as a replacement, and the
// database's name, as MySQL's lock names are shared by the whole server. MySQL takes names of up to
// 64 characters, so a long database name is cut short.
const DELETION_LOCK = "LEFT(CONCAT('cbl-export-ban-list-deletion:', ?, ':', DATABASE()), 64)";

// How long to wait for the deletion lock's connection to close before closing it at once.
const CLOSE_TIMEOUT = 5 * 1000;

// Close the deletion lock's connection, which frees the lock: telling MySQL first, or at once if
// that takes too long.
async function closeConnection(connection) {
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Timed out')), CLOSE_TIMEOUT);
  });
  try {
    await Promise.race([connection.end(), timeout]);
  } catch {
    connection.destroy();
  } finally {
    clearTimeout(timer);
  }
}

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

// Delete a list's row, which takes its export bans and configs with it, only while the Steam user
// owns the list, by a statement that locks the row as it checks the owner. The website holds the
// list's deletion lock while it deletes a list for its owner, so the Discord bot does not give the
// list to another user meanwhile, but MySQL frees that lock without a word if its connection is
// lost (see whileDeleting). A list given to another user meanwhile is kept, and the error says so.
// One deleted meanwhile, e.g. by the bot, is gone as asked. It runs in inTransaction, so it is run
// again if MySQL ends it in a deadlock, e.g. with the importer, which writes the list's export bans.
function destroyIfOwnedBy(exportBanList, owner) {
  const { id } = exportBanList;
  return ExportBanList.inTransaction(async (transaction) => {
    if ((await ExportBanList.destroy({ where: { id, owner }, transaction })) > 0) return;
    if ((await ExportBanList.count({ where: { id }, transaction })) > 0)
      throw new Error(
        'This export ban list was given to another user while it was being deleted, so it was not deleted.'
      );
  });
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
  // limits, once it holds the list's deletion lock (whileDeleting). The list is read with its row
  // locked, in a short transaction, so a change to the list or its configs that the website is
  // saving, which holds the row until it is saved, is saved first and seen here. The website
  // refuses changes to a list whose deletion lock is held, so none is saved after this either.
  static changeSince({ exportBanList, configs }) {
    const { ExportBanListConfig } = sequelize.models;
    const columns = ['battlemetricsID', ...SETTINGS];
    return ExportBanList.inTransaction(async (transaction) => {
      const current = await ExportBanList.findByPk(exportBanList.id, {
        attributes: ['id', ...columns],
        lock: true,
        transaction
      });
      if (!current) return 'deleted';
      const currentConfigs = await ExportBanListConfig.findAll({
        attributes: ['id', ...CONFIG_SETTINGS],
        where: { exportBanList: exportBanList.id },
        order: [['id', 'ASC']],
        transaction
      });
      const unchanged =
        columns.every((name) => current[name] === exportBanList[name]) &&
        currentConfigs.length === configs.length &&
        currentConfigs.every((config, index) =>
          ['id', ...CONFIG_SETTINGS].every((name) => config[name] === configs[index][name])
        );
      return unchanged ? null : 'changed';
    });
  }

  // The IDs of every BattleMetrics ban list CBL's API key can see. Deleting a list treats a ban
  // list BattleMetrics does not know as already gone, so anything that deletes many lists at once
  // can check first that the key sees CBL's ban lists. See findVisibleBanLists.
  static findVisibleBattlemetricsBanLists() {
    return findVisibleBanLists();
  }

  // The website and the Discord bot change export ban lists from separate processes, so changes
  // that must not interleave wait for each other in the database:
  // - A change to a list or its configs on the website, and the bot's transfer of the list to
  //   another user, each lock the list's row while they check it and write it, in one short
  //   transaction. A change on the website is only written while its user still owns the list, so
  //   the old owner's change in progress when the list is given away is refused.
  // - Creating a list, and giving one to a user, first lock that user's lists (lockListsOf), so the
  //   count of their lists cannot change before the new list or new owner is written.
  // - A deletion on the website, and the bot's removal of a list, hold the list's deletion lock
  //   while they work, which can take minutes on BattleMetrics (whileDeleting). A transfer, a change
  //   saved on the website and another deletion leave a list being deleted as it is
  //   (isBeingDeleted). The website deletes the row only while its user still owns the list, and the
  //   bot reads the list a last time with its row locked once it holds the lock (changeSince).
  // The transactions are short: nothing in them waits for BattleMetrics, Discord or a count of
  // players. They can wait for a statement of the ban importer's export step, which reads every
  // list, for as long as the statement runs. Creating a list, and giving one to a user, can also
  // wait for the importer's recalculation of every player's reputation, but do so before they lock
  // any list (see lockListsOf).

  // Run work(transaction) in a transaction. MySQL ends a transaction in a deadlock, rolling all of
  // it back, when it and another each wait for a lock the other holds, and lets the other go
  // ahead. These transactions can meet in one:
  // - a transfer and the ban importer's export step: the transfer locks the new owner's lists
  //   before the list it gives them, while the export step reads every list in ID order;
  // - a change saved on the website, such as a config added or deleted, and the export step, which
  //   reads every list and config: the change locks its list before it writes the list's configs,
  //   while the export step can lock the configs it has read and then wait for the list;
  // - a list created for a user with none and a list given to them at the same moment, as both
  //   lock the gap between other users' lists in the index on the owner where the user's lists
  //   would go (see lockListsOf), and then add a list to it;
  // - in the same way two or more users with no lists whose Steam IDs fall in the same gap,
  //   creating their first lists at the same moment;
  // - and a transfer and a list created at the same moment by the list's old owner, when no other
  //   user's lists sit between the old owner's and the new owner's in the index on the owner: the
  //   creation locks the old owner's lists, the list being given among them, and the transfer
  //   locks the new owner's lists with the gap before them, where the new list would go.
  // So a transaction ended in a deadlock is run again, after a short random wait, up to
  // DEADLOCK_ATTEMPTS times in all, which lets several such users through one after another. Each
  // work reads again what it checks, so running it again is safe. When MySQL still ends it in a
  // deadlock, or a statement in it waits too long for a lock, e.g. while the importer recalculates
  // every player's reputation, which can take most of a minute, the error is marked busy: nothing
  // was saved, and the change can be made again shortly, so the website and the bot tell the user
  // so plainly rather than as a failure. A statement that waited that long is not run again, as it
  // would only wait as long again.
  static async inTransaction(work) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await sequelize.transaction(work);
      } catch (error) {
        const number = errorNumber(error);
        if (number === DEADLOCK && attempt < DEADLOCK_ATTEMPTS) {
          const wait = Math.random() * DEADLOCK_WAIT * 2 ** (attempt - 1);
          await new Promise((resolve) => setTimeout(resolve, wait));
          continue;
        }
        if (number === DEADLOCK || number === LOCK_WAIT_TIMEOUT) error.busy = true;
        throw error;
      }
    }
  }

  // Lock a user's export ban lists in the transaction, and give how many they have. Everything that
  // gives a user a list, creating one on the website or a transfer by the bot, does this before it
  // counts their lists, so a list given to them meanwhile waits for the transaction to end, and the
  // count holds until the new list or new owner is written.
  //
  // The user's Steam user row is read with a shared lock first. Writing a list for the user takes
  // that same lock, for the list's foreign key, and the importer locks every Steam user while it
  // recalculates their reputation. So the transaction waits for the importer here, before it locks
  // any list, and changes to the user's lists are not held up behind it meanwhile.
  static async lockListsOf(owner, { transaction }) {
    await sequelize.query('SELECT id FROM SteamUsers WHERE id = ? FOR SHARE', {
      replacements: [owner],
      transaction
    });
    const lists = await ExportBanList.findAll({
      attributes: ['id'],
      where: { owner },
      lock: true,
      transaction
    });
    return lists.length;
  }

  // Run deletion() while holding the list's deletion lock, and give what it gives. A transfer, and a
  // change saved on the website, leave a list whose deletion lock is held as it is
  // (isBeingDeleted), so a list cannot be given to another user, or changed by its owner, while it
  // is being deleted, e.g. while its BattleMetrics ban list is deleted, which can take minutes. The
  // lock is MySQL's, on a connection of its own, outside the Sequelize pool, for the whole
  // deletion, and MySQL frees it once the connection closes, so a deletion that fails, or a web
  // server or bot that stops part-way, never leaves it held. A connection lost part-way frees it
  // too, without a word, so the website's deletion also deletes the row only while its user still
  // owns the list (see deleteExportBanList). When another deletion holds the list's lock, as when
  // the website and the bot delete it at the same moment, deletion() is not run, and the error
  // thrown is marked beingDeleted.
  static async whileDeleting(id, deletion) {
    let connection;
    try {
      connection = await openConnection();
    } catch (error) {
      // Shown as the database being unavailable, as mysql2's message can name its address.
      throw new Sequelize.ConnectionError(error);
    }
    try {
      const [[{ taken }]] = await connection.query(
        `SELECT GET_LOCK(${DELETION_LOCK}, 0) AS taken`,
        [id]
      );
      if (Number(taken) !== 1)
        throw Object.assign(new Error('This export ban list is already being deleted.'), {
          beingDeleted: true
        });
      return await deletion();
    } finally {
      await closeConnection(connection);
    }
  }

  // Whether a deletion of the list holds its deletion lock (see whileDeleting).
  static async isBeingDeleted(id, { transaction } = {}) {
    const { holder } = await sequelize.query(`SELECT IS_USED_LOCK(${DELETION_LOCK}) AS holder`, {
      replacements: [id],
      plain: true,
      transaction
    });
    return holder !== null;
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
            defaultAutoAddEnabled: true,
            // Each ban is also sent with native bans off (see export-ban.js), which BattleMetrics'
            // documentation says prevents native bans; each subscriber most likely has its own
            // defaults.
            defaultNativeEnabled: false
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
  //
  // A caller that deletes a list for its owner, as the website does, passes owner, their Steam ID,
  // and the row is then only deleted while they still own the list (see destroyIfOwnedBy).
  async deleteExportBanList({ important = false, owner } = {}) {
    let stage = 'battlemetrics';
    try {
      const outcome =
        this.type === 'battlemetrics'
          ? await this.deleteBattlemetricsBanList({ important })
          : 'none';
      stage = 'database deletion';
      if (owner === undefined) await this.destroy();
      else await destroyIfOwnedBy(this, owner);
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
