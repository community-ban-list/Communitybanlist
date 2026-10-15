// Describe an error in one line, by its name, message and HTTP status. Errors from API clients
// such as axios also hold the request they were for, with its address and headers, and so the API
// keys and webhook tokens in them, so errors must be logged this way rather than whole.
//
// This file has no imports, so it can be loaded on its own.
export default function describeError(err) {
  if (typeof err?.message !== 'string') {
    // Name only the kind of value, as an object's text could be an address with a token in it.
    const isObject = (typeof err === 'object' && err !== null) || typeof err === 'function';
    return isObject ? Object.prototype.toString.call(err) : String(err);
  }

  const name = typeof err.name === 'string' && err.name ? err.name : 'Error';
  // Some network errors only have a code, e.g. ECONNREFUSED.
  const message = (err.message || (typeof err.code === 'string' ? err.code : ''))
    .replace(/\s+/g, ' ')
    .trim();
  const status = [err.response?.status, err.status].find(Number.isInteger);

  let description = message ? `${name}: ${message}` : name;
  // Add the HTTP status unless the message already gives it.
  if (status && !message.includes(String(status))) description += ` (HTTP ${status})`;
  return description;
}
