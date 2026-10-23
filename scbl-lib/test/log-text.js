import assert from 'assert';

import logText from '../utils/log-text.js';
import * as utils from '../utils/index.js';

// Names users choose go in the log channel's lines on one line, and shown as written. Characters
// that cannot be seen are made with String.fromCodePoint, so this file holds none.
const char = (...codePoints) => String.fromCodePoint(...codePoints);

// Ordinary names are left as they are: apostrophes, quotes, round brackets, hyphens, other
// punctuation, letters of any script and emoji, those joined with zero-width joiners included.
const family = char(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467);
for (const name of [
  'Main Bans',
  "AFO's Server",
  'EU-West (Main) #1',
  'Say "hi" > all',
  'Ban list 3: 50% off!',
  `${family} Family`,
  `${char(0xdc)}nic${char(0xf8)}de`
])
  assert.strictEqual(logText(name), name);

// A line break in any form, and each run of other spaces and control characters, becomes one
// space, so a name cannot start a line of its own, such as one that looks like another module's.
for (const brk of [
  '\n',
  '\r\n',
  '\r',
  char(0x2028),
  char(0x2029),
  char(0x85),
  '\v',
  '\f',
  '\t',
  char(0),
  char(0x7f),
  char(0xa0)
])
  assert.strictEqual(logText(`A${brk}B`), 'A B', JSON.stringify(brk));
assert.strictEqual(logText('A \n\t \r\n  B'), 'A B');
assert.strictEqual(logText('A  B'), 'A B');
assert.strictEqual(logText('\nLeading and trailing\n'), ' Leading and trailing ');

// So does each character that changes the direction of the text after it, which could make the
// rest of the line read differently.
for (const control of [
  0x61c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2069
])
  assert.strictEqual(logText(`A${char(control)}B`), 'A B', control.toString(16));

// Each character Discord reads as Markdown within a line gets a backslash, so the text cannot hide
// the rest of the line in a spoiler, become a masked link or a mention, or lose its underscores.
assert.strictEqual(logText('xX_Sniper_Xx'), 'xX\\_Sniper\\_Xx');
assert.strictEqual(logText('||AFO'), '\\|\\|AFO');
assert.strictEqual(logText('[Main](https://example.com/x)'), '\\[Main\\](https://example.com/x)');
assert.strictEqual(logText('<@123456789012345678>'), '\\<@123456789012345678>');
assert.strictEqual(
  logText('**bold** ~~gone~~ `code`'),
  '\\*\\*bold\\*\\* \\~\\~gone\\~\\~ \\`code\\`'
);
// A backslash of the name's own is escaped too, so it cannot undo the one before the next
// character.
assert.strictEqual(logText('\\||'), '\\\\\\|\\|');

// Both at once.
assert.strictEqual(
  logText('Bans".\n[DiscordBot][1] admin (1) removed'),
  'Bans". \\[DiscordBot\\]\\[1\\] admin (1) removed'
);

// Anything that is not text is given as text, as a template literal would.
assert.strictEqual(logText(12), '12');
assert.strictEqual(logText(undefined), 'undefined');

// The services get it with the other utils.
assert.strictEqual(utils.logText, logText);

console.log('Log text checks passed: names stay on one line and are shown as written in Discord.');
