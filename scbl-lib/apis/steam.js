import axios from 'axios';
import Bottleneck from 'bottleneck';
import { STEAM_API_KEY } from '../config.js';

if (!STEAM_API_KEY) throw new Error('Environmental variable STEAM_API_KEY must be provided.');
const STEAM_API_RESERVIOR = 200;
const STEAM_API_RETRIES = 5;
const STEAM_TIMEOUT = 50000;

async function withTimeout(promise) {
  const myError = new Error(`timeout`);
  const timeout = new Promise((resolve, reject) =>
    setTimeout(() => reject(myError), STEAM_TIMEOUT)
  );

  return await Promise.race([promise, timeout]);
}

const rl = new Bottleneck({
  reservoir: STEAM_API_RESERVIOR,
  reservoirRefreshAmount: STEAM_API_RESERVIOR,
  reservoirRefreshInterval: 300000,
  minTime: 1500 //300s per 200 requests as a rule of thumb to stop hitting burst rate limit on Steam
});

rl.on('failed', async (error, jobInfo) => {
  const id = jobInfo.options.id;
  console.warn(`Job ${id} failed`, error);

  if (jobInfo.retryCount <= STEAM_API_RETRIES) {
    console.log(`Retrying job ${id} in 1s!`);
    return 1000;
  } else throw error;
});

rl.on('retry', (error, jobInfo) => console.log(`Now retrying ${jobInfo.options.id}`));

const makeRequest = rl.wrap(async (method, url, params, data = {}) => {
  console.log('starting steam axios request');
  const retVar = await withTimeout(
    axios({
      method: method,
      url: 'https://api.steampowered.com/' + url,
      params: { ...params, key: STEAM_API_KEY },
      data
    })
  );
  console.log('done with steam axios request');
  return retVar;
});

export default async function (method, url, params, data = {}, priority = 5) {
  return await makeRequest.withOptions(
    { priority, id: 'STEAM-API-CALL' },
    method,
    url,
    params,
    data
  );
}
