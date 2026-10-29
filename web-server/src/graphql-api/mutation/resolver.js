import { EXPORT_LIST_LIMITS } from 'scbl-lib/config';
import { BanList, ExportBanList, ExportBanListConfig, Organisation } from 'scbl-lib/db/models';
import {
  DEFAULT_SETTINGS,
  checkBounds,
  checkChange,
  defaultThreshold
} from 'scbl-lib/export-list-limits';
import Validators from 'scbl-lib/validators';

import audit, {
  auditCleanup,
  describeChanges,
  describeConfig,
  describeList,
  describeSettings,
  quote
} from './audit.js';
import checkSize from './check-size.js';
import refusal from './refusal.js';
import testWebhook from './test-webhook.js';

// Each change, and each change that fails after its checks, is posted to the CBL log channel with
// who made it (audit.js). Changes the checks refuse, before anything is saved, a webhook is tested
// or BattleMetrics is asked for anything, such as a value out of bounds or a list that does not
// exist, are only shown to the user, as they change nothing. So are changes refused as they are
// saved, as the list changed after their checks, is no longer the user's or is being deleted (see
// saveOwnList), or as the database was too busy to save them (see inTransaction), and a deletion of
// a list that is being deleted already, e.g. by the Discord bot.

// The settings that decide who is on an export ban list, with its configs: its threshold, default
// points and max ban age.
const SETTINGS = Object.keys(DEFAULT_SETTINGS);

// The values of a list the log channel's line about a change to it compares.
const LOGGED_VALUES = ['name', 'server', ...SETTINGS, 'discordWebhook'];

// The values of a config that a change to a list is checked with, as loadConfigs gives them.
const CONFIG_VALUES = ['id', 'banList', 'activePoints', 'expiredPoints'];

// The most export ban lists a user can have, and the refusal for a user who has them.
const LISTS_PER_USER = 4;
const LIST_LIMIT = `You are limited to ${LISTS_PER_USER} export ban lists.`;

// The refusal for a change whose list changed after the change was checked, e.g. as it waited for
// its webhook test. Nothing is saved, and the user can try again with the list as it is now.
const CHANGED =
  'This export ban list was changed while your change was being saved, so your change was not saved. Please reload the page and try again.';

// The refusal for a change MySQL could not save, as other changes held the rows it needed (see
// inTransaction). Nothing is saved, and the user can try again shortly.
const DATABASE_BUSY =
  'The database was busy, so your change was not saved. Please try again in a minute.';

// The refusal for a change to a list that is being deleted, e.g. by the Discord bot, whose change
// would be lost with the list (see saveOwnList). Nothing is saved.
const BEING_DELETED = 'This export ban list is being deleted, so your change was not saved.';

// A list's settings, from its stored row or a change's arguments. Only the arguments given are
// taken, so a change leaves the others as they are.
const storedSettings = (exportBanList) =>
  Object.fromEntries(SETTINGS.map((name) => [name, exportBanList[name]]));
const givenSettings = (args) =>
  Object.fromEntries(SETTINGS.filter((name) => name in args).map((name) => [name, args[name]]));

// Refuse a change with the first of its problems, as { message }.
function refuseProblems(problems) {
  if (problems.length > 0) throw refusal(problems[0].message);
}

// Check the name, server and Discord webhook a change sets with the forms' rules
// (scbl-lib/validators.js). Values the same as the list's are left alone, as the edit form sends
// every value on each save, so lists saved before the checks can still be changed. An empty
// webhook, or none, removes the list's webhook.
function checkFormats(args, exportBanList = {}) {
  for (const field of ['name', 'server', 'discordWebhook']) {
    const value = args[field];
    if (!(field in args) || value === exportBanList[field]) continue;
    if (field === 'discordWebhook' && !value) continue;
    try {
      Validators.ExportBanList[field].validateSync(value, { strict: true });
    } catch (error) {
      throw refusal(error.message);
    }
  }
}

// Whether a user has room for another export ban list, as each user can have 4. A new list is only
// created once its user's lists are locked and counted again (see createExportBanList).
async function hasRoomForList(user) {
  return (await ExportBanList.count({ where: { owner: user } })) < LISTS_PER_USER;
}

// Check a change that can change who is on a list against the limits on export ban lists
// (scbl-lib/export-list-limits.js): its creation, a change to its settings, or a config added or
// deleted. before is the list as stored, or null for a new list, and after is the whole list after
// the change, each as { settings, configs }. A change that can only make the list smaller, or keep
// it the same, is allowed, so lists saved before the limits keep working. One that could make the
// list bigger must leave the whole list within the points rules, and within its type's limit on
// players (check-size.js). list is the list's type, its ID (undefined for a new list) and the kind
// of change, which check-size.js describes.
//
// Every such change comes here before anything is saved, a webhook is tested or BattleMetrics is
// asked for anything, so any other check of a change that could make a list bigger
// (change.mayGrow) belongs here too.
async function checkListChange(context, list, before, after) {
  const change = checkChange(list.type, before, after, EXPORT_LIST_LIMITS);
  refuseProblems(change.problems);
  await checkSize(context, {
    ...list,
    before,
    after,
    change,
    hasRoomForList: () => hasRoomForList(context.user.id)
  });
  return change;
}

// A list's configs as the checks take them, with their ban lists' and organisations' names for the
// messages, read in the transaction if one is given.
async function loadConfigs(exportBanList, transaction) {
  const configs = await ExportBanListConfig.findAll({
    where: { exportBanList },
    include: [{ model: BanList, include: [Organisation] }],
    order: [['id', 'ASC']],
    transaction
  });
  return configs.map((config) => ({
    id: config.id,
    banList: config.banList,
    activePoints: config.activePoints,
    expiredPoints: config.expiredPoints,
    banListName: config.BanList?.name,
    organisationName: config.BanList?.Organisation?.name
  }));
}

// Run work(transaction) in a short transaction (ExportBanList.inTransaction). MySQL can end one in a
// deadlock with another change, e.g. two users with no lists creating their first at the same
// moment, which inTransaction runs again, or give up waiting for a lock, e.g. while the importer
// recalculates every player's reputation. When the change still could not be saved, nothing was,
// so it is refused plainly, and not posted as a failure, and the user can try again.
async function inTransaction(work) {
  try {
    return await ExportBanList.inTransaction(work);
  } catch (error) {
    if (error?.busy === true) throw refusal(DATABASE_BUSY);
    throw error;
  }
}

// Save a change to one of the user's lists in a short transaction, with the list's row locked. The
// Discord bot can give a list to another user from its own process, so guard-changes.js keeping
// each user's changes in order is not enough: the list is looked up again with its row locked, and
// the change is only saved while the user still owns it. Another change to the list, such as the
// new owner's or the transfer itself, waits for the row until this one is saved, and this one waits
// for theirs. The bot can also remove the list, which can take minutes on BattleMetrics, and holds
// its deletion lock meanwhile, so a change to a list being deleted is refused, as it would be lost
// with the list. The bot reads the list a last time with its row locked once it holds that lock,
// so a change that got past this check is saved before that read, which then sees it.
// save(list, transaction) gets the list as it is now, to check it again and write the change in the
// transaction.
function saveOwnList(context, id, save) {
  return inTransaction(async (transaction) => {
    const list = await ExportBanList.findOne({
      where: { id, owner: context.user.id },
      lock: true,
      transaction
    });
    if (!list) throw refusal('Export ban list does not exist!');
    if (await ExportBanList.isBeingDeleted(id, { transaction })) throw refusal(BEING_DELETED);
    return save(list, transaction);
  });
}

// Refuse a change unless its list still has the settings and configs the change was checked with.
// The checks run before the change's transaction, so a change they refuse is refused before its
// webhook is tested, as before, and neither a count of the list's players nor a webhook test keeps
// the list's row locked. Here, with the row locked (see saveOwnList), the list is read again, so a
// change is never saved to a list that has changed since its checks. list is the list as it is now.
async function checkUnchanged(list, settings, configs, transaction) {
  const current = await loadConfigs(list.id, transaction);
  const same = (values, checked, names) => names.every((name) => values[name] === checked[name]);
  if (
    !same(list, settings, SETTINGS) ||
    current.length !== configs.length ||
    current.some((config, index) => !same(config, configs[index], CONFIG_VALUES))
  )
    throw refusal(CHANGED);
}

// The log channel's line, up to the error, for a new BattleMetrics list that records a ban list
// but was not finished, from the stage that createBattlemetricsBanList's error gives.
function describeUnfinished(exportBanList, error) {
  const list = describeList(exportBanList);
  const settings = describeSettings(exportBanList);
  const id = exportBanList.battlemetricsID;
  if (error.stage === 'saving')
    return `created export ban list ${list}: ${settings}. BattleMetrics ban list ${id} was made for it, but saving it to the list failed, so nothing records the ban list, which must be removed on BattleMetrics by hand:`;
  if (error.stage === 'invite')
    return `created export ban list ${list} with BattleMetrics ban list ${id}: ${settings}. Its invite could not be made, which saving the list tries again:`;
  return `created export ban list ${list}: ${settings}. Making its BattleMetrics ban list ${id} failed:`;
}

// How a deletion ended on BattleMetrics, for the log channel's line, from what deleteExportBanList
// gives and the BattleMetrics ban list the list recorded before it. 'gone' only says BattleMetrics
// did not know the ban list, which it also says of one CBL's key cannot see, so the line says no
// more than ExportBanList's does.
function describeOutcome(outcome, type, battlemetricsID) {
  if (outcome === 'deleted') return ` and its BattleMetrics ban list ${battlemetricsID}`;
  if (outcome === 'gone')
    return `; BattleMetrics did not know its ban list ${battlemetricsID}, so it was taken to be deleted already`;
  return type === 'battlemetrics' ? ', which had no BattleMetrics ban list' : '';
}

// What failed in a deletion, for the log channel's line, from its error's stage.
function describeFailedDeletion(error, battlemetricsID) {
  if (error.stage === 'battlemetrics')
    return `, as deleting its BattleMetrics ban list ${battlemetricsID} failed`;
  if (error.stage === 'database deletion') return ', as deleting it from the database failed';
  return '';
}

// What is logged of a failed BattleMetrics request for an export ban list: the BattleMetrics client
// says in the message what failed and whether BattleMetrics may have carried it out anyway, and the
// list's IDs say what there is to clean up. The error is never logged whole.
function logBattlemetricsFailure(description, exportBanList, error) {
  const response = error.response;
  const errors = response && response.data && response.data.errors;
  console.error(description, {
    exportBanListID: exportBanList.id,
    battlemetricsID: exportBanList.battlemetricsID,
    name: error.name,
    message: error.message,
    status: response && response.status,
    ambiguous: error.ambiguous,
    errors: Array.isArray(errors)
      ? errors.map(({ code, title, detail }) => ({ code, title, detail }))
      : undefined
  });
}

export default {
  Mutation: {
    createExportBanList: async (parent, args, context) => {
      // Ensure user does not exceed max export ban list amount.
      if (!(await hasRoomForList(context.user.id))) throw new Error(LIST_LIMIT);

      // Validate arguments.
      if (!['remote', 'battlemetrics'].includes(args.type))
        throw new Error('Invalid export ban list type.');
      checkFormats(args);

      // Settings that are not given take the defaults the form starts with. Every setting is
      // stored, so the list is saved as it was checked.
      const settings = {
        ...DEFAULT_SETTINGS,
        threshold: defaultThreshold(EXPORT_LIST_LIMITS),
        ...givenSettings(args)
      };
      await checkListChange(context, { type: args.type, kind: 'create' }, null, {
        settings,
        configs: []
      });

      if (args.discordWebhook) await testWebhook(context, args.discordWebhook);

      // Create export ban list. The user's lists are locked and counted again first, in the same
      // short transaction, as the Discord bot may have given them a list since they were counted
      // above, and a transfer to them locks their lists too, so it waits for this one or this one
      // waits for it.
      let exportBanLsit;
      try {
        exportBanLsit = await inTransaction(async (transaction) => {
          const lists = await ExportBanList.lockListsOf(context.user.id, { transaction });
          if (lists >= LISTS_PER_USER) throw refusal(LIST_LIMIT);
          return ExportBanList.create(
            {
              name: args.name,
              server: args.server,
              type: args.type,
              ...settings,
              discordWebhook: args.discordWebhook,
              owner: context.user.id
            },
            { transaction }
          );
        });
      } catch (error) {
        if (error.refusal !== true)
          audit(context, `could not create export ban list ${describeList(args)}:`, error);
        throw error;
      }

      if (exportBanLsit.type === 'battlemetrics') {
        try {
          await exportBanLsit.createBattlemetricsBanList();
        } catch (error) {
          // The owner sees the message, but only this says which list it was, and whether
          // BattleMetrics may have created a ban list that the list does not record.
          logBattlemetricsFailure(
            'Failed to create the BattleMetrics ban list for export ban list:',
            exportBanLsit,
            error
          );

          // Without a BattleMetrics ban list, the export ban list could never be used, so it is
          // deleted, and the owner can try again. It is deleted on its own rather than created in
          // one transaction with its BattleMetrics ban list, as f6630b9 tried:
          // createBattlemetricsBanList saves the list outside the transaction, so the save waited
          // on the list's uncommitted row until MySQL gave up. The list's own transaction above has
          // ended before the BattleMetrics ban list is made, which can take a while within the
          // BattleMetrics budget, and the Discord bot can give the list to another user meanwhile.
          // So it is deleted only while it is still the user's, in one statement, which locks the
          // row as it checks the owner.
          if (!exportBanLsit.battlemetricsID) {
            const failed = `could not create export ban list ${describeList(exportBanLsit)}, as making its BattleMetrics ban list failed`;
            // A ban list BattleMetrics may have made without saying so is recorded nowhere, so the
            // line says what an admin should look for on BattleMetrics, and is posted ahead of
            // others.
            const unrecorded = error.ambiguous
              ? ` BattleMetrics may have made the ban list anyway, which nothing records: look for ${quote(exportBanLsit.battlemetricsBanListName())} among CBL's ban lists on BattleMetrics, and remove it.`
              : '';
            const postFailure = error.ambiguous ? auditCleanup : audit;
            let deleted;
            try {
              deleted = await ExportBanList.destroy({
                where: { id: exportBanLsit.id, owner: context.user.id }
              });
            } catch (destroyError) {
              console.error(
                'Failed to delete the export ban list with no BattleMetrics ban list:',
                {
                  exportBanListID: exportBanLsit.id,
                  name: destroyError.name,
                  message: destroyError.message
                }
              );
              postFailure(
                context,
                `${failed}, and the list could not be deleted either, so its owner was asked to delete it.${unrecorded}`,
                error,
                destroyError
              );
              throw new Error(
                'BattleMetrics could not create a ban list for your export ban list. Please delete it and try again later.'
              );
            }
            // A list that is no longer the user's is left to its new owner, who can delete it.
            const outcome =
              deleted > 0
                ? 'so the list was deleted'
                : 'and it was no longer theirs, as it had been given to another user or removed meanwhile, so it was left as it is';
            postFailure(context, `${failed}, ${outcome}.${unrecorded}`, error);
            throw new Error(
              'BattleMetrics could not create a ban list for your export ban list, so it was not created. Please try again later.'
            );
          }
          // A ban list the list could not be saved with is recorded nowhere, and must be removed
          // by hand, so that line is posted ahead of others.
          const postUnfinished = error.stage === 'saving' ? auditCleanup : audit;
          postUnfinished(context, describeUnfinished(exportBanLsit, error), error);
          throw error;
        }
      }

      audit(
        context,
        `created export ban list ${describeList(exportBanLsit)}: ${describeSettings(exportBanLsit)}.`
      );
      return exportBanLsit;
    },

    updateExportBanList: async (parent, args, context) => {
      // Get export ban list.
      const exportBanList = await ExportBanList.findOne({
        where: { id: args.id, owner: context.user.id }
      });

      // Check export ban list exists.
      if (!exportBanList) throw new Error('Export ban list does not exist!');

      // Validate the values the change sets. The edit form sends every value on each save, so
      // only those that differ from the list's are checked.
      checkFormats(args, exportBanList);
      const stored = storedSettings(exportBanList);
      const settings = { ...stored, ...givenSettings(args) };
      const changed = SETTINGS.filter((name) => settings[name] !== stored[name]);
      refuseProblems(
        checkBounds(Object.fromEntries(changed.map((name) => [name, settings[name]])))
      );

      // A change to the settings can change who is on the list, so it is checked with the list's
      // configs, and the ban list needs generating again. Renames and webhook changes need neither.
      let configs;
      if (changed.length > 0) {
        configs = await loadConfigs(exportBanList.id);
        await checkListChange(
          context,
          { type: exportBanList.type, exportBanList: exportBanList.id, kind: 'update' },
          { settings: stored, configs },
          { settings, configs }
        );
        exportBanList.generated = false;
      }

      if (args.discordWebhook && args.discordWebhook !== exportBanList.discordWebhook)
        await testWebhook(context, args.discordWebhook);

      // The list as it was, for the log channel's line, which gives only the values that changed.
      const before = Object.fromEntries(LOGGED_VALUES.map((name) => [name, exportBanList[name]]));

      // Update arguments if specified
      if ('name' in args) exportBanList.name = args.name;
      if ('server' in args) exportBanList.server = args.server;
      if ('threshold' in args) exportBanList.threshold = args.threshold;
      if ('defaultActivePoints' in args)
        exportBanList.defaultActivePoints = args.defaultActivePoints;
      if ('defaultExpiredPoints' in args)
        exportBanList.defaultExpiredPoints = args.defaultExpiredPoints;
      if ('maxBanAge' in args) exportBanList.maxBanAge = args.maxBanAge;
      if ('discordWebhook' in args) exportBanList.discordWebhook = args.discordWebhook;

      // A save that changes nothing, as the edit form sends every value, posts no line.
      const changes = describeChanges(before, exportBanList).join(', ');
      try {
        // Saved while the user still owns the list, and a change to its settings only while it has
        // the settings and configs the change was checked with.
        await saveOwnList(context, exportBanList.id, async (list, transaction) => {
          if (configs) await checkUnchanged(list, stored, configs, transaction);
          await exportBanList.save({ transaction });
        });
      } catch (error) {
        if (error.refusal === true) throw error;
        // The list as the database still has it. A Sequelize instance's values are read one by
        // one, as spreading it would not give them.
        const { id, type } = exportBanList;
        const list = describeList({ id, type, name: before.name, server: before.server });
        audit(
          context,
          `could not save export ban list ${list}${changes ? ` (${changes})` : ''}:`,
          error
        );
        throw error;
      }
      if (changes)
        audit(context, `updated export ban list ${describeList(exportBanList)}: ${changes}.`);

      // A BattleMetrics export ban list whose invite could not be created along with it gets one
      // now. The changes are saved either way, so a failure is only logged and posted, and the
      // owner is not shown it.
      try {
        await exportBanList.createBattlemetricsInvite();
      } catch (error) {
        logBattlemetricsFailure(
          'Failed to create the BattleMetrics invite for export ban list:',
          exportBanList,
          error
        );
        audit(
          context,
          `saved export ban list ${describeList(exportBanList)}, but its missing invite to BattleMetrics ban list ${exportBanList.battlemetricsID} could not be made, which saving the list tries again:`,
          error
        );
      }

      return exportBanList;
    },

    deleteExportBanList: async (parent, args, context) => {
      let stage = 'authentication';
      let exportBanList;
      // The list and the BattleMetrics ban list it recorded, for the log channel's line, as the
      // deletion clears the list's BattleMetrics ban list.
      let list;
      let battlemetricsID;
      let outcome;
      try {
        if (!context.user) throw new Error('Please sign in again to delete an export ban list.');

        // Get the export ban list.
        stage = 'lookup';
        const found = await ExportBanList.findOne({
          where: { id: args.id, owner: context.user.id }
        });

        // Check the export ban list exists.
        if (!found) throw new Error('Export ban list does not exist!');

        // The deletion holds the list's deletion lock, as deleting a BattleMetrics list can take
        // minutes, and the Discord bot neither gives a list being deleted to another user nor
        // removes it meanwhile. The list is looked up again once the lock is held, with its row
        // locked, so a list given to another user just before is not deleted either.
        outcome = await ExportBanList.whileDeleting(found.id, async () => {
          exportBanList = await inTransaction((transaction) =>
            ExportBanList.findOne({
              where: { id: found.id, owner: context.user.id },
              lock: true,
              transaction
            })
          );
          if (!exportBanList) throw new Error('Export ban list does not exist!');

          // Delete the export ban list, and its BattleMetrics ban list if it has one. Its error
          // says which of these failed. Its row is deleted only while the user still owns it, in
          // case the deletion lock was lost part-way.
          stage = 'deletion';
          list = describeList(exportBanList);
          ({ battlemetricsID } = exportBanList);
          return exportBanList.deleteExportBanList({ owner: context.user.id });
        });
      } catch (error) {
        // A list whose deletion lock is held is being deleted already, e.g. by the Discord bot.
        // Nothing was changed, so this is only shown to the user, as a refusal, which does not
        // count towards their limit on creating and deleting lists.
        if (error.beingDeleted === true) throw refusal(error.message);

        // Do not log the full Axios error: it includes the API authorization header.
        const response = error.response;
        const errors = response && response.data && response.data.errors;
        console.error('Failed to delete export ban list:', {
          exportBanListID: args.id,
          stage: error.stage || stage,
          name: error.name,
          message: error.message,
          status: response && response.status,
          errors: Array.isArray(errors)
            ? errors.map(({ code, title, detail }) => ({ code, title, detail }))
            : undefined
        });
        // Signing in and looking the list up change nothing, so only a failed deletion is posted.
        if (stage === 'deletion')
          audit(
            context,
            `could not delete export ban list ${list}${describeFailedDeletion(error, battlemetricsID)}:`,
            error
          );
        throw error;
      }

      audit(
        context,
        `deleted export ban list ${list}${describeOutcome(outcome, exportBanList.type, battlemetricsID)}.`
      );
      return exportBanList;
    },

    createExportBanListConfig: async (parent, args, context) => {
      const exportBanList = await ExportBanList.findOne({
        where: { id: args.exportBanList, owner: context.user.id }
      });

      if (!exportBanList) throw new Error('Export ban list does not exist!');

      const banList = await BanList.findOne({
        where: { id: args.banList },
        include: [Organisation]
      });

      if (!banList) throw new Error('Ban list does not exist!');
      // A paused ban list's bans count for nothing, and it is left out of the website's lists, so
      // no new config is made for it until it counts again. Configs it has are kept.
      if (context.paused?.has(banList.id))
        throw new Error(
          'That ban list is paused, so no config can be added for it until it counts again.'
        );

      const exportBanListConfig = await ExportBanListConfig.findOne({
        where: { exportBanList: args.exportBanList, banList: args.banList }
      });

      if (exportBanListConfig)
        throw new Error('Export ban list config already exists for this ban list.');

      // A config needs both its points. More points than the list's defaults could make the list
      // bigger, so the change is checked with the list's other configs.
      const points = { activePoints: args.activePoints, expiredPoints: args.expiredPoints };
      refuseProblems(checkBounds(points));
      const settings = storedSettings(exportBanList);
      const configs = await loadConfigs(exportBanList.id);
      const added = {
        banList: banList.id,
        ...points,
        banListName: banList.name,
        organisationName: banList.Organisation?.name
      };
      await checkListChange(
        context,
        { type: exportBanList.type, exportBanList: exportBanList.id, kind: 'add config' },
        { settings, configs },
        { settings, configs: [...configs, added] }
      );

      const list = describeList(exportBanList);
      let created;
      try {
        // Added while the user still owns the list, and only while it has the settings and configs
        // the config was checked with.
        created = await saveOwnList(context, exportBanList.id, async (current, transaction) => {
          await checkUnchanged(current, settings, configs, transaction);
          return ExportBanListConfig.create(
            { exportBanList: args.exportBanList, banList: args.banList, ...points },
            { transaction }
          );
        });
      } catch (error) {
        if (error.refusal === true) throw error;
        audit(
          context,
          `could not add a config to export ban list ${list} (${describeConfig(added)}):`,
          error
        );
        throw error;
      }
      audit(context, `added a config to export ban list ${list}: ${describeConfig(added)}.`);
      return created;
    },

    deleteExportBanListConfig: async (parent, args, context) => {
      const exportBanListConfig = await ExportBanListConfig.findOne({
        where: { id: args.id, '$ExportBanList.owner$': context.user.id },
        include: [ExportBanList]
      });

      if (!exportBanListConfig) throw new Error('Export ban list config does not exist!');

      // Without the config, its ban list gives the list's default points, or those of another
      // config for it, which could make the list bigger.
      const exportBanList = exportBanListConfig.ExportBanList;
      const settings = storedSettings(exportBanList);
      const configs = await loadConfigs(exportBanList.id);
      await checkListChange(
        context,
        { type: exportBanList.type, exportBanList: exportBanList.id, kind: 'delete config' },
        { settings, configs },
        { settings, configs: configs.filter((config) => config.id !== exportBanListConfig.id) }
      );

      // The config as the checks loaded it, with its ban list's and organisation's names.
      const list = describeList(exportBanList);
      const { id, banList, activePoints, expiredPoints } = exportBanListConfig;
      const config = describeConfig(
        configs.find((loaded) => loaded.id === id) ?? { banList, activePoints, expiredPoints }
      );
      try {
        // Deleted while the user still owns the list, and only while it has the settings and
        // configs the deletion was checked with.
        await saveOwnList(context, exportBanList.id, async (current, transaction) => {
          await checkUnchanged(current, settings, configs, transaction);
          await exportBanListConfig.destroy({ transaction });
        });
      } catch (error) {
        if (error.refusal === true) throw error;
        audit(
          context,
          `could not delete a config from export ban list ${list} (${config}):`,
          error
        );
        throw error;
      }
      audit(context, `deleted a config from export ban list ${list}: ${config}.`);
      return exportBanListConfig;
    }
  }
};
