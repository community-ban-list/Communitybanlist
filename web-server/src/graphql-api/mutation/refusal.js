// The error for a change that is refused before anything is saved, a webhook is tested or
// BattleMetrics is asked for anything, with the message to show the user. guard-changes.js does
// not count a refused creation or deletion towards its limits, so the user can correct the change
// and try again at once.
export default function refusal(message) {
  return Object.assign(new Error(message), { refusal: true });
}
