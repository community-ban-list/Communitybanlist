import chalk from 'chalk';
import Bottleneck from 'bottleneck';

import describeError, { stackTrace } from './describe-error.js';
import sendDiscordWebhook, {
  DELETED_WEBHOOK_CODES,
  editDiscordWebhookMessage
} from './discord-webhook.js';
import isDiscordWebhookUrl from './discord-webhook-url.js';

// Messages to the log channel are sent one at a time, at most one every 400 ms. That is right at
// Discord's limit for a webhook of 5 every 2 seconds, so a burst can still be rate limited now and
// then, as can a request when another service posts to the same webhook. Such a request is tried
// again after the wait Discord asks for.
const MIN_TIME = 400;

// At most 200 messages, or 80 seconds of them, wait to be sent. When more arrive, the least
// important are dropped first: progress bars, then other messages, then errors. A run's own lines,
// such as its start, failure and summary, go ahead of all of these and are never dropped for them.
// Bottleneck sends the lowest numbers first.
const MAX_QUEUED = 200;
const RUN_PRIORITY = 2;
const ERROR_PRIORITY = 4;
const MESSAGE_PRIORITY = 5;
const PROGRESS_PRIORITY = 9;

// A request Discord rate limited or failed (HTTP 429 or 5xx) is tried once more, after the wait
// Discord asked for, but never more than 10 seconds, or after 1 second when it did not say.
const MAX_RETRY_WAIT = 10 * 1000;
const DEFAULT_RETRY_WAIT = 1000;

// A message Discord could not be reached for, or did not answer in time, is tried twice more,
// after 1 and then 3 seconds, so a network blip of a few seconds loses nothing.
const NETWORK_RETRY_WAITS = [1000, 3000];

// Discord allows 2,000 characters a message.
const MAX_MESSAGE_LENGTH = 1900;

// A progress bar is edited at most once every 15 seconds, with its latest value.
const PROGRESS_BAR_INTERVAL = 15 * 1000;

function convertToBarChart(minValue = 0, maxValue = 1, barValue) {
  const chartWidth = 50;
  if (minValue === maxValue) minValue = 0;
  const scaleFactor = chartWidth / ((maxValue || 1) - minValue);
  // Keep the bar between 1 and 50 cells, as rounding can give 51 for a full bar, e.g. 182 of 182.
  const barSize = Math.min(
    Math.max(Math.ceil(((barValue || 1) - minValue) * scaleFactor), 1),
    chartWidth
  );
  const chart = `\`\`[${'█'.repeat(barSize)}${' '.repeat(
    chartWidth - barSize
  )}] ${barValue}/${maxValue}\`\``;

  // (${(((barValue || (maxValue > 0 ? 0 : 1)) / (maxValue || 1)) * 100).toFixed(2)}%)

  return chart;
}

// Cut a message to fit in a Discord message.
function truncate(content) {
  return content.length > MAX_MESSAGE_LENGTH
    ? `${content.slice(0, MAX_MESSAGE_LENGTH - 1)}…`
    : content;
}

// Whether a value passed to the logger is an error. Some libraries throw errors that are not
// instances of Error.
function isError(value) {
  return typeof value?.message === 'string';
}

// A progress bar in the log channel, which discordProgressBar returns at once. It is posted in the
// background, then edited at most once every 15 seconds with its latest value, so a step that
// updates it thousands of times sends a few edits and never waits for Discord.
class ProgressBar {
  constructor(logger, content) {
    this.logger = logger;
    this.messageID = null;
    // The latest value, while it waits to be sent.
    this.waiting = null;
    this.sending = false;
    this.sentAt = 0;
    this.timer = null;
    this.flushing = false;
    // Without Discord logging, or once the bar could not be posted, updates do nothing rather than
    // post new bars.
    this.stopped = !logger.discordWebhook;
    if (!this.stopped) this.send(content);
  }

  update(content) {
    if (this.stopped) return;
    this.wait(content);
    this.sendLatest();
  }

  // Send the latest value now rather than when it is due, e.g. before the service exits.
  flush() {
    if (this.stopped || this.waiting === null) return;
    this.flushing = true;
    clearTimeout(this.timer);
    this.timer = null;
    this.sendLatest();
  }

  wait(content) {
    this.waiting = content;
    if (content === null) this.logger.waitingProgressBars.delete(this);
    else this.logger.waitingProgressBars.add(this);
  }

  stop() {
    this.stopped = true;
    this.wait(null);
    clearTimeout(this.timer);
    this.timer = null;
  }

  // Send the latest value, once the last one has been sent and 15 seconds have passed since.
  sendLatest() {
    // Stop once Discord logging is off, as it is when its webhook turns out to be gone.
    if (!this.logger.discordWebhook) this.stop();
    if (this.stopped || this.sending || this.timer || this.waiting === null) return;

    const due = this.flushing ? 0 : this.sentAt + PROGRESS_BAR_INTERVAL - Date.now();
    if (due > 0) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.sendLatest();
      }, due);
      // A value waiting to be sent must not keep the process running.
      this.timer.unref?.();
      return;
    }

    const content = this.waiting;
    this.wait(null);
    this.flushing = false;
    this.send(content);
  }

  send(content) {
    this.sending = true;
    this.logger.queue(
      PROGRESS_PRIORITY,
      async () => {
        try {
          // The webhook is read only now, as Discord logging is turned off if it turns out to be
          // gone, maybe while this waited.
          const webhook = this.logger.discordWebhook;
          if (!webhook) {
            this.stop();
          } else if (this.messageID) {
            await this.logger.withRetry(() =>
              editDiscordWebhookMessage(webhook, this.messageID, { content: truncate(content) })
            );
          } else {
            const message = await this.logger.withRetry(() =>
              sendDiscordWebhook(webhook, { content: truncate(content) })
            );
            if (!message?.id) throw new Error('Discord did not say which message it posted');
            this.messageID = message.id;
          }
        } catch (err) {
          if (!this.logger.webhookGone(err))
            console.warn(
              `Could not ${this.messageID ? 'update' : 'post'} a progress bar in the Discord log: ${describeError(err)}`
            );
          this.failed(content, err?.status);
        }
        this.done();
      },
      () => {
        this.failed(content);
        this.done();
      }
    );
  }

  // After a send failed or was dropped, give up on a bar that was never posted, or that Discord
  // refused to edit, e.g. because its message was deleted. Otherwise send the value again when the
  // next one is due, unless a newer value is waiting.
  failed(content, status) {
    if (!this.messageID || (status >= 400 && status < 500 && status !== 429)) this.stop();
    else if (this.waiting === null) this.wait(content);
  }

  done() {
    this.sending = false;
    this.sentAt = Date.now();
    this.sendLatest();
  }
}

class Logger {
  constructor() {
    this.verboseness = {};
    this.colors = {};

    // Without a valid webhook for the log channel, messages only go to the console. The address is
    // never printed, as anyone with it can post to the channel.
    const webhook = process.env.DISCORD_LOG_WEBHOOK;
    this.discordWebhook = isDiscordWebhookUrl(webhook) ? webhook : null;
    if (!this.discordWebhook)
      console.warn(
        `Warning: Discord logging is off, as DISCORD_LOG_WEBHOOK ${
          webhook ? 'is not a Discord webhook address' : 'is not set'
        }.`
      );

    this.rl = new Bottleneck({
      maxConcurrent: 1,
      minTime: MIN_TIME,
      highWater: MAX_QUEUED,
      strategy: Bottleneck.strategy.OVERFLOW_PRIORITY
    });

    // Dropped messages are reported once, and again only after the queue has emptied.
    this.dropping = false;
    this.rl.on('idle', () => {
      this.dropping = false;
    });

    // Progress bars whose latest value is waiting to be sent.
    this.waitingProgressBars = new Set();
  }

  verbose(module, verboseness, message, ...extras) {
    this.log(module, verboseness, message, extras);
  }

  // Log a level 1 line about a whole run, such as its start, failure or summary. In the log channel
  // it goes ahead of other messages and is not dropped for them, so the run's outcome is not lost
  // when many per-item errors are waiting to be sent.
  important(module, message, ...extras) {
    this.log(module, 1, message, extras, RUN_PRIORITY);
  }

  // Print a line for verbose or important, and send level 1 lines to the log channel.
  log(module, verboseness, message, extras, priority) {
    // Errors are described in a line rather than logged whole, as errors from API clients hold
    // their request, with its keys and tokens.
    const errors = extras.filter(isError);
    let text = `${message}`;
    if (errors.length > 0)
      text += `${/\s$/.test(text) ? '' : ' '}${errors.map(describeError).join(', ')}`;

    if (verboseness === 1)
      this.sendMessage(
        `[${module}][${verboseness}] ${text}`,
        priority ?? (errors.length > 0 ? ERROR_PRIORITY : MESSAGE_PRIORITY)
      );

    let colorFunc = chalk[this.colors[module] || 'white'];
    if (typeof colorFunc !== 'function') colorFunc = chalk.white;

    // The console also gets the errors' stack traces.
    if ((this.verboseness[module] || 2) >= verboseness)
      console.log(
        `[${colorFunc(module)}][${verboseness}] ${text}${errors.map(stackTrace).join('')}`,
        ...extras.filter((extra) => !isError(extra))
      );
  }

  // Post a progress bar to the log channel, or update the one passed in, and return it to pass to
  // later calls. Nothing waits for Discord: the bar is posted in the background and then edited at
  // most once every 15 seconds, with its latest value.
  discordProgressBar(module, message, progressBar, min = 0, max = 1, current) {
    const content = `[${module}] Progress on ${message}\n${convertToBarChart(min, max, current)}`;
    if (!progressBar) return new ProgressBar(this, content);
    progressBar.update(content);
    return progressBar;
  }

  // Send progress bars' latest values now rather than when they are due, e.g. before exiting.
  flush() {
    for (const progressBar of [...this.waitingProgressBars]) progressBar.flush();
  }

  // Post a message to the log channel. Nothing waits for it, and a failure is only reported in the
  // console, so Discord can never hold up or stop the service that is logging.
  sendMessage(content, priority) {
    if (!this.discordWebhook) return;
    this.queue(priority, async () => {
      // Discord logging may have been turned off while this waited, as its webhook is gone.
      if (!this.discordWebhook) return;
      try {
        await this.withRetry(
          () => sendDiscordWebhook(this.discordWebhook, { content: truncate(content) }),
          { retryNetwork: true }
        );
      } catch (err) {
        if (!this.webhookGone(err))
          console.warn(`Could not send a message to the Discord log: ${describeError(err)}`);
      }
    });
  }

  // Whether an error says the log webhook is gone for good: it was deleted, or its token no longer
  // works. Discord asks that such a webhook is not used again, so Discord logging is then turned
  // off, with one warning, and nothing more is sent. Other errors leave it on, including the one
  // for editing a progress bar whose message was deleted.
  webhookGone(err) {
    if (!DELETED_WEBHOOK_CODES.includes(err?.code)) return false;
    if (this.discordWebhook) {
      this.discordWebhook = null;
      console.warn(
        `Warning: Discord logging is off, as Discord says the DISCORD_LOG_WEBHOOK webhook no longer exists: ${describeError(err)}`
      );
      for (const progressBar of [...this.waitingProgressBars]) progressBar.stop();
    }
    return true;
  }

  // Queue a request to the log webhook. Jobs handle their own errors, so the queue only rejects one
  // that it dropped for being full, and onDropped then runs. Every rejection is caught here: an
  // uncaught one used to stop the importer and the web server.
  queue(priority, job, onDropped) {
    let started = false;
    this.rl
      .schedule({ priority }, () => {
        started = true;
        return job();
      })
      .catch((err) => {
        if (started) {
          console.warn(`Discord logging failed: ${describeError(err)}`);
          return;
        }
        if (!this.dropping) {
          this.dropping = true;
          console.warn(
            'Warning: Discord logging is falling behind, so less important messages are being dropped until it catches up.'
          );
        }
        if (onDropped) onDropped();
      });
  }

  // Make a request to the log webhook, and try once more if Discord rate limited it or failed
  // (HTTP 429 or 5xx), after the wait Discord asked for, up to 10 seconds. With retryNetwork, a
  // request Discord could not be reached for, or did not answer in time, is also tried twice more,
  // after 1 and then 3 seconds. Discord may have posted a message it did not answer for in time,
  // but a rare duplicate line in the log is better than a lost one. Progress bars do not use it: a
  // posted bar's value is sent again with its next one, and one that was never posted stays quiet.
  async withRetry(request, { retryNetwork = false } = {}) {
    // The tries left: one after a 429 or 5xx, and one for each wait after a network error.
    const networkWaits = retryNetwork ? [...NETWORK_RETRY_WAITS] : [];
    let failureRetries = 1;
    for (;;) {
      try {
        return await request();
      } catch (err) {
        let wait;
        if ((err.status === 429 || err.status >= 500) && failureRetries > 0) {
          failureRetries--;
          wait = err.retryAfter === undefined ? DEFAULT_RETRY_WAIT : err.retryAfter * 1000;
        } else if (err.network && networkWaits.length > 0) {
          wait = networkWaits.shift();
        } else {
          throw err;
        }
        await new Promise((resolve) => setTimeout(resolve, Math.min(wait, MAX_RETRY_WAIT)));
      }
    }
  }

  // How many messages for the log channel have been received, are queued, or are being sent.
  // Progress bars' latest values count as queued while they wait to be due. Once Discord logging is
  // off, nothing more will be sent, so nothing is counted.
  getLogQueue() {
    const counts = this.rl.counts();
    if (!this.discordWebhook)
      return Object.fromEntries(Object.keys(counts).map((status) => [status, 0]));
    return { ...counts, QUEUED: counts.QUEUED + this.waitingProgressBars.size };
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
