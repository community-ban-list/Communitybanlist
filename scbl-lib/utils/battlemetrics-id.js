// BattleMetrics ban list IDs are UUIDs, which are written in either case, with or without their
// hyphens, and with spaces around them when they are copied by hand. The bot and the ban importer
// compare them with these, so an ID written another way still matches, e.g. a partner's ban list
// source and one of CBL's own export ban lists.
//
// This file has no imports, so it can be loaded on its own.

// An ID written the one way IDs are compared: in lower case, without hyphens or spaces. Anything
// that is not text, such as a missing ID, gives ''.
export function normaliseBattlemetricsID(id) {
  return typeof id === 'string' ? id.replace(/[\s-]/g, '').toLowerCase() : '';
}

// Whether two IDs are the same BattleMetrics ID, ignoring case, hyphens and spaces. An empty ID is
// never the same as another.
export default function isSameBattlemetricsID(a, b) {
  const id = normaliseBattlemetricsID(a);
  return id !== '' && id === normaliseBattlemetricsID(b);
}
