import assert from 'assert';
import { readFileSync } from 'fs';
import { spawnSync } from 'child_process';
import os from 'os';

// The web image sizes Node's heap from the container's memory limit, so the heap always fits inside
// the container with room to spare for Node's own memory and the health check's node process. The
// image build runs this test in both stages, so the runtime stage's own Node is checked as well.
const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');

// Returns the node flags the image's runtime stage, the last FROM, starts the server with.
function serverNodeFlags(text) {
  const stages = text.split(/^FROM\s/m);
  assert.ok(stages.length >= 3, 'The Dockerfile should have a build stage and a runtime stage');
  const runtime = stages[stages.length - 1];

  // The server starts with plain node, so nothing replaces the command's flags on the way.
  assert.doesNotMatch(runtime, /^ENTRYPOINT\b/m, 'The runtime stage should not set an ENTRYPOINT');

  // Docker uses the last CMD. The health check's CMD is indented under HEALTHCHECK.
  const cmd = [...runtime.matchAll(/^CMD (.*)$/gm)].at(-1);
  assert.ok(cmd, 'The runtime stage should set a CMD');
  let argv = null;
  try {
    argv = JSON.parse(cmd[1]);
  } catch {
    // Shell form, which the runtime image cannot run.
  }
  assert.ok(Array.isArray(argv) && argv[0] === 'node', `The CMD should run node: ${cmd[0]}`);
  const script = argv.findIndex((arg, i) => i > 0 && !arg.startsWith('-'));
  assert.ok(script > 0, `The CMD should name the server's script: ${cmd[0]}`);
  const flags = argv.slice(1, script);

  // The percentage wins over a fixed --max-old-space-size, so only one heap flag may be set.
  const heapFlags = flags.filter((flag) => /^--max[-_]old[-_]space[-_]size/.test(flag));
  assert.strictEqual(heapFlags.length, 1, `The CMD should set the heap size once: ${cmd[0]}`);
  const percentage = heapFlags[0].match(/^--max-old-space-size-percentage=(\d+)$/);
  assert.ok(percentage, `The CMD should size the heap from the memory limit: ${heapFlags[0]}`);
  const percent = Number(percentage[1]);
  assert.ok(
    percent >= 25 && percent <= 75,
    `The heap should take between 25% and 75% of the memory limit, not ${percent}%`
  );
  return { flags, percent };
}

const { flags, percent } = serverNodeFlags(dockerfile);

// A later command without the setting, with another heap flag, or behind an ENTRYPOINT is caught.
const withCmd = (...argv) => `${dockerfile}\nCMD ${JSON.stringify(argv)}\n`;
serverNodeFlags(
  withCmd('node', '--enable-source-maps', '--max-old-space-size-percentage=50', 'a.js')
);
for (const changed of [
  withCmd('node', 'web-server/index.js'),
  `${dockerfile}\nCMD node --max-old-space-size-percentage=60 web-server/index.js\n`,
  withCmd('node', '--max-old-space-size=4096', 'web-server/index.js'),
  withCmd('node', '--max-old-space-size-percentage=90', 'web-server/index.js'),
  withCmd('node', '--max-old-space-size-percentage=60', '--max_old_space_size=100', 'index.js'),
  dockerfile.replace(/^EXPOSE /m, 'ENTRYPOINT [ "node", "--max-old-space-size=4096" ]\nEXPOSE ')
]) {
  assert.notStrictEqual(changed, dockerfile);
  assert.throws(() => serverNodeFlags(changed), assert.AssertionError);
}

// Returns the heap limit this Node gives with the server's flags, and with the given NODE_OPTIONS.
// Node exits at once for a flag it does not know.
function heapLimit(nodeOptions) {
  const env = { PATH: process.env.PATH };
  if (nodeOptions !== undefined) env.NODE_OPTIONS = nodeOptions;
  const run = spawnSync(
    process.execPath,
    [...flags, '-e', "console.log(require('v8').getHeapStatistics().heap_size_limit)"],
    { env, encoding: 'utf8', timeout: 30000 }
  );
  assert.strictEqual(
    run.status,
    0,
    `Node should start with ${flags.join(' ')} and NODE_OPTIONS=${nodeOptions}: ${run.stderr}`
  );
  return Number(run.stdout.trim());
}

// The heap limit is close to the percentage of the memory this process may use, which V8's own
// default is not, with or without a memory limit.
const limit = heapLimit();
const constrained = process.constrainedMemory();
const memoryLimit = Math.min(constrained > 0 ? constrained : Infinity, os.totalmem());
assert.ok(
  limit >= memoryLimit * ((percent - 10) / 100) && limit <= memoryLimit * ((percent + 10) / 100),
  `The heap limit of ${limit} bytes should be about ${percent}% of ${memoryLimit} bytes`
);

// A NODE_OPTIONS set in the stack adds to the setting rather than replacing it.
for (const nodeOptions of ['', '--enable-source-maps', '--max-old-space-size=4096']) {
  assert.strictEqual(heapLimit(nodeOptions), limit, `NODE_OPTIONS=${nodeOptions} changed the heap`);
}

console.log(
  `Runtime heap limit checks passed: ${flags.join(' ')} gives ${Math.round(limit / 1048576)} MiB` +
    ` of ${Math.round(memoryLimit / 1048576)} MiB on Node ${process.version}.`
);
