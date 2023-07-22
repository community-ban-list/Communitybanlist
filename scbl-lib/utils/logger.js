import chalk from 'chalk';
import createDiscordWebhookMessage from './create-discord-webhook-message.js';
import Bottleneck from 'bottleneck';

function convertToBarChart(minValue = 0, maxValue = Infinity, barValue) {
  const chartWidth = 50;
  if (minValue === maxValue) minValue = 0;
  const scaleFactor = chartWidth / (maxValue - minValue);
  const barSize = Math.max(Math.ceil((barValue - minValue) * scaleFactor), 1);
  const chart = `\`\`[${'█'.repeat(barSize)}${' '.repeat(chartWidth - barSize)}] ${(
    (barValue / maxValue) *
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
    )[0].bind(this);
    this.rl = new Bottleneck({
      reservoir: 5,
      reservoirRefreshAmount: 5,
      reservoirRefreshInterval: 1000,
      minTime: 200,
      maxConcurrent: 1
    });
  }

  async verbose(module, verboseness, message, ...extras) {
    try {
      if (verboseness === 1)
        this.rl.schedule(
          this.discordHook.send.bind(this),
          `[${module}][${verboseness}] ${message}`
        );
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
        return this.rl.schedule(
          this.discordHook.send.bind(this),
          `[${module}] Progress on ${message}\n${convertToBarChart(min, max, current)}`
        );
      } catch (err) {
        console.error('Error sending Discord progress bar.', err, JSON.stringify(err));
      }
    } else {
      try {
        return this.rl.schedule(
          this.discordHook.edit.bind(this),
          `[${module}] Progress on ${message}\n${convertToBarChart(min, max, current)}`
        );
      } catch (err) {
        console.error('Error sending Discord progress bar.', err, JSON.stringify(err));
      }
    }
  }

  setVerboseness(module, verboseness) {
    this.verboseness[module] = verboseness;
  }

  setColor(module, color) {
    this.colors[module] = color;
  }
}

export default new Logger();
