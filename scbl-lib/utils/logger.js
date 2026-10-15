import chalk from 'chalk';
import Bottleneck from 'bottleneck';

import describeError from './describe-error.js';
import sendDiscordWebhook, { editDiscordWebhookMessage } from './discord-webhook.js';
import isDiscordWebhookUrl from './discord-webhook-url.js';

// Messages to the log channel are sent one at a time, at most one every 400 ms, which keeps within
// Discord's limit for a webhook of about 5 every 2 seconds.
const MIN_TIME = 400;

// At most 200 messages, or 80 seconds of them, wait to be sent. When more arrive, the least
// important are dropped first: progress bars, then other messages, then errors. Bottleneck sends
// the lowest numbers first.
const MAX_QUEUED = 200;
const ERROR_PRIORITY = 4;
const MESSAGE_PRIORITY = 5;
const PROGRESS_PRIORITY = 9;

// A request Discord rate limited or failed (HTTP 429 or 5xx) is tried once more, after the wait
// Discord asked for, but never more than 10 seconds, or after 1 second when it did not say.
const MAX_RETRY_WAIT = 10 * 1000;
const DEFAULT_RETRY_WAIT = 1000;

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

// The lines of an error's stack trace that say where it was thrown. They hold only function and
// file names, so they are safe to print.
function stackTrace(err) {
  const lines = typeof err.stack === 'string' ? err.stack.split('\n') : [];
  return lines
    .filter((line) => /^\s+at /.test(line))
    .map((line) => `\n${line}`)
    .join('');
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
    const webhook = this.logger.discordWebhook;
    this.logger.queue(
      PROGRESS_PRIORITY,
      async () => {
        try {
          if (this.messageID) {
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
    // Errors are described in a line rather than logged whole, as errors from API clients hold
    // their request, with its keys and tokens.
    const errors = extras.filter(isError);
    let text = `${message}`;
    if (errors.length > 0)
      text += `${/\s$/.test(text) ? '' : ' '}${errors.map(describeError).join(', ')}`;

    if (verboseness === 1)
      this.sendMessage(
        `[${module}][${verboseness}] ${text}`,
        errors.length > 0 ? ERROR_PRIORITY : MESSAGE_PRIORITY
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
      try {
        await this.withRetry(() =>
          sendDiscordWebhook(this.discordWebhook, { content: truncate(content) })
        );
      } catch (err) {
        console.warn(`Could not send a message to the Discord log: ${describeError(err)}`);
      }
    });
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
  // (HTTP 429 or 5xx), after the wait Discord asked for, up to 10 seconds.
  async withRetry(request) {
    try {
      return await request();
    } catch (err) {
      const retryable = err.status === 429 || err.status >= 500;
      if (!retryable) throw err;
      const wait = err.retryAfter === undefined ? DEFAULT_RETRY_WAIT : err.retryAfter * 1000;
      await new Promise((resolve) => setTimeout(resolve, Math.min(wait, MAX_RETRY_WAIT)));
      return await request();
    }
  }

  // How many messages for the log channel have been received, are queued, or are being sent.
  // Progress bars' latest values count as queued while they wait to be due.
  getLogQueue() {
    const counts = this.rl.counts();
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
