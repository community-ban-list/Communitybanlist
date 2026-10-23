// Discord's IDs, such as a message's, are snowflakes: numbers that grow with the time each was
// made, given as text, as they are too large for a JavaScript number. So which of two messages is
// the newer is told by comparing their IDs as BigInts.
//
// This file has no imports, so anything can use it.

// Whether a value is a Discord ID: a number of up to 20 digits, as Discord's IDs are 64 bits.
export function isMessageID(value) {
  return typeof value === 'string' && /^\d{1,20}$/.test(value);
}

// Whether the message whose ID is id is newer than the one whose ID is than. Anything that is not
// an ID, such as null, is older than every message.
export default function isNewerMessage(id, than) {
  if (!isMessageID(id)) return false;
  return !isMessageID(than) || BigInt(id) > BigInt(than);
}

// The newer of two messages' IDs, or null when neither is an ID.
export function newerMessage(a, b) {
  if (isNewerMessage(a, b)) return a;
  return isMessageID(b) ? b : null;
}
