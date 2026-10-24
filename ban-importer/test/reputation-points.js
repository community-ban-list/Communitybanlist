import assert from 'assert';
import { readdir, readFile } from 'fs/promises';
import vm from 'vm';

import {
  FIND_MISMATCHED,
  POINTS,
  POINTS_MONTH_BEFORE,
  pointsOf,
  RECALCULATE_POINTS
} from '../src/reputation-points.js';

// Check the rule that players' reputation points are worked out by, without a database: the
// statement that recalculates the points of the players queued for it is the one the importer ran
// before the rule was shared, token for token, Core.updateReputationPoints sends it as it sent that
// one, and the reputation check compares players' stored points with the same table of their
// points that it joins, so the check finds exactly the players whose points the recalculation
// would change. No other file of the importer has a rule of its own. That the statements give the
// same results on MySQL as before is shown by the production-scale run, which runs the old and the
// new one on the same players.

// The statement Core.updateReputationPoints sent before the rule was shared, as it was written.
const BEFORE = `
        UPDATE SteamUsers SU
        LEFT JOIN (
          SELECT
            PPBL.steamUser,
            SUM(PPBL.points) AS "points"
          FROM (
            SELECT
              B.steamUser,
              IF(
                SUM(
                  IF(
                    B.expires IS NULL OR B.expires >= NOW(),
                    1,
                    0
                  )
                ) > 0,
                3,
                0
              ) +
              SUM(
                IF(
                  B.expires IS NULL OR B.expires >= NOW(),
                  0,
                  1
                )
              ) AS "points"
            FROM Bans B
            GROUP BY B.banList, B.steamUser
          ) PPBL
          GROUP BY PPBL.steamUser
        ) PPBLC ON SU.id = PPBLC.steamUser
        LEFT JOIN (
          SELECT
            PPBL.steamUser,
            SUM(PPBL.points) AS "points"
          FROM (
            SELECT
              B.steamUser,
              IF(
                SUM(
                  IF(
                    B.expires IS NULL OR B.expires >= NOW() - INTERVAL 1 MONTH,
                    1,
                    0
                  )
                ) > 0,
                3,
                0
              ) +
              SUM(
                IF(
                  B.expires IS NULL OR B.expires >= NOW() - INTERVAL 1 MONTH,
                  0,
                  1
                )
              ) AS "points"
            FROM Bans B
            WHERE B.created < NOW() - INTERVAL 1 MONTH
            GROUP BY B.banList, B.steamUser
          ) PPBL
          GROUP BY PPBL.steamUser
        ) PPBLMB ON SU.id = PPBLMB.steamUser
        SET
          SU.reputationPoints = IFNULL(PPBLC.points, 0),
          SU.reputationPointsMonthBefore = IFNULL(PPBLMB.points, 0),
          SU.reputationPointsMonthChange = IFNULL(PPBLC.points, 0) - IFNULL(PPBLMB.points, 0),
          SU.lastRefreshedReputationPoints = NOW()
        WHERE SU.lastRefreshedReputationPoints IS NULL
      `;

// SQL as its tokens, so statements that differ only in their spacing and line breaks compare equal.
const tokens = (sql) => sql.match(/<=>|>=|<=|<>|"[^"]*"|[A-Za-z_][\w.]*|\d+|\S/g);

// The recalculation is the statement it was, token for token, so it recalculates every player it
// did, as it did, with their points a month before still counting only bans created over a month
// ago, each active or not as it was then.
assert.deepStrictEqual(tokens(RECALCULATE_POINTS), tokens(BEFORE));
assert.ok(tokens(BEFORE).length > 150);

// It joins the table of each player's points now, and the one of their points a month before,
// which is the same table, with a month ago for now and only the bans created before then.
assert.ok(RECALCULATE_POINTS.includes(`LEFT JOIN (${POINTS}) PPBLC ON SU.id = PPBLC.steamUser`));
assert.ok(
  RECALCULATE_POINTS.includes(
    `LEFT JOIN (${POINTS_MONTH_BEFORE}) PPBLMB ON SU.id = PPBLMB.steamUser`
  )
);
assert.deepStrictEqual(
  tokens(POINTS_MONTH_BEFORE),
  tokens(
    POINTS.replaceAll('NOW()', 'NOW() - INTERVAL 1 MONTH').replace(
      'FROM Bans B',
      'FROM Bans B WHERE B.created < NOW() - INTERVAL 1 MONTH'
    )
  )
);
assert.ok(!POINTS.includes('WHERE'), 'Points now count every ban');

// The check joins the very same table of players' points now, and compares their stored points
// with what the recalculation would write, a player with no bans having 0, and NULL points not
// matching any. It compares only the players the recalculation would not recalculate anyway, those
// not queued for it, by ID, in order, and is a plain SELECT, which locks nothing. It compares their
// points now only, not their points a month before.
assert.ok(FIND_MISMATCHED.includes(`LEFT JOIN (${POINTS}) P ON SU.id = P.steamUser`));
assert.ok(RECALCULATE_POINTS.includes(`SU.reputationPoints = ${pointsOf('PPBLC')},`));
assert.strictEqual(pointsOf('P'), 'IFNULL(P.points, 0)');
const find = tokens(FIND_MISMATCHED).join(' ');
assert.ok(
  find.startsWith(
    'SELECT SU.id , SU.reputationPoints , IFNULL ( P.points , 0 ) AS points FROM SteamUsers SU'
  )
);
assert.ok(
  find.endsWith(
    'WHERE SU.lastRefreshedReputationPoints IS NOT NULL AND NOT ( SU.reputationPoints <=> IFNULL ( P.points , 0 ) ) ORDER BY SU.id'
  ),
  find
);
assert.ok(RECALCULATE_POINTS.trim().endsWith('WHERE SU.lastRefreshedReputationPoints IS NULL'));
assert.doesNotMatch(FIND_MISMATCHED, /FOR UPDATE|FOR SHARE|LOCK IN SHARE MODE|MonthBefore/i);

// Core.updateReputationPoints sends the recalculation as it sent it before: one statement, on its
// own, outside any transaction. core.js is loaded with the real reputation-points.js, and empty
// stand-ins for its other imports, named from its import statements.
{
  const queries = [];
  const stubs = {
    'scbl-lib/db': {
      sequelize: {
        QueryTypes: { BULKUPDATE: 'BULKUPDATE' },
        async query(sql, options) {
          queries.push({ sql, options });
          return 3;
        }
      }
    },
    'scbl-lib/utils': { Logger: { verbose() {} } },
    './apply-list.js': { retryOperation: (operation) => operation() }
  };
  const url = new URL('../src/core.js', import.meta.url);
  const source = await readFile(url, 'utf8');
  const imports = {};
  for (const [, names, specifier] of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*'([^']+)'/g))
    imports[specifier] = names
      .split(',')
      .map((name) => name.trim().split(/\s+as\s+/)[0])
      .filter(Boolean);
  const context = vm.createContext({});
  const module = new vm.SourceTextModule(source, { context, identifier: url.href });
  await module.link(async (specifier, referencingModule) => {
    if (specifier === './reputation-points.js') {
      const shared = new URL(specifier, referencingModule.identifier);
      return new vm.SourceTextModule(await readFile(shared, 'utf8'), {
        context,
        identifier: shared.href
      });
    }
    assert.ok(imports[specifier], `Unexpected dependency: ${specifier}`);
    const exports = Object.fromEntries(imports[specifier].map((name) => [name, undefined]));
    Object.assign(exports, stubs[specifier]);
    return new vm.SyntheticModule(
      Object.keys(exports),
      function () {
        for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
      },
      { context }
    );
  });
  await module.evaluate();
  await module.namespace.default.updateReputationPoints();
  assert.strictEqual(queries.length, 1);
  assert.strictEqual(queries[0].sql, RECALCULATE_POINTS);
  assert.deepStrictEqual({ ...queries[0].options }, { type: 'BULKUPDATE' });
}

// The rule is written in reputation-points.js only: no other file of the importer works out points
// from bans' expiries in a statement of its own, so the recalculation and the check cannot drift
// apart.
{
  const dir = new URL('../src/', import.meta.url);
  const files = (await readdir(dir, { recursive: true })).filter((name) => name.endsWith('.js'));
  const withRule = [];
  for (const name of files) {
    const source = await readFile(new URL(name, dir), 'utf8');
    if (/B\.expires\s*>=|IF\(\s*SUM\(/i.test(source)) withRule.push(name);
  }
  assert.deepStrictEqual(withRule, ['reputation-points.js']);
}

console.log(
  'Reputation points checks passed: the recalculation unchanged token for token and sent as before, the check joining the same table of points, and the rule written in one place.'
);
