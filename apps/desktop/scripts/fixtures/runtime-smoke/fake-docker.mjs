// Stateful stand-in for a rootful Docker daemon used by the desktop and preview
// runtime smoke regressions.  Containers that bind-mount the smoke data root
// create a private directory the host user cannot traverse (as root:root 0700
// would be on a real rootful host); the cleanup container emulates root's DAC
// override within its single bind mount.  Every invocation is appended to FAKE_DOCKER_STATE/calls.
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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

const [command, subcommand] = args;
if (command === 'image' && subcommand === 'inspect') process.exit(0);
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
