import * as yup from 'yup';
import { yupResolver } from '@hookform/resolvers/yup';

import {
  DEFAULT_CONFIG_POINTS,
  DEFAULT_LIMITS,
  DEFAULT_SETTINGS,
  checkBounds,
  checkChange,
  checkRules,
  defaultThreshold,
  readGivenLimits
} from 'scbl-lib/export-list-limits';
import Validators from 'scbl-lib/validators';

// The export ban list forms' checks against the limits on export ban lists
// (scbl-lib/export-list-limits.js). The forms show the problems the web server would give for
// saving a change under the fields they are about, as the owner types, and the web server checks
// every change again. This file has no JSX, so the web server's tests can load it too.

// The settings that decide who is on an export ban list, with its configs.
const SETTINGS = Object.keys(DEFAULT_SETTINGS);

const settingsOf = (values) => Object.fromEntries(SETTINGS.map((name) => [name, values[name]]));

// Whether there are limits for a type of list that the forms can check against: every limit for
// the type, each as the web server would read it. scbl-lib/config.js reads the client's limits so,
// and when there are none for a type, or some are missing or cannot be used, the forms leave the
// checks to the web server.
function hasLimits(limits, type) {
  if (!Object.hasOwn(DEFAULT_LIMITS, type) || limits == null || !Object.hasOwn(limits, type))
    return false;
  const given = limits[type];
  const read = readGivenLimits({ [type]: given }).limits[type];
  return Object.entries(read).every(([limit, value]) => given?.[limit] === value);
}

// An export ban list from the site's queries as the limits take it: its settings, and its configs
// in the order the web server checks them, with their ban lists' and organisations' names for the
// messages.
export function storedList(exportBanList) {
  const configs = (exportBanList.exportBanListConfigs ?? []).map((config) => ({
    id: config.id,
    banList: config.banList?.id ?? null,
    activePoints: config.activePoints,
    expiredPoints: config.expiredPoints,
    banListName: config.banList?.name,
    organisationName: config.banList?.organisation?.name
  }));
  return { settings: settingsOf(exportBanList), configs: configs.sort((a, b) => a.id - b.id) };
}

// The problems the web server would give for saving the list form's values, as { field, message }.
// It checks every setting of a new list, against the limits for the type chosen. For a saved list,
// it checks the settings that differ from the stored ones, with the list's configs, so a list
// saved before the limits can still be renamed, or given another webhook, and made smaller.
export function listProblems(values, exportBanList, limits) {
  const type = exportBanList ? exportBanList.type : values.type;
  if (!hasLimits(limits, type)) return [];
  const settings = settingsOf(values);
  if (!exportBanList) return checkChange(type, null, { settings, configs: [] }, limits).problems;

  const stored = storedList(exportBanList);
  if (SETTINGS.every((name) => settings[name] === stored.settings[name])) return [];
  return checkChange(type, stored, { ...stored, settings }, limits).problems;
}

// The problems the web server would give for adding a config with the config form's values to a
// list. It checks the bounds on the config's points, and then, for a ban list the list has no
// config for, the points rules on the whole list with the config added. It refuses a second config
// for a ban list before it checks the points, so that is left to it, and so is a ban list not
// chosen yet. The points rules' problems are about both points, so they are given for the field
// 'points'.
export function configProblems(values, exportBanList, banLists, limits) {
  const points = { activePoints: values.activePoints, expiredPoints: values.expiredPoints };
  const bounds = checkBounds(points);
  if (bounds.length > 0 || !exportBanList || !hasLimits(limits, exportBanList.type)) return bounds;

  const banList = (banLists ?? []).find(({ id }) => id === values.banList);
  const stored = storedList(exportBanList);
  if (!banList || stored.configs.some((config) => config.banList === banList.id)) return [];
  const added = {
    banList: banList.id,
    ...points,
    banListName: banList.name,
    organisationName: banList.organisation?.name
  };
  const { problems } = checkChange(
    exportBanList.type,
    stored,
    { ...stored, configs: [...stored.configs, added] },
    limits
  );
  return problems.map((problem) =>
    problem.field === 'threshold' ? { ...problem, field: 'points' } : problem
  );
}

// What the edit form says above its fields about a saved list outside today's limits.
export const OUTSIDE_LIMITS_NOTE =
  "This list's settings are outside today's limits. You can keep them, and changes that make the list smaller are always allowed. Other changes must bring the whole list within the limits, so once you change these settings you may not be able to set them back.";

// What puts a saved list outside today's points rules, as the problems the limits give, each with
// its message, or none for a list within them.
export function outsideLimits(exportBanList, limits) {
  if (!exportBanList || !hasLimits(limits, exportBanList.type)) return [];
  return checkRules(exportBanList.type, storedList(exportBanList), limits);
}

// A yup test for a form's schema that gives the problems found for its values, each under its
// field. They are found with the form's context, which holds what the values are checked against.
// Messages are passed as functions, so yup takes them as they are.
function limitsTest(findProblems) {
  return {
    name: 'export-list-limits',
    test(values) {
      const problems = findProblems(values, this.options.context ?? {});
      if (problems.length === 0) return true;
      return new yup.ValidationError(
        problems.map(({ field, message }) =>
          this.createError({ path: field, message: () => message })
        )
      );
    }
  };
}

// The rule for each number the forms take, which need only be numbers there: the list form's
// settings and the config form's points. Their bounds, and the points rules, come from the limits,
// as the web server checks them: on every value of a new list or config, and on the values a
// change sets on a saved list, so a list saved with values outside them can still be renamed. A
// number left empty is null, which the limits refuse unless the list was saved without it, and
// text that is not a number gets the web server's message for the value.
const numberRule = (name) =>
  yup
    .number()
    .nullable()
    .transform((value, original) =>
      typeof original === 'string' && original.trim() === '' ? null : value
    )
    .typeError(checkBounds({ [name]: NaN })[0].message);

// The list form's schema: the format rules every list meets for its name, server, type and webhook
// (scbl-lib/validators.js), its settings as numbers, and then the limits.
const listSchema = yup
  .object()
  .shape({
    ...Validators.ExportBanList,
    ...Object.fromEntries(SETTINGS.map((name) => [name, numberRule(name)]))
  })
  .test(
    limitsTest((values, { exportBanList, limits }) => listProblems(values, exportBanList, limits))
  );

// The list form's starting values: a saved list's, or for a new list the model's defaults, with the
// lowest threshold that is allowed whichever type it is. Only the form's own fields are taken, so
// the submitted data does not carry the rest of the list, and a missing value starts as an empty
// string, as an empty input would give.
function listValues(exportBanList, limits) {
  if (!exportBanList)
    return { type: 'remote', ...DEFAULT_SETTINGS, threshold: defaultThreshold(limits) };
  return Object.fromEntries(
    Object.keys(Validators.ExportBanList).map((field) => [field, exportBanList[field] ?? ''])
  );
}

// The list form's options for useForm. exportBanList is the saved list, with its configs, or none
// for a new list. Values are checked as they change, so problems show as the owner types.
export function listFormOptions(exportBanList, limits) {
  return {
    mode: 'onChange',
    resolver: yupResolver(listSchema),
    context: { exportBanList, limits },
    defaultValues: listValues(exportBanList, limits)
  };
}

// The options the list form's fields are registered with, by name. The points rules' problems show
// under the threshold, so a change to a value they depend on checks the threshold again.
export const LIST_FIELDS = {
  type: { deps: ['threshold'] },
  defaultActivePoints: { deps: ['threshold'] },
  defaultExpiredPoints: { deps: ['threshold'] },
  maxBanAge: { deps: ['threshold'] }
};

// The config form's schema: the format rules every config meets for its ban list
// (scbl-lib/validators.js), its points as numbers, and then the limits. The points are always
// checked against their bounds, so the form never sends points left empty.
const configSchema = yup
  .object()
  .shape({
    ...Validators.ExportBanListConfig,
    activePoints: numberRule('activePoints'),
    expiredPoints: numberRule('expiredPoints')
  })
  .test(
    limitsTest((values, { exportBanList, banLists, limits }) =>
      configProblems(values, exportBanList, banLists, limits)
    )
  );

// The config form's options for useForm. exportBanList is the list the config is for, with its
// settings and configs, and banLists the ban lists that can be chosen, with their names. Either is
// missing until it has loaded, and only the bounds on the points are checked until then.
export function configFormOptions(exportBanList, banLists, limits) {
  return {
    mode: 'onChange',
    resolver: yupResolver(configSchema),
    context: { exportBanList, banLists, limits },
    defaultValues: { banList: null, ...DEFAULT_CONFIG_POINTS }
  };
}

// The options the config form's fields are registered with, by name. Each of them changes what
// the points rules say about the config's points.
export const CONFIG_FIELDS = {
  banList: { deps: ['points'] },
  activePoints: { deps: ['points'] },
  expiredPoints: { deps: ['points'] }
};
