import assert from 'assert';
import { readFile, stat } from 'fs/promises';
import vm from 'vm';

import * as apolloClient from '@apollo/client';
import * as apolloClientErrors from '@apollo/client/errors';
import * as React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import * as reactRouter from 'react-router';
import * as reactstrap from 'reactstrap';
import { transformWithOxc } from 'vite';

// Checks that the client asks before it deletes an export ban list or a list's custom points for a
// ban list: Delete only opens a dialog that names what is deleted and says what that does, Cancel
// and Escape send nothing, and only the dialog's own button, which names the action, deletes. While
// the deletion runs its buttons do nothing, a failed one shows the web server's message, and the
// page says when one has worked. The client's files are compiled the way its build compiles
// them, loaded with the client's own packages, and rendered to HTML, with stand-ins for the GraphQL
// requests. A dialog is rendered in place, as reactstrap only shows one in a browser; its focus
// handling is reactstrap's and the browser's.

const CLIENT = new URL('../../client/src/', import.meta.url);

const { createElement: h } = React;
const { CombinedGraphQLErrors } = apolloClientErrors;

// The mutation's stand-in: the state every mutation has when rendered, the variables of each one
// sent, the options it was set up with, and how often its state was reset.
let mutation;
const sent = [];
let mutationOptions;
let resets = 0;
const useMutation = (document, options) => {
  mutationOptions = options;
  return [
    async (request) => {
      sent.push(request.variables);
    },
    {
      ...mutation,
      reset: () => {
        resets += 1;
      }
    }
  ];
};
const IDLE = { loading: false, error: undefined, data: undefined };

// The query's stand-in, for the pages.
let answer;
const useQuery = () => answer;

// A page can only be rendered, not used, so state is set beforehand: the next useState calls start
// with the values in startWith, in order, and every value a component sets is kept in setTo.
const startWith = [];
const setTo = [];
const useState = (initial) => {
  const [value, set] = React.useState(startWith.length > 0 ? startWith.shift() : initial);
  return [
    value,
    (next) => {
      setTo.push(next);
      set(next);
    }
  ];
};

// The props of the buttons and dialogs on the last thing rendered, and the keys of its table rows.
const buttons = [];
const dialogs = [];
const rowKeys = [];
const Modal = (props) => {
  dialogs.push(props);
  return props.isOpen
    ? h(
        'div',
        { className: 'modal', role: props.role, 'aria-labelledby': props.labelledBy },
        props.children
      )
    : null;
};
const Button = (props) => {
  buttons.push(props);
  return h(reactstrap.Button, props);
};
const recordRows =
  (create) =>
  (type, props, ...rest) => {
    if (type === 'tr') rowKeys.push(rest[0]);
    return create(type, props, ...rest);
  };

// The address the export ban lists page's Install box gives a list, from the browser's location.
globalThis.window = { location: new URL('https://communitybanlist.com/export-ban-lists') };

const packages = {
  react: { default: React, ...React, useState },
  'react/jsx-runtime': {
    ...jsxRuntime,
    jsx: recordRows(jsxRuntime.jsx),
    jsxs: recordRows(jsxRuntime.jsxs)
  },
  'react-router': reactRouter,
  reactstrap: { ...reactstrap, Modal, Button },
  '@apollo/client': apolloClient,
  '@apollo/client/errors': apolloClientErrors,
  '@apollo/client/react': { useMutation, useQuery }
};

// The components index, with the components these checks load and stand-ins for the others.
const Plain = (props) => jsxRuntime.jsx(jsxRuntime.Fragment, { children: props.children });
const stand = (name) => () => jsxRuntime.jsx('span', { children: `[${name}]` });
const indexFile = await readFile(new URL('components/index.js', CLIENT), 'utf8');
const components = Object.fromEntries(
  [...indexFile.matchAll(/^import (\w+) from/gm)].map(([, name]) => [name, stand(name)])
);
const stubs = {
  'views/layout/layout.jsx': { default: Plain },
  components,
  'components/': components
};

const synthetic = (exports) =>
  new vm.SyntheticModule(Object.keys(exports), function () {
    for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
  });

// A client file by the path an import gives, as the client's build finds it: the file itself, or
// with .jsx or .js added, or a folder's index file.
async function find(path) {
  for (const file of [path, `${path}.jsx`, `${path}.js`, `${path}/index.jsx`, `${path}/index.js`]) {
    const found = await stat(new URL(file, CLIENT)).catch(() => null);
    if (found?.isFile()) return file;
  }
  assert.fail(`No client file for ${path}`);
}

// Load one of the client's modules, compiled as the client's build does, with the client's modules
// it imports loaded the same way unless they have a stand-in.
const loaded = new Map();
async function loadClient(path) {
  const url = new URL(await find(path), CLIENT);
  if (loaded.has(url.href)) return loaded.get(url.href);
  const { code } = await transformWithOxc(await readFile(url, 'utf8'), url.pathname, {
    lang: 'jsx',
    jsx: { runtime: 'automatic' }
  });
  const module = new vm.SourceTextModule(code, { identifier: url.href });
  loaded.set(url.href, module);
  await module.link(async (specifier, referrer) => {
    if (!specifier.startsWith('.')) {
      assert.ok(Object.hasOwn(packages, specifier), `Unexpected dependency: ${specifier}`);
      return synthetic(packages[specifier]);
    }
    const resolved = new URL(specifier, referrer.identifier).href.slice(CLIENT.href.length);
    if (Object.hasOwn(stubs, resolved)) return synthetic(stubs[resolved]);
    return loadClient(resolved);
  });
  return module;
}
async function component(path) {
  const module = await loadClient(path);
  if (module.status !== 'evaluated') await module.evaluate();
  return module.namespace.default;
}

const DeleteExportBanList = await component('components/DeleteExportBanList/index.jsx');
const DeleteExportBanListConfig = await component('components/DeleteExportBanListConfig/index.jsx');

// The pages are checked with the real delete buttons, whose props are kept.
const listButtons = [];
const configButtons = [];
const capture = (list, Component) => (props) => {
  list.push(props);
  return h(Component, props);
};
components.AdvancedModal = await component('components/AdvancedModal/index.jsx');
components.DeleteExportBanList = capture(listButtons, DeleteExportBanList);
components.DeleteExportBanListConfig = capture(configButtons, DeleteExportBanListConfig);
const ExportBanLists = await component('views/pages/export-ban-lists.jsx');
const ExportBanListConfigs = await component('components/ExportBanListConfigs/index.jsx');

// Render an element as a page does, with the mutation in the given state, the next useState calls
// starting with the given values, and the query's answer.
function render(element, { state = IDLE, start = [], data } = {}) {
  mutation = state;
  startWith.length = 0;
  startWith.push(...start);
  answer = { loading: false, error: undefined, data };
  for (const list of [buttons, dialogs, rowKeys, listButtons, configButtons, setTo, sent])
    list.length = 0;
  resets = 0;
  return renderToStaticMarkup(h(reactRouter.MemoryRouter, null, element));
}
const text = (children) => [children].flat(Infinity).join('');
const escape = (string) => string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const button = (label) => {
  const found = buttons.filter((props) => text(props.children) === label);
  assert.strictEqual(found.length, 1, `one ${label} button`);
  return found[0];
};
// The dialog's text, without its markup.
const plain = (html) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, ' ');

const BATTLEMETRICS = { id: 7, name: 'Main list', type: 'battlemetrics', battlemetricsID: '9001' };
const REMOTE = { id: 8, name: 'Squad servers', type: 'remote', battlemetricsID: null };
const NO_BATTLEMETRICS_LIST = { ...BATTLEMETRICS, id: 9, battlemetricsID: null };

const SERVERS = 'Servers using this export ban list will stop getting its bans.';
const BATTLEMETRICS_TOO =
  'Its BattleMetrics ban list is deleted too: its share invite stops working, and the organisations subscribed to it are removed from it. This can take a few minutes.';
const FOR_GOOD = 'This cannot be undone.';

// Delete opens the dialog and sends nothing. The button names the list for screen readers.
{
  const deleted = [];
  const onDeleted = (name) => deleted.push(name);
  const html = render(h(DeleteExportBanList, { exportBanList: BATTLEMETRICS, onDeleted }));
  button('Delete').onClick();
  assert.deepStrictEqual(sent, [], 'Delete sends nothing');
  assert.deepStrictEqual(setTo, [true], 'Delete opens the dialog');
  assert.strictEqual(resets, 1, "an earlier try's error is cleared");
  assert.deepStrictEqual(deleted, []);
  assert.ok(!html.includes('role="alertdialog"'), 'no dialog until Delete is pressed');
  assert.match(html, /aria-label="Delete Main list"[^>]*>Delete</);
}

// The dialog is labelled by its title, which names the list, and says what deleting it does. Its
// focus starts on Cancel, before the button that deletes, which names the action.
{
  const html = render(h(DeleteExportBanList, { exportBanList: BATTLEMETRICS }), { start: [true] });
  const [dialog] = dialogs;
  assert.strictEqual(dialog.isOpen, true);
  assert.strictEqual(dialog.role, 'alertdialog');
  assert.strictEqual(dialog.autoFocus, false, 'the dialog leaves focus to Cancel');
  assert.strictEqual(dialog.returnFocusAfterClose, true, 'focus goes back to Delete');
  const titled = html.match(/aria-labelledby="([^"]+)"/)[1];
  assert.match(
    html,
    new RegExp(`<span id="${escape(titled)}">Delete &quot;Main list&quot;\\?</span>`)
  );
  assert.ok(plain(html).includes(`${SERVERS} ${BATTLEMETRICS_TOO} ${FOR_GOOD}`), plain(html));

  const cancel = button('Cancel');
  const confirm = button('Delete export ban list');
  assert.strictEqual(cancel.autoFocus, true);
  assert.strictEqual(confirm.autoFocus, undefined);
  assert.strictEqual(confirm.color, 'danger');
  assert.ok(html.indexOf('>Cancel<') < html.indexOf('>Delete export ban list<'));

  // Cancel, and Escape or a click outside the dialog, which reactstrap passes to toggle, close it
  // and send nothing.
  cancel.onClick();
  dialog.toggle();
  assert.deepStrictEqual(sent, []);
  assert.deepStrictEqual(setTo, [false, false]);

  // Only the dialog's button deletes, and only that list.
  confirm.onClick();
  assert.deepStrictEqual(sent, [{ id: 7 }]);
}

// Only a BattleMetrics list that has a BattleMetrics ban list says that it is deleted too.
for (const exportBanList of [REMOTE, NO_BATTLEMETRICS_LIST]) {
  const html = render(h(DeleteExportBanList, { exportBanList }), { start: [true] });
  assert.ok(plain(html).includes(`${SERVERS} ${FOR_GOOD}`), exportBanList.name);
  assert.ok(!html.includes('BattleMetrics'), exportBanList.name);
}

// While the deletion runs, nothing does anything, the dialog cannot be closed, and its button says
// it is deleting. That button keeps focus, so it is only marked disabled.
function checkBusy() {
  assert.strictEqual(button('Delete').disabled, true);
  assert.strictEqual(button('Cancel').disabled, true);
  const confirm = button('Deleting...');
  assert.strictEqual(confirm['aria-disabled'], true);
  assert.strictEqual(confirm.className, 'disabled');
  confirm.onClick();
  dialogs[0].toggle();
  assert.deepStrictEqual(sent, [], 'nothing more is sent while it runs');
  assert.deepStrictEqual(setTo, [], 'Escape does not close it while it runs');
  assert.strictEqual(dialogs[0].returnFocusAfterClose, false);
}
render(h(DeleteExportBanList, { exportBanList: BATTLEMETRICS }), {
  state: { ...IDLE, loading: true },
  start: [true]
});
checkBusy();

// A failed deletion shows the web server's message in the dialog, which stays open to try again,
// or a request's own error when the web server did not answer.
for (const [error, message] of [
  [
    new CombinedGraphQLErrors({
      data: { deleteExportBanList: null },
      errors: [{ message: 'This export ban list is already being deleted.' }]
    }),
    'This export ban list is already being deleted.'
  ],
  [new Error('Failed to fetch'), 'Failed to fetch']
]) {
  const html = render(h(DeleteExportBanList, { exportBanList: BATTLEMETRICS }), {
    state: { ...IDLE, error },
    start: [true]
  });
  assert.match(html, new RegExp(`role="alert"><p class="mb-0">${escape(message)}</p>`));
  assert.strictEqual(button('Cancel').disabled, false);
  assert.strictEqual(button('Delete export ban list')['aria-disabled'], false);
  assert.strictEqual(dialogs[0].returnFocusAfterClose, true);
  button('Delete export ban list').onClick();
  assert.deepStrictEqual(sent, [{ id: 7 }], 'it can be tried again');
}

// Once the list is deleted, the dialog closes without sending focus back to a Delete button that is
// gone, and the page is told which list it was.
{
  const deleted = [];
  render(
    h(DeleteExportBanList, {
      exportBanList: BATTLEMETRICS,
      onDeleted: (name) => deleted.push(name)
    }),
    { state: { ...IDLE, data: { deleteExportBanList: { id: 7 } } }, start: [true] }
  );
  assert.strictEqual(dialogs[0].returnFocusAfterClose, false);
  mutationOptions.onCompleted();
  assert.deepStrictEqual(setTo, [false]);
  assert.deepStrictEqual(deleted, ['Main list']);
}

// The same for a list's custom points for a ban list, whose dialog says what they become.
const EXPORT_BAN_LIST = { id: 7, defaultActivePoints: 3, defaultExpiredPoints: 1 };
const config = (id, banList) => ({
  id,
  activePoints: 5,
  expiredPoints: 2,
  banList: { id: id + 100, name: banList, paused: false, organisation: { id: 1, name: 'AFO' } }
});
const BAN_LIST_POINTS = config(10, 'Squad Bans');
{
  const deleted = [];
  const props = {
    exportBanListConfig: BAN_LIST_POINTS,
    exportBanList: EXPORT_BAN_LIST,
    onDeleted: (name) => deleted.push(name)
  };
  let html = render(h(DeleteExportBanListConfig, props));
  button('Delete').onClick();
  assert.deepStrictEqual(sent, [], 'Delete sends nothing');
  assert.deepStrictEqual(setTo, [true]);
  assert.ok(!html.includes('role="alertdialog"'));
  assert.match(
    html,
    /aria-label="Delete the custom points for AFO&#x27;s Squad Bans"[^>]*>Delete</
  );
  assert.strictEqual(resets, 1);

  html = render(h(DeleteExportBanListConfig, props), { start: [true] });
  const titled = html.match(/aria-labelledby="([^"]+)"/)[1];
  assert.match(
    html,
    new RegExp(
      `<span id="${escape(titled)}">Delete the custom points for AFO&#x27;s Squad Bans\\?</span>`
    )
  );
  assert.ok(
    plain(html).includes(
      "Bans on AFO's Squad Bans will count for this export ban list's default points: 3 for an active ban and 1 for an expired ban."
    ),
    plain(html)
  );
  assert.strictEqual(button('Cancel').autoFocus, true);
  assert.strictEqual(dialogs[0].autoFocus, false);
  button('Cancel').onClick();
  dialogs[0].toggle();
  assert.deepStrictEqual(sent, []);
  button('Delete custom points').onClick();
  assert.deepStrictEqual(sent, [{ id: 10 }]);

  // Its Delete button is disabled while the deletion runs, and the dialog's buttons do nothing.
  render(h(DeleteExportBanListConfig, props), { state: { ...IDLE, loading: true }, start: [true] });
  checkBusy();

  // A refused deletion shows the web server's message.
  html = render(h(DeleteExportBanListConfig, props), {
    state: {
      ...IDLE,
      data: { deleteExportBanListConfig: null },
      error: new CombinedGraphQLErrors({
        data: { deleteExportBanListConfig: null },
        errors: [{ message: 'Export ban list config does not exist!' }]
      })
    },
    start: [true]
  });
  assert.match(html, /role="alert"><p class="mb-0">Export ban list config does not exist!<\/p>/);
  assert.strictEqual(dialogs[0].returnFocusAfterClose, true);

  render(h(DeleteExportBanListConfig, props), {
    state: { ...IDLE, data: { deleteExportBanListConfig: { id: 10 } } },
    start: [true]
  });
  assert.strictEqual(dialogs[0].returnFocusAfterClose, false);
  mutationOptions.onCompleted();
  assert.deepStrictEqual(deleted, ["AFO's Squad Bans"]);
}

// The export ban lists page keys each list's row by the list's ID, so a row, and the Delete button
// in it, is never handed to another list once one is deleted. Delete is set apart from Install and
// Edit, and is given the list. Once a list is deleted, the page says so, in a message that takes
// focus as the list's row goes.
{
  const data = {
    loggedInSteamUser: {
      id: 'owner',
      exportBanLists: [BATTLEMETRICS, REMOTE].map((list) => ({
        ...list,
        threshold: 9,
        defaultActivePoints: 3,
        defaultExpiredPoints: 1,
        battlemetricsInvite: null
      }))
    }
  };
  let html = render(h(ExportBanLists), { data });
  assert.deepStrictEqual(
    rowKeys.filter((key) => key !== undefined),
    [7, 8],
    'rows keyed by list'
  );
  assert.deepStrictEqual(
    listButtons.map((props) => props.exportBanList.id),
    [7, 8]
  );
  for (const props of listButtons) assert.strictEqual(props.className, 'ms-3');
  assert.match(html, /aria-label="Delete Squad servers"/);
  assert.ok(!html.includes('Deleted export ban list'));
  listButtons[1].onDeleted('Squad servers');
  assert.deepStrictEqual(setTo, [{ name: 'Squad servers' }]);

  html = render(h(ExportBanLists), { data, start: [{ name: 'Squad servers' }] });
  assert.match(
    html,
    /<p tabindex="-1" class="fw-bold">Deleted export ban list &quot;Squad servers&quot;\.<\/p>/
  );
}

// The configs table keys each row by the config's ID, gives Delete the config and the list's
// default points, and says once custom points are deleted.
{
  const data = {
    loggedInSteamUser: {
      exportBanList: {
        ...EXPORT_BAN_LIST,
        type: 'remote',
        threshold: 9,
        maxBanAge: 0,
        exportBanListConfigs: [BAN_LIST_POINTS, config(11, 'Seed Bans')]
      }
    }
  };
  let html = render(h(ExportBanListConfigs, { exportBanListID: 7 }), { data });
  assert.deepStrictEqual(
    rowKeys.filter((key) => key !== undefined),
    [10, 11],
    'rows keyed by config'
  );
  assert.deepStrictEqual(
    configButtons.map((props) => [props.exportBanListConfig.id, props.exportBanList.id]),
    [
      [10, 7],
      [11, 7]
    ]
  );
  assert.match(html, /aria-label="Delete the custom points for AFO&#x27;s Seed Bans"/);
  configButtons[1].onDeleted("AFO's Seed Bans");
  assert.deepStrictEqual(setTo, [{ banListName: "AFO's Seed Bans" }]);

  html = render(h(ExportBanListConfigs, { exportBanListID: 7 }), {
    data,
    start: [{ banListName: "AFO's Seed Bans" }]
  });
  assert.match(
    html,
    /<p tabindex="-1" class="fw-bold mb-0">Deleted the custom points for AFO&#x27;s Seed Bans\.<\/p>/
  );
}

console.log(
  'Delete confirmation checks passed: export ban lists and custom points are deleted only from their dialogs, which name them and say what deleting does.'
);
