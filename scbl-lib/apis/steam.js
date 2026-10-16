import axios from 'axios';
import Bottleneck from 'bottleneck';

import createApiClient from './create-api-client.js';
import { STEAM_API_KEY } from '../config.js';

if (!STEAM_API_KEY) throw new Error('Environmental variable STEAM_API_KEY must be provided.');
const STEAM_API_RESERVIOR = 200;

// How long Steam has to answer a request in full, after which the request is cut off.
const STEAM_TIMEOUT = 15 * 1000;

const rl = new Bottleneck({
  reservoir: STEAM_API_RESERVIOR,
  reservoirRefreshAmount: STEAM_API_RESERVIOR,
  reservoirRefreshInterval: 300000,
  minTime: 1500 // 300s per 200 requests as a rule of thumb to stop hitting burst rate limit on Steam
});

// Each attempt is a job of its own on the limiter, with an ID of its own, so retries use the
// budget. Steam refuses a key with 401 or 403, which is never tried again: retrying does not help,
// and partner.steam-api.com limits the whole IP address after repeated refusals. The key is sent
// in the address, which a failed request's ApiError never includes. See create-api-client.js for
// when a request is made again.
const request = createApiClient({
  name: 'Steam',
  limiter: rl,
  jobPrefix: 'STEAM',
  timeout: STEAM_TIMEOUT,
  authStatuses: [401, 403],
  secrets: [STEAM_API_KEY],
  async send(method, url, params, data, options) {
    console.log('starting steam axios request');
    const profileStartTime = Date.now();
    const response = await axios({
      method,
      // url: 'https://api.steampowered.com/' + url,
      url: 'https://partner.steam-api.com/' + url,
      params: { ...params, key: STEAM_API_KEY },
      data,
      ...options
    });
    console.log(
      `done with steam axios request after ${((Date.now() - profileStartTime) / 1000).toFixed(2)}s`
    );
    return response;
  }
});

export default async function (method, url, params, data = {}, priority = 5) {
  return request(method, url, params, data, priority);
}
