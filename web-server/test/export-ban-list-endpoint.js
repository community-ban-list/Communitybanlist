import assert from 'assert';
import { readFile } from 'fs/promises';
import http from 'http';
import vm from 'vm';

import Router from '@koa/router';
import Koa from 'koa';

// Exercise the /export/:id route without a database. The stand-in for ExportBan records each
// query and answers it from these rows, as MySQL would.
const Op = { in: Symbol('in') };
const rows = [
  { steamUser: '76561198000000001', exportBanList: 7, status: 'CREATED' },
  { steamUser: '76561198000000002', exportBanList: 7, status: 'TO_BE_DELETED' },
  { steamUser: '76561198000000003', exportBanList: 7, status: 'TO_BE_CREATED' },
  { steamUser: '76561198000000004', exportBanList: 7, status: null },
  { steamUser: '76561198000000005', exportBanList: 8, status: 'CREATED' },
  { steamUser: '76561198000000006', exportBanList: 7, status: 'CREATED' },
  { steamUser: ' <b>76561198000000007</b>', exportBanList: 9, status: 'CREATED' },
  { steamUser: '76561198000000008', exportBanList: 9, status: 'CREATED' }
];
const queries = [];
const ExportBan = {
  async findAll(options) {
    queries.push(options);
    const { exportBanList, status } = options.where;
    return rows
      .filter((row) => row.exportBanList === exportBanList && status[Op.in].includes(row.status))
      .map((row) => Object.fromEntries(options.attributes.map((name) => [name, row[name]])));
  }
};
const dependencies = {
  '@koa/router': { default: Router },
  'scbl-lib/db/models': { ExportBan },
  'scbl-lib/db/sequelize': { Op }
};

// Evaluate the route in this context, so the queries it builds can be compared as they are.
const source = await readFile(new URL('../src/export-ban-lists.js', import.meta.url), 'utf8');
const module = new vm.SourceTextModule(source);
await module.link((specifier) => {
  const exports = dependencies[specifier];
  assert.ok(exports, `Unexpected dependency: ${specifier}`);
  return new vm.SyntheticModule(Object.keys(exports), function () {
    for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
  });
});
await module.evaluate();
const exportBanLists = module.namespace.default;

// Mount the route as the web server does, and send requests through it without opening a socket.
const app = new Koa();
const router = new Router();
router.use('/export', exportBanLists.routes(), exportBanLists.allowedMethods());
const routes = router.routes();
async function get(path) {
  const req = new http.IncomingMessage(null);
  req.method = 'GET';
  req.url = path;
  const ctx = app.createContext(req, new http.ServerResponse(req));
  await routes(ctx, async () => {});
  return {
    status: ctx.status,
    type: ctx.response.get('Content-Type'),
    length: ctx.length,
    body: ctx.body
  };
}
const query = (id) => ({
  attributes: ['steamUser'],
  where: { exportBanList: id, status: { [Op.in]: ['TO_BE_CREATED', 'CREATED'] } },
  raw: true
});

// A list serves the players who are on it now, in the order the rows come back: not those waiting
// to be removed (TO_BE_DELETED), nor rows without a status. Only the Steam IDs are fetched, as
// plain rows.
const body = '76561198000000001:0\n76561198000000003:0\n76561198000000006:0';
assert.deepStrictEqual(await get('/export/7'), {
  status: 200,
  type: 'text/plain; charset=utf-8',
  length: Buffer.byteLength(body),
  body
});
assert.deepStrictEqual(queries.splice(0), [query(7)]);

// Ids are read as MySQL read them when the route passed them on as text: the number at the start,
// after any ASCII whitespace, decimals and exponent included. So these are list 7 too.
for (const id of ['07', '7.txt', '7.0', '+7', ' 7', '\n7', '0.7e1', '.7e1']) {
  const response = await get(`/export/${encodeURIComponent(id)}`);
  assert.strictEqual(response.body, body, `List for ${JSON.stringify(id)}`);
  assert.deepStrictEqual(queries.splice(0), [query(7)], `Query for ${JSON.stringify(id)}`);
}

// A list is always served as plain text, whatever its first line holds. Koa would otherwise guess
// the type from the body, and take one that starts with '<' for HTML.
const markup = ' <b>76561198000000007</b>:0\n76561198000000008:0';
assert.deepStrictEqual(await get('/export/9'), {
  status: 200,
  type: 'text/plain; charset=utf-8',
  length: Buffer.byteLength(markup),
  body: markup
});
assert.deepStrictEqual(queries.splice(0), [query(9)]);

// A list that does not exist gets an empty list, such as list 10, which /export/1e1 names.
const empty = { status: 200, type: 'text/plain; charset=utf-8', length: 0, body: '' };
for (const [id, list] of Object.entries({ 99: 99, '1e1': 10 })) {
  assert.deepStrictEqual(await get(`/export/${id}`), empty, `Response for ${JSON.stringify(id)}`);
  assert.deepStrictEqual(queries.splice(0), [query(list)], `Query for ${JSON.stringify(id)}`);
}

// So does an id that cannot name a list, without a query: one that is not a whole number, that
// starts with something other than a number (here a no-break space, which parseFloat skips but
// MySQL did not), or that is too large to be an id.
for (const id of ['abc', '7.5', '\u00a07', 'Infinity', '12345678901234567890', '9'.repeat(400)]) {
  const response = await get(`/export/${encodeURIComponent(id)}`);
  assert.deepStrictEqual(response, empty, `Response for ${JSON.stringify(id)}`);
}
assert.strictEqual(queries.length, 0);

console.log(
  'Export endpoint checks passed: current rows only, slim query, id parsing and response format.'
);
