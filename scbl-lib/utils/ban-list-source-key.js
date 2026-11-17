import { createHash } from 'crypto';

// A SHA-256 of a ban list's type and source, which the ban importer keeps in the list's BanListSyncs
// row (sourceKey), by which the row tells that the list's type or source was changed since the row
// was written: the importer then reads the list afresh, and the bot's /banlist status does not give
// what the row says as the list's own. Both work it out here, so they always agree.
//
// This file imports only Node's crypto, so it can be loaded on its own.
export default function sourceKey({ type, source }) {
  return createHash('sha256')
    .update(JSON.stringify([type ?? null, source ?? null]))
    .digest('hex');
}
