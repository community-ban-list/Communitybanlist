/**
 * @file PM2 Configuration File.
 */
module.exports = {
  apps: [
    {
      name: 'CBL Web Server',
      script: './ban-importer/index.js',
      listen_timeout: 3000,
      wait_ready: true,
      log_date_format: 'YYYY-MM-DD HH:mm Z',
      env: {
        NODE_ENV: 'production'
      }
    }
  ]
};
