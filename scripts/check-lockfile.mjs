// Checks that yarn.lock lists every package the package.json files ask for, so that an install
// takes each package from it. Run it from the repository root, before yarn install:
//
//   node scripts/check-lockfile.mjs
//
// yarn install --frozen-lockfile installs the versions yarn.lock lists, but it compares yarn.lock
// with the root package.json only. When a workspace's package.json asks for a package or a version
// range that yarn.lock does not list, Yarn 1 installs the newest matching version from the registry
// and still succeeds, and without a yarn.lock it resolves every package afresh. In those cases this
// script fails instead. It also fails when yarn.lock fetches a package from anywhere but the npm
// registry over HTTPS or without a sha512 checksum, or lists a package that needs one it does not
// list. When every workspace is here, as in the pull request checks, it fails too when yarn.lock
// lists a package that nothing needs any more. An image copies only some of the workspaces, so
// there the other workspaces' packages are left alone. It uses no packages, so it can run before
// any are installed.
//
// After changing a package.json, run yarn install at the repository root and commit yarn.lock.
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

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
const workspaces = root.workspaces ?? [];
const here = workspaces.filter((workspace) => existsSync(join(workspace, 'package.json')));
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
if (here.length === workspaces.length)
  for (const pattern of entries.keys())
    if (!reached.has(pattern))
      problems.push(`yarn.lock lists ${pattern}, which nothing here needs any more.`);

// Each package comes from the npm registry over HTTPS, and Yarn checks it against its checksum.
const checked = new Set();
for (const [pattern, entry] of entries) {
  if (checked.has(entry)) continue;
  checked.add(entry);
  if (!registries.includes(httpsHost(entry.resolved)))
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
    `package versions they need${here.length === workspaces.length ? ', and nothing else' : ''}, ` +
    'each from the npm registry with a sha512 checksum.'
);
