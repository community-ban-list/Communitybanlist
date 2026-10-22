// Discord accepts edits to a command's reply for 15 minutes after the command. Edits stop a little
// before then, so that none is cut off part-way.
const REPLY_LIFETIME = 15 * 60 * 1000;
const MARGIN = 30 * 1000;

// Progress is shown at most this often, so a long job sends a few edits rather than one a step.
const INTERVAL = 2000;

// Keep a command's reply up to date while a long job runs, such as removing many export ban lists,
// without the job waiting for Discord. update() shows the latest progress, one edit at a time and
// at most every 2 seconds, and finish() shows the final payload once any edit under way is done.
// A failed edit is reported in the console and stops later edits, as does the end of the reply's
// 15 minutes. Whatever the reply would say after that must reach the admin another way, such as
// the log channel, so finish() resolves to whether the final payload was shown. `now` gives the
// time in milliseconds.
export default class ReplyUpdater {
  constructor(interaction, { now = Date.now, interval = INTERVAL } = {}) {
    this.interaction = interaction;
    this.now = now;
    this.interval = interval;
    this.deadline = (interaction.createdTimestamp ?? now()) + REPLY_LIFETIME - MARGIN;
    // The latest progress, while it waits to be shown, and the edit under way.
    this.latest = null;
    this.sending = null;
    this.timer = null;
    this.sentAt = -Infinity;
    // Set once an edit fails.
    this.failed = false;
  }

  // Whether the reply can still be edited.
  get open() {
    return !this.failed && this.now() < this.deadline;
  }

  update(payload) {
    if (!this.open) return;
    this.latest = payload;
    this.schedule();
  }

  async finish(payload) {
    clearTimeout(this.timer);
    this.timer = null;
    this.latest = null;
    if (this.sending) await this.sending;
    return this.edit(payload);
  }

  // Show the latest progress, once the edit under way is done and the interval has passed.
  schedule() {
    if (this.sending || this.timer || this.latest === null) return;

    const wait = this.sentAt + this.interval - this.now();
    if (wait > 0) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.schedule();
      }, wait);
      // Progress waiting to be shown must not keep the process running.
      this.timer.unref?.();
      return;
    }

    const payload = this.latest;
    this.latest = null;
    this.sending = this.edit(payload).finally(() => {
      this.sending = null;
      this.sentAt = this.now();
      this.schedule();
    });
  }

  async edit(payload) {
    if (!this.open) return false;
    try {
      await this.interaction.editReply(payload);
      return true;
    } catch (error) {
      this.failed = true;
      console.warn(
        `Could not update the reply to /${this.interaction.commandName}, so it is no longer updated: ${error.message}`
      );
      return false;
    }
  }
}
