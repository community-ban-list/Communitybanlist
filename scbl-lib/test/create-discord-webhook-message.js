import assert from 'assert';

import createDiscordWebhookMessage from '../utils/create-discord-webhook-message.js';
import * as utils from '../utils/index.js';

// The importer's export ban list alerts start from this message, and sendDiscordWebhook posts it
// with the Community Ban List's name and logo.
assert.strictEqual(utils.createDiscordWebhookMessage, createDiscordWebhookMessage);

const before = Date.now();
const message = createDiscordWebhookMessage();
message.setTitle("We've updated your export ban list.");
const [embed] = message.getJSON().embeds;
assert.strictEqual(embed.title, "We've updated your export ban list.");
assert.strictEqual(embed.color, 0xffc40b);
assert.strictEqual(embed.footer.text, 'Powered by the Community Ban List.');
const sent = new Date(embed.timestamp).getTime();
assert.ok(sent >= before && sent <= Date.now(), String(embed.timestamp));

// The importer colours a player added to a list green and one removed red.
const colourOf = (options) => createDiscordWebhookMessage(options).getJSON().embeds[0].color;
assert.strictEqual(colourOf({ color: '#00ff00' }), 0x00ff00);
assert.strictEqual(colourOf({ color: '#ff0000' }), 0xff0000);

// Each call makes a new message, so one alert's title never shows in the next.
assert.notStrictEqual(createDiscordWebhookMessage(), createDiscordWebhookMessage());
assert.strictEqual(createDiscordWebhookMessage().getJSON().embeds[0].title, undefined);

console.log('Discord message checks passed: the style, colours and a new message for each alert.');
