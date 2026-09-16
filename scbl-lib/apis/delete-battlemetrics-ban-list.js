import battlemetrics from './battlemetrics.js';
import { BATTLEMETRICS_ORGANIZATION } from '../config.js';

// Snapshot every page before deleting items so pagination cannot skip removed records.
async function readAll(endpoint) {
  const records = [];
  const visited = new Set();
  const base = new URL(`https://api.battlemetrics.com/${endpoint}`);
  let page = new URL(`${base}?page[size]=100`);
  while (page) {
    if (page.origin !== base.origin || page.pathname !== base.pathname || visited.has(page.href))
      throw new Error('Invalid BattleMetrics pagination link.');
    visited.add(page.href);
    const { data } = await battlemetrics('get', endpoint, Object.fromEntries(page.searchParams));
    if (!data || !Array.isArray(data.data))
      throw new Error('Invalid BattleMetrics collection response.');
    records.push(...data.data);
    const next = data.links && data.links.next;
    page = next ? new URL(typeof next === 'string' ? next : next.href, base) : null;
  }
  return records;
}

export default async function deleteBattlemetricsBanList(id) {
  const base = `ban-lists/${encodeURIComponent(id)}/relationships`;
  const owner = String(BATTLEMETRICS_ORGANIZATION);
  let stage = 'checking ownership';
  try {
    const { data } = await battlemetrics('get', `${base}/organizations/${owner}`);
    if (String(data.data.relationships.owner.data.id) !== owner)
      throw new Error('The configured CBL organization does not own this BattleMetrics list.');

    stage = 'listing invites';
    const invites = await readAll(`${base}/invites`);
    const inviteIDs = invites.map((invite) => {
      if (invite.type !== 'banListInvite' || !invite.id)
        throw new Error('Invalid BattleMetrics invite response.');
      return invite.id;
    });

    stage = 'listing subscribers';
    const subscriptions = await readAll(`${base}/organizations`);
    const organizationIDs = subscriptions.map((subscription) => {
      // Subscription IDs identify the ban list, not the subscribed organization.
      const organization = subscription.relationships && subscription.relationships.organization;
      if (!organization || !organization.data || !organization.data.id)
        throw new Error('Invalid BattleMetrics subscription response.');
      return String(organization.data.id);
    });

    stage = 'removing invites';
    for (const inviteID of new Set(inviteIDs))
      await battlemetrics('delete', `${base}/invites/${encodeURIComponent(inviteID)}`);

    stage = 'removing subscribers';
    for (const organizationID of new Set(organizationIDs)) {
      if (organizationID === owner) continue;
      await battlemetrics('delete', `${base}/organizations/${encodeURIComponent(organizationID)}`);
    }

    // Whether the owner can leave an otherwise unshared list requires live verification.
    stage = 'removing owner';
    await battlemetrics('delete', `${base}/organizations/${owner}`);
  } catch (error) {
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
    throw error;
  }
}
