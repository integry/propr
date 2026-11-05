#!/usr/bin/env node
// Fake docker CLI for the image smoke cleanup regressions.  It emulates a
// rootful engine leaving a root-owned 0700 `web-push` directory in the smoke's
// bind-mounted data root, then fails the step so the harness exits through its
// cleanup trap.  The cleanup container (one bind mount at /smoke-root) empties
// that mount the way `find -mindepth 1 -delete` as root would.
import { appendFileSync, chmodSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
appendFileSync(join(process.env.FAKE_DOCKER_STATE, 'calls.jsonl'), `${JSON.stringify(args)}\n`);
const option = (name) => args.flatMap((arg, index) => (args[index - 1] === name ? [arg] : []));
const fail = (message) => {
  process.stderr.write(`${message}\n`);
  process.exit(1);
};

// What a root container leaves behind: a directory the host user cannot traverse.
function protectedWebPush(dataDir) {
  const webPush = join(dataDir, 'web-push');
  mkdirSync(webPush, { recursive: true, mode: 0o700 });
  writeFileSync(join(webPush, 'vapid.json'), '{}');
  chmodSync(webPush, 0o000);
}

function privilegedEmpty(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      chmodSync(path, 0o700);
      privilegedEmpty(path);
    }
    rmSync(path, { recursive: true, force: true });
  }
}

const [command, subcommand] = args;
if ((command === 'container' || command === 'network') && subcommand === 'inspect') {
  fail(`Error: No such object: ${args.at(-1)}`);
} else if (command === 'image' && subcommand === 'inspect') {
  process.exit(0);
} else if (command === 'run' && option('--mount').length > 0) {
  const mounts = option('--mount');
  if (mounts.length !== 1) fail('cleanup must mount exactly one path');
  const source = /^type=bind,source=(.+),target=\/smoke-root$/.exec(mounts[0])?.[1];
  if (!source) fail(`invalid cleanup mount ${mounts[0]}`);
  if (process.env.FAKE_DOCKER_CLEANUP === 'fail') fail('cleanup container failed');
  privilegedEmpty(source);
} else if (command === 'run' && args.some((arg) => arg.includes('/app/manifest.json'))
  && !args.some((arg) => arg.includes('EXPECTED_VERSION'))) {
  // The SQLite smoke asks the launcher which app image it selects.
  process.stdout.write(process.env.FAKE_APP_TAG);
} else if (command === 'run' && args.includes('-d') && option('-e').some((env) => env.startsWith('PROPR_DATA_DIR='))) {
  // The SQLite smoke's launcher: services write into PROPR_DATA_DIR as root.
  protectedWebPush(option('-e').find((env) => env.startsWith('PROPR_DATA_DIR=')).slice('PROPR_DATA_DIR='.length));
  fail('synthetic launcher start failure');
} else if (command === 'run' && args.some((arg) => arg.includes('docs-manifest.json'))) {
  // The image smoke's first app container; its data root is the only one under the base.
  const base = process.env.FAKE_SMOKE_BASE;
  const [root] = readdirSync(base).filter((name) => name.startsWith('propr-image-smoke.'));
  protectedWebPush(join(base, root, 'data'));
  fail('synthetic app image check failure');
} else if (command === 'logs') {
  process.stdout.write(process.env.FAKE_DOCKER_LOGS ?? '');
}
