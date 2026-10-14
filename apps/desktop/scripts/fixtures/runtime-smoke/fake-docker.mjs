// Stateful stand-in for a rootful Docker daemon used by the desktop and preview
// runtime smoke regressions.  Containers that bind-mount the smoke data root
// create a private directory the host user cannot traverse (as root:root 0700
// would be on a real rootful host); the cleanup container emulates root's DAC
// override within its single bind mount.  The app image's /usr/src/app is the
// checkout itself, as for an image built from it.  Every invocation is appended to FAKE_DOCKER_STATE/calls.
import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const stateDir = process.env.FAKE_DOCKER_STATE;
const statePath = join(stateDir, 'state.json');
const args = process.argv.slice(2);
appendFileSync(join(stateDir, 'calls.jsonl'), `${JSON.stringify(args)}\n`);

const state = existsSync(statePath)
  ? JSON.parse(readFileSync(statePath, 'utf8'))
  : { containers: {}, networks: {} };
const save = () => writeFileSync(statePath, JSON.stringify(state, null, 2));
const fail = (message) => { process.stderr.write(`${message}\n`); process.exit(1); };

function option(name) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name) values.push(args[index + 1]);
  }
  return values;
}

function labelFromFormat(format, labels) {
  const match = /index \.(?:Config\.)?Labels "([^"]+)"/.exec(format ?? '');
  return match ? labels[match[1]] ?? '' : '';
}

function inspect(kind, name) {
  const resource = state[kind][name];
  if (!resource) fail(`Error: no such object: ${name}`);
  const format = option('--format')[0];
  process.stdout.write(format ? `${labelFromFormat(format, resource.labels)}\n` : '[{}]\n');
}

function parseLabels() {
  return Object.fromEntries(option('--label').map((label) => {
    const separator = label.indexOf('=');
    return [label.slice(0, separator), label.slice(separator + 1)];
  }));
}

function privilegedEmpty(directory) {
  chmodSync(directory, 0o700);
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) privilegedEmpty(path);
    rmSync(path, { recursive: true, force: true });
  }
}

const repoRoot = resolve(import.meta.dirname, '../../../../..');
const entrypoint = args.includes('--entrypoint') ? args[args.indexOf('--entrypoint') + 1] : undefined;

const [command, subcommand] = args;
if (command === 'image' && (subcommand === 'inspect' || subcommand === 'rm')) process.exit(0);
if (command === 'network' && subcommand === 'create') {
  state.networks[args.at(-1)] = { labels: parseLabels() };
  save();
} else if (command === 'network' && subcommand === 'inspect') {
  inspect('networks', args.at(-1));
} else if (command === 'network' && subcommand === 'rm') {
  delete state.networks[args.at(-1)];
  save();
} else if (command === 'container' && subcommand === 'inspect') {
  inspect('containers', args.at(-1));
} else if (command === 'rm') {
  delete state.containers[args.at(-1)];
  save();
} else if (command === 'port') {
  process.stdout.write(`127.0.0.1:${process.env.FAKE_API_PORT}\n`);
} else if (command === 'logs') {
  process.stdout.write('fake api logs\n');
} else if (command === 'inspect') {
  process.stdout.write('running\n');
} else if (command === 'run' && args.includes('--rm') && args.includes('--mount')) {
  if (process.env.FAKE_DOCKER_CLEANUP === 'fail') fail('cleanup container failed');
  const mounts = option('--mount');
  if (mounts.length !== 1) fail('cleanup must mount exactly one path');
  const source = /^type=bind,source=(.+),target=\/smoke-root$/.exec(mounts[0])?.[1];
  if (!source || !existsSync(source)) fail(`invalid cleanup mount ${mounts[0]}`);
  privilegedEmpty(source);
} else if (command === 'run' && args.includes('--entrypoint') && args[args.indexOf('--entrypoint') + 1] === 'node'
  && args.some((arg) => arg.startsWith('EXPECTED_SHARP_VERSION='))) {
  // The shared sharp check: FAKE_DOCKER_SHARP=fail emulates a missing or
  // unloadable nested sharp tree in the app image.
  if (process.env.FAKE_DOCKER_SHARP === 'fail') fail("Error: Cannot find module 'sharp'");
  process.stdout.write('fake sharp check passed\n');
} else if (command === 'run' && entrypoint === 'cat' && args.at(-1) === '/usr/src/app/Dockerfile.agent') {
  // The shared agent build-context check reads the image's Dockerfile.agent.
  process.stdout.write(readFileSync(join(repoRoot, 'Dockerfile.agent')));
} else if (command === 'run' && entrypoint === 'sh' && args.includes('/usr/src/app')) {
  // Its presence probe: FAKE_DOCKER_AGENT_CONTEXT=missing emulates an app
  // image that omits the extension bridge from the agent build context.
  if (process.env.FAKE_DOCKER_AGENT_CONTEXT === 'missing') process.stdout.write('scripts/extension-stdio-bridge.mjs\n');
} else if (command === 'run' && entrypoint === 'sha256sum') {
  for (const file of args.slice(args.indexOf('--') + 1)) {
    process.stdout.write(`${createHash('sha256').update(readFileSync(join(repoRoot, file))).digest('hex')}  ${file}\n`);
  }
} else if (command === 'run' && entrypoint === 'docker' && args.includes('build')) {
  // The worker-style COPY build from /usr/src/app succeeds for a complete context.
  readFileSync(0);
} else if (command === 'run') {
  // One-shot `--rm` runs (preview migrations) leave no container behind.
  const name = option('--name')[0];
  if (!args.includes('--rm')) state.containers[name] = { labels: parseLabels() };
  for (const volume of option('-v')) {
    const [source, target] = volume.split(':');
    if (target === '/usr/src/app/data' && !existsSync(join(source, 'web-push'))) {
      const webPush = join(source, 'web-push');
      mkdirSync(webPush);
      writeFileSync(join(webPush, 'vapid.json'), '{}');
      chmodSync(webPush, 0o000);
    }
  }
  save();
  process.stdout.write(`${name}-id\n`);
} else {
  fail(`unsupported fake docker invocation: ${args.join(' ')}`);
}
