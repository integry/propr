// Stateful stand-in for a rootful Docker daemon used by the image integration
// harness regression. Starting the launcher emulates its sibling services and a
// container-created private subtree the host user cannot remove; stopping it
// emulates the launcher's SIGTERM teardown (entrypoint.mjs -> stopStack with
// removeNetwork), which removes every propr.stack-labelled container and the
// stack network; `rm -f` kills the launcher without that teardown. Like the
// launcher's ensureNetwork, starting it reuses an existing stack network and
// creates one only when absent. FAKE_DOCKER_NETWORK_RACE=1 lets a foreign
// creator take the stack network name just before `network create`;
// FAKE_DOCKER_REPLACE_NETWORK=1 swaps in a same-named foreign network (copying
// its labels) after the launcher starts. FAKE_DOCKER_LATE_SIBLING=<service>
// emulates sequential startup still in progress: that sibling is created only
// once its name was inspected while missing and the next container is then
// inspected, provided the launcher is still running. FAKE_DOCKER_LAUNCHER_RM=fail
// makes removing the launcher fail. FAKE_DOCKER_DENY_AFTER_RM=1 revokes socket
// access once the launcher is killed; the fake npm revokes it during the e2e run
// when FAKE_E2E_DENY_DOCKER=1. While FAKE_DOCKER_STATE/socket-denied exists,
// every invocation fails with a permission error and running containers are
// left untouched. The cleanup container emulates root's
// DAC override within its single bind mount. Every invocation is appended to
// FAKE_DOCKER_STATE/calls.jsonl and the private-root modes seen at launch are
// recorded in FAKE_DOCKER_STATE/observed.json. Only synthetic data is handled.
//
// The fake runs inside the test process, not as a Node process per call: the
// harness makes over a hundred Docker calls per run and parses most of them
// with its own `node -e`, so a Node cold start per fake call roughly doubled
// the process count. Under host contention that overhead pushed the nightly
// unit past its per-unit timeout. `startFakeDockerDaemon` serves invocations
// on a loopback port and `fakeDockerClient` is a bash-only `docker` that
// forwards its argv and FAKE_DOCKER_* environment there and replays the
// output and exit status.
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';

// `fail` ends one invocation with the given status, like process.exit did.
class Exit extends Error {
  constructor(code) {
    super(`fake docker exit ${code}`);
    this.code = code;
  }
}

// Runs one `docker` invocation against FAKE_DOCKER_STATE and returns its
// output and exit status.
export function runFakeDocker(args, env) {
  const out = { stdout: '', stderr: '' };
  try {
    fakeDocker(args, env, out);
    return { code: 0, ...out };
  } catch (error) {
    if (error instanceof Exit) return { code: error.code, ...out };
    return { code: 125, stdout: out.stdout, stderr: `${out.stderr}fake docker crashed: ${error.stack}\n` };
  }
}

function fakeDocker(args, env, out) {
  const stateDir = env.FAKE_DOCKER_STATE;
  const statePath = join(stateDir, 'state.json');
  appendFileSync(join(stateDir, 'calls.jsonl'), `${JSON.stringify(args)}\n`);
  const fail = (message) => { out.stderr += `${message}\n`; throw new Exit(1); };
  if (existsSync(join(stateDir, 'socket-denied'))) {
    fail('permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock');
  }

  const state = existsSync(statePath)
    ? JSON.parse(readFileSync(statePath, 'utf8'))
    : { containers: {}, networks: {} };
  const save = () => writeFileSync(statePath, JSON.stringify(state, null, 2));
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

  function findNetwork(reference) {
    return Object.entries(state.networks).find(([name, network]) => name === reference || network.Id === reference);
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
    const containerEnv = keyValues('-e');
    const binds = option('-v').map((volume) => {
      const [Source, Destination, flags] = volume.split(':');
      return { Type: 'bind', Source, Destination, RW: flags !== 'ro' };
    });
    addContainer(name, { Config: { Labels: keyValues('--label') }, Mounts: binds, autoRemove: args.includes('--rm') });

    const root = dirname(containerEnv.PROPR_DATA_DIR);
    const envFile = readFileSync(containerEnv.PROPR_ENV_FILE, 'utf8');
    const observed = {
      base: mode(dirname(root)),
      root: mode(root),
      marker: mode(join(root, '.propr-itest-owner')),
      env: mode(containerEnv.PROPR_ENV_FILE),
      directories: Object.fromEntries(['data', 'logs', 'repos', 'vibe-prompts'].map((directory) => [directory, mode(join(root, directory))])),
      rootEntries: readdirSync(root).sort(),
      dataEntries: readdirSync(containerEnv.PROPR_DATA_DIR).sort(),
      hostKey: /^HOST_GH_PRIVATE_KEY=(.*)$/m.exec(envFile)?.[1],
      inContainerKeyPath: /^GH_PRIVATE_KEY_PATH=/m.test(envFile),
      syntheticSecretKept: /^SYNTHETIC_SECRET=synthetic-only-value$/m.test(envFile),
    };
    writeFileSync(join(stateDir, 'observed.json'), JSON.stringify(observed, null, 2));

    // Launcher-started siblings, labelled and mounted exactly as the launcher does.
    const stack = containerEnv.PROPR_STACK;
    const network = `${stack}-net`;
    const appMounts = [
      { Type: 'bind', Source: containerEnv.PROPR_LOGS_DIR, Destination: '/usr/src/app/logs' },
      { Type: 'bind', Source: containerEnv.PROPR_DATA_DIR, Destination: '/usr/src/app/data' },
    ];
    for (const service of ['api', 'daemon', 'worker', 'indexing-worker']) {
      const sibling = { Config: { Labels: { 'propr.stack': stack, 'propr.service': service } }, Mounts: appMounts, network };
      if (env.FAKE_DOCKER_LATE_SIBLING === service) {
        state.lateSibling = { launcher: name, name: `${stack}-${service}`, container: sibling, armed: false };
      } else {
        addContainer(`${stack}-${service}`, sibling);
      }
    }
    addContainer(`${stack}-redis`, {
      Config: { Labels: { 'propr.stack': stack, 'propr.service': 'redis' } },
      Mounts: [{ Type: 'volume', Name: `${stack}-redis-data`, Destination: '/data' }], network,
    });
    addContainer(`${stack}-ui`, { Config: { Labels: { 'propr.stack': stack, 'propr.service': 'ui' } }, Mounts: [], network });
    state.networks[network] ??= { Id: newId(), launcherCreated: true };
    if (env.FAKE_DOCKER_REPLACE_NETWORK === '1') {
      state.networks[network] = { Id: 'e'.repeat(64), Labels: { ...state.networks[network].Labels }, foreign: true };
    }

    // A rootful app container creates root:root 0700 entries in the data root.
    const webPush = join(containerEnv.PROPR_DATA_DIR, 'web-push');
    mkdirSync(webPush, { recursive: true });
    chmodSync(webPush, 0o700);
    writeFileSync(join(webPush, 'vapid.json'), '{"synthetic":true}');
    chmodSync(webPush, 0o000);
    save();
  }

  function stopLauncher(name, container) {
    const stack = container.Config.Labels['com.propr.itest.stack'];
    for (const [sibling, candidate] of Object.entries(state.containers)) {
      if (candidate.Config.Labels['propr.stack'] === stack) delete state.containers[sibling];
    }
    delete state.networks[`${stack}-net`];
    if (container.autoRemove) delete state.containers[name];
  }

  const [command, subcommand] = args;
  if (command === 'image' && subcommand === 'inspect') return;
  if (command === 'container' && subcommand === 'inspect') {
    const late = state.lateSibling;
    if (late && !state.containers[late.launcher]) delete state.lateSibling;
    else if (late && args.at(-1) === late.name) late.armed = true;
    else if (late?.armed) {
      addContainer(late.name, late.container);
      delete state.lateSibling;
    }
    save();
    const found = findContainer(args.at(-1));
    if (!found) fail(`Error: No such container: ${args.at(-1)}`);
    const [, container] = found;
    out.stdout += `${JSON.stringify([{ Id: container.Id, Name: container.Name, Config: container.Config, Mounts: container.Mounts }])}\n`;
  } else if (command === 'network' && subcommand === 'inspect') {
    const found = findNetwork(args.at(-1));
    if (!found) fail(`Error: No such network: ${args.at(-1)}`);
    const [name, network] = found;
    const attached = Object.fromEntries(Object.values(state.containers)
      .filter((container) => container.network === name).map((container) => [container.Id, { Name: container.Name.slice(1) }]));
    out.stdout += `${JSON.stringify([{ Id: network.Id, Name: name, Labels: network.Labels ?? {}, Containers: attached }])}\n`;
  } else if (command === 'network' && subcommand === 'create') {
    const name = args.at(-1);
    if (env.FAKE_DOCKER_NETWORK_RACE === '1') {
      state.networks[name] ??= { Id: 'e'.repeat(64), foreign: true };
      save();
    }
    if (state.networks[name]) fail(`Error response from daemon: network with name ${name} already exists`);
    const id = newId();
    state.networks[name] = { Id: id, Labels: keyValues('--label') };
    save();
    out.stdout += `${id}\n`;
  } else if (command === 'network' && subcommand === 'rm') {
    const found = findNetwork(args.at(-1));
    if (!found) fail('Error: No such network');
    delete state.networks[found[0]];
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
    if (env.FAKE_DOCKER_LAUNCHER_RM === 'fail' && found[1].Config.Labels['com.propr.itest.stack']) fail('cannot kill launcher');
    delete state.containers[found[0]];
    save();
    if (env.FAKE_DOCKER_DENY_AFTER_RM === '1' && found[1].Config.Labels['com.propr.itest.stack']) {
      writeFileSync(join(stateDir, 'socket-denied'), '');
    }
  } else if (command === 'logs') {
    out.stdout += 'fake logs\n';
  } else if (command === 'run' && option('--entrypoint')[0] === 'find') {
    if (env.FAKE_DOCKER_CLEANUP === 'fail') fail('cleanup container failed');
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
}

// Request: NUL-terminated fields "<env count>", "<arg count>", then each
// NAME=value and each argument. Response: "<status>", stdout and stderr, each
// NUL-terminated. Requests are handled synchronously, one at a time, so state
// updates never interleave. The server is unref'd: it never keeps a test
// process alive, while a pending harness child does.
export async function startFakeDockerDaemon() {
  let served = 0;
  const server = createServer((socket) => {
    let buffered = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      const fields = buffered.toString('utf8').split('\0');
      fields.pop();
      if (fields.length < 2) return;
      const envCount = Number(fields[0]);
      const argCount = Number(fields[1]);
      if (fields.length < 2 + envCount + argCount) return;
      const env = Object.fromEntries(fields.slice(2, 2 + envCount).map((entry) => {
        const separator = entry.indexOf('=');
        return [entry.slice(0, separator), entry.slice(separator + 1)];
      }));
      const result = runFakeDocker(fields.slice(2 + envCount, 2 + envCount + argCount), env);
      served += 1;
      socket.end(`${result.code}\0${result.stdout}\0${result.stderr}\0`);
    });
    socket.on('error', () => {});
  });
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  server.unref();
  return { port: server.address().port, served: () => served };
}

// A `docker` executable that only uses bash builtins: no process is started
// per call. An unreachable daemon fails the invocation instead of passing.
export function fakeDockerClient(port) {
  return `#!/usr/bin/env bash
exec 3<>"/dev/tcp/127.0.0.1/${port}" || { echo "fake docker daemon unreachable" >&2; exit 125; }
names=(\${!FAKE_DOCKER_@})
printf '%s\\0' "\${#names[@]}" "$#" >&3
for name in "\${names[@]}"; do printf '%s=%s\\0' "$name" "\${!name}" >&3; done
if [ "$#" -gt 0 ]; then printf '%s\\0' "$@" >&3; fi
IFS= read -r -d '' code <&3 && IFS= read -r -d '' stdout <&3 && IFS= read -r -d '' stderr <&3 \\
  || { echo "fake docker daemon closed the connection" >&2; exit 125; }
printf '%s' "$stdout"
printf '%s' "$stderr" >&2
exit "$code"
`;
}
