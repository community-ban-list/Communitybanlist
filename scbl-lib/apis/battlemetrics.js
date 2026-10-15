import axios from 'axios';
import Bottleneck from 'bottleneck';

import {
  BATTLEMETRICS_API_KEY,
  BATTLEMETRICS_API_RESERVOIR,
  BATTLEMETRICS_API_RESERVOIR_VARIABLE
} from '../config.js';

const BATTLEMETRICS_TIMEOUT = 60000;
const BATTLEMETRICS_API_RETRIES = 20;

// BattleMetrics allows 300 requests a minute for the whole API key. The web server and the
// importer share it, each with a budget of its own from BATTLEMETRICS_API_RESERVOIR.
const BATTLEMETRICS_LIMIT = 300;
const DEFAULT_REQUESTS_PER_MINUTE = 10;
const HIGH_REQUESTS_PER_MINUTE = 200;

// Requests start at least this far apart to stay under BattleMetrics' burst limit, so the client
// never sends more than about MAX_REQUESTS_PER_MINUTE, whatever the budget.
const MIN_TIME = 214;
const MAX_REQUESTS_PER_MINUTE = Math.floor((60 * 1000) / MIN_TIME);

if (!BATTLEMETRICS_API_KEY)
  throw new Error('Environmental variable BATTLEMETRICS_API_KEY must be provided.');

async function withTimeout(promise) {
  const myError = new Error(`timeout`);
  const timeout = new Promise((resolve, reject) =>
    setTimeout(() => reject(myError), BATTLEMETRICS_TIMEOUT)
  );

  return await Promise.race([promise, timeout]);
}

const VARIABLE = BATTLEMETRICS_API_RESERVOIR_VARIABLE || 'BATTLEMETRICS_API_RESERVOIR';

// An invalid budget, such as 0, would stop every request, so it is replaced with the default.
function readBudget(value) {
  if (value === undefined || String(value).trim() === '')
    return { perMinute: DEFAULT_REQUESTS_PER_MINUTE, valid: true };

  const budget = Number(value);
  if (Number.isInteger(budget) && budget > 0) return { perMinute: budget, valid: true };
  return { perMinute: DEFAULT_REQUESTS_PER_MINUTE, valid: false };
}

const { perMinute: REQUESTS_PER_MINUTE, valid: BUDGET_VALID } = readBudget(
  BATTLEMETRICS_API_RESERVOIR
);

// Describe the budget when the first request is made, so services that load this client without
// using it, such as the Discord bot, do not report one.
let budgetReported = false;
function reportBudget() {
  if (budgetReported) return;
  budgetReported = true;

  if (!BUDGET_VALID)
    console.warn(
      `Warning: ${VARIABLE} must be a whole number above 0, not "${BATTLEMETRICS_API_RESERVOIR}", so the default of ${DEFAULT_REQUESTS_PER_MINUTE} is used.`
    );

  const source = !BATTLEMETRICS_API_RESERVOIR_VARIABLE
    ? 'the default, as BATTLEMETRICS_API_RESERVOIR is not set'
    : BATTLEMETRICS_API_RESERVOIR_VARIABLE === 'BATTLEMETRICS_API_RESERVIOR'
      ? 'from BATTLEMETRICS_API_RESERVIOR, the old spelling of BATTLEMETRICS_API_RESERVOIR'
      : 'from BATTLEMETRICS_API_RESERVOIR';
  console.log(`BattleMetrics budget: ${REQUESTS_PER_MINUTE} requests a minute (${source}).`);

  if (REQUESTS_PER_MINUTE > BATTLEMETRICS_LIMIT)
    console.warn(
      `Warning: a BattleMetrics budget of ${REQUESTS_PER_MINUTE} is over BattleMetrics' limit of ${BATTLEMETRICS_LIMIT} requests a minute for the whole API key.`
    );
  else if (REQUESTS_PER_MINUTE > HIGH_REQUESTS_PER_MINUTE)
    console.warn(
      `Warning: a BattleMetrics budget of ${REQUESTS_PER_MINUTE} leaves little of BattleMetrics' ${BATTLEMETRICS_LIMIT} requests a minute for the web server and importer together, which must stay under it.`
    );
  if (REQUESTS_PER_MINUTE > MAX_REQUESTS_PER_MINUTE)
    console.warn(
      `Warning: requests start at least ${MIN_TIME} ms apart, so no more than about ${MAX_REQUESTS_PER_MINUTE} are sent a minute.`
    );
}

const rl = new Bottleneck({
  reservoir: REQUESTS_PER_MINUTE,
  reservoirRefreshAmount: REQUESTS_PER_MINUTE,
  reservoirRefreshInterval: 60 * 1000,
  minTime: MIN_TIME // stop hitting burst rate limit on BM
});

rl.on('failed', async (error, jobInfo) => {
  const id = jobInfo.options.id;
  console.warn(`Job ${id} failed`, error);

  if (jobInfo.retryCount <= BATTLEMETRICS_API_RETRIES) {
    console.log(`Retrying job ${id} in 1s!`);
    return 1000;
  } else throw error;
});

// eslint-disable-next-line n/handle-callback-err
rl.on('retry', (error, jobInfo) => console.log(`Now retrying ${jobInfo.options.id}`));

const makeRequest = rl.wrap(async (method, endpoint, params, data) => {
  console.log('Starting BM axios request');
  const profileStartTime = Date.now();
  const retVar = await withTimeout(
    axios({
      method,
      url: 'https://api.battlemetrics.com/' + endpoint,
      params,
      data,
      headers: { Authorization: `Bearer ${BATTLEMETRICS_API_KEY}` }
    })
  );
  console.log(
    `Done with BM axios request after ${((Date.now() - profileStartTime) / 1000).toFixed(2)}s`
  );
  return retVar;
});

// Each request gets a job ID of its own. Bottleneck rejects a job while another with the same ID is
// waiting or running, so a shared ID made requests fail whenever two were made at once.
let jobCount = 0;

export default async function (method, url, params, data, priority = 5) {
  reportBudget();
  jobCount++;
  return makeRequest.withOptions({ priority, id: `BM-${jobCount}` }, method, url, params, data);
}
