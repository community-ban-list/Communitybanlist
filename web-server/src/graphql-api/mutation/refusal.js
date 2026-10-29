// The error for a change that is refused before anything is saved or BattleMetrics is asked for
// anything, with the message to show the user. Most are refused by the checks, before a webhook is
// tested; some come as the change is saved, after any webhook test, such as a list that changed
// meanwhile or a database too busy to save it (see saveOwnList and inTransaction in resolver.js).
// guard-changes.js does not count a refused creation or deletion towards its limits, so the user
// can correct the change and try again at once.
export default function refusal(message) {
  return Object.assign(new Error(message), { refusal: true });
}
