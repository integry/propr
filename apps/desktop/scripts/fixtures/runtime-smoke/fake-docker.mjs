// Stateful stand-in for a rootful Docker daemon used by the desktop and preview
// runtime smoke regressions.  Containers that bind-mount the smoke data root
// create a private directory the host user cannot traverse (as root:root 0700
// would be on a real rootful host); the cleanup container emulates root's DAC
// override within its single bind mount.  The app image's /usr/src/app is the
// host directory FAKE_DOCKER_APP_CONTEXT, so the agent build-context check reads,
// hashes and builds from real files a test can omit, alter or .dockerignore.
// Every invocation is appended to FAKE_DOCKER_STATE/calls.
import { createHash } from 'node:crypto';
import {
  appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
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

const entrypoint = args.includes('--entrypoint') ? args[args.indexOf('--entrypoint') + 1] : undefined;

// Maps a path inside the app image's /usr/src/app to its host stand-in.
function appContextPath(path) {
  const root = process.env.FAKE_DOCKER_APP_CONTEXT;
  if (!root) fail('FAKE_DOCKER_APP_CONTEXT must name the app image /usr/src/app stand-in');
  const relative = path.replace(/^\/usr\/src\/app(?:\/|$)/, '');
  if (relative === path && path.startsWith('/')) fail(`fake app image has no ${path}`);
  return join(root, relative);
}
const isFile = (path) => existsSync(path) && statSync(path).isFile();

// `docker build -f - -t <tag> /usr/src/app` from inside the app image: a
// FROM-scratch Dockerfile whose local COPY sources must exist in the context
// and must not be excluded by its .dockerignore, as the real engine enforces.
function buildFromAppImage() {
  const buildArgs = args.slice(args.indexOf('build') + 1);
  const valueOf = (flag) => buildArgs[buildArgs.indexOf(flag) + 1];
  const socketMount = option('-v').find((volume) => volume.endsWith(':/var/run/docker.sock'));
  if (!socketMount || !statSync(socketMount.split(':')[0]).isSocket()) fail('Cannot connect to the Docker daemon');
  if (valueOf('-f') !== '-' || !valueOf('-t') || buildArgs.at(-1) !== '/usr/src/app') {
    fail(`unsupported fake docker build: ${buildArgs.join(' ')}`);
  }
  const context = appContextPath(buildArgs.at(-1));
  const ignorePath = join(context, '.dockerignore');
  const ignored = new Set(isFile(ignorePath)
    ? readFileSync(ignorePath, 'utf8').split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#'))
    : []);
  const lines = readFileSync(0, 'utf8').trim().split('\n');
  if (lines[0] !== 'FROM scratch') fail(`fake docker build only models FROM scratch, got: ${lines[0]}`);
  lines.slice(1).forEach((line, index) => {
    const words = line.split(/\s+/);
    if (words[0] !== 'COPY') fail(`fake docker build only models COPY, got: ${line}`);
    for (const source of words.slice(1, -1)) {
      if (ignored.has(source) || !isFile(join(context, source))) {
        fail(`ERROR: failed to solve: failed to compute cache key: "/${source}": not found\n`
          + `COPY failed (step ${index + 2}): file not found in build context or excluded by .dockerignore: stat ${source}: file does not exist`);
      }
    }
  });
  state.images = { ...state.images, [valueOf('-t')]: {} };
  save();
}

const [command, subcommand] = args;
if (command === 'image' && subcommand === 'inspect') process.exit(0);
if (command === 'image' && subcommand === 'rm') {
  // Built check images are tracked so a test can prove none is left behind.
  for (const tag of args.slice(2).filter((arg) => !arg.startsWith('-'))) delete state.images?.[tag];
  if (state.images && Object.keys(state.images).length === 0) delete state.images;
  save();
} else if (command === 'network' && subcommand === 'create') {
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
} else if (command === 'run' && entrypoint === 'cat') {
  // The agent build-context check reads the image's own Dockerfile.agent.
  const path = appContextPath(args.at(-1));
  if (!isFile(path)) fail(`cat: ${args.at(-1)}: No such file or directory`);
  process.stdout.write(readFileSync(path));
} else if (command === 'run' && entrypoint === 'sh' && option('--workdir')[0] === '/usr/src/app') {
  // Its presence probe: `sh -c '<list missing>' sh <file>...` in /usr/src/app.
  for (const file of args.slice(args.indexOf('-c') + 3)) {
    if (!isFile(appContextPath(file))) process.stdout.write(`${file}\n`);
  }
} else if (command === 'run' && entrypoint === 'sha256sum' && option('--workdir')[0] === '/usr/src/app') {
  for (const file of args.slice(args.indexOf('--') + 1)) {
    const path = appContextPath(file);
    if (!isFile(path)) fail(`sha256sum: ${file}: No such file or directory`);
    process.stdout.write(`${createHash('sha256').update(readFileSync(path)).digest('hex')}  ${file}\n`);
  }
} else if (command === 'run' && entrypoint === 'docker' && args.includes('build')) {
  buildFromAppImage();
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
