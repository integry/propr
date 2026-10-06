// Stateful stand-in for a rootful Docker daemon used by the image integration
// harness regression. Starting the launcher emulates its sibling services and a
// container-created private subtree the host user cannot remove; stopping it
// emulates the launcher's own teardown. The cleanup container emulates root's
// DAC override within its single bind mount. Every invocation is appended to
// FAKE_DOCKER_STATE/calls.jsonl and the private-root modes seen at launch are
// recorded in FAKE_DOCKER_STATE/observed.json. Only synthetic data is handled.
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';

const stateDir = process.env.FAKE_DOCKER_STATE;
const statePath = join(stateDir, 'state.json');
const args = process.argv.slice(2);
appendFileSync(join(stateDir, 'calls.jsonl'), `${JSON.stringify(args)}\n`);

const state = existsSync(statePath)
  ? JSON.parse(readFileSync(statePath, 'utf8'))
  : { containers: {}, networks: {} };
const save = () => writeFileSync(statePath, JSON.stringify(state, null, 2));
const fail = (message) => { process.stderr.write(`${message}\n`); process.exit(1); };
const newId = () => randomBytes(32).toString('hex');

function option(name) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name) values.push(args[index + 1]);
  }
  return values;
}

function keyValues(name) {
  return Object.fromEntries(option(name).map((entry) => {
    const separator = entry.indexOf('=');
    return [entry.slice(0, separator), entry.slice(separator + 1)];
  }));
}

function findContainer(reference) {
  return Object.entries(state.containers).find(([name, container]) => name === reference || container.Id === reference);
}

function addContainer(name, container) {
  state.containers[name] = { Id: newId(), Name: `/${name}`, ...container };
}

function mode(path) {
  return (lstatSync(path).mode & 0o777).toString(8);
}

function privilegedEmpty(directory) {
  chmodSync(directory, 0o700);
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) privilegedEmpty(path);
    rmSync(path, { recursive: true, force: true });
  }
}

function startLauncher() {
  const [name] = option('--name');
  if (state.containers[name]) fail(`Conflict. The container name "/${name}" is already in use`);
  const env = keyValues('-e');
  const binds = option('-v').map((volume) => {
    const [Source, Destination, flags] = volume.split(':');
    return { Type: 'bind', Source, Destination, RW: flags !== 'ro' };
  });
  addContainer(name, { Config: { Labels: keyValues('--label') }, Mounts: binds, autoRemove: args.includes('--rm') });

  const root = dirname(env.PROPR_DATA_DIR);
  const envFile = readFileSync(env.PROPR_ENV_FILE, 'utf8');
  const observed = {
    base: mode(dirname(root)),
    root: mode(root),
    marker: mode(join(root, '.propr-itest-owner')),
    env: mode(env.PROPR_ENV_FILE),
    directories: Object.fromEntries(['data', 'logs', 'repos', 'vibe-prompts'].map((directory) => [directory, mode(join(root, directory))])),
    rootEntries: readdirSync(root).sort(),
    dataEntries: readdirSync(env.PROPR_DATA_DIR).sort(),
    hostKey: /^HOST_GH_PRIVATE_KEY=(.*)$/m.exec(envFile)?.[1],
    inContainerKeyPath: /^GH_PRIVATE_KEY_PATH=/m.test(envFile),
    syntheticSecretKept: /^SYNTHETIC_SECRET=synthetic-only-value$/m.test(envFile),
  };
  writeFileSync(join(stateDir, 'observed.json'), JSON.stringify(observed, null, 2));

  // Launcher-started siblings, labelled and mounted exactly as the launcher does.
  const stack = env.PROPR_STACK;
  const network = `${stack}-net`;
  const appMounts = [
    { Type: 'bind', Source: env.PROPR_LOGS_DIR, Destination: '/usr/src/app/logs' },
    { Type: 'bind', Source: env.PROPR_DATA_DIR, Destination: '/usr/src/app/data' },
  ];
  for (const service of ['api', 'daemon', 'worker', 'indexing-worker']) {
    addContainer(`${stack}-${service}`, {
      Config: { Labels: { 'propr.stack': stack, 'propr.service': service } }, Mounts: appMounts, network,
    });
  }
  addContainer(`${stack}-redis`, {
    Config: { Labels: { 'propr.stack': stack, 'propr.service': 'redis' } },
    Mounts: [{ Type: 'volume', Name: `${stack}-redis-data`, Destination: '/data' }], network,
  });
  addContainer(`${stack}-ui`, { Config: { Labels: { 'propr.stack': stack, 'propr.service': 'ui' } }, Mounts: [], network });
  state.networks[network] ??= { Id: newId(), launcherCreated: true };

  // A rootful app container creates root:root 0700 entries in the data root.
  const webPush = join(env.PROPR_DATA_DIR, 'web-push');
  mkdirSync(webPush, { recursive: true });
  chmodSync(webPush, 0o700);
  writeFileSync(join(webPush, 'vapid.json'), '{"synthetic":true}');
  chmodSync(webPush, 0o000);
  save();
}

function stopLauncher(name, container) {
  if (process.env.FAKE_LAUNCHER_TEARDOWN !== 'skip') {
    const stack = container.Config.Labels['com.propr.itest.stack'];
    for (const [sibling, candidate] of Object.entries(state.containers)) {
      if (candidate.Config.Labels['propr.stack'] === stack) delete state.containers[sibling];
    }
  }
  if (container.autoRemove) delete state.containers[name];
}

const [command, subcommand] = args;
if (command === 'image' && subcommand === 'inspect') process.exit(0);
if (command === 'container' && subcommand === 'inspect') {
  const found = findContainer(args.at(-1));
  if (!found) fail(`Error: No such container: ${args.at(-1)}`);
  const [, container] = found;
  process.stdout.write(`${JSON.stringify([{ Id: container.Id, Name: container.Name, Config: container.Config, Mounts: container.Mounts }])}\n`);
} else if (command === 'network' && subcommand === 'inspect') {
  const name = args.at(-1);
  const network = state.networks[name];
  if (!network) fail(`Error: No such network: ${name}`);
  const attached = Object.fromEntries(Object.values(state.containers)
    .filter((container) => container.network === name).map((container) => [container.Id, { Name: container.Name.slice(1) }]));
  process.stdout.write(`${JSON.stringify([{ Id: network.Id, Name: name, Containers: attached }])}\n`);
} else if (command === 'network' && subcommand === 'rm') {
  if (!state.networks[args.at(-1)]) fail('Error: No such network');
  delete state.networks[args.at(-1)];
  save();
} else if (command === 'stop') {
  const found = findContainer(args.at(-1));
  if (!found) fail('Error: No such container');
  const [name, container] = found;
  if (container.Config.Labels['com.propr.itest.stack']) stopLauncher(name, container);
  save();
} else if (command === 'rm') {
  const found = findContainer(args.at(-1));
  if (!found) fail('Error: No such container');
  delete state.containers[found[0]];
  save();
} else if (command === 'logs') {
  process.stdout.write('fake logs\n');
} else if (command === 'run' && option('--entrypoint')[0] === 'find') {
  if (process.env.FAKE_DOCKER_CLEANUP === 'fail') fail('cleanup container failed');
  const mounts = option('--mount');
  if (mounts.length !== 1 || args.includes('-v') || args.includes('--privileged')) fail('cleanup must mount exactly one path');
  if (option('--network')[0] !== 'none' || option('--cap-drop')[0] !== 'ALL') fail('cleanup must be network-less with no capabilities');
  const source = /^type=bind,source=(.+),target=\/itest-root$/.exec(mounts[0])?.[1];
  if (!source || !existsSync(source)) fail(`invalid cleanup mount ${mounts[0]}`);
  privilegedEmpty(source);
} else if (command === 'run') {
  startLauncher();
} else {
  fail(`unexpected docker invocation: ${args.join(' ')}`);
}
