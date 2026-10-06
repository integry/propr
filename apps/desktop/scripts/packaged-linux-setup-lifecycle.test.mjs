import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  createIsolatedSetupEnvironment,
  createLinuxSetupIsolation,
  createInterruptedRelaunchDiagnostics,
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
      const admittedBeforePull = 5 + rejectedDockerCommands.length * 2;
      const events = await waitForEventCount(eventsPath, admittedBeforePull + 1);
      assert.equal(events.at(-1).operation, 'pull');
      held.kill('SIGTERM');
      assert.deepEqual(await once(held, 'close'), [143, null]);
      const final = await waitForEventCount(eventsPath, admittedBeforePull + 2);
      assert.equal(final.at(-1).event, 'sigterm');
      assert.deepEqual(final.filter(event => event.event === 'invoked').map(event => event.operation), [
        'version', 'image-inspect', 'image-inspect', 'image-inspect', 'image-inspect',
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
