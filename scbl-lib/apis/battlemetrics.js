import axios from 'axios';
import Bottleneck from 'bottleneck';

import { BATTLEMETRICS_API_KEY, BATTLEMETRICS_API_RESERVIOR } from '../config.js';

const BATTLEMETRICS_TIMEOUT = 60000;
const BATTLEMETRICS_API_RETRIES = 20;

if (!BATTLEMETRICS_API_KEY)
  throw new Error('Environmental variable BATTLEMETRICS_API_KEY must be provided.');

async function withTimeout(promise) {
  const myError = new Error(`timeout`);
  const timeout = new Promise((resolve, reject) =>
    setTimeout(() => reject(myError), BATTLEMETRICS_TIMEOUT)
  );

  return await Promise.race([promise, timeout]);
}

const rl = new Bottleneck({
  reservoir: BATTLEMETRICS_API_RESERVIOR,
  reservoirRefreshAmount: BATTLEMETRICS_API_RESERVIOR,
  reservoirRefreshInterval: 60 * 1000,
  minTime: 214 // 280/60, stop hitting burst rate limit on BM
});

rl.on('failed', async (error, jobInfo) => {
  const id = jobInfo.options.id;
  console.warn(`Job ${id} failed`, error);

  if (jobInfo.retryCount <= BATTLEMETRICS_API_RETRIES) {
    console.log(`Retrying job ${id} in 1s!`);
    return 1000;
  } else throw error;
});

// eslint-disable-next-line handle-callback-err
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

export default async function (method, url, params, data = {}, priority = 5) {
  return makeRequest.withOptions({ priority, id: 'BM-API-CALL' }, method, url, params, data);
}
