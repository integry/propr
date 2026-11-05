import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline/promises';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, test } from 'node:test';
import {
  assertMacGuiSession,
  awaitMacStartupReview,
  isolatedAgentPaths,
  createIsolatedSetupEnvironment,
  createLinuxSetupIsolation,
  createInterruptedRelaunchDiagnostics,
  daemonHostInspectionCount,
  hasFreshRetryExecution,
  dockerOperation,
  dockerWrapperSource,
  parseDockerEvents,
  probeDockerSupport,
  reserveFreeLoopbackPorts,
  validateSourceSha,
} from './packaged-linux-setup-lifecycle.mjs';

const digest = `sha256:${'a'.repeat(64)}`;

const rejectedDockerCommands = [
  ['image', 'tag', 'propr/app:test', 'propr/app:mutated'],
  ['image', 'inspect', 'propr/app:test', '--format', '{{.Id}}'],
  ['image', 'inspect', '--help'],
  ['image', 'inspect', '--format', '{{json .}}', 'propr/app:test'],
  ['image', 'inspect', '--format', '{{.Id}} ', 'propr/app:test'],
  ['image', 'inspect', '-f', '{{.Id}}', 'propr/app:test'],
  ['image', 'inspect', '--format={{.Id}}', 'propr/app:test'],
  ['image', 'inspect', '--format', '{{.Id}}'],
  ['image', 'inspect', '--format', '{{.Id}}', ''],
  ['image', 'inspect', '--format', '{{.Id}}', ' propr/app:test'],
  ['image', 'inspect', '--format', '{{.Id}}', '--type=image'],
  ['image', 'inspect', '--format', '{{.Id}}', 'propr/app:test', 'propr/ui:test'],
  ['image', 'inspect', '--format', '{{.Id}}', '--format', 'propr/app:test'],
  ['inspect', '--format', '{{.Id}}', 'propr/app:test'],
  ['run', `propr/agent:0123abc@${digest}`],
  ['build', '-t', 'propr/app:test', '.'],
  ['rmi', 'propr/app:test'],
  ['image', 'rm', 'propr/app:test'],
  ['network', 'create', 'propr-test'],
];

const waitForEventCount = async (path, count) => {
  const deadline = Date.now() + 5_000;
  do {
    try {
      const events = parseDockerEvents(await readFile(path, 'utf8'));
      if (events.length >= count) return events;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  } while (Date.now() < deadline);
  throw new Error('Docker wrapper test event deadline expired');
};

describe('real packaged Linux setup lifecycle harness', () => {
  it('creates only unique non-default stack, network, and ownership names', () => {
    assert.deepEqual(createLinuxSetupIsolation('0123456789abcdef'), {
      id: '0123456789abcdef',
      stack: 'propr-desktop-acceptance-0123456789abcdef',
      network: 'propr-desktop-acceptance-0123456789abcdef-net',
      ownershipLabel: 'propr.stack=propr-desktop-acceptance-0123456789abcdef',
    });
    assert.throws(() => createLinuxSetupIsolation('short'), /isolation id/);
  });

  it('requires an exact source SHA and allocates distinct loopback ports', async () => {
    assert.equal(validateSourceSha('a'.repeat(40)), 'a'.repeat(40));
    assert.throws(() => validateSourceSha('A'.repeat(40)), /exact 40-character source SHA/);
    const ports = await reserveFreeLoopbackPorts();
    assert.equal(ports.length, 3);
    assert.equal(new Set(ports).size, 3);
    assert.ok(ports.every(port => Number.isSafeInteger(port) && port > 0 && port <= 65_535));
  });

  it('passes only allowlisted host context into the private runtime', () => {
    const profile = {
      root: '/tmp/propr-desktop-smoke-private',
      home: '/tmp/propr-desktop-smoke-private/home',
      temporary: '/tmp/propr-desktop-smoke-private/temp',
      xdgCache: '/tmp/propr-desktop-smoke-private/cache',
      xdgConfig: '/tmp/propr-desktop-smoke-private/config',
      xdgData: '/tmp/propr-desktop-smoke-private/data',
      xdgRuntime: '/tmp/propr-desktop-smoke-private/runtime',
    };
    const isolation = createLinuxSetupIsolation('0123456789abcdef');
    const environment = createIsolatedSetupEnvironment({
      baseEnvironment: {
        PATH: '/usr/bin:/bin', DISPLAY: ':99', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/tmp/dbus',
        GH_TOKEN: 'must-not-cross', GITHUB_TOKEN: 'must-not-cross', DOCKER_CONFIG: '/production/docker',
      },
      profile,
      wrapperDirectory: '/tmp/propr-desktop-smoke-private/wrapper',
      isolation,
      ports: [41001, 41002, 41003],
    });
    assert.equal(environment.GH_TOKEN, undefined);
    assert.equal(environment.GITHUB_TOKEN, undefined);
    assert.equal(environment.DOCKER_CONFIG, undefined);
    assert.equal(environment.PROPR_STACK, isolation.stack);
    assert.equal(environment.PROPR_NETWORK, isolation.network);
    assert.equal(environment.API_PORT, '127.0.0.1:41001');
    assert.equal(environment.PATH, '/tmp/propr-desktop-smoke-private/wrapper:/usr/bin:/bin');
  });

  it('classifies only exact read-only image inspection forms as image-inspect', () => {
    assert.equal(dockerOperation(['image', 'inspect', 'propr/agent:0123abc']), 'image-inspect');
    assert.equal(dockerOperation(['image', 'inspect', `propr/agent:0123abc@${digest}`]), 'image-inspect');
    assert.equal(dockerOperation(['image', 'inspect', '--format', '{{.Id}}', 'propr/agent:0123abc']), 'image-inspect');
    assert.equal(dockerOperation(['image', 'inspect', '--format', '{{.Id}}', `propr/agent:0123abc@${digest}`]), 'image-inspect');
    assert.equal(dockerOperation(['image', 'inspect', '--format', '{{.Id}}', `propr/agent@${digest}`]), 'image-inspect');
    for (const args of rejectedDockerCommands) {
      assert.equal(dockerOperation(args), 'rejected', JSON.stringify(args));
    }
  });

  it('delegates read-only Docker inspection, holds pull, and rejects mutations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'propr-linux-setup-wrapper-test-'));
    const wrapper = join(root, 'docker');
    const realDocker = join(root, 'real-docker');
    const eventsPath = join(root, 'events.jsonl');
    const slowEventWriter = join(root, 'slow-event-writer.cjs');
    try {
      await writeFile(realDocker, `#!/usr/bin/env node
'use strict';
const args = process.argv.slice(2);
if (args.at(-1) === 'propr/agent:missing') {
  process.stderr.write('Error: No such image: propr/agent:missing\\n');
  process.exit(1);
}
process.stdout.write(JSON.stringify(args));
`, { mode: 0o700 });
      await writeFile(wrapper, dockerWrapperSource({ realDockerPath: realDocker, eventPath: eventsPath }), { mode: 0o700 });
      await chmod(realDocker, 0o700);
      await chmod(wrapper, 0o700);

      const version = spawn(process.execPath, [wrapper, '--version']);
      let delegatedOutput = '';
      version.stdout.on('data', chunk => { delegatedOutput += chunk.toString('utf8'); });
      assert.deepEqual(await once(version, 'close'), [0, null]);
      assert.deepEqual(JSON.parse(delegatedOutput), ['--version']);

      const inspect = spawn(process.execPath, [wrapper, 'image', 'inspect', 'propr/app:test']);
      let inspectOutput = '';
      inspect.stdout.on('data', chunk => { inspectOutput += chunk.toString('utf8'); });
      assert.deepEqual(await once(inspect, 'close'), [0, null]);
      assert.deepEqual(JSON.parse(inspectOutput), ['image', 'inspect', 'propr/app:test']);

      for (const args of [
        ['info', '--format', '{{.OSType}}'],
        ['info', '--format', '{{.Architecture}}'],
        ['image', 'inspect', '--format', '{{.Id}}', 'propr/agent:0123abc'],
        ['image', 'inspect', '--format', '{{.Id}}', `propr/agent:0123abc@${digest}`],
      ]) {
        const formatted = spawn(process.execPath, [wrapper, ...args]);
        let formattedOutput = '';
        formatted.stdout.on('data', chunk => { formattedOutput += chunk.toString('utf8'); });
        assert.deepEqual(await once(formatted, 'close'), [0, null]);
        assert.deepEqual(JSON.parse(formattedOutput), args);
      }

      // A delegated nonzero result (absent image) must surface unchanged.
      const missing = spawn(process.execPath, [wrapper, 'image', 'inspect', '--format', '{{.Id}}', 'propr/agent:missing']);
      let missingError = '';
      missing.stderr.on('data', chunk => { missingError += chunk.toString('utf8'); });
      assert.deepEqual(await once(missing, 'close'), [1, null]);
      assert.match(missingError, /No such image: propr\/agent:missing/);

      for (const args of rejectedDockerCommands) {
        const rejected = spawn(process.execPath, [wrapper, ...args]);
        assert.deepEqual(await once(rejected, 'close'), [97, null]);
      }

      // Keep the child inside the event write long enough for the parent to
      // signal it as soon as pull admission is visible, before startup resumes.
      await writeFile(slowEventWriter, `
const fs = require('node:fs');
const appendFileSync = fs.appendFileSync;
fs.appendFileSync = (...args) => {
  appendFileSync(...args);
  if (JSON.parse(args[1]).event === 'invoked') {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  }
};
`);
      const held = spawn(process.execPath, ['--require', slowEventWriter, wrapper, 'pull', 'propr/app:test']);
      const admittedBeforePull = 7 + rejectedDockerCommands.length * 2;
      const events = await waitForEventCount(eventsPath, admittedBeforePull + 1);
      assert.equal(events.at(-1).operation, 'pull');
      held.kill('SIGTERM');
      assert.deepEqual(await once(held, 'close'), [143, null]);
      const final = await waitForEventCount(eventsPath, admittedBeforePull + 2);
      assert.equal(final.at(-1).event, 'sigterm');
      assert.deepEqual(final.filter(event => event.event === 'invoked').map(event => event.operation), [
        'version', 'image-inspect', 'daemon-host-inspection', 'architecture-inspection', 'image-inspect', 'image-inspect', 'image-inspect',
        ...rejectedDockerCommands.map(() => 'rejected'), 'pull',
      ]);
      assert.equal(final.filter(event => event.event === 'rejected').length, rejectedDockerCommands.length);
      assert.equal(final.some(event => event.event === 'delegate-error'), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reports the exact phase when Docker execution is unavailable', async () => {
    assert.deepEqual(await probeDockerSupport(null), {
      supported: false,
      phase: 'docker-cli',
      limitation: 'Docker CLI was not available.',
    });
    assert.deepEqual(await probeDockerSupport('/usr/bin/docker', async () => ({ code: 1 })), {
      supported: false,
      phase: 'docker-daemon-inspection',
      limitation: 'Docker CLI was available, but the daemon was not reachable by the current user.',
    });
    assert.deepEqual(await probeDockerSupport('/usr/bin/docker', async () => ({ code: 0 })), { supported: true });
  });

  it('rejects malformed or expanded Docker evidence records', () => {
    assert.throws(() => parseDockerEvents('{"schemaVersion":1}\n'), /malformed/);
    assert.throws(() => parseDockerEvents(`${JSON.stringify({
      schemaVersion: 1, event: 'invoked', operation: 'pull', pid: 42, ppid: 1, time: 1, secret: 'no',
    })}\n`), /malformed/);
  });

  it('bounds interrupted-relaunch diagnostics to final conditions and operation metadata', () => {
    const secretSentinel = 'token=secret-SENTINEL';
    const diagnostics = createInterruptedRelaunchDiagnostics({
      interrupted: { phase: 'failed', error: secretSentinel },
      events: [
        ...Array.from({ length: 12 }, (_, index) => ({
          schemaVersion: 1, event: 'invoked', operation: 'info', pid: 20 + index, ppid: 1, time: index + 1,
        })),
        { schemaVersion: 1, event: 'invoked', operation: 'info', pid: 40, ppid: 1, time: 1 },
        { schemaVersion: 1, event: 'invoked', operation: 'pull', pid: 41, ppid: 1, time: 2 },
        { schemaVersion: 1, event: 'invoked', operation: 'rejected', pid: 42, ppid: 1, time: 3 },
        { schemaVersion: 1, event: 'rejected', operation: 'rejected', pid: 42, ppid: 1, time: 4 },
      ],
    });
    assert.deepEqual(diagnostics.failedConditions, [
      'interrupted-phase', 'recovery-message', 'pull-count', 'rejected-command',
    ]);
    assert.equal(diagnostics.finalConditions.recoveryMessagePresent, true);
    assert.equal(diagnostics.finalConditions.recoveryMessageMatches, false);
    assert.equal(diagnostics.finalConditions.recoveryMessageBytes, Buffer.byteLength(secretSentinel));
    assert.match(diagnostics.finalConditions.recoveryMessageSha256, /^[a-f0-9]{64}$/);
    assert.equal(diagnostics.finalConditions.pullInvocations, 1);
    assert.equal(diagnostics.finalConditions.rejectedCommands, 1);
    assert.deepEqual(diagnostics.recentOperationEvents.at(-1), {
      event: 'rejected', operation: 'rejected',
    });
    assert.equal(diagnostics.totalOperationEvents, 16);
    assert.equal(diagnostics.recentOperationEvents.length, 12);
    assert.equal(JSON.stringify(diagnostics).includes('pid'), false);
    assert.equal(JSON.stringify(diagnostics).includes(secretSentinel), false);

    assert.deepEqual(createInterruptedRelaunchDiagnostics({
      interrupted: {
        phase: 'interrupted',
        error: 'Setup was interrupted. Review the saved choices to continue.',
      },
      events: [
        { event: 'invoked', operation: 'pull' },
        { event: 'invoked', operation: 'pull' },
      ],
    }).failedConditions, []);
  });
});


test('Mac acceptance permits only local endpoint handoff and the required platform inspection forms', () => {
  assert.equal(dockerOperation(['manifest', 'inspect', '--verbose', 'propr/app:test']), 'manifest-inspect');
  assert.equal(dockerOperation(['image', 'inspect', '--format', '{"Os":{{json .Os}},"Architecture":{{json .Architecture}}}', 'propr/app:test']), 'image-inspect');
  assert.equal(dockerOperation(['pull', '--platform', 'linux/amd64', 'propr/agent:test']), 'pull');
  assert.equal(dockerOperation(['pull', '--platform', 'windows/amd64', 'propr/agent:test']), 'rejected');
});


test('macOS retains GUI HOME while Linux retains disposable HOME and session allowlist', () => {
  const profile = Object.fromEntries(['root', 'home', 'temporary', 'xdgCache', 'xdgConfig', 'xdgData', 'xdgRuntime']
    .map(key => [key, `/tmp/private/${key}`]));
  const options = {
    baseEnvironment: { HOME: '/Users/tester', USER: 'tester', LOGNAME: 'tester', PATH: '/usr/bin:/bin',
      DISPLAY: ':99', DBUS_SESSION_BUS_ADDRESS: 'test', __CF_USER_TEXT_ENCODING: '0:0:0',
      NODE_OPTIONS: 'unsafe', ELECTRON_RUN_AS_NODE: '1', GH_TOKEN: 'secret', OPENAI_API_KEY: 'secret',
      PROPR_SKIP_REMOTE_IMAGE_CHECK: '1', DOCKER_CONFIG: '/Users/tester/.docker', HOST_CODEX_DIR: '/Users/tester/.codex' },
    profile, wrapperDirectory: '/tmp/private/wrapper', isolation: createLinuxSetupIsolation(), ports: [40001, 40002, 40003],
    localDockerEndpoint: 'unix:///Users/tester/.docker/run/docker.sock',
  };
  const mac = createIsolatedSetupEnvironment({ ...options, platform: 'darwin' });
  const linux = createIsolatedSetupEnvironment({ ...options, platform: 'linux' });
  assert.equal(mac.PROPR_SKIP_REMOTE_IMAGE_CHECK, undefined);
  assert.equal(linux.PROPR_SKIP_REMOTE_IMAGE_CHECK, '1');
  assert.equal(mac.HOME, '/Users/tester');
  assert.equal(linux.HOME, profile.home);
  assert.equal(mac.USER, 'tester');
  assert.equal(mac.DISPLAY, undefined);
  assert.equal(linux.DISPLAY, ':99');
  assert.equal(mac.DOCKER_CONFIG, '/tmp/private/home/.docker');
  assert.equal(mac.PATH, '/tmp/private/wrapper:/usr/bin:/bin');
  assert.equal(mac.DOCKER_HOST, options.localDockerEndpoint);
  assert.equal(mac.XDG_CONFIG_HOME, profile.xdgConfig);
  for (const [key, value] of Object.entries(isolatedAgentPaths(profile))) {
    assert.equal(mac[key], value);
    assert.ok(value.startsWith(profile.home + '/'));
  }
  for (const key of ['GH_TOKEN', 'OPENAI_API_KEY', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE']) assert.equal(mac[key], undefined);
  assert.throws(() => createIsolatedSetupEnvironment({ ...options, platform: 'darwin', baseEnvironment: { HOME: 'relative' } }), /GUI user HOME/);
  assert.throws(() => createIsolatedSetupEnvironment({ ...options, platform: 'darwin', localDockerEndpoint: 'tcp://remote' }), /local Docker/);
});

test('macOS session preflight rejects SSH, non-GUI, root and noninteractive launches', () => {
  const session = { environment: {}, uid: 501, consoleUid: 501, managerName: 'Aqua\n', interactive: true };
  assert.doesNotThrow(() => assertMacGuiSession(session));
  for (const override of [ { environment: { SSH_CONNECTION: 'test' } }, { environment: { SSH_TTY: 'test' } },
    { accountHome: '/Users/actual' }, { uid: 0 }, { consoleUid: 502 }, { managerName: 'Background' }, { interactive: false } ]) {
    assert.throws(() => assertMacGuiSession({ ...session, ...override }), /GUI session/);
  }
});

test('human startup review remains unverified and resumable until explicit input', async () => {
  let report;
  let resume;
  let closed = false;
  let completed = false;
  const review = awaitMacStartupReview({ outputPath: 'unused', sourceSha: 'a'.repeat(40), userData: '/tmp/private/data',
    reportWriter: async (_, value) => { report = value; },
    terminalFactory: () => Object.assign(new EventEmitter(), { question: async message => {
      assert.match(message, /human approval is required/);
      assert.match(message, /Never reset a Keychain/);
      await new Promise(resolve => { resume = resolve; });
    }, close: () => { closed = true; } }),
  }).then(() => { completed = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(report.result, 'unverified');
  assert.equal(report.unverifiedPhase, 'native-startup-human-review');
  assert.match(report.resume, /running GUI Terminal/);
  assert.equal(completed, false);
  resume();
  await review;
  assert.equal(closed, true);
  assert.equal(report.result, 'unverified'); // Enter is never evidence of success.
});


test('startup review abort rejects instead of approving or completing the gate', async () => {
  let signal;
  let closed = false;
  const review = awaitMacStartupReview({ outputPath: 'unused', sourceSha: 'a'.repeat(40), userData: '/tmp/private/data',
    reportWriter: async () => {},
    terminalFactory: () => Object.assign(new EventEmitter(), { question: (_, options) => {
      signal = options.signal;
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    }, close: () => { closed = true; } }),
  });
  const rejected = assert.rejects(review, /aborted/);
  await new Promise(resolve => setImmediate(resolve));
  process.emit('SIGTERM');
  await rejected;
  assert.equal(signal.aborted, true);
  assert.equal(closed, true);
});


for (const action of ['ctrl-c', 'close', 'enter']) {
  test(`real terminal startup review settles on ${action}`, { timeout: 2000 }, async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    input.isTTY = output.isTTY = true;
    input.setRawMode = () => input;
    let terminal;
    const review = awaitMacStartupReview({
      outputPath: 'unused', sourceSha: 'a'.repeat(40), userData: '/tmp/private/data',
      reportWriter: async () => {},
      terminalFactory: () => (terminal = createInterface({ input, output, terminal: true })),
    });
    const outcome = action === 'enter' ? review : assert.rejects(review, { name: 'AbortError' });
    await new Promise(resolve => setImmediate(resolve));
    if (action === 'close') terminal.close();
    else input.write(action === 'ctrl-c' ? '\x03' : '\n');
    await outcome;
    assert.equal(terminal.listenerCount('SIGINT'), 0);
    input.destroy();
    output.destroy();
  });
}

test('prelaunch Docker failures remove the allocated profile and replace stale reports', { skip: process.platform !== 'linux' || process.arch !== 'x64' }, async () => {
  const { createPrivateSmokeProfile } = await import('./packaged-smoke-support.mjs');
  const { runPackagedLinuxSetupLifecycle, lifecycleFailureCategory } = await import('./packaged-linux-setup-lifecycle.mjs');
  const { access } = await import('node:fs/promises');
  const directory = await mkdtemp(join(tmpdir(), 'propr-prelaunch-failure-'));
  try {
    for (const script of ['#!/missing-fixture-interpreter\n', '#!/bin/sh\n[ "$1" = info ] && exit 0\nexit 1\n']) {
      const docker = join(directory, 'docker');
      await writeFile(docker, script, { mode: 0o700 });
      const output = join(directory, 'report.json');
      await writeFile(output, '{"result":"passed"}');
      let profile;
      await assert.rejects(runPackagedLinuxSetupLifecycle({
        binaryPath: process.execPath,
        environment: {
          PATH: directory,
          PROPR_DESKTOP_REAL_LINUX_SETUP_ACCEPTANCE: '1',
          PROPR_DESKTOP_SETUP_ACCEPTANCE_SOURCE_SHA: 'a'.repeat(40),
          PROPR_DESKTOP_SETUP_ACCEPTANCE_OUTPUT: output,
        },
        createProfile: async () => (profile = await createPrivateSmokeProfile(directory)),
      }));
      assert.ok(profile);
      await assert.rejects(access(profile.root));
      const report = JSON.parse(await readFile(output, 'utf8'));
      assert.equal(report.result, 'failed');
      assert.equal(report.unverifiedPhase, 'docker-prerequisites');
      assert.equal(report.cleanup.temporaryRootRemoved, true);
      assert.ok(['docker-command', 'lifecycle-assertion'].includes(report.failureCategory));
    }
    assert.equal(lifecycleFailureCategory(new Error('timeout token=private-value /private/user')), 'timeout');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

for (const platform of ['linux', 'darwin']) {
  test(`${platform} retry evidence requires exactly one new host check and execution`, () => {
    const event = operation => ({ event: 'invoked', operation });
    const host = dockerOperation(['info', '--format', '{{.OSType}}']);
    const arch = dockerOperation(['info', '--format', '{{.Architecture}}']);
    assert.equal(host, 'daemon-host-inspection');
    assert.equal(arch, 'architecture-inspection');
    const run = [event(host), ...(platform === 'darwin' ? [event(arch)] : []), event('pull')];
    assert.equal(hasFreshRetryExecution(run, [...run, ...run]), true);
    assert.equal(daemonHostInspectionCount([...run, ...run]), 2);
    for (const retry of [
      [event(arch), event('pull')], // extra info is not a host inspection
      [event('info'), event('pull')],
      [event(host), ...run], // duplicated host check
      [event(host)], // no fresh execution
      [...run, event('pull')], // duplicated execution
      [event('pull'), event(host)], // inspection must precede execution
    ]) assert.equal(hasFreshRetryExecution(run, [...run, ...retry]), false);
    assert.equal(hasFreshRetryExecution([event('pull')], [event('pull'), ...run]), false);
    assert.equal(hasFreshRetryExecution([event(host), ...run], [event(host), ...run, ...run]), false);
  });
}
