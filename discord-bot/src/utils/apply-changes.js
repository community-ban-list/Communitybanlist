import { quote } from './format.js';

// A value as the audit log gives it: none, or in quotes. A name is free text, so it is shown as
// written (see quote), as the record it names is; a type, source or link is given as it is.
function formatValue(field, value) {
  if (value === null) return 'none';
  return field === 'name' ? quote(value) : `"${value}"`;
}

// Set the given values on the record, ignoring undefined ones, and describe what changed, for the
// audit log.
export default function applyChanges(record, values) {
  const changes = [];
  for (const [field, value] of Object.entries(values)) {
    if (value === undefined || value === record[field]) continue;

    changes.push(`${field} ${formatValue(field, record[field])} → ${formatValue(field, value)}`);
    record[field] = value;
  }
  return changes;
}
