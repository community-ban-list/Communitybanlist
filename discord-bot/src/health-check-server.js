import http from 'http';

import { Status } from 'discord.js';

import { sequelize } from 'scbl-lib/db';

import { HEALTH_CHECK_PORT } from './config.js';

const DATABASE_TIMEOUT = 5000;

function checkDiscord(client) {
  if (!client.isReady()) return 'not logged in';

  // The client stays ready while its connection to Discord drops and reconnects, so check that too.
  return client.ws.shards.every((shard) => shard.status === Status.Ready)
    ? 'connected'
    : 'reconnecting';
}

async function checkDatabase() {
  let timeout;
  try {
    await Promise.race([
      sequelize.authenticate(),
      new Promise((resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('timed out')), DATABASE_TIMEOUT);
      })
    ]);
    return 'connected';
  } catch (err) {
    return `error: ${err.message}`;
  } finally {
    clearTimeout(timeout);
  }
}

// Serve whether the bot is connected to Discord and the database, for the Docker health check.
export default function startHealthCheckServer(client) {
  return http
    .createServer(async (req, res) => {
      const status = { discord: checkDiscord(client), database: await checkDatabase() };
      const healthy = status.discord === 'connected' && status.database === 'connected';

      res.writeHead(healthy ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(status));
    })
    .on('error', (err) => console.error('Health check server failed:', err))
    .listen(HEALTH_CHECK_PORT, '127.0.0.1');
}
