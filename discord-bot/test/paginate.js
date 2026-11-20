import assert from 'assert';
import { readFile } from 'fs/promises';
import vm from 'vm';

import * as discord from 'discord.js';

import logText from '../../scbl-lib/utils/log-text.js';

// Page the lines of a reply, as /banlist status and /org list do, with the real discord.js
// builders, which refuse an embed whose description is longer than Discord takes: at most 20 lines
// a page, and at most 4,096 characters with the line breaks between them, so long lines, such as
// those of ban lists with long names whose bans are held, start a page sooner.
const context = vm.createContext({});
async function load(path, dependencies) {
  const source = await readFile(new URL(path, import.meta.url), 'utf8');
  const module = new vm.SourceTextModule(source, { context });
  await module.link((specifier) => {
    const exports = dependencies[specifier];
    assert.ok(exports, `Unexpected dependency of ${path}: ${specifier}`);
    return new vm.SyntheticModule(
      Object.keys(exports),
      function () {
        for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
      },
      { context }
    );
  });
  await module.evaluate();
  return module.namespace;
}
const format = await load('../src/utils/format.js', {
  'discord.js': discord,
  'scbl-lib/utils': { logText }
});
const { default: paginate, pageLines } = await load('../src/utils/paginate.js', {
  'discord.js': discord,
  './format.js': format
});

// A line of the length given, starting with its number. The pages are made in the module's
// context, so they are copied into this one to compare.
const line = (n, length) => String(n).padEnd(length, 'x');
const lineCounts = (pages) => [...pages].map((page) => page.split('\n').length);
const lengths = (pages) => [...pages].map((page) => page.length);

// Short lines go 20 to a page, as before.
assert.deepStrictEqual(
  lineCounts(pageLines(Array.from({ length: 45 }, (_, i) => `line ${i}`))),
  [20, 20, 5]
);
// 20 lines of 300 characters, 6,019 with their line breaks, do not fit on one page: 13 do.
let pages = pageLines(Array.from({ length: 20 }, (_, i) => line(i, 300)));
assert.deepStrictEqual(lineCounts(pages), [13, 7]);
assert.ok(pages.every((page) => page.length <= 4096));
assert.deepStrictEqual(
  pages.join('\n').split('\n'),
  Array.from({ length: 20 }, (_, i) => line(i, 300))
);
// Lines that fill a page exactly stay on it, and one more character starts another.
assert.deepStrictEqual(lengths(pageLines([line(1, 2047), line(2, 2048)])), [4096]);
assert.deepStrictEqual(lengths(pageLines([line(1, 2048), line(2, 2048)])), [2048, 2048]);
// A line too long for a page on its own is cut short.
pages = pageLines([line(1, 5000), 'next']);
assert.deepStrictEqual(
  [...pages].map((page) => [page.length, page.at(-1)]),
  [
    [4096, '…'],
    [4, 't']
  ]
);
assert.strictEqual(pageLines([]).length, 0);

// The reply shows the first page in an embed, which the real builder takes, with the page it is
// and buttons to the others. With nothing to show, it says so, without buttons.
const replies = [];
const interaction = {
  user: { id: '1' },
  async editReply(reply) {
    replies.push(reply);
    return { createMessageComponentCollector: () => ({ on() {} }) };
  }
};
await paginate(
  interaction,
  'Ban lists',
  Array.from({ length: 20 }, (_, i) => line(i, 300))
);
const [embed] = replies[0].embeds;
assert.strictEqual(embed.data.description.split('\n').length, 13);
assert.strictEqual(embed.data.footer.text, 'Page 1 of 2');
assert.strictEqual(replies[0].components.length, 1);
replies.length = 0;
await paginate(interaction, 'Ban lists', []);
assert.strictEqual(replies[0].embeds[0].data.description, 'Nothing to show.');
assert.strictEqual(replies[0].components.length, 0);

// A name is cut to the 100 characters /org and /banlist let an admin give, as one written by hand
// before the bot existed can have up to 255, so the question of /banlist confirm-removal, which gives
// the list's name twice, stays within the 2,000 characters Discord takes in a message, with the real
// escapeMarkdown, which doubles a name of backslashes: the longest question, for bans held as a list
// lost a large part of them, with others waiting, an earlier confirmation, and counts of 9,999,999.
for (const name of ['\\'.repeat(255), '\u{1F600}'.repeat(255), '_*'.repeat(127)]) {
  const question = format.describeConfirmation(
    format.formatBanListName({ name }, { name }),
    { kind: 'large', held: 9999999, waiting: 9999999, since: new Date() },
    { storedCount: 9999999, allowFullRemovalUntil: new Date(Date.now() + 60 * 60 * 1000) },
    2
  );
  assert.ok(question.length <= 2000, `The question is ${question.length} characters long.`);
}

console.log(
  'Pagination checks passed: 20 lines a page, fewer when they would make a page longer than an embed holds, a line too long cut short, replies the real builders take, and a question with the longest names that a Discord message holds.'
);
