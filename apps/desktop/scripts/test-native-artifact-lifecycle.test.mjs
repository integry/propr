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
  closeProfileApi,
  DmgMountAuthority,
  extractDmg,
  extractRpm,
  LaunchServicesAuthority,
  NativeLifecycleFailure,
  OwnedProcessGroups,
  parseArguments,
  removeAuthorizedProfile,
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
