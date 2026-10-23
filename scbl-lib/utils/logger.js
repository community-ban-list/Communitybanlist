import chalk from 'chalk';
import Bottleneck from 'bottleneck';

import describeError, { stackTrace } from './describe-error.js';
import sendDiscordWebhook, {
  DELETED_WEBHOOK_CODES,
  editDiscordWebhookMessage,
  getDiscordWebhookMessage
} from './discord-webhook.js';
import isDiscordWebhookUrl from './discord-webhook-url.js';

// Messages to the log channel are sent one at a time, at most one every 400 ms. That is right at
// Discord's limit for a webhook of 5 every 2 seconds, so a burst can still be rate limited now and
// then, as can a request when another service posts to the same webhook. Such a request is tried
// again after the wait Discord asks for.
const MIN_TIME = 400;

// At most 200 messages, or 80 seconds of them, wait to be sent. When more arrive, the least
// important are dropped first: progress bars, then other messages, then errors. A run's own lines,
// such as its start, failure and summary, go ahead of all of these and are never dropped for them,
// and a status message, such as a run's, goes ahead of those, so its final edit is not lost.
// Bottleneck sends the lowest numbers first.
const MAX_QUEUED = 200;
const STATUS_PRIORITY = 1;
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

// A progress bar is only posted once it has existed for a minute without being finished, so a step
// that takes less than a minute posts no bar at all. After that it is edited at most once every 15
// seconds, with its latest value, as is any message that is kept up to date.
const PROGRESS_BAR_DELAY = 60 * 1000;
const EDIT_INTERVAL = 15 * 1000;

// A status message, such as a run's, has 30 seconds rather than the usual 10 for Discord to answer
// its post, as nothing waits for it. Discord may post a message it does not answer for in time,
// and the logger then never learns which message it is, so the longer this is, the rarer that is.
const STATUS_POST_TIMEOUT = 30 * 1000;

// Discord's error code for a message that does not exist, e.g. as someone deleted it.
const UNKNOWN_MESSAGE = 10008;

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

// What a payload asks Discord to show, with its text cut to fit in a Discord message. A payload is
// { content, embeds }, either of which may be left out.
function messageBody(payload) {
  return {
    content: typeof payload.content === 'string' ? truncate(payload.content) : null,
    embeds: payload.embeds ?? []
  };
}

// A message in the log channel that is edited as what it shows changes, such as a progress bar or
// a run's status, which the logger returns at once. It is posted in the background, at once or
// after a delay, and then edited at most once every 15 seconds, or every editInterval
// milliseconds, with its latest payload, so whatever updates it thousands of times sends a few
// edits and never waits for Discord. A payload is { content, embeds }, or a function that returns
// one, which is only called when the payload is sent, so a message can show the latest of
// something that changes often without drawing it each time. postTimeout, if given, is how long
// Discord has to answer its post, and with postAgain, a post that failed is made again when the
// next payload is due, unless Discord refused it (see failed). A message given messageID edits that
// message, posted earlier, rather than posting a new one, and with repostIfDeleted, a message that
// turns out to have been deleted is posted again. onPosted is told the ID of each message it posts.
class LogMessage {
  constructor(
    logger,
    payload,
    {
      priority,
      name,
      delay = 0,
      finished = false,
      postTimeout,
      postAgain = false,
      messageID = null,
      editInterval = EDIT_INTERVAL,
      repostIfDeleted = false,
      onPosted = null
    }
  ) {
    this.logger = logger;
    this.priority = priority;
    // What the message is, for the console, e.g. 'a progress bar'.
    this.name = name;
    this.postTimeout = postTimeout;
    this.postAgain = postAgain;
    this.editInterval = editInterval;
    this.repostIfDeleted = repostIfDeleted;
    this.onPosted = onPosted;
    this.messageID = messageID;
    // The latest payload, while it waits to be sent.
    this.waiting = null;
    this.sending = false;
    this.sentAt = 0;
    this.timer = null;
    this.flushing = false;
    // Set once the message has its final payload, after which updates do nothing.
    this.final = false;
    // Settles with the message's ID once it is posted, or with null once it never will be.
    this.posted = new Promise((resolve) => {
      this.resolvePosted = resolve;
    });
    // Told once nothing of the message is waiting to be sent or being sent (see sent).
    this.sentWaiters = [];
    // Without Discord logging, or once the message could not be posted, updates do nothing rather
    // than post new messages. A message that is finished when it is made is never posted.
    this.stopped = !logger.discordWebhook || finished;
    // The latest payload of a message that is not posted yet.
    this.unposted = null;
    if (this.stopped) {
      this.resolvePosted(null);
      return;
    }

    if (delay === 0) {
      this.wait(payload);
      this.flush();
      return;
    }
    this.unposted = payload;
    logger.unpostedMessages.add(this);
    this.timer = setTimeout(() => this.post(), delay);
    // A message that is not posted yet must not keep the process running.
    this.timer.unref?.();
  }

  update(payload) {
    if (this.stopped || this.final) return;
    if (this.unposted !== null) {
      this.unposted = payload;
      return;
    }
    this.wait(payload);
    this.sendLatest();
  }

  // Give the message its final payload, which is sent at once rather than when it is due. Updates
  // after it do nothing.
  finish(payload) {
    if (this.stopped || this.final) return;
    this.final = true;
    if (this.unposted !== null) {
      clearTimeout(this.timer);
      this.timer = null;
      this.unposted = null;
      this.logger.unpostedMessages.delete(this);
    }
    this.wait(payload);
    this.flush();
  }

  // Post the message with its latest payload, once its delay is up, e.g. a progress bar that has
  // existed for a minute without being finished.
  post() {
    this.timer = null;
    const payload = this.unposted;
    this.unposted = null;
    this.logger.unpostedMessages.delete(this);
    // Stop once Discord logging is off, as it is when its webhook turns out to be gone.
    if (!this.logger.discordWebhook) this.stop();
    if (this.stopped || payload === null) return;
    this.wait(payload);
    this.flush();
  }

  // Send the latest payload now rather than when it is due, e.g. before the service exits.
  flush() {
    if (this.stopped || this.waiting === null) return;
    this.flushing = true;
    clearTimeout(this.timer);
    this.timer = null;
    this.sendLatest();
  }

  wait(payload) {
    this.waiting = payload;
    if (payload === null) this.logger.waitingMessages.delete(this);
    else this.logger.waitingMessages.add(this);
  }

  stop() {
    this.stopped = true;
    this.unposted = null;
    this.logger.unpostedMessages.delete(this);
    this.wait(null);
    clearTimeout(this.timer);
    this.timer = null;
    // A message that was posted has already settled with its ID.
    this.resolvePosted(null);
    this.settle();
  }

  // Settles once nothing of the message is waiting to be sent or being sent, e.g. once its final
  // payload has been sent, or once it stops, and never fails. A message posted again by then, as
  // Discord said it was deleted, has told onPosted its new ID. It waits for Discord, so whatever
  // waits for it limits how long.
  sent() {
    if (this.isSent()) return Promise.resolve();
    return new Promise((resolve) => this.sentWaiters.push(resolve));
  }

  isSent() {
    return this.stopped || (!this.sending && this.waiting === null && this.unposted === null);
  }

  // Tell what waits for the message to be sent, once it has been.
  settle() {
    if (this.sentWaiters.length === 0 || !this.isSent()) return;
    const waiters = this.sentWaiters;
    this.sentWaiters = [];
    for (const resolve of waiters) resolve();
  }

  // Send the latest payload, once the last one has been sent and 15 seconds have passed since.
  sendLatest() {
    // Stop once Discord logging is off, as it is when its webhook turns out to be gone.
    if (!this.logger.discordWebhook) this.stop();
    if (this.stopped || this.sending || this.timer || this.waiting === null) return;

    const due = this.flushing ? 0 : this.sentAt + this.editInterval - Date.now();
    if (due > 0) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.sendLatest();
      }, due);
      // A payload waiting to be sent must not keep the process running.
      this.timer.unref?.();
      return;
    }

    const latest = this.waiting;
    this.wait(null);
    this.flushing = false;
    // A payload that is a function is drawn now. One that cannot be drawn stops the message, as it
    // would most likely fail again, rather than fail whatever updated it.
    let payload;
    try {
      payload = typeof latest === 'function' ? latest() : latest;
      if (!payload || typeof payload !== 'object') throw new Error('It gave nothing to show');
    } catch (err) {
      console.warn(`Could not draw ${this.name} for the Discord log: ${describeError(err)}`);
      this.stop();
      return;
    }
    this.send(payload);
  }

  send(payload) {
    this.sending = true;
    this.logger.queue(
      this.priority,
      async () => {
        try {
          // The webhook is read only now, as Discord logging is turned off if it turns out to be
          // gone, maybe while this waited.
          const webhook = this.logger.discordWebhook;
          if (!webhook) this.stop();
          else {
            if (this.messageID) await this.editMessage(webhook, payload);
            if (!this.messageID) await this.postMessage(webhook, payload);
          }
        } catch (err) {
          if (!this.logger.webhookGone(err))
            console.warn(
              `Could not ${this.messageID ? 'update' : 'post'} ${this.name} in the Discord log: ${describeError(err)}`
            );
          this.failed(payload, err);
        }
        this.done();
      },
      () => {
        this.failed(payload, null);
        this.done();
      }
    );
  }

  // Replace what the message shows with the payload. A message given when it was made, posted
  // earlier, is known to be there once an edit works. One that turns out to have been deleted is
  // forgotten, with repostIfDeleted, so it is posted again.
  async editMessage(webhook, payload) {
    try {
      await this.logger.withRetry(() =>
        editDiscordWebhookMessage(webhook, this.messageID, messageBody(payload))
      );
      this.resolvePosted(this.messageID);
    } catch (err) {
      if (!this.repostIfDeleted || err?.status !== 404 || err.code !== UNKNOWN_MESSAGE) throw err;
      console.warn(
        `Discord says ${this.name} in the log channel was deleted, so it is posted again.`
      );
      this.messageID = null;
    }
  }

  // Post the message with the payload, and keep its ID, for its later edits and for onPosted.
  async postMessage(webhook, payload) {
    const message = await this.logger.withRetry(() =>
      sendDiscordWebhook(webhook, messageBody(payload), { timeout: this.postTimeout })
    );
    if (!message?.id) throw new Error('Discord did not say which message it posted');
    this.messageID = message.id;
    this.resolvePosted(message.id);
    if (this.onPosted) {
      // Whatever onPosted does, e.g. saving the ID, it never holds up or fails the message.
      Promise.resolve()
        .then(() => this.onPosted(message.id))
        .catch((err) =>
          console.warn(
            `Could not keep the ID of ${this.name} in the Discord log: ${describeError(err)}`
          )
        );
    }
  }

  // After a send failed, or was dropped as the queue was full (err is then null), send the payload
  // again when the next one is due, unless a newer one is waiting. A message Discord refused to
  // post or edit, with a 4xx other than 429, e.g. as it was deleted, is not sent again. Nor is a
  // message that was never posted, rather than risk posting it twice, unless it is one to post
  // again (postAgain), such as a run's status, which matters more than a rare second message. That
  // is posted again when Discord did not post it, as it rate limited or failed the post or never
  // got it, or may not have, as it did not answer.
  failed(payload, err) {
    const status = err?.status;
    const refused = status >= 400 && status < 500 && status !== 429;
    const notPosted = err === null || status === 429 || status >= 500 || err?.network === true;
    if (refused || (!this.messageID && !(this.postAgain && notPosted))) this.stop();
    else if (this.waiting === null) this.wait(payload);
  }

  done() {
    this.sending = false;
    this.sentAt = Date.now();
    this.sendLatest();
    this.settle();
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

    // Messages whose latest payload is waiting to be sent, such as a progress bar's latest value,
    // and messages not posted yet, such as progress bars in their first minute, which may never be.
    this.waitingMessages = new Set();
    this.unpostedMessages = new Set();

    // How many lines have been logged for the log channel, whether or not Discord logging is on,
    // e.g. for the importer service to tell whether a cycle had anything to say.
    this.channelLines = 0;
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

    if (verboseness === 1) {
      this.channelLines++;
      this.sendMessage(
        `[${module}][${verboseness}] ${text}`,
        priority ?? (errors.length > 0 ? ERROR_PRIORITY : MESSAGE_PRIORITY)
      );
    }

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
  // later calls. A bar is finished once current reaches max. Nothing waits for Discord: the bar is
  // posted in the background once it has existed for a minute without being finished, so a step
  // that takes less than a minute posts nothing, and then edited at most once every 15 seconds,
  // with its latest value.
  discordProgressBar(module, message, progressBar, min = 0, max = 1, current) {
    const payload = {
      content: `[${module}] Progress on ${message}\n${convertToBarChart(min, max, current)}`
    };
    const finished = current >= max;
    if (!progressBar)
      return new LogMessage(this, payload, {
        priority: PROGRESS_PRIORITY,
        name: 'a progress bar',
        delay: PROGRESS_BAR_DELAY,
        finished
      });
    // A bar that is finished within its first minute is never posted.
    if (finished && progressBar.unposted !== null) progressBar.stop();
    else progressBar.update(payload);
    return progressBar;
  }

  // Post a message to the log channel that is kept up to date, such as a run's status, and return
  // it at once, to update and finish later. It is posted in the background straight away, ahead of
  // other messages, then edited at most once every 15 seconds with its latest payload, and its final
  // payload, given to finish(), is sent at once. Nothing waits for Discord. A payload is
  // { content, embeds }, or a function that returns one when it is sent. Unlike a progress bar, a
  // status message whose post failed is posted again, with its latest payload, 15 seconds later,
  // unless Discord refused it, and Discord has 30 seconds to answer its post. Options:
  // - messageID: a status message posted earlier, e.g. by the process before this one, which is
  //   edited from the start rather than posted again; once it is, it settles with that ID;
  // - editInterval: the time between edits, in milliseconds, rather than 15 seconds;
  // - repostIfDeleted: a message Discord says no longer exists, as someone deleted it, is posted
  //   again, rather than no longer edited;
  // - onPosted(id): told the ID of each message posted, e.g. to keep it for the next process.
  // Its sent() settles once its latest payload has been sent, e.g. its final one.
  statusMessage(payload, { messageID = null, editInterval, repostIfDeleted, onPosted } = {}) {
    return new LogMessage(this, payload, {
      priority: STATUS_PRIORITY,
      name: 'a status message',
      postTimeout: STATUS_POST_TIMEOUT,
      postAgain: true,
      messageID: typeof messageID === 'string' && /^\d+$/.test(messageID) ? messageID : null,
      editInterval,
      repostIfDeleted,
      onPosted
    });
  }

  // Post a message to the log channel once, such as an embed of the importer service's cycle or
  // its hourly summary, ahead of other messages, as a run's own lines go. Like a line, it is tried
  // again after a network error, as a rare second copy is better than a lost one. Nothing waits for
  // it, and a failure is only reported in the console. A payload is { content, embeds }.
  post(payload) {
    if (!this.discordWebhook) return;
    this.queue(RUN_PRIORITY, async () => {
      // Discord logging may have been turned off while this waited, as its webhook is gone.
      const webhook = this.discordWebhook;
      if (!webhook) return;
      try {
        await this.withRetry(() => sendDiscordWebhook(webhook, messageBody(payload)), {
          retryNetwork: true
        });
      } catch (err) {
        if (!this.webhookGone(err))
          console.warn(`Could not post a message to the Discord log: ${describeError(err)}`);
      }
    });
  }

  // Change a message the log webhook posted earlier, such as the status message of a run that ended
  // without its final edit. revise is given the message as Discord has it now, and returns the
  // payload to replace it with, or nothing to leave it as it is. It is done in the background, ahead
  // of other messages, and a failure is only reported in the console. Reading and editing a message
  // can safely be done twice, so both are tried again after a network error too.
  reviseMessage(messageID, revise) {
    if (!this.discordWebhook) return;
    this.queue(STATUS_PRIORITY, async () => {
      // Discord logging may have been turned off while this waited, as its webhook is gone.
      const webhook = this.discordWebhook;
      if (!webhook) return;
      let message;
      try {
        message = await this.withRetry(() => getDiscordWebhookMessage(webhook, messageID), {
          retryNetwork: true
        });
      } catch (err) {
        if (!this.webhookGone(err))
          console.warn(`Could not read a message in the Discord log: ${describeError(err)}`);
        return;
      }
      let payload;
      try {
        payload = revise(message);
      } catch (err) {
        console.warn(`Could not change a message in the Discord log: ${describeError(err)}`);
        return;
      }
      if (!payload) return;

      this.queue(STATUS_PRIORITY, async () => {
        const webhook = this.discordWebhook;
        if (!webhook) return;
        try {
          await this.withRetry(
            () => editDiscordWebhookMessage(webhook, messageID, messageBody(payload)),
            { retryNetwork: true }
          );
        } catch (err) {
          if (!this.webhookGone(err))
            console.warn(`Could not change a message in the Discord log: ${describeError(err)}`);
        }
      });
    });
  }

  // Send messages' latest payloads now rather than when they are due, e.g. before exiting. Progress
  // bars that are not posted yet are dropped, as their steps took less than a minute.
  flush() {
    for (const message of [...this.unpostedMessages]) message.stop();
    for (const message of [...this.waitingMessages]) message.flush();
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
      for (const message of [...this.waitingMessages, ...this.unpostedMessages]) message.stop();
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
  // but a rare duplicate line in the log is better than a lost one. Messages that are kept up to
  // date, such as progress bars, do not use it: a posted message's payload is sent again with its
  // next one, and one that was never posted stays quiet rather than risk being posted twice, or,
  // for a status message, is posted again with its next payload.
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
  // Payloads waiting to be due, such as progress bars' latest values, count as queued, but progress
  // bars that are not posted yet do not, as they may never be. Once Discord logging is off, nothing
  // more will be sent, so nothing is counted.
  getLogQueue() {
    const counts = this.rl.counts();
    if (!this.discordWebhook)
      return Object.fromEntries(Object.keys(counts).map((status) => [status, 0]));
    return { ...counts, QUEUED: counts.QUEUED + this.waitingMessages.size };
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
