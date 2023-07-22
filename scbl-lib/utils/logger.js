import chalk from 'chalk';
import createDiscordWebhookMessage from './create-discord-webhook-message.js';
import Bottleneck from 'bottleneck';

function convertToBarChart(minValue = 0, maxValue = Infinity, barValue) {
  const chartWidth = 50;
  if (minValue === maxValue) minValue = 0;
  const scaleFactor = chartWidth / ((maxValue || 1) - minValue);
  const barSize = Math.max(Math.ceil(((barValue || 1) - minValue) * scaleFactor), 1);
  const chart = `\`\`[${'█'.repeat(barSize)}${' '.repeat(chartWidth - barSize)}] ${(
    ((barValue || (maxValue > 0 ? 0 : 1)) / (maxValue || 1)) *
    100
  ).toFixed(2)}%\`\``;

  return chart;
}

class Logger {
  constructor() {
    this.verboseness = {};
    this.colors = {};
    this.discordHook = createDiscordWebhookMessage(
      process.env.DISCORD_LOG_WEBHOOK ||
        `https://discord.com/api/webhooks/1131519627608993843/UtaS_uOs7lCLQNE7r9--QVcinHqwKpy5g11gKdvDz_k02uUKMl0Axx4TAotChe-VjfUw`
    )[0];
    this.rl = new Bottleneck({
      reservoir: 5,
      reservoirRefreshAmount: 5,
      reservoirRefreshInterval: 1000,
      minTime: 201,
      maxConcurrent: 1
    });

    this.rl.on('failed', async (error, jobInfo) => {
      const id = jobInfo.options.id;
      console.warn(`Job ${id} failed`, error);

      if (jobInfo.retryCount <= 5) {
        console.log(`Retrying job ${id} in 1s!`);
        return 1000;
      } else throw error;
    });
    this.rl.on('retry', (error, jobInfo) => console.log(`Now retrying ${jobInfo.options.id}`));
  }

  async verbose(module, verboseness, message, ...extras) {
    try {
      if (verboseness === 1)
        this.rl.schedule(async () => {
          await this.discordHook.send(`[${module}][${verboseness}] ${message}`);
        });
    } catch (err) {
      console.error('Error sending Discord Log Message.', err, JSON.stringify(err));
    }

    let colorFunc = chalk[this.colors[module] || 'white'];
    if (typeof colorFunc !== 'function') colorFunc = chalk.white;

    if ((this.verboseness[module] || 2) >= verboseness)
      console.log(`[${colorFunc(module)}][${verboseness}] ${message}`, ...extras);
  }

  async discordProgressBar(module, message, discordMessage, min = 0, max = Infinity, current) {
    if (!discordMessage) {
      try {
        return this.rl.schedule(async () => {
          return await this.discordHook.send(
            `[${module}] Progress on ${message}\n${convertToBarChart(min, max, current)}`
          );
        });
      } catch (err) {
        console.error('Error sending Discord progress bar.', err, JSON.stringify(err));
      }
    } else {
      try {
        return this.rl.schedule(async () => {
          return await discordMessage.edit(
            `[${module}] Progress on ${message}\n${convertToBarChart(min, max, current)}`
          );
        });
      } catch (err) {
        console.error('Error sending Discord progress bar.', err, JSON.stringify(err));
      }
    }
  }

  getLogQueue() {
    return this.rl.counts();
  }

  setVerboseness(module, verboseness) {
    this.verboseness[module] = verboseness;
  }

  setColor(module, color) {
    this.colors[module] = color;
  }
}
let thisLogger = null;
function getLogger() {
  if (!thisLogger) thisLogger = new Logger();
  return thisLogger;
}

export default getLogger();
