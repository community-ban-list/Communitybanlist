import assert from 'assert';
import { readFile } from 'fs/promises';
import vm from 'vm';

import * as hookformYup from '@hookform/resolvers/yup';
import { createFormControl } from 'react-hook-form';
import * as yup from 'yup';

import * as exportListLimits from '../../scbl-lib/export-list-limits.js';
import Validators from '../../scbl-lib/validators.js';

// Checks the export ban list forms' checks against the limits on export ban lists, and the FAQ's
// answer about the limits. The forms show the problems the web server gives for a change, from the
// same scbl-lib/export-list-limits.js, under the fields they are about as the owner types. The
// client's modules are loaded with the real limits and form packages, and each form runs in
// react-hook-form's form control with the options useForm gets, without a page.

// Load one of the client's modules, with its package imports from these.
const packages = {
  yup,
  '@hookform/resolvers/yup': hookformYup,
  'scbl-lib/export-list-limits': exportListLimits,
  'scbl-lib/validators': { default: Validators }
};
async function loadClient(path) {
  const url = new URL(path, import.meta.url);
  const module = new vm.SourceTextModule(await readFile(url, 'utf8'), { identifier: url.href });
  await module.link((specifier) => {
    assert.ok(Object.hasOwn(packages, specifier), `Unexpected dependency: ${specifier}`);
    const exports = packages[specifier];
    return new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
    });
  });
  await module.evaluate();
  return module.namespace;
}

const forms = await loadClient('../../client/src/utils/export-list-forms.js');
const { default: exportListLimitsAnswer } = await loadClient(
  '../../client/src/views/pages/faq-export-list-limits.js'
);

const { DEFAULT_LIMITS, readLimits } = exportListLimits;
const limitsWith = (env) => readLimits(env).limits;
const limits = limitsWith({});

// The web server's messages, as web-server/test/export-ban-list-values.js has them.
const typeName = (type) => (type === 'remote' ? 'remote' : 'BattleMetrics');
const MESSAGES = {
  threshold: 'The threshold must be a whole number from 1 to 1,000.',
  points: 'Points must be whole numbers from 0 to 100.',
  maxBanAge:
    'The max ban age must be a whole number of days from 0 to 3,650. Use 0 to count bans of any age.',
  activePlusExpired: (total, active, expired, lowest) =>
    `One active ban plus one expired ban must not be enough to put a player on an export ban list. Here they can give ${total} points (${active}, plus ${expired}), so the threshold must be ${lowest} or more. Raise the threshold or lower the points.`,
  minimum: (type, minimum) =>
    `A ${typeName(type)} export ban list's threshold must be at least ${minimum}.`
};

// Ban lists, and export ban lists with their configs, as the site's queries give them. The ban
// lists belong to the same organisations as in the web server's test.
const ORGANISATIONS = { 1: 1, 2: 2, 3: 2, 4: 1, 5: 1 };
const banLists = Object.entries(ORGANISATIONS).map(([id, organisation]) => ({
  id: Number(id),
  name: `Ban List ${id}`,
  organisation: { id: organisation, name: `Partner Org ${organisation}` }
}));
let configIDs = 1000;
const configOf = (banList, activePoints, expiredPoints) => ({
  id: configIDs++,
  activePoints,
  expiredPoints,
  banList: banLists.find(({ id }) => id === banList)
});
const listOf = (values, configs = []) => ({
  id: 1,
  name: 'List 1',
  server: 'Server',
  type: 'remote',
  threshold: 9,
  defaultActivePoints: 3,
  defaultExpiredPoints: 1,
  maxBanAge: 0,
  discordWebhook: null,
  exportBanListConfigs: configs,
  ...values
});

// A form as useForm runs it, with these options and its fields registered as the form registers
// them. typing sets a field's value as an input does, and waits for the checks that starts. errors
// gives the messages the form shows, by the names it shows them under: each field's own, and for
// the config form, the points rules' problems under 'points'.
const LIST_FORM_FIELDS = Object.keys(Validators.ExportBanList);
const CONFIG_FORM_FIELDS = ['banList', 'activePoints', 'expiredPoints'];
const CONFIG_FORM_ERRORS = [...CONFIG_FORM_FIELDS, 'points'];
const settled = () => new Promise((resolve) => setImmediate(resolve));
function formOf(options, names, fieldOptions, shown = names) {
  const form = createFormControl(options);
  const fields = Object.fromEntries(
    names.map((name) => [name, form.register(name, fieldOptions[name])])
  );
  return {
    async type(name, value) {
      await fields[name].onChange({ target: { name, value }, type: 'change' });
      await settled();
      await settled();
    },
    errors() {
      return Object.fromEntries(
        shown.flatMap((name) => {
          const message = form.getFieldState(name).error?.message;
          return message === undefined ? [] : [[name, message]];
        })
      );
    },
    // The values the form would submit, or none if its checks stop it.
    async submit() {
      let submitted;
      await form.handleSubmit((values) => {
        submitted = values;
      })();
      return submitted;
    },
    // The form rendered again with new options. useForm gives the form control its options this
    // way each time the form renders, which is how the config form gets the list's configs once
    // they have changed.
    render(options) {
      form.control._options = options;
    }
  };
}
const listForm = (exportBanList, withLimits = limits) =>
  formOf(forms.listFormOptions(exportBanList, withLimits), LIST_FORM_FIELDS, forms.LIST_FIELDS);
const configFormWith = (exportBanList, choices, withLimits = limits) =>
  formOf(
    forms.configFormOptions(exportBanList, choices, withLimits),
    CONFIG_FORM_FIELDS,
    forms.CONFIG_FIELDS,
    CONFIG_FORM_ERRORS
  );
const configForm = (exportBanList, withLimits = limits) =>
  configFormWith(exportBanList, banLists, withLimits);

// A list's configs are taken as the web server takes them: in the order of their IDs, with their
// ban lists' and organisations' names, and nothing else of the list.
assert.deepStrictEqual(
  forms.storedList(
    listOf({}, [configOf(3, 6, 3), { id: 7, activePoints: null, expiredPoints: 2, banList: null }])
  ),
  {
    settings: { threshold: 9, defaultActivePoints: 3, defaultExpiredPoints: 1, maxBanAge: 0 },
    configs: [
      {
        id: 7,
        banList: null,
        activePoints: null,
        expiredPoints: 2,
        banListName: undefined,
        organisationName: undefined
      },
      {
        id: 1000,
        banList: 3,
        activePoints: 6,
        expiredPoints: 3,
        banListName: 'Ban List 3',
        organisationName: 'Partner Org 2'
      }
    ]
  }
);

// Creating a list. The form starts with the model's defaults and the lowest threshold allowed for
// either type, which are within the limits, and every value is checked as it is typed.
assert.deepStrictEqual(forms.listFormOptions(undefined, limits).defaultValues, {
  type: 'remote',
  threshold: 9,
  defaultActivePoints: 3,
  defaultExpiredPoints: 1,
  maxBanAge: 0
});
assert.strictEqual(
  forms.listFormOptions(undefined, limitsWith({ EXPORT_BM_MIN_THRESHOLD: '12' })).defaultValues
    .threshold,
  12
);
assert.strictEqual(forms.listFormOptions(undefined, limits).mode, 'onChange');

let form = listForm(undefined);
assert.deepStrictEqual(form.errors(), {});
// One active ban plus one expired ban must not be enough, so 3/1 points need a threshold of 5.
await form.type('threshold', '4');
assert.deepStrictEqual(form.errors(), {
  threshold: MESSAGES.activePlusExpired(4, '3 for an active ban', '1 for an expired ban', 5)
});
await form.type('threshold', '5');
assert.deepStrictEqual(form.errors(), {});
// The rules' problems show under the threshold, and changing the points checks it again.
await form.type('defaultActivePoints', '5');
assert.deepStrictEqual(form.errors(), {
  threshold: MESSAGES.activePlusExpired(6, '5 for an active ban', '1 for an expired ban', 7)
});
// Values outside their bounds come first, under their own fields, as the web server refuses them
// first.
await form.type('defaultActivePoints', '101');
assert.deepStrictEqual(form.errors(), { defaultActivePoints: MESSAGES.points });
await form.type('defaultActivePoints', '2.5');
assert.deepStrictEqual(form.errors(), { defaultActivePoints: MESSAGES.points });
await form.type('defaultActivePoints', '1');
await form.type('defaultExpiredPoints', '1');
// 1/1 points need only the minimum threshold of 4.
await form.type('threshold', '3');
assert.deepStrictEqual(form.errors(), { threshold: MESSAGES.minimum('remote', 4) });
await form.type('threshold', '0');
assert.deepStrictEqual(form.errors(), { threshold: MESSAGES.threshold });
await form.type('threshold', '1001');
assert.deepStrictEqual(form.errors(), { threshold: MESSAGES.threshold });
await form.type('maxBanAge', '3651');
assert.deepStrictEqual(form.errors(), {
  threshold: MESSAGES.threshold,
  maxBanAge: MESSAGES.maxBanAge
});
await form.type('maxBanAge', '365');
await form.type('threshold', '4');
assert.deepStrictEqual(form.errors(), {});
// The settings' bounds come only from the limits, so a value typed below 0, left empty or not a
// number gets the web server's message for it.
await form.type('threshold', '-1');
assert.deepStrictEqual(form.errors(), { threshold: MESSAGES.threshold });
await form.type('threshold', '');
assert.deepStrictEqual(form.errors(), { threshold: MESSAGES.threshold });
await form.type('threshold', '4');
await form.type('maxBanAge', '-1');
assert.deepStrictEqual(form.errors(), { maxBanAge: MESSAGES.maxBanAge });
await form.type('maxBanAge', 'a year');
assert.deepStrictEqual(form.errors(), { maxBanAge: MESSAGES.maxBanAge });
await form.type('maxBanAge', ' ');
assert.deepStrictEqual(form.errors(), { maxBanAge: MESSAGES.maxBanAge });
await form.type('maxBanAge', '365');
await form.type('defaultExpiredPoints', '');
assert.deepStrictEqual(form.errors(), { defaultExpiredPoints: MESSAGES.points });
await form.type('defaultExpiredPoints', '1');
assert.deepStrictEqual(form.errors(), {});
// The form's own rules for the name, server and webhook still apply, and a form with problems is
// not submitted.
assert.strictEqual(await form.submit(), undefined);
assert.deepStrictEqual(Object.keys(form.errors()).sort(), ['name', 'server']);
await form.type('name', 'New');
await form.type('server', 'Server');
assert.deepStrictEqual(await form.submit(), {
  type: 'remote',
  threshold: 4,
  defaultActivePoints: 1,
  defaultExpiredPoints: 1,
  maxBanAge: 365,
  name: 'New',
  server: 'Server'
});
// Each type has its own limits, so changing the type checks the threshold again.
form = listForm(undefined, limitsWith({ EXPORT_BM_MIN_THRESHOLD: '12' }));
await form.type('name', 'New');
await form.type('server', 'Server');
await form.type('threshold', '11');
assert.deepStrictEqual(form.errors(), {});
await form.type('type', 'battlemetrics');
assert.deepStrictEqual(form.errors(), { threshold: MESSAGES.minimum('battlemetrics', 12) });
assert.strictEqual(await form.submit(), undefined);
await form.type('type', 'remote');
assert.deepStrictEqual(form.errors(), {});
// Under the rule that only one ban must not be enough, 3/1 points at threshold 4 are allowed.
form = listForm(undefined, limitsWith({ EXPORT_REMOTE_NEVER_ENOUGH: 'one-ban' }));
await form.type('threshold', '4');
assert.deepStrictEqual(form.errors(), {});
await form.type('threshold', '3');
assert.deepStrictEqual(form.errors(), {
  threshold:
    'One ban must not be enough to put a player on an export ban list. Here one ban can give 3 points (an active ban), so the threshold must be 4 or more. Raise the threshold or lower the points.'
});

// Saving a list. The form starts with its saved values, without its configs or anything else of
// it, and checks the settings that differ from them with its configs, as the web server does.
const withConfig = listOf({ id: 4 }, [configOf(3, 6, 3)]);
assert.deepStrictEqual(forms.listFormOptions(withConfig, limits).defaultValues, {
  name: 'List 1',
  server: 'Server',
  threshold: 9,
  type: 'remote',
  defaultActivePoints: 3,
  defaultExpiredPoints: 1,
  maxBanAge: 0,
  discordWebhook: ''
});
form = listForm(withConfig);
await form.type('threshold', '8');
assert.deepStrictEqual(form.errors(), {
  threshold: MESSAGES.activePlusExpired(
    9,
    "6 for an active ban on Partner Org 2's Ban List 3",
    "3 for an expired ban on Partner Org 2's Ban List 3",
    10
  )
});
await form.type('threshold', '10');
assert.deepStrictEqual(form.errors(), {});
assert.deepStrictEqual(await form.submit(), {
  name: 'List 1',
  server: 'Server',
  threshold: 10,
  type: 'remote',
  defaultActivePoints: 3,
  defaultExpiredPoints: 1,
  maxBanAge: 0,
  discordWebhook: ''
});

// A list saved before these limits, and outside them: one active ban plus one expired ban is
// enough for it, with 2/1 and configs of 3/1 for two ban lists at threshold 4. The form says so
// above its fields, and why.
const older = listOf({ threshold: 4, defaultActivePoints: 2 }, [
  configOf(1, 3, 1),
  configOf(2, 3, 1)
]);
assert.deepStrictEqual(
  forms.outsideLimits(older, limits).map(({ message }) => message),
  [
    MESSAGES.activePlusExpired(
      4,
      "3 for an active ban on Partner Org 1's Ban List 1",
      '1 for an expired ban',
      5
    )
  ]
);
assert.strictEqual(
  forms.OUTSIDE_LIMITS_NOTE,
  "This list's settings are outside today's limits. You can keep them, and changes that make the list smaller are always allowed. Other changes must bring the whole list within the limits, so once you change these settings you may not be able to set them back."
);
for (const within of [listOf({}), listOf({ threshold: 5 }), { ...withConfig, threshold: 10 }])
  assert.deepStrictEqual(forms.outsideLimits(within, limits), []);
// A new list has no note.
assert.deepStrictEqual(forms.outsideLimits(undefined, limits), []);
// The list with a 6/3 config at threshold 9 above was outside the rules too.
assert.strictEqual(forms.outsideLimits(withConfig, limits).length, 1);
// The note follows the limits for the list's own type. With a higher minimum threshold for one
// type, a list with 3/1 at threshold 10 is outside the limits as that type, and within them as the
// other.
for (const [type, variable] of [
  ['battlemetrics', 'EXPORT_BM_MIN_THRESHOLD'],
  ['remote', 'EXPORT_REMOTE_MIN_THRESHOLD']
]) {
  const typeLimits = limitsWith({ [variable]: '12' });
  const other = type === 'remote' ? 'battlemetrics' : 'remote';
  assert.deepStrictEqual(
    forms.outsideLimits(listOf({ type, threshold: 10 }), typeLimits).map(({ message }) => message),
    [MESSAGES.minimum(type, 12)]
  );
  assert.deepStrictEqual(
    forms.outsideLimits(listOf({ type: other, threshold: 10 }), typeLimits),
    []
  );
}
// It can be saved as it is, renamed and given another server or webhook, with no problems from
// the limits.
form = listForm(older);
assert.deepStrictEqual(await form.submit(), forms.listFormOptions(older, limits).defaultValues);
await form.type('name', 'Renamed');
await form.type('server', 'Another server');
await form.type('discordWebhook', 'https://discord.com/api/webhooks/11/token-11');
assert.deepStrictEqual(form.errors(), {});
assert.strictEqual((await form.submit()).name, 'Renamed');
// Changes that can only make it smaller have no problems: a higher threshold, and lower points.
await form.type('threshold', '5');
await form.type('defaultActivePoints', '1');
assert.deepStrictEqual(form.errors(), {});
await form.type('defaultActivePoints', '2');
await form.type('threshold', '4');
assert.deepStrictEqual(form.errors(), {});
// A change that could make it bigger must bring the whole list within the rules, configs
// included.
await form.type('threshold', '3');
assert.deepStrictEqual(form.errors(), {
  threshold: MESSAGES.activePlusExpired(
    4,
    "3 for an active ban on Partner Org 1's Ban List 1",
    '1 for an expired ban',
    5
  )
});
await form.type('threshold', '4');
await form.type('defaultExpiredPoints', '2');
assert.deepStrictEqual(form.errors(), {
  threshold: MESSAGES.activePlusExpired(
    5,
    "3 for an active ban on Partner Org 1's Ban List 1",
    '2 for an expired ban',
    6
  )
});
// Counting older bans could make it bigger too.
await form.type('defaultExpiredPoints', '1');
assert.deepStrictEqual(form.errors(), {});
const olderWithAge = { ...older, maxBanAge: 730 };
form = listForm(olderWithAge);
await form.type('maxBanAge', '365');
assert.deepStrictEqual(form.errors(), {});
await form.type('maxBanAge', '0');
assert.deepStrictEqual(Object.keys(form.errors()), ['threshold']);
await form.type('threshold', '6');
assert.deepStrictEqual(form.errors(), {});

// A BattleMetrics list with 5/5/0 can only put its expired points back with a threshold that
// brings it within the rules.
const fiveFive = listOf({ type: 'battlemetrics', threshold: 5, defaultActivePoints: 5 }, []);
fiveFive.defaultExpiredPoints = 0;
form = listForm(fiveFive);
await form.type('defaultExpiredPoints', '1');
assert.deepStrictEqual(form.errors(), {
  threshold: MESSAGES.activePlusExpired(6, '5 for an active ban', '1 for an expired ban', 7)
});
await form.type('threshold', '7');
assert.deepStrictEqual(form.errors(), {});
// The limits are those of its saved type, whatever the form's type field holds. Here remote lists
// have no points rules.
form = listForm(fiveFive, limitsWith({ EXPORT_REMOTE_NEVER_ENOUGH: 'none' }));
await form.type('type', 'remote');
await form.type('defaultExpiredPoints', '1');
assert.deepStrictEqual(form.errors(), {
  threshold: MESSAGES.activePlusExpired(6, '5 for an active ban', '1 for an expired ban', 7)
});

// A list with a value below 0, which any change to its settings could make bigger, can still be
// saved as it is and renamed, as the web server only checks the settings a change sets.
const belowZero = listOf({ threshold: 3, defaultExpiredPoints: -1 });
form = listForm(belowZero);
await form.type('name', 'Renamed');
assert.deepStrictEqual(await form.submit(), {
  ...forms.listFormOptions(belowZero, limits).defaultValues,
  name: 'Renamed'
});
assert.deepStrictEqual(form.errors(), {});
// So can a list with a threshold or max ban age below 0, or a value missing, which is sent back as
// it was saved, so the web server leaves it alone.
for (const saved of [{ threshold: -1 }, { maxBanAge: -1 }, { maxBanAge: null }]) {
  const list = listOf(saved);
  form = listForm(list);
  await form.type('name', 'Renamed');
  assert.deepStrictEqual(
    await form.submit(),
    { ...forms.listFormOptions(list, limits).defaultValues, ...saved, name: 'Renamed' },
    JSON.stringify(saved)
  );
  assert.deepStrictEqual(form.errors(), {}, JSON.stringify(saved));
}
// Its values can be changed to ones within the limits, which any change must bring the whole list
// within, as it could make the list bigger.
form = listForm(listOf({ threshold: -1 }));
await form.type('threshold', '4');
assert.deepStrictEqual(form.errors(), {
  threshold: MESSAGES.activePlusExpired(4, '3 for an active ban', '1 for an expired ban', 5)
});
await form.type('threshold', '5');
assert.deepStrictEqual(form.errors(), {});
assert.strictEqual((await form.submit()).threshold, 5);

// A list with a value outside the bounds can still be saved, and its other values changed. The
// values a change sets must be within them.
const outOfBounds = listOf({ maxBanAge: 5000 });
form = listForm(outOfBounds);
await form.type('threshold', '10');
assert.deepStrictEqual(form.errors(), {});
await form.type('maxBanAge', '4000');
assert.deepStrictEqual(form.errors(), { maxBanAge: MESSAGES.maxBanAge });

// Adding a config. Its points must be within their bounds, and points that could make the list
// bigger must leave the whole list within the rules. The rules' problems are about both points,
// so they show under both, and the ban list chosen is named in them.
const adding = listOf({ id: 10 }, [configOf(1, 5, 2)]);
assert.deepStrictEqual(forms.configFormOptions(adding, banLists, limits).defaultValues, {
  banList: null,
  activePoints: 3,
  expiredPoints: 1
});
form = configForm(adding);
await form.type('banList', '2');
assert.deepStrictEqual(form.errors(), {});
await form.type('activePoints', '6');
assert.deepStrictEqual(form.errors(), {});
await form.type('expiredPoints', '3');
assert.deepStrictEqual(form.errors(), {
  points:
    "With these points, an active ban on Partner Org 2's Ban List 2 plus an expired ban on Partner Org 2's Ban List 2 could give 9 points, which reaches this list's threshold of 9. Use fewer points, or raise the list's threshold to 10 or more first."
});
assert.strictEqual(await form.submit(), undefined);
await form.type('expiredPoints', '2');
assert.deepStrictEqual(form.errors(), {});
assert.deepStrictEqual(await form.submit(), { banList: 2, activePoints: 6, expiredPoints: 2 });
// Choosing another ban list names it in the message.
await form.type('expiredPoints', '3');
await form.type('banList', '5');
assert.deepStrictEqual(form.errors(), {
  points:
    "With these points, an active ban on Partner Org 1's Ban List 5 plus an expired ban on Partner Org 1's Ban List 5 could give 9 points, which reaches this list's threshold of 9. Use fewer points, or raise the list's threshold to 10 or more first."
});
// Points outside their bounds come first, under their own fields.
await form.type('activePoints', '101');
assert.deepStrictEqual(form.errors(), { activePoints: MESSAGES.points });
await form.type('activePoints', '-1');
assert.deepStrictEqual(form.errors(), { activePoints: MESSAGES.points });
await form.type('activePoints', '6');
assert.deepStrictEqual(Object.keys(form.errors()), ['points']);
// The web server refuses a second config for a ban list before it checks the points, so the form
// leaves that to it.
await form.type('banList', '1');
assert.deepStrictEqual(form.errors(), {});
// Once a config has been added, the form checks the next one with it.
await form.type('banList', '2');
assert.deepStrictEqual(Object.keys(form.errors()), ['points']);
form.render(
  forms.configFormOptions(
    { ...adding, exportBanListConfigs: [...adding.exportBanListConfigs, configOf(2, 6, 2)] },
    banLists,
    limits
  )
);
await form.type('expiredPoints', '4');
assert.deepStrictEqual(form.errors(), {});
// Until the list or the ban lists have loaded, only the bounds are checked.
for (const [list, choices] of [
  [undefined, banLists],
  [adding, undefined]
]) {
  form = configFormWith(list, choices);
  await form.type('banList', '2');
  await form.type('activePoints', '50');
  assert.deepStrictEqual(form.errors(), {});
  await form.type('expiredPoints', '101');
  assert.deepStrictEqual(form.errors(), { expiredPoints: MESSAGES.points });
}

// A list outside the rules can be given a config with points of at most its defaults, but not one
// that could make it bigger.
form = configForm(listOf({ id: 11, threshold: 3 }));
await form.type('banList', '3');
assert.deepStrictEqual(form.errors(), {});
await form.type('activePoints', '0');
await form.type('expiredPoints', '0');
assert.deepStrictEqual(form.errors(), {});
await form.type('banList', '5');
await form.type('activePoints', '4');
await form.type('expiredPoints', '1');
assert.deepStrictEqual(form.errors(), {
  points:
    "With these points, an active ban on Partner Org 1's Ban List 5 plus an expired ban could give 5 points, which reaches this list's threshold of 3. Use fewer points, or raise the list's threshold to 6 or more first."
});
// When the list's other configs already put it outside the rules, the message says so and names
// them. Here two copies of a 2/2 config for Ban List 2 give an expired ban 4 points.
form = configForm(listOf({ id: 14, threshold: 6 }, [configOf(2, 2, 2), configOf(2, 2, 2)]));
await form.type('banList', '3');
await form.type('expiredPoints', '2');
assert.deepStrictEqual(form.errors(), {
  points:
    "This list's settings are outside today's limits. One active ban plus one expired ban can already give 7 points (3 for an active ban, plus 4 for an expired ban on Partner Org 2's Ban List 2), which reaches the list's threshold of 6. Use points no higher than the list's defaults (3 for an active ban, 1 for an expired ban), or raise the list's threshold to 8 or more first."
});
await form.type('expiredPoints', '1');
assert.deepStrictEqual(form.errors(), {});
// The limits are those of the list's type.
form = configForm(
  listOf({ id: 15, type: 'battlemetrics', threshold: 6 }),
  limitsWith({ EXPORT_BM_NEVER_ENOUGH: 'one-ban' })
);
await form.type('banList', '4');
await form.type('expiredPoints', '3');
assert.deepStrictEqual(form.errors(), {});
await form.type('activePoints', '6');
assert.deepStrictEqual(form.errors(), {
  points:
    "With these points, one active ban on Partner Org 1's Ban List 4 could give 6 points, which reaches this list's threshold of 6. Use fewer points, or raise the list's threshold to 7 or more first."
});

// Without limits for a list's type that can be used, every one of them as the web server would
// read it, the forms leave the checks to the web server, and never fail.
for (const odd of [
  undefined,
  null,
  {},
  { remote: undefined },
  { battlemetrics: limits.remote },
  { remote: {} },
  { remote: 'remote' },
  { remote: { ...limits.remote, neverEnough: 'ACTIVE-PLUS-EXPIRED' } },
  { remote: { ...limits.remote, minThreshold: 0 } },
  { remote: { ...limits.remote, maxPlayers: '40000' } },
  { remote: { minThreshold: 4, neverEnough: 'active-plus-expired' } }
]) {
  const which = JSON.stringify(odd);
  assert.deepStrictEqual(
    forms.listProblems({ ...listOf({}), threshold: 1 }, undefined, odd),
    [],
    which
  );
  assert.deepStrictEqual(
    forms.listProblems({ ...listOf({}), threshold: 1 }, listOf({}), odd),
    [],
    which
  );
  assert.deepStrictEqual(
    forms.configProblems(
      { banList: 2, activePoints: 50, expiredPoints: 50 },
      adding,
      banLists,
      odd
    ),
    [],
    which
  );
  assert.deepStrictEqual(forms.outsideLimits(older, odd), [], which);

  // The client never gives the forms such limits: it reads those /config.js gives as the web
  // server reads its environment variables (scbl-lib/config.js), so each limit that is missing or
  // cannot be used is the default, and the forms check with it.
  const read = exportListLimits.readGivenLimits(odd).limits;
  assert.deepStrictEqual(read.remote, DEFAULT_LIMITS.remote, which);
  assert.deepStrictEqual(
    forms.listProblems({ ...listOf({}), threshold: 4 }, undefined, read),
    [
      {
        rule: 'never-enough',
        field: 'threshold',
        message: MESSAGES.activePlusExpired(4, '3 for an active ban', '1 for an expired ban', 5)
      }
    ],
    which
  );
}
for (const type of ['constructor', '__proto__', 'toString', undefined])
  assert.deepStrictEqual(
    forms.listProblems({ ...listOf({}), threshold: 1, type }, undefined, limits),
    []
  );

// The FAQ's answer, with the default limits.
assert.strictEqual(
  exportListLimitsAnswer(DEFAULT_LIMITS),
  'So that one active ban and one expired ban are never enough to put a player on an export ban list, its threshold must be higher than the most points they can give together, whichever ban lists they are on, and at least 4. ' +
    'With the default points of 3 for an active ban and 1 for an expired ban, that is a threshold of 5 or more. ' +
    'A remote export ban list can have at most 40,000 players, and a BattleMetrics export ban list at most 20,000, as each player on a BattleMetrics export ban list is added to BattleMetrics separately. ' +
    'Points can be whole numbers from 0 to 100, thresholds from 1 to 1,000, and max ban ages from 0 to 3,650 days, where 0 counts bans of any age. ' +
    'Export ban lists saved before these limits keep working as they are, and you can always rename them or make them smaller, for example by raising the threshold. Changes that could make one bigger must bring the whole list within the limits.'
);
const OLDER_LISTS =
  'Export ban lists saved before these limits keep working as they are, and you can always rename them or make them smaller, for example by raising the threshold. Changes that could make one bigger must bring the whole list within the limits.';
const answerWith = (env) => exportListLimitsAnswer(limitsWith(env));
// It follows the limits set: here one ban must not be enough for either type, with a higher
// minimum, and lists of each type can be as big as each other.
assert.strictEqual(
  answerWith({
    EXPORT_BM_NEVER_ENOUGH: 'one-ban',
    EXPORT_REMOTE_NEVER_ENOUGH: 'one-ban',
    EXPORT_BM_MIN_THRESHOLD: '12',
    EXPORT_REMOTE_MIN_THRESHOLD: '12',
    EXPORT_BM_MAX_PLAYERS: '30000',
    EXPORT_REMOTE_MAX_PLAYERS: '30000'
  }).split('. Points can')[0],
  'So that one ban is never enough to put a player on an export ban list, its threshold must be higher than the most points one ban can give, whichever ban list it is on, and at least 12. With the default points of 3 for an active ban and 1 for an expired ban, that is a threshold of 12 or more. An export ban list can have at most 30,000 players'
);
// Each type is described on its own when their rules differ.
assert.strictEqual(
  answerWith({
    EXPORT_BM_MIN_THRESHOLD: '6',
    EXPORT_REMOTE_NEVER_ENOUGH: 'none',
    EXPORT_REMOTE_MIN_THRESHOLD: '1',
    EXPORT_BM_MAX_PLAYERS: '0'
  }),
  'So that one active ban and one expired ban are never enough to put a player on a BattleMetrics export ban list, its threshold must be higher than the most points they can give together, whichever ban lists they are on, and at least 6. ' +
    'With the default points of 3 for an active ban and 1 for an expired ban, that is a threshold of 6 or more. ' +
    'A remote export ban list can have at most 40,000 players. ' +
    'Points can be whole numbers from 0 to 100, thresholds from 1 to 1,000, and max ban ages from 0 to 3,650 days, where 0 counts bans of any age. ' +
    OLDER_LISTS
);
assert.match(
  answerWith({ EXPORT_REMOTE_NEVER_ENOUGH: 'none', EXPORT_REMOTE_MAX_PLAYERS: '0' }),
  /^So that one active ban and one expired ban are never enough to put a player on a BattleMetrics export ban list, .*, and at least 4\. With the default points .* that is a threshold of 5 or more\. A remote export ban list's threshold must be at least 4\. A BattleMetrics export ban list can have at most 20,000 players, as each player on a BattleMetrics export ban list is added to BattleMetrics separately\. Points can/
);
assert.match(
  answerWith({ EXPORT_BM_MAX_PLAYERS: '50000' }),
  / A remote export ban list can have at most 40,000 players, and a BattleMetrics export ban list at most 50,000\. Points can/
);
// With no rules and no caps, it says what is left.
const unlimited = {
  EXPORT_BM_NEVER_ENOUGH: 'none',
  EXPORT_REMOTE_NEVER_ENOUGH: 'none',
  EXPORT_BM_MIN_THRESHOLD: '1',
  EXPORT_REMOTE_MIN_THRESHOLD: '1',
  EXPORT_BM_MAX_PLAYERS: '0',
  EXPORT_REMOTE_MAX_PLAYERS: '0'
};
assert.strictEqual(
  answerWith(unlimited),
  'Points can be whole numbers from 0 to 100, thresholds from 1 to 1,000, and max ban ages from 0 to 3,650 days, where 0 counts bans of any age. ' +
    OLDER_LISTS
);
// The lowest threshold it gives is the one the forms allow for the default points.
for (const env of [
  {},
  { EXPORT_BM_NEVER_ENOUGH: 'one-ban', EXPORT_REMOTE_NEVER_ENOUGH: 'one-ban' },
  { EXPORT_BM_MIN_THRESHOLD: '7', EXPORT_REMOTE_MIN_THRESHOLD: '7' }
]) {
  const lowest = Number(answerWith(env).match(/that is a threshold of (\d+) or more/)[1]);
  const at = (threshold) =>
    forms.listProblems(
      { ...exportListLimits.DEFAULT_SETTINGS, threshold, type: 'remote' },
      undefined,
      limitsWith(env)
    );
  assert.deepStrictEqual([at(lowest).length, at(lowest - 1).length], [0, 1], JSON.stringify(env));
}
// It never fails, whatever /config.js gave.
for (const odd of [undefined, null, {}, { remote: null }, { battlemetrics: 'x' }, { remote: {} }])
  assert.match(exportListLimitsAnswer(odd), /Points can be whole numbers/);

console.log(
  'Export list form checks passed: the list and config forms show the web server problems as values are typed, older lists, the edit form note, and the FAQ answer.'
);
