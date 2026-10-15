import Router from '@koa/router';

import { ExportBan } from 'scbl-lib/db/models';
import { Op } from 'scbl-lib/db/sequelize';

const router = new Router();

router.get('/:id', async (ctx) => {
  // Read the id as MySQL read it when this route passed it on as text, so every URL names the
  // same list as before: the number at the start, after any ASCII whitespace. So /export/7.txt is
  // list 7, /export/1e1 is list 10 and /export/7.5 is no list. parseFloat reads numbers the same
  // way, but also skips other Unicode spaces, hence the check. An id that is not a whole number,
  // or is too large to be one, cannot name a list, so it gets the same empty list as a list that
  // does not exist, without a query.
  const text = ctx.params.id;
  const id = /^[ \t\n\v\f\r]*[-+.\d]/.test(text) ? Number.parseFloat(text) : NaN;

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
