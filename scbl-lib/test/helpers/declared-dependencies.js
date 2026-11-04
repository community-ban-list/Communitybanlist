import { readdir, readFile } from 'fs/promises';
import { isBuiltin } from 'module';
import vm from 'vm';

// Shared by the scbl-lib and web server manifest tests, which check that each manifest declares
// the packages its code imports. It is in a helpers folder, so it is not run as a test itself.

// npm and Yarn read packages only from blocks with these exact names. A misspelt one, such as
// dev-dependencies, is ignored, so the packages listed in it are never installed.
const dependencyBlocks = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
  'bundleDependencies',
  'bundledDependencies'
];

// The manifest's blocks whose name, without case or punctuation, ends like one of those, but is
// not spelt as npm and Yarn expect. Every other field, such as scripts, deprecated or
// dependenciesMeta, is left alone.
export const misnamedDependencyBlocks = (manifest) =>
  Object.keys(manifest).filter(
    (key) =>
      /dep[ae]nd[ae]nc(y|ies)$/.test(key.toLowerCase().replace(/[^a-z]/g, '')) &&
      !dependencyBlocks.includes(key)
  );

// Every .js, .mjs and .cjs file under dir, but in the folders named in skip and in node_modules.
export async function sourceFiles(dir, skip = []) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || skip.includes(entry.name)) continue;
    const url = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir);
    if (entry.isDirectory()) files.push(...(await sourceFiles(url, skip)));
    else if (/\.[cm]?js$/.test(entry.name)) files.push(url);
  }
  return files;
}

// The package an import names: '@scope/name' or 'name', without the path inside it.
export const packageOf = (specifier) =>
  specifier
    .split('/')
    .slice(0, specifier.startsWith('@') ? 2 : 1)
    .join('/');

// A name given as a plain string, in quotes or in backticks with nothing filled in.
const plainName = String.raw`\(\s*(?<quote>['"\x60])(?<name>[^'"\x60$]+)\k<quote>`;
// createRequire and what is in its brackets, which may hold one more level of brackets, as in
// createRequire(new URL('../x.js', import.meta.url)).
const createRequireCall = String.raw`\bcreateRequire\(((?:[^()]|\([^()]*\))*)\)`;
// A createRequire based on the file itself, which loads packages as the file's import would.
const basedHere = (argument) => argument.trim() === 'import.meta.url';

// What a file's code loads by name: what its import and export statements name, read by parsing
// the file as a module, and the names given as plain strings to import(), require(), a require
// that createRequire made from the file's own URL, or a variable that holds one. Those are read
// from the text, without its comments. A require made from another file or package loads the
// packages that one's manifest declares, so it is left out. A CommonJS file is read from the text
// only.
export function specifiersIn(source, cjs = false) {
  const specifiers = cjs
    ? []
    : new vm.SourceTextModule(source).moduleRequests.map(({ specifier }) => specifier);
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
  const requires = new Set(['require']);
  const assigned =
    String.raw`\b(?:const|let|var)\s+([\w$]+)\s*=\s*` + createRequireCall + String.raw`(?!\s*\()`;
  for (const [, variable, argument] of code.matchAll(new RegExp(assigned, 'g')))
    if (basedHere(argument)) requires.add(variable);
    else requires.delete(variable);
  const matches = (pattern) => [...code.matchAll(new RegExp(pattern, 'g'))];
  for (const { groups } of matches(String.raw`\bimport` + plainName)) specifiers.push(groups.name);
  for (const variable of requires) {
    const call = String.raw`(?<![\w$.])` + variable.replaceAll('$', '\\$') + plainName;
    for (const { groups } of matches(call)) specifiers.push(groups.name);
  }
  for (const [, argument, , specifier] of matches(createRequireCall + plainName))
    if (basedHere(argument)) specifiers.push(specifier);
  return specifiers;
}

// Each package the files load, with the first file, relative to root, that loads it.
export async function packagesLoadedBy(files, root) {
  const loaded = new Map();
  for (const file of files) {
    const name = file.pathname.slice(root.pathname.length);
    for (const specifier of specifiersIn(await readFile(file, 'utf8'), name.endsWith('.cjs'))) {
      if (specifier.startsWith('.') || specifier.startsWith('/') || isBuiltin(specifier)) continue;
      if (!loaded.has(packageOf(specifier))) loaded.set(packageOf(specifier), name);
    }
  }
  return loaded;
}
