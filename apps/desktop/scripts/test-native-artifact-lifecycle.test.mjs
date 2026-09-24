import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { inspect } from 'node:util';
import {
  assertArtifactSet,
  assertSafeExtractedTree,
  classifyFirstEvidenceFailure,
  classifyWarmOpenEvidenceFailure,
  closeProfileApi,
  createNativeLaunchContext,
  DmgMountAuthority,
  extractDmg,
  extractRpm,
  inspectRunningProcessGroupMembers,
  LaunchServicesAbsenceFailure,
  LaunchServicesAuthority,
  LAUNCH_SERVICES_STALE_REGISTRATION,
  launchServicesRecordMatchesApplication,
  linuxProtocolDispatch,
  NativeLifecycleCommandFailure,
  NativeLifecycleEvidenceWaitFailure,
  NativeLifecycleFailure,
  NativeLifecycleOperationFailure,
  OwnedProcessGroups,
  parseArguments,
  removeCopiedApplicationWithLaunchServicesAuthority,
  removeLifecycleRootsWithAuthority,
  removeAuthorizedProfile,
  runningProcessGroupMembersFromPs,
  runNativeLifecycleCommand,
  scanCommandLinesForMatch,
  waitForEvents,
  waitForWarmOpenEvidence,
  withDeadline,
} from './test-native-artifact-lifecycle.mjs';

describe('native staged artifact lifecycle authority', () => {
  test('classifies command failures without exposing command arguments or output', async () => {
    const secret = 'https://secret.invalid/private-profile';
    const cases = [
      [process.execPath, ['-e', `console.error(${JSON.stringify(secret)}); process.exit(7)`], {}, 'COMMAND_FAILED'],
      [`/missing/${secret}`, [], {}, 'COMMAND_SPAWN_FAILED'],
      [process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeout: 100 }, 'COMMAND_DEADLINE'],
      ...(process.platform === 'win32' ? [] : [
        [process.execPath, ['-e', "process.kill(process.pid, 'SIGTERM')"], {}, 'COMMAND_SIGNALLED'],
      ]),
    ];
    for (const [file, args, options, expected] of cases) {
      await assert.rejects(runNativeLifecycleCommand(file, args, options), error => {
        assert.ok(error instanceof NativeLifecycleCommandFailure);
        assert.equal(error.resultClass, expected);
        const failure = new NativeLifecycleOperationFailure('PROTOCOL_LAUNCH', error);
        assert.equal(failure.resultClass, expected);
        assert.match(failure.message, new RegExp(expected));
        const combined = new NativeLifecycleFailure(failure, [{ label: 'profile-api', error: new Error(secret) }]);
        assert.match(combined.message, new RegExp(expected));
        assert.doesNotMatch(inspect(error) + inspect(failure) + inspect(combined), /secret\.invalid/);
        return true;
      });
    }
    assert.throws(() => new NativeLifecycleCommandFailure(secret), /result class is invalid/);
    const success = await runNativeLifecycleCommand(process.execPath, ['-e', "process.stdout.write('ready')"]);
    assert.equal(success.stdout.toString(), 'ready');
  });

  test('identifies each Linux protocol failure and still requires the registered handler and GIO dispatch', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'propr-native-protocol-'));
    const source = join(directory, 'source.desktop');
    const parameters = {
      application: { desktopFile: source, executable: join(directory, 'propr-desktop') },
      profile: { xdgData: join(directory, 'data'), userData: join(directory, 'profile') },
      link: 'propr://connect?api=https%3A%2F%2Fsecret.invalid',
      env: { PRIVATE: 'secret.invalid' },
    };
    const stages = ['PROTOCOL_DATABASE', 'PROTOCOL_REGISTER', 'PROTOCOL_QUERY', 'PROTOCOL_LAUNCH'];
    try {
      await writeFile(source, '[Desktop Entry]\nName=ProPR Desktop\nExec=propr-desktop %U\nType=Application\n');
      for (const [failedIndex, stage] of stages.entries()) {
        let calls = 0;
        await assert.rejects(linuxProtocolDispatch(parameters, {
          runCommand: async () => {
            if (calls++ === failedIndex) throw new NativeLifecycleCommandFailure('COMMAND_FAILED');
            return { stdout: Buffer.from('propr-desktop.desktop\n') };
          },
        }), error => {
          assert.equal(error.stage, stage);
          assert.equal(error.resultClass, 'COMMAND_FAILED');
          assert.doesNotMatch(inspect(error), /secret\.invalid/);
          return true;
        });
        assert.equal(calls, failedIndex + 1);
      }
      const calls = [];
      await assert.rejects(linuxProtocolDispatch(parameters, {
        runCommand: async (file, args) => {
          calls.push(file);
          return { stdout: Buffer.from(args[0] === 'query' ? 'secret.invalid.desktop' : '') };
        },
      }), error => {
        assert.equal(error.stage, 'PROTOCOL_QUERY');
        assert.equal(error.resultClass, 'UNEXPECTED_OUTPUT');
        assert.doesNotMatch(inspect(error), /secret\.invalid/);
        return true;
      });
      assert.equal(calls.length, 3);
      calls.length = 0;
      assert.match(await linuxProtocolDispatch(parameters, {
        runCommand: async (file, args) => {
          calls.push([file, args]);
          return { stdout: Buffer.from('propr-desktop.desktop\n') };
        },
      }), /xdg-mime-registration\+gio-dispatch/);
      assert.equal(calls.length, 4);
      assert.deepEqual(calls.at(-1), ['/usr/bin/gio', ['open', parameters.link]]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('signs only copied Darwin apps with the shared disposable identity and verifies stability', async () => {
    const source = await readFile(new URL('./test-native-artifact-lifecycle.mjs', import.meta.url), 'utf8');
    assert.match(source, /signDarwinPackagedConnectApplication/);
    assert.match(source, /verifyDarwinPackagedConnectSignature/);
    assert.match(source, /mode: 'establish'[\s\S]*mode: 'stable'/u);
    assert.match(source, /PROPR_DESKTOP_NATIVE_SIGNING_KEYCHAIN/);
    assert.match(source, /beforeDigest[\s\S]*digest\(artifact\) !== beforeDigest/u);
    assert.match(source, /verifyPackagedLinuxIcon/);
    assert.match(source, /verifyLinuxLauncherIcon/);
    assert.match(source, /verifyMacApplicationIcon/);
    assert.doesNotMatch(source, /add-trusted-cert|remove-trusted-cert|xattr|spctl/u);
  });

  test('accepts only the exact four native target coordinates', () => {
    assert.deepEqual(parseArguments([
      '--version', '1.2.3',
      '--platform', 'linux',
      '--arch', 'arm64',
      '--artifact-directory', 'artifacts',
    ]), {
      version: '1.2.3',
      platform: 'linux',
      arch: 'arm64',
      artifactDirectory: join(process.cwd(), 'artifacts'),
    });
    for (const args of [
      ['--version', '1.2.3', '--platform', 'win32', '--arch', 'x64', '--artifact-directory', 'artifacts'],
      ['--version', '1.2.3', '--platform', 'darwin', '--arch', 'ia32', '--artifact-directory', 'artifacts'],
      ['--version', '1.2.3-beta', '--platform', 'darwin', '--arch', 'arm64', '--artifact-directory', 'artifacts'],
      ['--version', '1.2.3', '--version', '1.2.4', '--platform', 'linux', '--arch', 'x64'],
    ]) assert.throws(() => parseArguments(args), /invalid|missing|duplicated|malformed/);
  });

  test('binds Linux launches to one validated libsecret session without disabling the sandbox', () => {
    const baseEnvironment = Object.freeze({
      HOME: '/private/profile/home',
      PROPR_DESKTOP_SMOKE_TEST: '1',
    });
    const sessionAddress = 'unix:path=/run/user/1000/bus,guid=0123456789abcdef0123456789abcdef';
    const linux = createNativeLaunchContext({
      platform: 'linux',
      baseEnvironment,
      sessionAddress,
    });
    assert.deepEqual(linux, {
      environment: { ...baseEnvironment, DBUS_SESSION_BUS_ADDRESS: sessionAddress },
      arguments: ['--disable-gpu', '--password-store=gnome-libsecret'],
    });
    assert.throws(() => createNativeLaunchContext({
      platform: 'linux',
      baseEnvironment,
      sessionAddress: 'tcp:host=attacker.invalid',
    }), /validated D-Bus session/);
    assert.deepEqual(createNativeLaunchContext({
      platform: 'darwin',
      baseEnvironment,
      sessionAddress: undefined,
    }), { environment: baseEnvironment, arguments: [] });
  });

  test('fails closed for a missing kind, foreign file, or symlinked canonical artifact', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'propr-native-artifact-set-'));
    const target = { platform: 'linux', arch: 'x64', version: '1.2.3', artifactDirectory: directory };
    const names = ['deb', 'rpm', 'zip'].map(kind => `ProPR-Desktop-1.2.3-linux-x64.${kind}`);
    try {
      await Promise.all(names.map(name => writeFile(join(directory, name), name)));
      assert.deepEqual(await assertArtifactSet(target), ['deb', 'rpm', 'zip']);
      await writeFile(join(directory, 'foreign.zip'), 'foreign');
      await assert.rejects(assertArtifactSet(target), /unexpected or duplicate identity/);
      await rm(join(directory, 'foreign.zip'));
      await rm(join(directory, names[0]));
      await assert.rejects(assertArtifactSet(target), /canonical staged deb/);
      await symlink(join(directory, names[1]), join(directory, names[0]));
      await assert.rejects(assertArtifactSet(target), /canonical staged deb/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('cleans a live detached process group after evidence timeout', { skip: process.platform === 'win32' }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'propr-native-process-'));
    const groups = new OwnedProcessGroups();
    const child = spawn(process.execPath, ['-e', `
      const { spawn } = require('node:child_process');
      const child = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
      process.on('SIGTERM', () => child.once('close', () => process.exit(0)));
      setInterval(() => undefined, 1000);
    `], {
      detached: true,
      shell: false,
      stdio: 'ignore',
    });
    groups.track(child);
    try {
      await assert.rejects(
        waitForEvents(join(directory, 'missing.jsonl'), ['never'], child, 60),
        /evidence deadline/,
      );
      assert.doesNotThrow(() => process.kill(-child.pid, 0));
      assert.deepEqual(await groups.cleanup(), []);
      assert.throws(() => process.kill(-child.pid, 0), error => error?.code === 'ESRCH');
    } finally {
      await groups.cleanup();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('reads fixed evidence before classifying a clean child exit', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'propr-native-exited-evidence-'));
    const complete = join(directory, 'complete.jsonl');
    const incomplete = join(directory, 'incomplete.jsonl');
    const exitedChild = { exitCode: 0, signalCode: null };
    try {
      await writeFile(complete, [
        JSON.stringify({ event: 'first' }),
        JSON.stringify({ event: 'second' }),
      ].join('\n'));
      await writeFile(incomplete, `${JSON.stringify({ event: 'first' })}\n`);

      await assert.doesNotReject(waitForEvents(complete, ['first', 'second'], exitedChild, 10));
      await assert.rejects(waitForEvents(incomplete, ['first', 'second'], exitedChild, 10), error => (
        error instanceof NativeLifecycleEvidenceWaitFailure
        && error.resultClass === 'CLEAN_EXIT'
      ));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('allows a successful parent a bounded natural same-group descendant drain', {
    skip: process.platform === 'win32',
  }, async () => {
    const groups = new OwnedProcessGroups();
    const child = spawn(process.execPath, ['-e', `
      const { spawn } = require('node:child_process');
      spawn('/bin/sleep', ['0.15'], { stdio: 'ignore' }).unref();
    `], { detached: true, shell: false, stdio: 'ignore' });
    const group = groups.track(child);
    try {
      const started = Date.now();
      await group.waitForSuccessfulExit(3_000);
      assert.ok(Date.now() - started >= 100, 'owned group was released before its descendant drained');
      assert.deepEqual(await inspectRunningProcessGroupMembers(child.pid), []);
    } finally {
      await groups.cleanup();
    }
  });

  test('kills and proves absence for a genuinely lingering successful-parent descendant', {
    skip: process.platform === 'win32',
  }, async () => {
    const groups = new OwnedProcessGroups();
    const child = spawn(process.execPath, ['-e', `
      const { spawn } = require('node:child_process');
      spawn('/bin/sleep', ['30'], { stdio: 'ignore' }).unref();
    `], { detached: true, shell: false, stdio: 'ignore' });
    const group = groups.track(child);
    try {
      await assert.rejects(group.waitForSuccessfulExit(3_000), /owned process group drained/);
      assert.deepEqual(await inspectRunningProcessGroupMembers(child.pid), []);
      assert.deepEqual(await groups.cleanup(), []);
    } finally {
      await groups.cleanup();
    }
  });

  test('treats zombie-only process-group records as non-running without hiding live members', () => {
    const records = Buffer.from([
      ' 410  410 Z',
      ' 411  410 Z+',
      ' 412  410 S',
      ' 510  510 R+',
    ].join('\n'));
    assert.deepEqual(runningProcessGroupMembersFromPs(records, 410), [412]);
    assert.deepEqual(runningProcessGroupMembersFromPs(Buffer.from(' 410  410 Z\n'), 410), []);
    assert.throws(
      () => runningProcessGroupMembersFromPs(Buffer.from('secret-capable malformed output\n'), 410),
      /invalid record/,
    );
  });

  for (const failurePoint of ['scan', 'copy']) {
    test(`detaches and verifies a DMG when ${failurePoint} fails after attach`, async () => {
      const calls = [];
      const runCommand = async (file, args) => {
        calls.push([file, ...args]);
        if (args[0] === 'info') return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
        if (failurePoint === 'copy' && file.endsWith('/ditto')) throw new Error('injected copy failure');
        return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      };
      const authority = new DmgMountAuthority('/private/mount', { runCommand });
      await assert.rejects(extractDmg({
        artifact: '/private/artifact.dmg',
        installRoot: '/private/install',
        mountAuthority: authority,
        readDirectory: failurePoint === 'scan'
          ? async () => { throw new Error('injected scan failure'); }
          : async () => [{ name: 'ProPR.app', isDirectory: () => true }],
        runCommand,
      }), new RegExp(`injected ${failurePoint} failure`));
      assert.equal(authority.mounted, false);
      assert.deepEqual(calls.map(call => call[1]), [
        'attach',
        ...(failurePoint === 'copy' ? ['/private/mount/ProPR.app'] : []),
        'detach',
        'info',
      ]);
    });
  }

  test('detaches and proves absence when attach fails after mounting the exact DMG root', async () => {
    const calls = [];
    let infoCalls = 0;
    const runCommand = async (file, args) => {
      calls.push([file, ...args]);
      if (args[0] === 'attach') throw new Error('injected partial attach failure');
      if (args[0] === 'info') {
        infoCalls += 1;
        return {
          stdout: Buffer.from(infoCalls === 1 ? '/dev/disk9 /private/mount\n' : ''),
          stderr: Buffer.alloc(0),
        };
      }
      return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    };
    const authority = new DmgMountAuthority('/private/mount', { runCommand });

    await assert.rejects(extractDmg({
      artifact: '/private/artifact.dmg',
      installRoot: '/private/install',
      mountAuthority: authority,
      readDirectory: async () => { throw new Error('scan must not run'); },
      runCommand,
    }), /injected partial attach failure/);

    assert.equal(authority.mounted, false);
    assert.deepEqual(calls.map(call => call[1]), ['attach', 'info', 'detach', 'info']);
  });

  test('retains DMG authority and fails when detach cannot prove the mount absent', async () => {
    const authority = new DmgMountAuthority('/private/mount', {
      runCommand: async (_file, args) => ({
        stdout: Buffer.from(args[0] === 'info' ? '/dev/disk9 /private/mount\n' : ''),
        stderr: Buffer.alloc(0),
      }),
    });
    authority.mounted = true;
    await assert.rejects(authority.detach(), /dmg-mounted-postcondition/);
    assert.equal(authority.mounted, true);
  });

  test('preserves a DMG primary failure without exposing it through cleanup diagnostics', async () => {
    const privateFailure = new Error('scan failed at /private/profile with https://secret.invalid/token');
    const authority = new DmgMountAuthority('/private/mount', {
      runCommand: async (_file, args) => ({
        stdout: Buffer.from(args[0] === 'info' ? '/dev/disk9 /private/mount\n' : ''),
        stderr: Buffer.alloc(0),
      }),
    });
    await assert.rejects(extractDmg({
      artifact: '/private/artifact.dmg',
      installRoot: '/private/install',
      mountAuthority: authority,
      readDirectory: async () => { throw privateFailure; },
    }), error => {
      assert.ok(error instanceof NativeLifecycleFailure);
      assert.equal(error.primaryError, privateFailure);
      assert.match(error.message, /dmg-mount/);
      assert.doesNotMatch(String(error), /private\/profile|secret\.invalid/);
      assert.doesNotMatch(JSON.stringify(error), /private\/profile|secret\.invalid/);
      assert.doesNotMatch(inspect(error), /private\/profile|secret\.invalid/);
      return true;
    });
    assert.equal(authority.mounted, true);
  });

  test('classifies first-evidence exits by fixed non-secret milestone and result class', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'propr-native-stage-'));
    const evidence = join(directory, 'evidence.jsonl');
    const privateFailure = new Error('failed at /private/profile with https://secret.invalid/token');
    try {
      const cases = [
        { event: null, milestone: 'NO_EVIDENCE', stage: 'FIRST_INITIAL_EVIDENCE' },
        { event: 'desktop.smoke.authorized', milestone: 'AUTHORIZED', stage: 'FIRST_INITIAL_EVIDENCE' },
        { event: 'desktop.native.identity_verified', milestone: 'IDENTITY', stage: 'FIRST_INITIAL_EVIDENCE' },
        {
          event: 'desktop.deeplink.consumer_ready',
          milestone: 'CONSUMER_READY',
          stage: 'FIRST_INITIAL_EVIDENCE',
        },
        {
          event: 'desktop.native.secure_storage_backend_invalid',
          milestone: 'SECURE_STORAGE_BACKEND',
          stage: 'FIRST_INITIAL_EVIDENCE',
        },
        {
          event: 'desktop.deeplink.delivery_failed',
          milestone: 'DEEP_LINK_DELIVERY_FAILURE',
          stage: 'FIRST_INITIAL_EVIDENCE',
          failureCategory: 'DEEP_LINK_DELIVERY_FAILED',
        },
        { event: 'desktop.deeplink.cold_manual_once', milestone: 'COLD_ACK', stage: 'FIRST_INITIAL_EVIDENCE' },
        {
          event: 'desktop.native.secure_storage_probe.started',
          milestone: 'SECURE_STORAGE_STARTED',
          stage: 'FIRST_SECURE_STORAGE_PROBE',
        },
        {
          event: 'desktop.native.secure_storage_probe.completed',
          milestone: 'SECURE_STORAGE_COMPLETED',
          stage: 'FIRST_RENDERER_READY',
        },
        { event: 'desktop.renderer.ready', milestone: 'RENDERER', stage: 'FIRST_RENDERER_READY' },
      ];
      for (const fixture of cases) {
        await writeFile(evidence, fixture.event ? `${JSON.stringify({ event: fixture.event })}\n` : '');
        assert.deepEqual(await classifyFirstEvidenceFailure(evidence, 'FAILED_EXIT'), {
          milestone: fixture.milestone,
          resultClass: 'FAILED_EXIT',
          stage: fixture.stage,
          ...(fixture.failureCategory ? { failureCategory: fixture.failureCategory } : {}),
        });
      }

      const categories = [
        { event: 'desktop.app.start_failed', failureCategory: 'START_FAILED' },
        { event: 'desktop.main_process.uncaught_exception', failureCategory: 'UNCAUGHT_EXCEPTION' },
        {
          event: 'desktop.native.cold_confirmation_inspection_failed',
          failureCategory: 'COLD_CONFIRMATION_INSPECTION_FAILED',
        },
        {
          event: 'desktop.native.cold_confirmation_not_visible',
          failureCategory: 'COLD_CONFIRMATION_NOT_VISIBLE',
        },
        { event: 'desktop.renderer.gone', failureCategory: 'RENDERER_GONE' },
      ];
      for (const fixture of categories) {
        await writeFile(evidence, [
          JSON.stringify({ event: 'desktop.deeplink.cold_manual_once' }),
          JSON.stringify({ event: fixture.event }),
        ].join('\n'));
        assert.deepEqual(await classifyFirstEvidenceFailure(evidence, 'FAILED_EXIT'), {
          milestone: 'COLD_ACK',
          resultClass: 'FAILED_EXIT',
          stage: 'FIRST_INITIAL_EVIDENCE',
          failureCategory: fixture.failureCategory,
        });
      }

      await writeFile(evidence, [
        JSON.stringify({ event: 'desktop.deeplink.consumer_ready' }),
        JSON.stringify({ event: 'desktop.deeplink.delivery_failed' }),
        JSON.stringify({ event: 'desktop.app.start_failed' }),
        JSON.stringify({ event: 'desktop.native.cold_confirmation_inspection_failed' }),
      ].join('\n'));
      assert.deepEqual(await classifyFirstEvidenceFailure(evidence, 'FAILED_EXIT'), {
        milestone: 'DEEP_LINK_DELIVERY_FAILURE',
        resultClass: 'FAILED_EXIT',
        stage: 'FIRST_INITIAL_EVIDENCE',
        failureCategory: 'DEEP_LINK_DELIVERY_FAILED',
      });

      await writeFile(evidence, [
        JSON.stringify({ event: 'desktop.renderer.ready' }),
        JSON.stringify({ event: 'desktop.renderer.gone' }),
      ].join('\n'));
      const classification = await classifyFirstEvidenceFailure(evidence, 'FAILED_EXIT');
      const operationFailure = new NativeLifecycleOperationFailure(
        classification.stage,
        privateFailure,
        classification,
      );
      const aggregate = new NativeLifecycleFailure(operationFailure, [{
        label: 'process-groups',
        error: new Error('private cleanup output'),
      }]);
      assert.match(aggregate.message, /stage:FIRST_RENDERER_READY/);
      assert.match(aggregate.message, /milestone:RENDERER/);
      assert.match(aggregate.message, /result:FAILED_EXIT/);
      assert.match(aggregate.message, /category:RENDERER_GONE/);
      assert.doesNotMatch(String(aggregate), /private\/profile|secret\.invalid|private cleanup output/);
      assert.doesNotMatch(JSON.stringify(aggregate), /private\/profile|secret\.invalid|private cleanup output/);
      assert.doesNotMatch(inspect(aggregate), /private\/profile|secret\.invalid|private cleanup output/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('reports warm-open wait outcomes after tunnel acknowledgement and preserves them through cleanup', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'propr-native-warm-open-'));
    const evidence = join(directory, 'evidence.jsonl');
    const writeEvents = events => writeFile(evidence, events.map(event => JSON.stringify({ event })).join('\n'));
    const priorEvents = [
      'desktop.renderer.ready',
      'desktop.deeplink.warm_manual_once',
      'desktop.deeplink.warm_tunnel_once',
    ];
    try {
      for (const fixture of [
        { exitCode: null, signalCode: null, result: 'EVIDENCE_DEADLINE' },
        { exitCode: 0, signalCode: null, result: 'CLEAN_EXIT' },
        { exitCode: 1, signalCode: null, result: 'FAILED_EXIT', event: 'desktop.deeplink.delivery_failed' },
        { exitCode: null, signalCode: 'SIGTERM', result: 'SIGNALLED', event: 'desktop.renderer.gone' },
      ]) {
        await writeEvents([...priorEvents, ...(fixture.event ? [fixture.event] : [])]);
        const error = await waitForWarmOpenEvidence(evidence, fixture, 10).catch(error => error);
        assert.ok(error instanceof NativeLifecycleOperationFailure);
        assert.equal(error.stage, 'WARM_OPEN_EVIDENCE');
        assert.equal(error.resultClass, fixture.result);
        assert.equal(error.milestone, 'WARM_TUNNEL_ACK');
        assert.equal(error.evidenceState, 'READABLE');
        assert.equal(error.failureCategory, fixture.event === 'desktop.deeplink.delivery_failed'
          ? 'DEEP_LINK_DELIVERY_FAILED' : fixture.event ? 'RENDERER_GONE' : undefined);
        // Cleanup removes the only private evidence; the fixed classification
        // must remain available even if cleanup itself subsequently fails.
        await rm(evidence);
        const aggregate = new NativeLifecycleFailure(error, [{
          label: 'process-groups', error: new Error('https://secret.invalid/private-cleanup'),
        }]);
        for (const rendered of [String(error), JSON.stringify(error), inspect(error), inspect(aggregate)]) {
          assert.match(rendered, /WARM_OPEN_EVIDENCE/);
          assert.match(rendered, /WARM_TUNNEL_ACK/);
          assert.ok(rendered.includes(fixture.result));
          assert.doesNotMatch(rendered, /secret\.invalid|private-cleanup/);
          assert.ok(!rendered.includes(directory));
        }
      }
      await writeEvents([...priorEvents, 'desktop.deeplink.warm_open_once']);
      await assert.doesNotReject(waitForWarmOpenEvidence(evidence, { exitCode: 0, signalCode: null }, 10));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('bounds warm-open diagnostic reads and emits only fixed classifications', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'propr-native-warm-diagnostics-'));
    const evidence = join(directory, 'evidence.jsonl');
    const secret = 'https://secret.invalid/token';
    try {
      const missing = await classifyWarmOpenEvidenceFailure(evidence, 'EVIDENCE_DEADLINE');
      assert.equal(missing.evidenceState, 'MISSING');
      for (const fixture of [
        { contents: JSON.stringify({ event: secret }), state: 'READABLE' },
        { contents: JSON.stringify({ event: 'desktop.deeplink.warm_open_once', url: secret }), state: 'MALFORMED' },
        { contents: `{"event":"${secret}`, state: 'MALFORMED' },
        { contents: 'null', state: 'MALFORMED' },
        { contents: '[]', state: 'MALFORMED' },
        { contents: ' '.repeat(64 * 1024 + 1), state: 'OVERSIZED' },
      ]) {
        await writeFile(evidence, fixture.contents);
        const classification = await classifyWarmOpenEvidenceFailure(evidence, 'FAILED_EXIT');
        assert.deepEqual(classification, {
          milestone: 'NO_EVIDENCE', resultClass: 'FAILED_EXIT', evidenceState: fixture.state,
        });
        const failure = new NativeLifecycleOperationFailure('WARM_OPEN_EVIDENCE', new Error(secret), classification);
        assert.doesNotMatch(inspect(failure), /secret\.invalid/);
      }
      for (const [event, milestone] of [
        ['desktop.renderer.ready', 'RENDERER'],
        ['desktop.deeplink.warm_manual_once', 'WARM_MANUAL_ACK'],
        ['desktop.deeplink.warm_tunnel_once', 'WARM_TUNNEL_ACK'],
        ['desktop.deeplink.warm_open_once', 'WARM_OPEN_ACK'],
        ['desktop.app.shutdown', 'SHUTDOWN'],
      ]) {
        await writeFile(evidence, JSON.stringify({ event }));
        assert.equal((await classifyWarmOpenEvidenceFailure(evidence, 'CLEAN_EXIT')).milestone, milestone);
      }
      await writeFile(evidence, JSON.stringify({ event: 'desktop.deeplink.warm_open_once', url: secret }));
      await assert.rejects(waitForWarmOpenEvidence(evidence, { exitCode: 0, signalCode: null }, 10), error => {
        assert.equal(error.resultClass, 'EVIDENCE_READ_FAILED');
        assert.equal(error.evidenceState, 'MALFORMED');
        assert.doesNotMatch(inspect(error), /secret\.invalid/);
        return true;
      });
      const linkedEvidence = join(directory, 'linked.jsonl');
      await symlink(evidence, linkedEvidence);
      assert.equal((await classifyWarmOpenEvidenceFailure(linkedEvidence, 'FAILED_EXIT')).evidenceState, 'UNREADABLE');
      assert.equal((await classifyWarmOpenEvidenceFailure(directory, 'FAILED_EXIT')).evidenceState, 'UNREADABLE');
      for (const field of ['milestone', 'resultClass', 'evidenceState', 'failureCategory']) {
        assert.throws(() => new NativeLifecycleOperationFailure('WARM_OPEN_EVIDENCE', new Error(secret), {
          ...missing, [field]: secret,
        }), /classification is invalid/);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('retains fixed wait outcomes for later lifecycle stages without exposing underlying errors', () => {
    for (const stage of ['WARM_MANUAL_EVIDENCE', 'PROTOCOL_EVIDENCE', 'MALFORMED_EVIDENCE', 'RELAUNCH_EVIDENCE']) {
      const cause = new NativeLifecycleEvidenceWaitFailure('FAILED_EXIT');
      cause.message = 'private launcher output';
      const failure = new NativeLifecycleOperationFailure(stage, cause);
      assert.equal(failure.resultClass, 'FAILED_EXIT');
      assert.match(failure.message, /result:FAILED_EXIT/);
      assert.doesNotMatch(inspect(failure), /private launcher output/);
    }
  });

  test('surfaces LaunchServices unregister failure and stale exact registration', async () => {
    const applicationRoot = '/private/copied/ProPR Desktop.app';
    const unregisterFailure = new LaunchServicesAuthority(applicationRoot, {}, {
      runCommand: async (_file, args) => {
        if (args[0] === '-u') throw new Error('injected unregister failure');
        return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      },
    });
    unregisterFailure.registered = true;
    await assert.rejects(unregisterFailure.unregister(), /injected unregister failure/);

    const staleWaits = [];
    const staleUnregisters = [];
    let staleDumps = 0;
    let staleClock = 0;
    const stale = new LaunchServicesAuthority(applicationRoot, {}, {
      runCommand: async (_file, args) => {
        staleUnregisters.push(args[0]);
        return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      },
      scanCommand: async (_file, args, _options, matchesLine) => {
        assert.deepEqual(args, ['-dump']);
        staleDumps += 1;
        return { matched: matchesLine(`\tpath: ${applicationRoot}`) };
      },
      wait: async milliseconds => {
        staleWaits.push(milliseconds);
        staleClock += milliseconds;
      },
      now: () => staleClock,
      absenceBudgetMs: 2_000,
    });
    stale.registered = true;
    const staleError = await stale.assertGone().then(() => null, error => error);
    assert.ok(staleError instanceof LaunchServicesAbsenceFailure);
    assert.match(staleError.message, /remained registered/);
    assert.equal(staleError.resultClass, LAUNCH_SERVICES_STALE_REGISTRATION);
    assert.equal(stale.registered, true);
    assert.equal(staleDumps, 3);
    assert.deepEqual(staleWaits, [1_000, 1_000]);
    // Each re-probe re-issues the removal, because opening the bundle lets the
    // system re-register it after the first unregister returns.
    assert.deepEqual(staleUnregisters, ['-u', '-u']);

    // The aggregate says whether the record persisted or the probe never
    // answered, without ever repeating an unclassified error's text.
    assert.match(
      new NativeLifecycleFailure(null, [{ label: 'launchservices-postcondition', error: staleError }]).message,
      /launchservices-postcondition \[result:STALE_REGISTRATION\]/,
    );
    assert.match(
      new NativeLifecycleFailure(null, [{
        label: 'launchservices-postcondition',
        error: new NativeLifecycleCommandFailure('COMMAND_DEADLINE'),
      }]).message,
      /launchservices-postcondition \[result:COMMAND_DEADLINE\]/,
    );
    const unclassified = new Error('https://secret.invalid/private-profile');
    unclassified.resultClass = 'https://secret.invalid/private-profile';
    const aggregate = new NativeLifecycleFailure(null, [{ label: 'launchservices-postcondition', error: unclassified }]);
    assert.equal(aggregate.message, 'Native lifecycle cleanup failed: launchservices-postcondition');
    assert.doesNotMatch(inspect(aggregate), /secret\.invalid/);
  });

  test('re-probes a lagging LaunchServices removal for the full bounded window', async () => {
    const applicationRoot = '/private/copied/ProPR Desktop.app';
    // Each -dump answer costs seconds on a loaded runner, so the window is a
    // deadline: a slow probe must not spend the budget the removal needs.
    let clock = 0;
    let dumps = 0;
    const authority = new LaunchServicesAuthority(applicationRoot, {}, {
      runCommand: async () => ({ stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }),
      scanCommand: async (_file, _args, _options, matchesLine) => {
        dumps += 1;
        clock += 9_000;
        return { matched: matchesLine(`\tpath: ${applicationRoot}`) };
      },
      wait: async milliseconds => { clock += milliseconds; },
      now: () => clock,
    });
    authority.registered = true;

    await assert.rejects(authority.assertGone(), error => error instanceof LaunchServicesAbsenceFailure);

    // A probe count of ten would have declared the record stale at ninety-nine
    // seconds, well inside the window the removal is allowed to take.
    assert.equal(dumps, 13);
    assert.ok(clock >= 120_000);
  });

  test('re-probes LaunchServices until a lagging unregister is reflected in the dump', async () => {
    const applicationRoot = '/private/copied/ProPR Desktop.app';
    const dumps = [
      `\tpath: ${applicationRoot}`,
      `\tpath: ${applicationRoot}`,
      '\tpath: /Applications/Other.app',
    ];
    const waits = [];
    let clock = 0;
    const authority = new LaunchServicesAuthority(applicationRoot, {}, {
      runCommand: async (_file, args) => {
        assert.deepEqual(args, ['-u', applicationRoot]);
        return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      },
      scanCommand: async (_file, args, _options, matchesLine) => {
        assert.deepEqual(args, ['-dump']);
        return { matched: matchesLine(dumps.shift()) };
      },
      wait: async milliseconds => {
        waits.push(milliseconds);
        clock += milliseconds;
      },
      now: () => clock,
      absenceBudgetMs: 2_000,
    });
    authority.registered = true;

    await authority.assertGone();

    assert.equal(authority.registered, false);
    assert.equal(dumps.length, 0);
    assert.deepEqual(waits, [1_000, 1_000]);
  });

  test('spends a bounded attempt on an unreadable dump instead of ending the absence proof', async () => {
    const applicationRoot = '/private/copied/ProPR Desktop.app';
    // One dump never answers, the next still lists the bundle, and only the
    // third proves it gone. A probe that could not run is not evidence, so it
    // must not be read as absence and must not abandon the proof either.
    const probes = [
      () => { throw new NativeLifecycleCommandFailure('COMMAND_DEADLINE'); },
      () => true,
      () => false,
    ];
    const waits = [];
    const unregisters = [];
    const authority = new LaunchServicesAuthority(applicationRoot, {}, {
      runCommand: async (_file, args) => {
        unregisters.push(args[0]);
        return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      },
      scanCommand: async () => ({ matched: probes.shift()() }),
      wait: async milliseconds => { waits.push(milliseconds); },
      absenceAttempts: 4,
    });
    authority.registered = true;

    await authority.assertGone();

    assert.equal(authority.registered, false);
    assert.equal(probes.length, 0);
    assert.deepEqual(waits, [1_000, 1_000]);
    assert.deepEqual(unregisters, ['-u', '-u']);
  });

  test('keeps probing when a re-issued unregister fails instead of ending the absence proof', async () => {
    const applicationRoot = '/private/copied/ProPR Desktop.app';
    // A re-issued -u that exits nonzero ended the postcondition on a darwin-x64
    // runner with a bare COMMAND_FAILED, long before the absence window closed.
    const probes = [true, true, false];
    const unregisters = [];
    const authority = new LaunchServicesAuthority(applicationRoot, {}, {
      runCommand: async (_file, args) => {
        unregisters.push(args[0]);
        throw new NativeLifecycleCommandFailure('COMMAND_FAILED');
      },
      scanCommand: async () => ({ matched: probes.shift() }),
      wait: async () => undefined,
      absenceAttempts: 4,
    });
    authority.registered = true;

    await authority.assertGone();

    assert.equal(authority.registered, false);
    assert.equal(probes.length, 0);
    assert.deepEqual(unregisters, ['-u', '-u']);

    // A record that never leaves is still reported stale, not as the -u failure.
    const stale = new LaunchServicesAuthority(applicationRoot, {}, {
      runCommand: async () => { throw new NativeLifecycleCommandFailure('COMMAND_FAILED'); },
      scanCommand: async () => ({ matched: true }),
      wait: async () => undefined,
      absenceAttempts: 3,
    });
    stale.registered = true;
    const staleError = await stale.assertGone().catch(error => error);
    assert.ok(staleError instanceof LaunchServicesAbsenceFailure);
    assert.equal(staleError.resultClass, LAUNCH_SERVICES_STALE_REGISTRATION);
    assert.equal(stale.registered, true);
  });

  test('reports why the absence proof ended and carries that class into cleanup reporting', async () => {
    const applicationRoot = '/private/copied/ProPR Desktop.app';
    const secret = 'https://secret.invalid/private-dump';
    const authorityFor = probe => {
      const authority = new LaunchServicesAuthority(applicationRoot, {}, {
        runCommand: async () => ({ stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }),
        scanCommand: async () => ({ matched: probe() }),
        wait: async () => undefined,
        absenceAttempts: 2,
      });
      authority.registered = true;
      return authority;
    };

    const stale = await authorityFor(() => true).assertGone().catch(error => error);
    assert.ok(stale instanceof LaunchServicesAbsenceFailure);
    assert.equal(stale.resultClass, LAUNCH_SERVICES_STALE_REGISTRATION);
    assert.match(stale.message, /remained registered/);

    const unreadable = await authorityFor(() => {
      throw new NativeLifecycleCommandFailure('COMMAND_DEADLINE');
    }).assertGone().catch(error => error);
    assert.ok(unreadable instanceof LaunchServicesAbsenceFailure);
    assert.equal(unreadable.resultClass, 'COMMAND_DEADLINE');
    assert.match(unreadable.message, /could not be probed/);

    // A cleanup label alone cannot tell these two apart in a CI log, so the
    // fixed class rides along — and nothing else does.
    for (const [failure, expected] of [[stale, 'STALE_REGISTRATION'], [unreadable, 'COMMAND_DEADLINE']]) {
      const aggregate = new NativeLifecycleFailure(null, [
        { label: 'launchservices-postcondition', error: failure },
      ]);
      assert.match(aggregate.message, new RegExp(`launchservices-postcondition \\[result:${expected}\\]`));
      assert.doesNotMatch(inspect(aggregate), new RegExp(secret));
      assert.ok(!inspect(aggregate).includes(applicationRoot));
    }

    // An unclassified cleanup error still reports as a bare label.
    assert.equal(
      new NativeLifecycleFailure(null, [{ label: 'install-root', error: new Error(secret) }]).message,
      'Native lifecycle cleanup failed: install-root',
    );
  });

  test('matches only the exact copied bundle path record in an lsregister dump', () => {
    const applicationRoot = '/private/copied/ProPR Desktop.app';
    for (const listed of [
      `path:                   ${applicationRoot}`,
      `\tpath: ${applicationRoot}`,
      `path: ${applicationRoot} (0x1234)`,
    ]) {
      assert.equal(launchServicesRecordMatchesApplication(listed, applicationRoot), true);
    }
    for (const absent of [
      `path: ${applicationRoot}.backup`,
      `path: ${applicationRoot}/Contents/Frameworks/Helper.app`,
      'path: /Applications/Other.app',
      // A claimed-scheme or binding cache line can echo the path long after the
      // bundle record is unregistered; it is not proof of registration.
      `claimed scheme propr -> ${applicationRoot}`,
      `bindings: ${applicationRoot}`,
      '',
    ]) {
      assert.equal(launchServicesRecordMatchesApplication(absent, applicationRoot), false);
    }
  });

  test('scans an unbounded dump in full without a truncation window deciding the answer', async () => {
    const applicationRoot = '/private/copied/ProPR Desktop.app';
    const filler = `${'x'.repeat(4_096)}\n`;
    const emit = (target, repeats) => [
      process.execPath,
      ['-e', `const filler=${JSON.stringify(filler)};`
        + `for(let i=0;i<${repeats};i+=1)process.stdout.write(filler);`
        + `process.stdout.write(${JSON.stringify(`\tpath: ${target}\n`)});`
        + `for(let i=0;i<${repeats};i+=1)process.stdout.write(filler);`],
    ];
    const matchesLine = line => launchServicesRecordMatchesApplication(line, applicationRoot);

    // The record sits far outside the trailing OUTPUT_CAP window that the shared
    // bounded runner would have retained, and is still found.
    assert.deepEqual(
      await scanCommandLinesForMatch(...emit(applicationRoot, 64), {}, matchesLine),
      { matched: true },
    );
    assert.deepEqual(
      await scanCommandLinesForMatch(...emit('/Applications/Other.app', 64), {}, matchesLine),
      { matched: false },
    );

    // The shared bounded runner cannot answer this probe: it reports overflow and
    // retains only a trailing window that no longer holds the bundle record.
    const bounded = await runNativeLifecycleCommand(...emit(applicationRoot, 64));
    assert.equal(bounded.stdoutOverflow, true);
    assert.equal(bounded.stdout.toString('utf8').split('\n').some(matchesLine), false);

    // A final record without a trailing newline is still scanned.
    assert.deepEqual(
      await scanCommandLinesForMatch(
        process.execPath,
        ['-e', `process.stdout.write(${JSON.stringify(`\tpath: ${applicationRoot}`)})`],
        {},
        matchesLine,
      ),
      { matched: true },
    );

    // Probe failures stay classified and never leak the scanned output.
    await assert.rejects(
      scanCommandLinesForMatch(process.execPath, ['-e', 'process.exit(7)'], {}, matchesLine),
      error => error instanceof NativeLifecycleCommandFailure && error.resultClass === 'COMMAND_FAILED',
    );
    await assert.rejects(
      scanCommandLinesForMatch('/missing/lsregister', [], {}, matchesLine),
      error => error instanceof NativeLifecycleCommandFailure && error.resultClass === 'COMMAND_SPAWN_FAILED',
    );
    await assert.rejects(
      scanCommandLinesForMatch(
        process.execPath,
        ['-e', 'setInterval(() => {}, 1000)'],
        { timeout: 100 },
        matchesLine,
      ),
      error => error instanceof NativeLifecycleCommandFailure && error.resultClass === 'COMMAND_DEADLINE',
    );
  });

  test('registers before dispatching through the exact copied macOS application path', async () => {
    const applicationRoot = '/private/copied/ProPR Desktop.app';
    const link = 'propr://connect?api=https%3A%2F%2Ft-native-evidence.propr.dev';
    const calls = [];
    const authority = new LaunchServicesAuthority(applicationRoot, { FIXED: 'environment' }, {
      runCommand: async (file, args, options) => {
        calls.push({ file, args, options });
        return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      },
    });

    await assert.rejects(authority.dispatch(link), /must be registered/);
    await authority.register();
    await authority.dispatch(link);

    assert.equal(calls[0].args[0], '-f');
    assert.equal(calls[0].args[1], applicationRoot);
    assert.deepEqual(calls[1], {
      file: '/usr/bin/open',
      args: ['-a', applicationRoot, link],
      options: { env: { FIXED: 'environment' }, timeout: 15_000 },
    });
  });

  test('unregisters and proves absence when registration fails after partial success', async () => {
    const applicationRoot = '/private/copied/ProPR Desktop.app';
    const calls = [];
    const authority = new LaunchServicesAuthority(applicationRoot, { FIXED: 'environment' }, {
      runCommand: async (file, args) => {
        calls.push([file, ...args]);
        if (args[0] === '-f') throw new Error('injected partial registration failure');
        return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      },
      scanCommand: async (file, args) => {
        calls.push([file, ...args]);
        return { matched: false };
      },
    });

    await assert.rejects(authority.register(), /injected partial registration failure/);
    assert.equal(authority.registered, true);
    assert.deepEqual(await removeCopiedApplicationWithLaunchServicesAuthority({
      installRoot: '/private/install',
      launchServices: authority,
    }, {
      removeInstallRoot: async () => { calls.push(['remove-install-root']); },
      assertInstallRootAbsent: async () => { calls.push(['install-postcondition']); },
    }), []);

    assert.equal(authority.registered, false);
    assert.deepEqual(calls.map(call => call[1] ?? call[0]), [
      '-f',
      '-u',
      '-dump',
      'remove-install-root',
      'install-postcondition',
    ]);
  });

  test('retains the copied application until unregister and exact absence both succeed', async () => {
    for (const failurePoint of ['unregister', 'postcondition']) {
      const calls = [];
      const launchServices = {
        registered: true,
        unregister: async () => {
          calls.push('unregister');
          if (failurePoint === 'unregister') throw new Error('injected unregister failure');
        },
        assertGone: async () => {
          calls.push('postcondition');
          if (failurePoint === 'postcondition') throw new Error('injected stale record');
          launchServices.registered = false;
        },
      };
      const failures = await removeCopiedApplicationWithLaunchServicesAuthority({
        installRoot: '/private/install',
        launchServices,
      }, {
        removeInstallRoot: async () => { calls.push('remove'); },
        assertInstallRootAbsent: async () => { calls.push('install-postcondition'); },
      });
      assert.deepEqual(calls, ['unregister', 'postcondition']);
      assert.deepEqual(failures.map(failure => failure.label), [
        failurePoint === 'unregister' ? 'launchservices-unregister' : 'launchservices-postcondition',
      ]);
    }

    const calls = [];
    const launchServices = {
      registered: true,
      unregister: async () => { calls.push('unregister'); },
      assertGone: async () => {
        calls.push('postcondition');
        launchServices.registered = false;
      },
    };
    assert.deepEqual(await removeCopiedApplicationWithLaunchServicesAuthority({
      installRoot: '/private/install',
      launchServices,
    }, {
      removeInstallRoot: async () => { calls.push('remove'); },
      assertInstallRootAbsent: async () => { calls.push('install-postcondition'); },
    }), []);
    assert.deepEqual(calls, ['unregister', 'postcondition', 'remove', 'install-postcondition']);
  });

  test('retains copied install and outer work roots when process-group absence cannot be proved', async () => {
    const calls = [];
    const processGroupFailure = {
      label: 'process-groups',
      error: new Error('injected process-group postcondition failure'),
    };
    const failures = await removeLifecycleRootsWithAuthority({
      cleanupFailures: [processGroupFailure],
      installRoot: '/private/work/install',
      launchServices: { registered: true },
      workRoot: '/private/work',
    }, {
      removeCopiedApplication: async () => {
        calls.push('remove-copied-application');
        return [];
      },
      removeWorkRoot: async () => { calls.push('remove-work-root'); },
      assertWorkRootAbsent: async () => { calls.push('work-postcondition'); },
    });
    assert.deepEqual(calls, []);
    assert.deepEqual(failures, [processGroupFailure]);
  });

  test('does not mask profile API or private-profile authority cleanup failures', async () => {
    const server = {
      listening: true,
      address: () => ({ address: '127.0.0.1', family: 'IPv4', port: 1 }),
      close: callback => callback(new Error('injected close failure')),
      closeAllConnections: () => undefined,
    };
    await assert.rejects(
      closeProfileApi({ server, port: 1 }),
      error => error instanceof NativeLifecycleFailure && /profile-api-close, profile-api-listening/.test(error.message),
    );
    await assert.rejects(closeProfileApi({
      server: {
        ...server,
        close: () => undefined,
      },
      port: 1,
    }, { closeDeadline: 10 }), error => (
      error instanceof NativeLifecycleFailure
      && /profile-api-close, profile-api-listening/.test(error.message)
    ));
    await assert.rejects(removeAuthorizedProfile({ root: '/private/profile' }, {
      removeProfile: async () => { throw new Error('injected profile failure'); },
      inspectPath: async () => ({ isDirectory: () => true }),
    }), error => error instanceof NativeLifecycleFailure && /profile-authority, profile-postcondition/.test(error.message));
  });

  test('rejects escaping symlinks and symlinks to special files', { skip: process.platform === 'win32' }, async () => {
    const parent = await mkdtemp(join(tmpdir(), 'propr-native-tree-'));
    const root = join(parent, 'root');
    try {
      await mkdir(root);
      const outside = join(parent, 'outside target with spaces');
      await writeFile(outside, 'outside');
      await symlink(outside, join(root, 'escaping link'));
      await assert.rejects(assertSafeExtractedTree(root), /escaping its install root/);
      await rm(join(root, 'escaping link'));

      const fifo = join(root, 'owned fifo');
      const mkfifo = spawn('/usr/bin/mkfifo', [fifo], { shell: false, stdio: 'ignore' });
      const code = await new Promise(resolve => mkfifo.once('close', resolve));
      assert.equal(code, 0);
      await symlink(fifo, join(root, 'fifo link'));
      await assert.rejects(assertSafeExtractedTree(root), /symlink to an unsupported filesystem entry/);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  test('clears lifecycle deadlines once the raced operation settles', async () => {
    const pendingTimeouts = () => process.getActiveResourcesInfo().filter(type => type === 'Timeout').length;
    const before = pendingTimeouts();
    assert.equal(await withDeadline(Promise.resolve('done'), 600_000, 'unused deadline'), 'done');
    await assert.rejects(withDeadline(Promise.reject(new Error('operation failed')), 600_000, 'unused'), /operation failed/);
    assert.equal(pendingTimeouts(), before, 'a settled operation left its deadline timer active');
    await assert.rejects(withDeadline(new Promise(() => {}), 10, 'bounded deadline expired'), /bounded deadline expired/);
  });

  test('exits promptly after successful RPM extraction with a long deadline', { skip: process.platform === 'win32' }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'propr-native-rpm-exit-'));
    const converter = join(directory, 'converter.sh');
    const extractor = join(directory, 'extractor.sh');
    try {
      await writeFile(converter, '#!/bin/sh\nprintf archive\n');
      await writeFile(extractor, '#!/bin/sh\ncat >/dev/null\n');
      await chmod(converter, 0o700);
      await chmod(extractor, 0o700);
      const moduleUrl = new URL('./test-native-artifact-lifecycle.mjs', import.meta.url).href;
      // Reproduces the release-guard lifecycle process: the extraction succeeds
      // quickly, so the process must not wait for the unused ten-minute deadline.
      const script = `const { extractRpm } = await import(${JSON.stringify(moduleUrl)});
        await extractRpm('fixture.rpm', ${JSON.stringify(directory)}, {
          converterFile: ${JSON.stringify(converter)},
          extractorFile: ${JSON.stringify(extractor)},
          timeout: 600000,
        });`;
      const child = spawn(process.execPath, ['--input-type=module', '--eval', script], { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', chunk => { stderr += chunk; });
      const started = Date.now();
      const exited = await Promise.race([
        new Promise(resolve => child.once('close', code => resolve(code))),
        new Promise(resolve => setTimeout(() => resolve('lingering'), 20_000).unref()),
      ]);
      if (exited === 'lingering') child.kill('SIGKILL');
      assert.equal(exited, 0, stderr);
      assert.ok(Date.now() - started < 20_000);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('waits for a late rpm2cpio failure after extractor completion', { skip: process.platform === 'win32' }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'propr-native-rpm-'));
    const converter = join(directory, 'late-converter.sh');
    const extractor = join(directory, 'early-extractor.sh');
    try {
      await writeFile(converter, '#!/bin/sh\nexec 1>&-\nsleep 0.15\nexit 29\n');
      await writeFile(extractor, '#!/bin/sh\ncat >/dev/null\nexit 0\n');
      await chmod(converter, 0o700);
      await chmod(extractor, 0o700);
      const started = Date.now();
      await assert.rejects(
        extractRpm('fixture.rpm', directory, { converterFile: converter, extractorFile: extractor, timeout: 2_000 }),
        /rpm2cpio failed with code 29/,
      );
      assert.ok(Date.now() - started >= 100, 'extraction resolved before the converter reported its late failure');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
