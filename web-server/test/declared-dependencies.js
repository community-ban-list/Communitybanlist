import assert from 'assert';
import { existsSync, readFileSync } from 'fs';
import { readFile } from 'fs/promises';

import {
  misnamedDependencyBlocks,
  packagesLoadedBy,
  sourceFiles
} from '../../scbl-lib/test/helpers/declared-dependencies.js';

// web-server/package.json must declare every package the web server's code imports, in
// dependencies, and every other package its tests import, in devDependencies. A package that only
// another manifest declares is installed by chance, and is missing once that manifest stops
// declaring it. A declared package that nothing uses is installed for nothing.

const root = new URL('../', import.meta.url);
const readManifest = async (url) => JSON.parse(await readFile(url, 'utf8'));
const manifest = await readManifest(new URL('package.json', root));
const client = await readManifest(new URL('../client/package.json', root));
const scblLib = await readManifest(new URL('../scbl-lib/package.json', root));
const dependencies = Object.keys(manifest.dependencies);
const devDependencies = Object.keys(manifest.devDependencies ?? {});

// npm and Yarn ignore a list of packages under any other name, such as dev-dependencies, so the
// packages in it would never be installed.
for (const key of misnamedDependencyBlocks(manifest))
  assert.fail(`web-server/package.json lists packages under ${key}, which npm and Yarn ignore`);

// The code is every file but the tests; the tests are every file in test/.
const codeFiles = await sourceFiles(root, ['test']);
const testFiles = await sourceFiles(new URL('test/', root));
assert.ok(codeFiles.length > 20, `Found only ${codeFiles.length} of the web server's files`);
assert.ok(testFiles.length > 20, `Found only ${testFiles.length} of the web server's tests`);
const codeImports = await packagesLoadedBy(codeFiles, root);
const testImports = await packagesLoadedBy(testFiles, root);

// The image installs only dependencies, so the code's packages must be there.
for (const [name, file] of codeImports)
  assert.ok(
    dependencies.includes(name),
    `web-server/${file} imports ${name}, which web-server/package.json does not declare in dependencies`
  );

// Packages some tests load as another package installs them, to check the same copy the web
// server runs with. Declaring them here would not make it that copy. A test that loads a package
// with a require made from scbl-lib's files, as the list tests load the models' Sequelize, needs
// no entry, since scbl-lib's own test checks its manifest. A package may stay on this list while
// no test loads it, so the tests that load it can change on their own.
const installedBy = {
  // The web server's code loads these through scbl-lib, and the tests stand in for or check that
  // code: the BattleMetrics and Steam clients' axios and the logger's Bottleneck.
  axios: 'scbl-lib',
  bottleneck: 'scbl-lib',
  // The OpenID library that passport-steam loads, whose requests the sign-in tests replace.
  openid: 'passport-steam'
};
for (const [name, owner] of Object.entries(installedBy))
  if (owner === 'scbl-lib')
    assert.ok(scblLib.dependencies[name], `scbl-lib/package.json no longer declares ${name}`);

// The web server builds and serves the client, so its tests also check the client's code, which
// they load with the client's own packages. Those are devDependencies here: the image installs
// them because the client declares them.
for (const [name, file] of testImports)
  assert.ok(
    dependencies.includes(name) || devDependencies.includes(name) || name in installedBy,
    `web-server/${file} imports ${name}, which web-server/package.json does not declare`
  );
for (const name of devDependencies)
  assert.ok(
    testImports.has(name),
    `web-server/package.json declares ${name}, which no test imports`
  );

// The tests pass the client's packages into the client's code, so they must be the client's own
// copy. With the client's exact range, Yarn installs one copy for both; with another, it can
// install a second copy for the web server, and the tests would check the client with a version
// it does not use. A test-only package the client does not use can have any range.
const rangeMismatches = (web, ofClient) =>
  Object.entries(web.devDependencies ?? {})
    .filter(
      ([name, range]) =>
        name in (ofClient.dependencies ?? {}) && ofClient.dependencies[name] !== range
    )
    .map(([name]) => name);
assert.deepStrictEqual(
  rangeMismatches(
    { devDependencies: { rxjs: '^6.6.0', yup: '^1.7.1', other: '^1.0.0' } },
    { dependencies: { rxjs: '^7.8.2', yup: '^1.7.1' } }
  ),
  ['rxjs'],
  'A devDependency the client asks for with another range is found'
);
for (const name of rangeMismatches(manifest, client))
  assert.fail(
    `web-server/package.json asks for ${name} ${manifest.devDependencies[name]}, but the client ` +
      `asks for ${client.dependencies[name]}. Keep the two the same.`
  );

// A dependency the code does not import must be the peer of one it does, as helmet is for
// koa-helmet. Peers are read from the installed packages, wherever Yarn put them. A package that
// is not installed here has none to read; loading the code shows that it is missing.
function peersOf(name) {
  for (const dir of ['node_modules/', '../node_modules/']) {
    const file = new URL(`${dir}${name}/package.json`, root);
    if (existsSync(file))
      return Object.keys(JSON.parse(readFileSync(file, 'utf8')).peerDependencies ?? {});
  }
  return [];
}
const peers = new Set([...codeImports.keys()].flatMap(peersOf));
for (const name of dependencies)
  assert.ok(
    codeImports.has(name) || peers.has(name),
    `web-server/package.json declares ${name}, which the web server's code does not use`
  );

console.log(
  `Web server manifest checks passed: the ${dependencies.length} packages its code uses and the ${devDependencies.length} more its tests use are declared.`
);
