import { SteamUser } from 'scbl-lib/db/models';
import { describeError } from 'scbl-lib/utils';

// How often the players viewed since the last save are saved as viewed, and how many can wait to be
// saved. When more are waiting, the ones viewed longest ago are left out, as Recently Viewed Players
// shows the newest.
export const VIEW_SAVE_INTERVAL = 30 * 1000;
export const MAX_WAITING_VIEWS = 5000;

// How long a save may take before it is given up on, e.g. if its database connection stops
// answering, so that later views are still saved.
export const SAVE_TIME_LIMIT = 2 * VIEW_SAVE_INTERVAL;

// The time each player was last viewed since the last save, by Steam ID, oldest view first. Views
// are only kept in memory until they are saved, so any not yet saved are lost when the web server
// stops, unless something calls flushViews first.
const waiting = new Map();

let timer = null;
let saving = null;

// Note that a player was viewed, and when, and return that time. Their lastViewed time is saved
// with others' in the background, so a profile view never waits for the database to write it, e.g.
// while the importer is updating every player's rank, and many views of one player cost one write.
export default function recordView(id) {
  const time = Date.now();
  waiting.delete(id);
  waiting.set(id, time);
  if (waiting.size > MAX_WAITING_VIEWS) waiting.delete(waiting.keys().next().value);
  scheduleSave();
  return new Date(time);
}

// Save the waiting views after the interval, unless a save is waiting or running already. A save
// that is running schedules the next one when it ends, so only one runs at a time. The timer does
// not keep the process running.
function scheduleSave() {
  if (timer || saving || waiting.size === 0) return;
  timer = setTimeout(saveViews, VIEW_SAVE_INTERVAL);
  timer.unref();
}

// Save the waiting players as viewed. Players viewed while it runs wait for the next save, and so do
// those whose rows another query has locked. If it fails or runs out of time, the views it held are
// dropped, and only the error's name and message are logged.
function saveViews() {
  timer = null;
  const views = new Map(waiting);
  waiting.clear();
  let timeLimit;
  saving = Promise.race([
    writeViews(views),
    new Promise((resolve, reject) => {
      timeLimit = setTimeout(
        reject,
        SAVE_TIME_LIMIT,
        new Error(`The save took longer than ${SAVE_TIME_LIMIT / 1000} seconds.`)
      );
      timeLimit.unref();
    })
  ])
    .then(putBack)
    .catch((err) =>
      console.error(`Could not save which players were viewed: ${describeError(err)}`)
    )
    .finally(() => {
      clearTimeout(timeLimit);
      saving = null;
      scheduleSave();
    });
  return saving;
}

// Save these players as viewed, each at the time of their own view, so Recently Viewed Players lists
// them in the order they were viewed, and return the views it left for later. It locks only the rows
// no other query has locked, and never waits for a lock, so it cannot hold up the importer's
// transactions or deadlock with them. The rows it skipped are saved next time. lastViewed is stored
// to the second, so the players are grouped by the second they were viewed in. updatedAt is left as
// it is, as a view does not change the player.
async function writeViews(views) {
  const { sequelize } = SteamUser;
  return sequelize.transaction(async (transaction) => {
    const [rows] = await sequelize.query(
      'SELECT id FROM SteamUsers WHERE id IN (:ids) FOR UPDATE SKIP LOCKED',
      { replacements: { ids: [...views.keys()] }, transaction }
    );
    const locked = new Set(rows.map((row) => row.id));
    const bySecond = new Map();
    for (const [id, time] of views) {
      if (!locked.has(id)) continue;
      const second = time - (time % 1000);
      if (!bySecond.has(second)) bySecond.set(second, []);
      bySecond.get(second).push(id);
      views.delete(id);
    }
    if (bySecond.size > 0) {
      const times = [...bySecond].map(
        ([second, ids]) =>
          `WHEN id IN (${ids.map((id) => sequelize.escape(id)).join(', ')}) THEN ${sequelize.escape(new Date(second))}`
      );
      await SteamUser.update(
        { lastViewed: sequelize.literal(`CASE ${times.join(' ')} END`) },
        { where: { id: [...bySecond.values()].flat() }, silent: true, transaction }
      );
    }
    return views;
  });
}

// Put views a save left for later back in the queue, before the views made since, which are newer.
// A player viewed again since keeps their newer view.
function putBack(views) {
  if (views.size === 0) return;
  const newer = [...waiting];
  waiting.clear();
  for (const [id, time] of [...views, ...newer]) {
    waiting.delete(id);
    waiting.set(id, time);
  }
  while (waiting.size > MAX_WAITING_VIEWS) waiting.delete(waiting.keys().next().value);
}

// Save the views that are waiting now, without waiting for the interval, e.g. before the web server
// stops. It waits for a save that is running first, so it still makes one save at a time. Like any
// save, it never rejects. Views of rows that are locked stay waiting. Nothing calls it yet: the web
// server's shutdown should await it before it closes the database.
export async function flushViews() {
  clearTimeout(timer);
  timer = null;
  for (let running = saving; running; running = saving) await running;
  clearTimeout(timer);
  timer = null;
  if (waiting.size > 0) await saveViews();
}
