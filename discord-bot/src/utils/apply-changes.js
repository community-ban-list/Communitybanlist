function formatValue(value) {
  return value === null ? 'none' : `"${value}"`;
}

// Set the given values on the record, ignoring undefined ones, and describe what changed.
export default function applyChanges(record, values) {
  const changes = [];
  for (const [field, value] of Object.entries(values)) {
    if (value === undefined || value === record[field]) continue;

    changes.push(`${field} ${formatValue(record[field])} → ${formatValue(value)}`);
    record[field] = value;
  }
  return changes;
}
