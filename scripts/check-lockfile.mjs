// Checks that yarn.lock lists every package the package.json files ask for, so that an install
// takes each package from it. Run it from the repository root, before yarn install:
//
//   node scripts/check-lockfile.mjs [--all-workspaces]
//
// yarn install --frozen-lockfile installs the versions yarn.lock lists, but it compares yarn.lock
// with the root package.json only. When a workspace's package.json asks for a package or a version
// range that yarn.lock does not list, Yarn 1 installs the newest matching version from the registry
// and still succeeds. It does the same when yarn.lock lists a version outside a range that a
// workspace or another package asks for, as it then ignores that entry. It installs the version the
// root package.json's resolutions ask for in the same way, and without a yarn.lock it resolves
// every package afresh. A workspace that another one asks for comes from its folder only when its
// version is inside the range asked for; otherwise Yarn takes that name from the registry. In those
// cases this script fails instead. It also fails when a yarn.lock entry is fetched from anywhere
// but the npm registry over HTTPS, is not the package and version the entry names, has no sha512
// checksum, has a field other than those Yarn writes for a package from the npm registry, or needs
// a package yarn.lock does not list. And it fails unless yarn.lock is exactly as Yarn writes it, so
// that it reads the same entries from it as Yarn.
//
// An image copies only some of the workspaces, so there the other workspaces' packages are left
// alone. When every workspace is here, as in the pull request checks, the script also fails when
// yarn.lock lists a package that nothing needs any more. --all-workspaces, which the pull request
// checks pass, makes a missing workspace fail it too. It uses no packages, so it can run before any
// are installed.
//
// After changing a package.json, run yarn install at the repository root and commit yarn.lock.
import { existsSync, readFileSync } from 'fs';
import { isAbsolute, join, normalize, sep } from 'path';
import { parseArgs } from 'util';

const fix = 'Run yarn install at the repository root and commit the yarn.lock it writes.';

// The npm registry, under the names Yarn and npm give it.
const registries = ['registry.yarnpkg.com', 'registry.npmjs.org'];
// The package.json blocks whose packages Yarn installs, and so lists in yarn.lock.
const manifestBlocks = ['dependencies', 'devDependencies', 'optionalDependencies'];
// The blocks of a yarn.lock entry that list the packages it needs.
const entryBlocks = ['dependencies', 'optionalDependencies'];
// The other fields Yarn writes in the entry of a package from the npm registry. It also reads
// fields such as name, uid and registry, and installs an entry differently for them, but it does
// not write them for a package from the npm registry.
const entryFields = ['version', 'resolved', 'integrity'];

function stop(message) {
  console.error(message);
  process.exit(1);
}

let options;
try {
  options = parseArgs({
    options: { 'all-workspaces': { type: 'boolean', default: false } }
  }).values;
} catch (error) {
  stop(`${error.message}\nUsage: node scripts/check-lockfile.mjs [--all-workspaces]`);
}

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

// How Yarn writes yarn.lock. A word is bare when it starts with a letter and holds nothing Yarn
// would read another way, and is JSON otherwise.
const written = (word) =>
  /^[a-zA-Z]/.test(word) && !/^(true|false)|[\s:,"\\[\]]/.test(word) ? word : JSON.stringify(word);
// Yarn sorts the keys at each level in character order, but puts these fields of an entry first,
// in this order. It does so at every level, so a package named uid comes first in a dependencies
// block too.
const firstFields = ['name', 'version', 'uid', 'resolved', 'integrity', 'registry', 'dependencies'];
function yarnOrder(a, b) {
  const [first, second] = [a, b].map((key) => firstFields.indexOf(key) + 1 || 100);
  if (first < 100 || second < 100) return first > second ? 1 : -1;
  return a < b ? -1 : 1;
}
// The text Yarn writes for what is read from yarn.lock. An entry shared by several name@range
// patterns is written once, under all of them, and each entry ends with a blank line.
function textOf(object, indent = '') {
  const keys = Object.keys(object).sort(yarnOrder);
  const done = new Set();
  const lines = [];
  for (const key of keys) {
    if (done.has(key)) continue;
    const value = object[key];
    const shared =
      typeof value === 'string' ? [key] : keys.filter((other) => object[other] === value);
    for (const other of shared) done.add(other);
    const names = shared.sort().map(written).join(', ');
    lines.push(
      typeof value === 'string'
        ? `${names} ${written(value)}`
        : `${names}:\n${textOf(value, `${indent}  `)}${indent ? '' : '\n'}`
    );
  }
  return indent + lines.join(`\n${indent}`);
}
// It starts yarn.lock with these comments and two blank lines.
const header =
  '# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.\n# yarn lockfile v1\n\n\n';

// The words of a line of yarn.lock: bare words, and words in double quotes, which hold no
// backslash in a line that is read.
const wordsOf = (line) =>
  (line.match(/"[^"]*"|[^\s,:"]+/g) ?? []).map((word) =>
    word.startsWith('"') ? word.slice(1, -1) : word
  );
// A line as JSON, with every character outside printable ASCII escaped, so that it can be seen.
const shown = (line) =>
  line === undefined
    ? 'nothing'
    : JSON.stringify(line).replace(
        /[^ -~]/g,
        (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`
      );

// yarn.lock's entries, by each name@range Yarn wrote one under. Ranges that resolved to the same
// version share an entry, which is written once under all of them.
function readLockfile(text) {
  // Yarn ends each line as it ends the first.
  const lines = text.split(/\r?\n/.exec(text)?.[0] ?? '\n');
  const lockfile = {};
  let entry = null;
  let block = null;
  for (const [index, line] of lines.entries()) {
    if (line === '' || line.startsWith('#')) continue;
    const unread = () =>
      stop(`Line ${index + 1} of yarn.lock is not in Yarn's format: ${shown(line)}\n${fix}`);
    const unknownField = () =>
      stop(
        `Line ${index + 1} of yarn.lock is ${shown(line)}, a field Yarn does not write for a ` +
          `package from the npm registry.\n${fix}`
      );
    const indent = line.length - line.trimStart().length;
    const opens = line.endsWith(':');
    const words = wordsOf(opens ? line.slice(0, -1) : line);
    // Yarn cannot read back an empty name, or a word with a backslash before a double quote, so
    // they are not in its format here. No name, version, address or checksum has a backslash.
    if (line.includes('\\') || (opens ? words : words.slice(0, 1)).includes('')) unread();
    if (indent === 0 && opens && words.length > 0) {
      // Yarn writes every key as name@range, so a key without a range is a hand edit. Yarn reads
      // it as asking for the latest version, and for a workspace's name it then fetches that entry
      // from the registry instead of using the workspace.
      const bare = words.find((pattern) => pattern.indexOf('@', 1) === -1);
      if (bare !== undefined)
        stop(
          `Line ${index + 1} of yarn.lock lists ${bare} with no range, which Yarn does not write.\n${fix}`
        );
      entry = {};
      block = null;
      for (const pattern of words) lockfile[pattern] = entry;
    } else if (indent === 2 && entry && opens && words.length === 1) {
      if (!entryBlocks.includes(words[0])) unknownField();
      block = {};
      entry[words[0]] = block;
    } else if (indent === 2 && entry && !opens && words.length === 2) {
      if (!entryFields.includes(words[0])) unknownField();
      block = null;
      entry[words[0]] = words[1];
    } else if (indent === 4 && block && !opens && words.length === 2) {
      block[words[0]] = words[1];
    } else {
      unread();
    }
  }
  // Yarn reads back what it writes, but can read other ways of writing a line as other names, and
  // can stop reading yarn.lock early. So yarn.lock must be exactly what Yarn writes for the
  // entries read here, which are then the entries Yarn reads.
  const expected = (header + textOf(lockfile)).split('\n');
  const at = expected.findIndex((line, index) => line !== lines[index]);
  if (at !== -1 || lines.length > expected.length) {
    const index = at === -1 ? expected.length : at;
    stop(
      `Line ${index + 1} of yarn.lock is ${shown(lines[index])}, but Yarn writes ` +
        `${shown(expected[index])} there.\n${fix}`
    );
  }
  return new Map(Object.entries(lockfile));
}

// The name and the range of a name@range pattern.
function nameAndRange(pattern) {
  const at = pattern.indexOf('@', 1);
  return at === -1 ? [pattern, ''] : [pattern.slice(0, at), pattern.slice(at + 1)];
}

// The package a pattern installs: the one it names, or for an alias such as sw@npm:ms@^2.1.3, the
// one after npm:.
function packageOf(pattern) {
  const [name, range] = nameAndRange(pattern);
  return range.startsWith('npm:') ? nameAndRange(range.slice(4))[0] : name;
}

// The host a package is fetched from, if it is fetched over HTTPS.
function httpsHost(address) {
  try {
    const url = new URL(address);
    return url.protocol === 'https:' ? url.hostname : null;
  } catch {
    return null;
  }
}

// Yarn compares a yarn.lock entry's version with a range using the copy of the semver package it
// bundles, which reads ranges strictly. The code from here to satisfies follows that copy, with its
// names, so it reads the ranges that copy reads, the same way, and no others.
const num = '0|[1-9]\\d*';
const id = `(?:${num}|\\d*[a-zA-Z-][a-zA-Z0-9-]*)`;
const looseId = '(?:[0-9]+|\\d*[a-zA-Z-][a-zA-Z0-9-]*)';
const pre = `(?:-(${id}(?:\\.${id})*))`;
const build = '(?:\\+([0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*))';
const full = `v?(${num})\\.(${num})\\.(${num})${pre}?${build}?`;
const loose =
  '[v=\\s]*([0-9]+)\\.([0-9]+)\\.([0-9]+)' + `(?:-?(${looseId}(?:\\.${looseId})*))?${build}?`;
const xId = `${num}|x|X|\\*`;
const xPlain = `[v=\\s]*(${xId})(?:\\.(${xId})(?:\\.(${xId})(?:${pre})?${build}?)?)?`;
const gtlt = '((?:<|>)?=?)';
const fullRe = new RegExp(`^${full}$`);
const hyphenRe = new RegExp(`^\\s*(${xPlain})\\s+-\\s+(${xPlain})\\s*$`);
const comparatorTrimRe = new RegExp(`(\\s*)${gtlt}\\s*(${loose}|${xPlain})`, 'g');
const caretRe = new RegExp(`^\\^${xPlain}$`);
const tildeRe = new RegExp(`^~>?${xPlain}$`);
const xRangeRe = new RegExp(`^${gtlt}\\s*${xPlain}$`);
const comparatorRe = new RegExp(`^${gtlt}\\s*(${full})$|^$`);

const isX = (part) => !part || part.toLowerCase() === 'x' || part === '*';
const preTag = (tag) => (!tag ? '' : tag.startsWith('-') ? tag : `-${tag}`);

// ^1.2.3 is >=1.2.3 <2.0.0, ^0.2.3 is >=0.2.3 <0.3.0 and ^0.0.3 is >=0.0.3 <0.0.4.
function replaceCaret(_, M, m, p, tag) {
  if (isX(M)) return '';
  if (isX(m)) return `>=${M}.0.0 <${+M + 1}.0.0`;
  if (isX(p)) return `>=${M}.${m}.0 <${M === '0' ? `${M}.${+m + 1}.0` : `${+M + 1}.0.0`}`;
  const low = `>=${M}.${m}.${p}${preTag(tag)}`;
  if (M !== '0') return `${low} <${+M + 1}.0.0`;
  return m !== '0' ? `${low} <${M}.${+m + 1}.0` : `${low} <${M}.${m}.${+p + 1}`;
}

// ~1.2.3 is >=1.2.3 <1.3.0, and ~1 is >=1.0.0 <2.0.0.
function replaceTilde(_, M, m, p, tag) {
  if (isX(M)) return '';
  if (isX(m)) return `>=${M}.0.0 <${+M + 1}.0.0`;
  if (isX(p)) return `>=${M}.${m}.0 <${M}.${+m + 1}.0`;
  return `>=${M}.${m}.${p}${preTag(tag)} <${M}.${+m + 1}.0`;
}

// 1.x is >=1.0.0 <2.0.0, >1.2 is >=1.3.0 and <=1.2 is <1.3.0.
function replaceXRange(text, op, M, m, p) {
  const xM = isX(M);
  const xm = xM || isX(m);
  const xp = xm || isX(p);
  if (op === '=' && xp) op = '';
  if (xM) return op === '>' || op === '<' ? '<0.0.0' : '*';
  if (op && xp) {
    if (xm) m = 0;
    p = 0;
    if (op === '>') {
      op = '>=';
      if (xm) [M, m] = [+M + 1, 0];
      else m = +m + 1;
    } else if (op === '<=') {
      op = '<';
      if (xm) M = +M + 1;
      else m = +m + 1;
    }
    return `${op}${M}.${m}.${p}`;
  }
  if (xm) return `>=${M}.0.0 <${+M + 1}.0.0`;
  if (xp) return `>=${M}.${m}.0 <${M}.${+m + 1}.0`;
  return text;
}

// 1.2.3 - 2.3 is >=1.2.3 <2.4.0.
function replaceHyphen(_, from, fM, fm, fp, fTag, fBuild, to, tM, tm, tp, tTag) {
  if (isX(fM)) from = '';
  else if (isX(fm)) from = `>=${fM}.0.0`;
  else if (isX(fp)) from = `>=${fM}.${fm}.0`;
  else from = `>=${from}`;
  if (isX(tM)) to = '';
  else if (isX(tm)) to = `<${+tM + 1}.0.0`;
  else if (isX(tp)) to = `<${tM}.${+tm + 1}.0`;
  else if (tTag) to = `<=${tM}.${tm}.${tp}-${tTag}`;
  else to = `<=${to}`;
  return `${from} ${to}`.trim();
}

// A version's three numbers and prerelease identifiers, or null for one semver does not take.
function readVersion(text) {
  const match = typeof text === 'string' && text.length <= 256 && fullRe.exec(text);
  const numbers = match ? match.slice(1, 4).map(Number) : [];
  if (!match || numbers.some((number) => number > Number.MAX_SAFE_INTEGER)) return null;
  return { numbers, prerelease: match[4]?.split('.') ?? [] };
}

// A comparator as an operator and a version, or null for one that takes any version.
function readComparator(text) {
  const match = comparatorRe.exec(text);
  const version = match?.[2] && readVersion(match[2]);
  if (!match || version === null) throw new Error(`Cannot read ${text}`);
  return version ? { op: match[1] === '=' ? '' : match[1], version } : null;
}

// The forms a word of a range can take, each replaced by plain comparators, in this order.
const forms = [
  [caretRe, replaceCaret],
  [tildeRe, replaceTilde],
  [xRangeRe, replaceXRange]
];

// The comparators of one of a range's || alternatives, all of which a version must pass.
function readComparators(text) {
  const words = text
    .trim()
    .replace(hyphenRe, replaceHyphen)
    .replace(comparatorTrimRe, '$1$2$3')
    .replace(/(\s*)~>?\s+/g, '$1~')
    .replace(/(\s*)\^\s+/g, '$1^')
    .split(/\s+/)
    .map((word) => {
      for (const [re, replace] of forms)
        word = word
          .trim()
          .split(/\s+/)
          .map((part) => part.replace(re, replace))
          .join(' ');
      return word.trim().replace(/(<|>)?=?\s*\*/, '');
    });
  return words.join(' ').split(/\s+/).map(readComparator);
}

function compareIdentifiers(a, b) {
  const [aNumeric, bNumeric] = [/^[0-9]+$/.test(a), /^[0-9]+$/.test(b)];
  if (aNumeric && bNumeric) [a, b] = [Number(a), Number(b)];
  if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

// Below zero when version a comes before b, zero when they are the same, and above zero otherwise.
function compare(a, b) {
  for (const index of [0, 1, 2]) {
    const order = compareIdentifiers(a.numbers[index], b.numbers[index]);
    if (order !== 0) return order;
  }
  const [x, y] = [a.prerelease, b.prerelease];
  if (x.length === 0 || y.length === 0) return x.length === y.length ? 0 : x.length === 0 ? 1 : -1;
  for (let index = 0; ; index++) {
    if (x[index] === undefined || y[index] === undefined)
      return x[index] === y[index] ? 0 : x[index] === undefined ? -1 : 1;
    if (x[index] !== y[index]) return compareIdentifiers(x[index], y[index]);
  }
}

const operators = {
  '': (order) => order === 0,
  '<': (order) => order < 0,
  '<=': (order) => order <= 0,
  '>': (order) => order > 0,
  '>=': (order) => order >= 0
};

// Whether version is inside range, or null when semver cannot read range. A prerelease version
// is only inside an alternative that names a prerelease of the same major, minor and patch.
function satisfies(version, range) {
  let alternatives;
  try {
    alternatives = range.split(/\s*\|\|\s*/).map(readComparators);
  } catch {
    return null;
  }
  return alternatives.some(
    (comparators) =>
      comparators.every((c) => c === null || operators[c.op](compare(version, c.version))) &&
      (version.prerelease.length === 0 ||
        comparators.some(
          (c) =>
            c !== null &&
            c.version.prerelease.length > 0 &&
            c.version.numbers.every((number, index) => number === version.numbers[index])
        ))
  );
}

if (!existsSync('package.json')) stop('Found no package.json. Run this from the repository root.');
const root = readJson('package.json');

// Yarn takes the workspaces as a list, or as the packages of an object, and each can be a folder
// or a wildcard. This script finds each workspace by its folder, so it fails on anything else
// rather than leave a workspace out.
const workspaces = Array.isArray(root.workspaces)
  ? root.workspaces
  : (root.workspaces?.packages ?? []);
const isFolder = (workspace) =>
  typeof workspace === 'string' &&
  !/[*?[\]{}()!]/.test(workspace) &&
  !isAbsolute(workspace) &&
  !['.', '..'].includes(normalize(workspace).split(sep)[0]);
const unfound = Array.isArray(workspaces)
  ? workspaces.filter((workspace) => !isFolder(workspace))
  : [workspaces];
if (unfound.length > 0) {
  const listed = unfound.map((item) => JSON.stringify(item)).join(', ');
  stop(
    `package.json lists the workspaces as ${listed}, which this check cannot follow. List each ` +
      'workspace by its folder in the repository, without wildcards, so this check can find its ' +
      'package.json.'
  );
}

const here = workspaces.filter((workspace) => existsSync(join(workspace, 'package.json')));
const absent = workspaces.filter((workspace) => !here.includes(workspace));
if (options['all-workspaces'] && absent.length > 0)
  stop(
    `Found no package.json in ${absent.join(', ')}, which package.json lists as workspaces. ` +
      'With --all-workspaces, every workspace must be here.'
  );
const manifests = [
  ['package.json', root],
  ...here.map((workspace) => {
    const file = join(workspace, 'package.json');
    return [file, readJson(file)];
  })
];
// The version of each workspace here, by its name. Yarn installs a workspace that another one asks
// for from its folder, not from yarn.lock, but only when its version is inside the range asked for.
// Otherwise it takes that name from the registry, which --frozen-lockfile does not stop.
const workspaceVersions = new Map(
  manifests.slice(1).map(([, manifest]) => [manifest.name, manifest.version])
);

if (!existsSync('yarn.lock')) stop(`Found no yarn.lock. ${fix}`);
const entries = readLockfile(readFileSync('yarn.lock', 'utf8'));
const problems = [];

// Each name@range the package.json files ask for, and then each one those need, and so on.
const needed = [];
for (const [file, manifest] of manifests)
  for (const block of manifestBlocks)
    for (const [name, range] of Object.entries(manifest[block] ?? {})) {
      if (workspaceVersions.has(name)) {
        const version = readVersion(workspaceVersions.get(name));
        if (version === null || satisfies(version, range) !== true)
          problems.push(
            `${file} asks for ${name} ${range}, but the ${name} workspace is ` +
              `${workspaceVersions.get(name) ?? 'not versioned'}, so Yarn would take ${name} ` +
              'from the registry.'
          );
        continue;
      }
      if (entries.has(`${name}@${range}`)) needed.push(`${name}@${range}`);
      else problems.push(`${file} asks for ${name} ${range}, which yarn.lock does not list.`);
    }

// Yarn installs the version a resolution in the root package.json asks for wherever the package is
// needed, without comparing it with yarn.lock. yarn.lock lists that version under the resolution's
// own name@range, so every entry for the package must be that version. A resolution for a package
// under one parent only cannot be checked against yarn.lock, so it fails.
const resolvedNames = new Set();
const resolutionPatterns = new Set();
for (const [key, range] of Object.entries(root.resolutions ?? {})) {
  const name = key.replace(/^\*\*\//, '');
  const pattern = `${name}@${range}`;
  if (!/^(@[^/@]+\/)?[^/@]+$/.test(name)) {
    problems.push(
      `package.json's resolutions name ${key}. Name only the package, as in "ms" or "**/ms", ` +
        'so this check can compare the resolution with yarn.lock.'
    );
  } else if (!entries.has(pattern)) {
    problems.push(
      `package.json's resolutions ask for ${name} ${range}, which yarn.lock does not list.`
    );
  } else {
    needed.push(pattern);
    resolvedNames.add(name);
    resolutionPatterns.add(pattern);
    const { version } = entries.get(pattern);
    for (const [other, entry] of entries)
      if (nameAndRange(other)[0] === name && entry.version !== version)
        problems.push(
          `yarn.lock lists ${other} at ${entry.version}, but package.json's resolutions make Yarn ` +
            `install ${name} ${version}.`
        );
  }
}

const reached = new Set();
while (needed.length > 0) {
  const pattern = needed.pop();
  if (reached.has(pattern)) continue;
  reached.add(pattern);
  for (const block of entryBlocks)
    for (const [name, range] of Object.entries(entries.get(pattern)[block] ?? {})) {
      if (entries.has(`${name}@${range}`)) needed.push(`${name}@${range}`);
      else problems.push(`${pattern} needs ${name} ${range}, which yarn.lock does not list.`);
    }
}

// With every workspace here, yarn.lock lists only what they need, as yarn install leaves it.
if (absent.length === 0)
  for (const pattern of entries.keys())
    if (!reached.has(pattern))
      problems.push(`yarn.lock lists ${pattern}, which nothing here needs any more.`);

// Yarn compares each entry's version with every name@range it is listed under. For a range the
// version is outside, it ignores the entry and installs the newest version in the range from the
// registry, which --frozen-lockfile stops only for the root package.json's own ranges. For a
// package with a resolution, only the resolution's own range is compared: for the ranges that
// workspaces and other packages ask for, Yarn installs the resolution's version, compared above,
// without comparing it with them. Yarn cannot read a tag such as latest, an npm: alias or an
// address as a range, and takes the entry as it is for one. A range that starts the way a version
// range does, but that this check cannot read, fails, so that a range Yarn reads is never left
// unchecked.
for (const [pattern, entry] of entries) {
  const [name, range] = nameAndRange(pattern);
  const version = readVersion(entry.version);
  if (range === '' || version === null) continue;
  if (resolvedNames.has(name) && !resolutionPatterns.has(pattern)) continue;
  const inside = satisfies(version, range);
  if (inside === false)
    problems.push(
      `yarn.lock lists ${pattern} at ${entry.version}, which is outside that range, so Yarn ` +
        'would ignore the entry and resolve the range afresh.'
    );
  else if (inside === null && /^\s*[\d^~<>=*vxX|]/.test(range))
    problems.push(
      `yarn.lock lists ${pattern}, but this check cannot read that range, so it cannot tell ` +
        `whether Yarn installs ${entry.version} for it.`
    );
}

// Each package comes from the npm registry over HTTPS, as the tarball of the package and version
// its entry names, and Yarn checks it against its checksum.
const checked = new Set();
for (const [pattern, entry] of entries) {
  const host = httpsHost(entry.resolved);
  const target = packageOf(pattern);
  const tarball = `/${target}/-/${target.split('/').pop()}-${entry.version}.tgz`;
  if (registries.includes(host) && entry.resolved.split('#')[0] !== `https://${host}${tarball}`)
    problems.push(
      `yarn.lock fetches ${pattern} from ${entry.resolved}, which is not ${target} ${entry.version}.`
    );
  if (checked.has(entry)) continue;
  checked.add(entry);
  if (!registries.includes(host))
    problems.push(
      `yarn.lock fetches ${pattern} from ${entry.resolved ?? 'nowhere'}, ` +
        'not from the npm registry over HTTPS.'
    );
  if (
    !(entry.integrity ?? '').split(/\s+/).some((hash) => /^sha512-[A-Za-z0-9+/]{86}==$/.test(hash))
  )
    problems.push(`yarn.lock has no sha512 checksum for ${pattern}.`);
}

if (problems.length > 0) stop(`${problems.join('\n')}\n\nyarn.lock does not match. ${fix}`);

const versions = new Set([...reached].map((pattern) => entries.get(pattern))).size;
console.log(
  `yarn.lock matches the ${manifests.length} package.json files here: it lists the ${versions} ` +
    `package versions they need${absent.length === 0 ? ', and nothing else' : ''}, ` +
    'each from the npm registry with a sha512 checksum.' +
    (absent.length > 0
      ? ` The packages of ${absent.join(', ')}, which are not here, are not checked.`
      : '')
);
