// Checks that yarn.lock lists every package the package.json files ask for, so that an install
// takes each package from it. Run it from the repository root, before yarn install:
//
//   node scripts/check-lockfile.mjs [--all-workspaces]
//
// yarn install --frozen-lockfile installs the versions yarn.lock lists, but it compares yarn.lock
// with the root package.json only. When a workspace's package.json asks for a package or a version
// range that yarn.lock does not list, Yarn 1 installs the newest matching version from the registry
// and still succeeds. It installs the version the root package.json's resolutions ask for in the
// same way, and without a yarn.lock it resolves every package afresh. In those cases this script
// fails instead. It also fails when a yarn.lock entry is fetched from anywhere but the npm registry
// over HTTPS, is not the package and version the entry names, has no sha512 checksum, or needs a
// package yarn.lock does not list.
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

// The words of a line of yarn.lock: strings in double quotes, which Yarn writes as JSON, and bare
// words, which never hold spaces, commas or quotes.
const wordsOf = (line) =>
  (line.match(/"(?:[^"\\]|\\.)*"|[^\s,"]+/g) ?? []).map((word) =>
    word.startsWith('"') ? JSON.parse(word) : word
  );

// yarn.lock's entries, by each name@range Yarn wrote one under. Ranges that resolved to the same
// version share an entry, which is written once under all of them.
function readLockfile(text) {
  const entries = new Map();
  let entry = null;
  let block = null;
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (line.trim() === '' || line.startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    const words = wordsOf(line);
    if (indent === 0 && line.endsWith(':')) {
      entry = { dependencies: {}, optionalDependencies: {} };
      block = null;
      for (const pattern of wordsOf(line.slice(0, -1))) entries.set(pattern, entry);
    } else if (indent === 2 && entry && words.length === 1 && words[0].endsWith(':')) {
      block = words[0].slice(0, -1);
      entry[block] ??= {};
    } else if (indent === 2 && entry && words.length === 2) {
      block = null;
      entry[words[0]] = words[1];
    } else if (indent === 4 && block && words.length === 2) {
      entry[block][words[0]] = words[1];
    } else {
      stop(`Line ${index + 1} of yarn.lock is not in Yarn's format: ${line}\n${fix}`);
    }
  }
  return entries;
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
// Yarn installs a workspace that another one asks for from its folder, not from yarn.lock.
const workspaceNames = new Set(manifests.slice(1).map(([, manifest]) => manifest.name));

if (!existsSync('yarn.lock')) stop(`Found no yarn.lock. ${fix}`);
const entries = readLockfile(readFileSync('yarn.lock', 'utf8'));
const problems = [];

// Each name@range the package.json files ask for, and then each one those need, and so on.
const needed = [];
for (const [file, manifest] of manifests)
  for (const block of manifestBlocks)
    for (const [name, range] of Object.entries(manifest[block] ?? {})) {
      if (workspaceNames.has(name)) continue;
      if (entries.has(`${name}@${range}`)) needed.push(`${name}@${range}`);
      else problems.push(`${file} asks for ${name} ${range}, which yarn.lock does not list.`);
    }

// Yarn installs the version a resolution in the root package.json asks for wherever the package is
// needed, without comparing it with yarn.lock. yarn.lock lists that version under the resolution's
// own name@range, so every entry for the package must be that version. A resolution for a package
// under one parent only cannot be checked against yarn.lock, so it fails.
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
    for (const [name, range] of Object.entries(entries.get(pattern)[block])) {
      if (entries.has(`${name}@${range}`)) needed.push(`${name}@${range}`);
      else problems.push(`${pattern} needs ${name} ${range}, which yarn.lock does not list.`);
    }
}

// With every workspace here, yarn.lock lists only what they need, as yarn install leaves it.
if (absent.length === 0)
  for (const pattern of entries.keys())
    if (!reached.has(pattern))
      problems.push(`yarn.lock lists ${pattern}, which nothing here needs any more.`);

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
