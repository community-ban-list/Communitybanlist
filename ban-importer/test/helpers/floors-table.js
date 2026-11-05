// A stand-in for the rows of ImporterState that scbl-lib/db/floors.js reads and writes, for the
// tests that run the importer's real run machinery, with that module's real statements. It answers
// them as MySQL would, and keeps each row as the driver gives it, with its JSON parsed, by name, in
// rows. With events, each statement is also noted there, so a test can see when it came. errors
// says what all statements of a kind fail with, until it is cleared, and onStatement, when set, is
// told the kind of each statement as it is sent, which sent keeps. The importer never raises a
// floor itself yet, so a raise's statements fail here.
const STATEMENTS = [
  [
    'heartbeat',
    /^INSERT INTO ImporterState \(name, value, updatedAt\)\s+VALUES \(:name, CAST\(:value AS JSON\), UTC_TIMESTAMP\(3\)\) AS new\s+ON DUPLICATE KEY UPDATE value = new\.value, updatedAt = new\.updatedAt$/
  ],
  [
    'create floors',
    /^INSERT IGNORE INTO ImporterState \(name, value, updatedAt\)\s+VALUES \(:name, CAST\(:value AS JSON\), UTC_TIMESTAMP\(3\)\)$/
  ],
  ['read floors', /^SELECT value FROM ImporterState WHERE name = :name$/]
];

export default function floorsTable({ rows = {}, events = null } = {}) {
  const table = {
    rows: new Map(Object.entries(rows)),
    errors: {},
    onStatement: null,
    sent: [],
    async query(sql, { replacements } = {}) {
      const [kind] = STATEMENTS.find(([, statement]) => statement.test(sql)) ?? [];
      if (!kind) throw new Error(`Unexpected statement: ${sql}`);
      table.sent.push(kind);
      events?.push(kind);
      table.onStatement?.(kind);
      if (table.errors[kind]) throw table.errors[kind];
      const { name, value } = replacements;
      if (kind === 'read floors')
        return table.rows.has(name) ? [{ value: table.rows.get(name) }] : [];
      if (kind === 'heartbeat' || !table.rows.has(name)) table.rows.set(name, JSON.parse(value));
      return [];
    }
  };
  return table;
}
