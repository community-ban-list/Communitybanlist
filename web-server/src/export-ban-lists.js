import Router from '@koa/router';

import { ExportBan } from 'scbl-lib/db/models';
import { Op } from 'scbl-lib/db/sequelize';

const router = new Router();

router.get('/:id', async (ctx) => {
  // Read the id as a whole number, which also accepts URLs such as /export/7.txt. An id that does
  // not start with a number, or is too large to be one, cannot name a list, so it gets the same
  // empty list as a list that does not exist, without a query.
  const id = parseInt(ctx.params.id, 10);

  // Serve the players on the list now: players who no longer qualify stay TO_BE_DELETED until the
  // importer's export step removes them, which can take hours. Naming the statuses also leaves out
  // rows without one, which the column allows but nothing writes. Lists can have tens of
  // thousands of rows, so fetch only the Steam IDs, as plain rows rather than model instances.
  const exportBans = Number.isSafeInteger(id)
    ? await ExportBan.findAll({
        attributes: ['steamUser'],
        where: { exportBanList: id, status: { [Op.in]: ['TO_BE_CREATED', 'CREATED'] } },
        raw: true
      })
    : [];

  ctx.body = exportBans.map((exportBan) => `${exportBan.steamUser}:0`).join('\n');
});

export default router;
