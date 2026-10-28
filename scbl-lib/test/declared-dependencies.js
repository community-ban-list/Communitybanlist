import assert from 'assert';
import { readdir, readFile } from 'fs/promises';
import { isBuiltin } from 'module';
import vm from 'vm';

// Each service installs scbl-lib from its manifest, so scbl-lib/package.json must declare every
// package scbl-lib's code imports. A package that only another manifest declares is installed by
// chance, and is missing once that manifest stops declaring it. A declared package that nothing
// imports is installed in every image for nothing.

const root = new URL('../', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
const declared = Object.keys(manifest.dependencies);

// The code's files: every .js file but the tests and the installed packages.
async function codeFiles(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'test') continue;
    const url = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir);
    if (entry.isDirectory()) files.push(...(await codeFiles(url)));
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

// Each package the code imports, with the first file that imports it. The files are parsed, not
// run, so this lists exactly the packages their import and export statements name.
const imported = new Map();
const files = await codeFiles(root);
assert.ok(files.length > 20, `Found only ${files.length} of scbl-lib's files`);
for (const file of files) {
  const name = file.pathname.slice(root.pathname.length);
  const module = new vm.SourceTextModule(await readFile(file, 'utf8'), { identifier: name });
  for (const { specifier } of module.moduleRequests) {
    if (specifier.startsWith('.') || isBuiltin(specifier)) continue;
    if (!imported.has(packageOf(specifier))) imported.set(packageOf(specifier), name);
  }
}

for (const [name, file] of imported)
  assert.ok(
    declared.includes(name),
    `scbl-lib/${file} imports ${name}, which scbl-lib/package.json does not declare`
  );

for (const name of declared)
  assert.ok(imported.has(name), `scbl-lib/package.json declares ${name}, which nothing imports`);

console.log(`scbl-lib declares the ${declared.length} packages its code imports.`);
