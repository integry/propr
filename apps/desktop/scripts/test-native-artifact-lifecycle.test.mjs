import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { inspect } from 'node:util';
import {
  assertArtifactSet,
  assertSafeExtractedTree,
  classifyFirstEvidenceFailure,
  closeProfileApi,
  DmgMountAuthority,
  extractDmg,
  extractRpm,
  inspectRunningProcessGroupMembers,
  LaunchServicesAuthority,
  NativeLifecycleEvidenceWaitFailure,
  NativeLifecycleFailure,
  NativeLifecycleOperationFailure,
  OwnedProcessGroups,
  parseArguments,
  removeCopiedApplicationWithLaunchServicesAuthority,
  removeLifecycleRootsWithAuthority,
  removeAuthorizedProfile,
  runningProcessGroupMembersFromPs,
  waitForEvents,
} from './test-native-artifact-lifecycle.mjs';

describe('native staged artifact lifecycle authority', () => {
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
          event: 'desktop.deeplink.delivery_failed',
          milestone: 'DEEP_LINK_DELIVERY_FAILURE',
          stage: 'FIRST_INITIAL_EVIDENCE',
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
        });
      }

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
      assert.doesNotMatch(String(aggregate), /private\/profile|secret\.invalid|private cleanup output/);
      assert.doesNotMatch(JSON.stringify(aggregate), /private\/profile|secret\.invalid|private cleanup output/);
      assert.doesNotMatch(inspect(aggregate), /private\/profile|secret\.invalid|private cleanup output/);
    } finally {
      await rm(directory, { recursive: true, force: true });
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

    const stale = new LaunchServicesAuthority(applicationRoot, {}, {
      runCommand: async () => ({
        stdout: Buffer.from(`path: ${applicationRoot}\n`),
        stderr: Buffer.alloc(0),
      }),
    });
    stale.registered = true;
    await assert.rejects(stale.assertGone(), /remained registered/);
    assert.equal(stale.registered, true);
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
