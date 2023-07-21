import chalk from 'chalk';
import createDiscordWebhookMessage from './create-discord-webhook-message.js';

function convertToBarChart(minValue = 0, maxValue = Infinity, barValue) {
  const chartWidth = 50;
  if (minValue === maxValue) minValue = 0;
  const scaleFactor = (chartWidth - 1) / (maxValue - minValue);
  const barSize = Math.max(Math.ceil((barValue - minValue) * scaleFactor), 1);
  const chart = `\`\`[${'#'.repeat(barSize)}${' '.repeat(chartWidth - barSize)}] ${(
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
    )[0];
  }

  async verbose(module, verboseness, message, ...extras) {
    try {
      if (verboseness === 1) await this.discordHook.send(`[${module}][${verboseness}] ${message}`);
    } catch (e) {
      console.log('Error sending Discord Log Message.', e);
    }

    let colorFunc = chalk[this.colors[module] || 'white'];
    if (typeof colorFunc !== 'function') colorFunc = chalk.white;

    if ((this.verboseness[module] || 2) >= verboseness)
      console.log(`[${colorFunc(module)}][${verboseness}] ${message}`, ...extras);
  }

  async discordProgressBar(module, message, discordMessage, min = 0, max = Infinity, current) {
    if (!discordMessage) {
      try {
        return await this.discordHook.send(
          `[${module}] Progress on ${message}\n${convertToBarChart(min, max, current)}`
        );
      } catch (e) {
        console.log('Error sending Discord progress bar.', e);
      }
    } else {
      try {
        return await discordMessage.edit(
          `[${module}] Progress on ${message}\n${convertToBarChart(min, max, current)}`
        );
      } catch (e) {
        console.log('Error sending Discord progress bar.', e);
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
