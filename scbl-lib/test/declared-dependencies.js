import assert from 'assert';
import { existsSync } from 'fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';

import {
  misnamedDependencyBlocks,
  packagesLoadedBy,
  sourceFiles,
  specifiersIn
} from './helpers/declared-dependencies.js';

// Each service installs scbl-lib from its manifest, so scbl-lib/package.json must declare every
// package scbl-lib's code imports. A package that only another manifest declares is installed by
// chance, and is missing once that manifest stops declaring it. A declared package that nothing
// imports is installed in every image for nothing.

const root = new URL('../', import.meta.url);
const readManifest = async (url) => JSON.parse(await readFile(url, 'utf8'));
const manifest = await readManifest(new URL('package.json', root));
const declared = Object.keys(manifest.dependencies);

// The checks find what they are meant to. A misspelt list of packages is caught, and any other
// field is not.
assert.deepStrictEqual(
  misnamedDependencyBlocks({
    name: 'web-server',
    private: true,
    scripts: {},
    engines: {},
    dependencies: {},
    devDependencies: {},
    deprecated: 'Use another package',
    dependenciesMeta: {},
    peerDependencies: {},
    optionalDependencies: {},
    'dev-dependencies': {},
    devdependencies: {},
    devDependency: {}
  }),
  ['dev-dependencies', 'devdependencies', 'devDependency']
);
// Packages loaded with import(), require(), a require that createRequire made from the file's URL
// or a variable holding one count, as do export statements. A require made from another file
// loads that file's packages, so its names do not count, and neither do names in comments.
assert.deepStrictEqual(
  specifiersIn(
    [
      "export * from 'one';",
      "const two = () => import('two');",
      'const twoAgain = () => import(`two-again`);',
      "const three = require('three');",
      "const four = createRequire(import.meta.url)('four');",
      'const load = createRequire( import.meta.url );',
      "const five = load('five');",
      "const notLoad = createRequire(import.meta.url)('six');",
      "notLoad('not-a-package'); load.resolve('not-loaded');",
      "createRequire(new URL('../../scbl-lib/x.js', import.meta.url))('elsewhere');",
      "const fromLib = createRequire(new URL('../../scbl-lib/x.js', import.meta.url));",
      "fromLib('elsewhere');",
      "// import('in-a-comment'); require('in-a-comment');",
      "/* require('in-a-comment') */ const url = 'https://example.com/'; // load('in-a-comment')"
    ].join('\n')
  ),
  ['one', 'two', 'two-again', 'three', 'five', 'four', 'six']
);
// The same holds when the require made from another file is itself named require.
assert.deepStrictEqual(
  specifiersIn(
    [
      "const require = createRequire(new URL('../../scbl-lib/x.js', import.meta.url));",
      "const Sequelize = require('sequelize');"
    ].join('\n')
  ),
  []
);
assert.deepStrictEqual(specifiersIn("module.exports = require('eight');", true), ['eight']);
// .mjs and .cjs files and files in subfolders are read, and installed packages are not.
const folder = await mkdtemp(join(tmpdir(), 'declared-dependencies-'));
try {
  await mkdir(join(folder, 'sub', 'deeper'), { recursive: true });
  await mkdir(join(folder, 'node_modules', 'six'), { recursive: true });
  await writeFile(join(folder, 'a.js'), "import a from 'a';");
  await writeFile(join(folder, 'b.mjs'), "await import('@scope/b/path.js');");
  await writeFile(join(folder, 'sub', 'deeper', 'c.cjs'), "require('c'); require('./local');");
  await writeFile(join(folder, 'sub', 'notes.md'), "import d from 'd';");
  await writeFile(join(folder, 'node_modules', 'six', 'index.js'), "import e from 'e';");
  const url = pathToFileURL(folder + '/');
  assert.deepStrictEqual(Object.fromEntries(await packagesLoadedBy(await sourceFiles(url), url)), {
    a: 'a.js',
    '@scope/b': 'b.mjs',
    c: 'sub/deeper/c.cjs'
  });
} finally {
  await rm(folder, { recursive: true, force: true });
}

for (const key of misnamedDependencyBlocks(manifest))
  assert.fail(`scbl-lib/package.json lists packages under ${key}, which npm and Yarn ignore`);

// Each package scbl-lib's code imports, with the first file that imports it: every file but the
// tests and the installed packages.
const files = await sourceFiles(root, ['test']);
assert.ok(files.length > 20, `Found only ${files.length} of scbl-lib's files`);
const imported = await packagesLoadedBy(files, root);

for (const [name, file] of imported)
  assert.ok(
    declared.includes(name),
    `scbl-lib/${file} imports ${name}, which scbl-lib/package.json does not declare`
  );

for (const name of declared)
  assert.ok(imported.has(name), `scbl-lib/package.json declares ${name}, which nothing imports`);

// Yarn installs scbl-lib from this folder only while each workspace asks for a version it has, so
// each workspace asks for its exact version. Each image has only some of the workspaces, so this
// checks the ones that are here.
const { workspaces } = await readManifest(new URL('../package.json', root));
for (const workspace of workspaces) {
  const file = new URL(`../${workspace}/package.json`, root);
  if (!existsSync(file)) continue;
  const range = (await readManifest(file)).dependencies?.['scbl-lib'];
  if (range === undefined) continue;
  assert.strictEqual(
    range,
    manifest.version,
    `${workspace}/package.json asks for scbl-lib ${range}, but scbl-lib is version ${manifest.version}`
  );
}

console.log(`scbl-lib declares the ${declared.length} packages its code imports.`);
