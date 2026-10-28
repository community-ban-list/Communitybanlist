import assert from 'assert';
import { existsSync, readFileSync } from 'fs';
import { readdir, readFile } from 'fs/promises';
import { isBuiltin } from 'module';
import vm from 'vm';

// web-server/package.json must declare every package the web server's code imports, in
// dependencies, and every other package its tests import, in devDependencies. A package that only
// another manifest declares is installed by chance, and is missing once that manifest stops
// declaring it. A declared package that nothing uses is installed for nothing.

const root = new URL('../', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
const dependencies = Object.keys(manifest.dependencies);
const devDependencies = Object.keys(manifest.devDependencies ?? {});

// npm and Yarn ignore a block with any other name, such as dev-dependencies, so a package listed
// there would never be installed.
for (const key of Object.keys(manifest))
  assert.ok(
    ['name', 'version', 'type', 'dependencies', 'devDependencies'].includes(key),
    `web-server/package.json has a block named ${key}, which npm and Yarn may not read`
  );

async function jsFiles(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const url = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir);
    if (entry.isDirectory()) files.push(...(await jsFiles(url)));
    else if (entry.name.endsWith('.js')) files.push(url);
  }
  return files;
}

// The package an import names: '@scope/name' or 'name', without the path inside it.
const packageOf = (specifier) =>
  specifier
    .split('/')
    .slice(0, specifier.startsWith('@') ? 2 : 1)
    .join('/');

// Each package the files import, with the first file that imports it. The files are parsed, not
// run, so this lists exactly the packages their import and export statements name.
async function importsOf(files) {
  const imported = new Map();
  for (const file of files) {
    const name = file.pathname.slice(root.pathname.length);
    const module = new vm.SourceTextModule(await readFile(file, 'utf8'), { identifier: name });
    for (const { specifier } of module.moduleRequests) {
      if (specifier.startsWith('.') || isBuiltin(specifier)) continue;
      if (!imported.has(packageOf(specifier))) imported.set(packageOf(specifier), name);
    }
  }
  return imported;
}

const codeFiles = [
  new URL('index.js', root),
  new URL('healthcheck.js', root),
  ...(await jsFiles(new URL('src/', root)))
];
const testFiles = await jsFiles(new URL('test/', root));
assert.ok(codeFiles.length > 20, `Found only ${codeFiles.length} of the web server's files`);
assert.ok(testFiles.length > 20, `Found only ${testFiles.length} of the web server's tests`);
const codeImports = await importsOf(codeFiles);
const testImports = await importsOf(testFiles);

// The image installs only dependencies, so the code's packages must be there.
for (const [name, file] of codeImports)
  assert.ok(
    dependencies.includes(name),
    `web-server/${file} imports ${name}, which web-server/package.json does not declare in dependencies`
  );

// The web server builds and serves the client, so its tests also check the client's code, which
// they load with the client's own packages. Those are devDependencies here: the image installs
// them because the client declares them.
for (const [name, file] of testImports)
  assert.ok(
    dependencies.includes(name) || devDependencies.includes(name),
    `web-server/${file} imports ${name}, which web-server/package.json does not declare`
  );
for (const name of devDependencies)
  assert.ok(
    testImports.has(name),
    `web-server/package.json declares ${name}, which no test imports`
  );

// A dependency the code does not import must be the peer of one it does, as helmet is for
// koa-helmet. Peers are read from the installed packages, wherever Yarn put them.
function peersOf(name) {
  for (const dir of ['node_modules/', '../node_modules/']) {
    const file = new URL(`${dir}${name}/package.json`, root);
    if (existsSync(file))
      return Object.keys(JSON.parse(readFileSync(file, 'utf8')).peerDependencies ?? {});
  }
  assert.fail(`${name}, which web-server/package.json declares, is not installed`);
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
