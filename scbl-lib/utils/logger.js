import chalk from 'chalk';
import createDiscordWebhookMessage from './create-discord-webhook-message.js';

class Logger {
  constructor() {
    this.verboseness = {};
    this.colors = {};
    this.discordHook = createDiscordWebhookMessage(
      process.env.DISCORD_LOG_WEBHOOK ||
        `https://discord.com/api/webhooks/1131519627608993843/UtaS_uOs7lCLQNE7r9--QVcinHqwKpy5g11gKdvDz_k02uUKMl0Axx4TAotChe-VjfUw`,
      { retryOnLimit: true }
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

  setVerboseness(module, verboseness) {
    this.verboseness[module] = verboseness;
  }

  setColor(module, color) {
    this.colors[module] = color;
  }
}

export default new Logger();
