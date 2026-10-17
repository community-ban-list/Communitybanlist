import battlemetrics from './battlemetrics.js';
import readBattlemetricsPages from './read-battlemetrics-pages.js';
import { BATTLEMETRICS_ORGANIZATION } from '../config.js';

// Deleting a BattleMetrics ban list takes three steps, which ExportBanList's deleteExportBanList
// takes in turn: checkOwnership, removeInvitesAndSubscribers and removeOwner. Once CBL's own
// organisation has left the ban list, CBL can no longer reach it, so the export ban list is saved
// without it before that last step. Each step's errors say which step failed and what
// BattleMetrics answered.

// BattleMetrics answers HTTP 404 with this error for a ban list it does not have, or that CBL
// cannot see.
const UNKNOWN_BAN_LIST = /unknown ban ?list/i;

const relationships = (id) => `ban-lists/${encodeURIComponent(id)}/relationships`;

// Remove an invite or subscription. BattleMetrics answers 404 when it is already gone, e.g. when a
// removal it carried out answered too late, was cut off and was made again, which is what the
// deletion wants. Without this, a late answer to the owner's removal would leave a list that can
// never be deleted, as the ownership check fails once the owner has left.
async function remove(endpoint) {
  try {
    await battlemetrics('delete', endpoint);
  } catch (error) {
    if (!error.response || error.response.status !== 404) throw error;
  }
}

// Whether BattleMetrics answered that it does not know the ban list.
function isUnknownBanList(error) {
  const response = error.response;
  const errors = response && response.status === 404 && response.data && response.data.errors;
  return (
    Array.isArray(errors) &&
    errors.some((item) => item && UNKNOWN_BAN_LIST.test(`${item.title} ${item.detail}`))
  );
}

// Say in an error which step failed and what BattleMetrics answered.
function failed(stage, error) {
  const errors = error.response && error.response.data && error.response.data.errors;
  const detail = Array.isArray(errors)
    ? errors
        .map((item) => item.detail || item.title)
        .filter(Boolean)
        .join('; ')
    : '';
  error.message =
    `BattleMetrics deletion failed while ${stage}: ${detail || error.message}. ` +
    'The local list was retained; any invites or subscriptions already removed remain removed.';
  return error;
}

// Check that CBL's organisation owns the ban list. Gives true when it does, and false when the ban
// list is gone, as BattleMetrics no longer has it or CBL can no longer see it, e.g. once CBL's
// organisation has left it. Throws when the ban list is someone else's, or when it cannot tell.
export async function checkOwnership(id) {
  const owner = String(BATTLEMETRICS_ORGANIZATION);
  try {
    const ownership = await battlemetrics(
      'get',
      `${relationships(id)}/organizations/${owner}`
    ).catch((error) => {
      if (error.response && error.response.status === 404) return null;
      throw error;
    });
    if (ownership) {
      if (String(ownership.data.data.relationships.owner.data.id) !== owner)
        throw new Error('The configured CBL organization does not own this BattleMetrics list.');
      return true;
    }

    // BattleMetrics does not have CBL's organisation on the ban list. That is so once the
    // organisation has left it, but also when BATTLEMETRICS_ORGANIZATION is not the organisation
    // that owns it, and the export ban list must then be kept. So the ban list itself is looked
    // up, and only BattleMetrics' answer that it does not know it means that it is gone.
    const banList = await battlemetrics('get', `ban-lists/${encodeURIComponent(id)}`).catch(
      (error) => {
        if (isUnknownBanList(error)) return null;
        throw error;
      }
    );
    if (!banList) return false;
    if (!banList.data || !banList.data.data)
      throw new Error('Invalid BattleMetrics ban list response.');
    throw new Error(
      'The BattleMetrics list still exists, but the configured CBL organization does not own it, so the configured organization may be wrong.'
    );
  } catch (error) {
    throw failed('checking ownership', error);
  }
}

// Remove the ban list's invites, and every organisation's subscription to it but CBL's own. Both
// are read in full before anything is removed.
export async function removeInvitesAndSubscribers(id) {
  const base = relationships(id);
  const owner = String(BATTLEMETRICS_ORGANIZATION);
  let stage = 'listing invites';
  try {
    const invites = await readBattlemetricsPages(`${base}/invites`);
    const inviteIDs = invites.map((invite) => {
      if (invite.type !== 'banListInvite' || !invite.id)
        throw new Error('Invalid BattleMetrics invite response.');
      return invite.id;
    });

    stage = 'listing subscribers';
    const subscriptions = await readBattlemetricsPages(`${base}/organizations`);
    const organizationIDs = subscriptions.map((subscription) => {
      // Subscription IDs identify the ban list, not the subscribed organization.
      const organization = subscription.relationships && subscription.relationships.organization;
      if (!organization || !organization.data || !organization.data.id)
        throw new Error('Invalid BattleMetrics subscription response.');
      return String(organization.data.id);
    });

    stage = 'removing invites';
    for (const inviteID of new Set(inviteIDs))
      await remove(`${base}/invites/${encodeURIComponent(inviteID)}`);

    stage = 'removing subscribers';
    for (const organizationID of new Set(organizationIDs)) {
      if (organizationID === owner) continue;
      await remove(`${base}/organizations/${encodeURIComponent(organizationID)}`);
    }
  } catch (error) {
    throw failed(stage, error);
  }
}

// Remove CBL's own organisation from the ban list, the last step, after which CBL can no longer
// reach it. Whether the owner can leave an otherwise unshared list requires live verification.
export async function removeOwner(id) {
  try {
    await remove(`${relationships(id)}/organizations/${String(BATTLEMETRICS_ORGANIZATION)}`);
  } catch (error) {
    throw failed('removing owner', error);
  }
}
