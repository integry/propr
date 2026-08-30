import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { chmodSync, closeSync, constants, copyFileSync, existsSync, linkSync, lstatSync, mkdtempSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { connect, createServer } from 'node:net';
import { after, test } from 'node:test';
import {
  ConnectRootError,
  getOrCreateSnapshotPublicInstanceIdentity,
  PublicInstanceIdentityError,
  readTrustedConnectTunnelOverride,
  withOwnedConnectRootSnapshot,
} from '../packages/cli/dist/connectIdentity.js';
import {
  nativeConnectRootAuthorityInspector,
  assertNativeEntryAuthority,
  closeWindowsAuthorityCapability,
  exerciseWindowsAuthorityCapabilityControlForNativeTest,
  exerciseWindowsAuthorityCapabilityForNativeTest,
  exerciseWindowsHelperProvenanceForNativeTest,
  protectWindowsSetupEntries,
  protectWindowsSetupEntry,
  stableAuthorityIdentity,
  WINDOWS_SUPERVISOR_STAGE_VALUES,
  exerciseWindowsAuthorityStageFailureForNativeTest,
} from '../packages/cli/dist/connectRootAuthority.js';
import {
  acquireInstalledWindowsLaunchLease,
  WINDOWS_CONNECT_AUTHORITY_PIPE,
  type InstalledAuthorityIdentity,
} from '../packages/cli/dist/windowsInstalledAuthority.js';
import { PUBLIC_INSTANCE_IDENTITY_FILENAME } from '@propr/shared';
import { getOrCreatePublicInstanceIdentityPinned } from '@propr/local-setup';

const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const READY = `.${PUBLIC_INSTANCE_IDENTITY_FILENAME}.ready-v1`;
const WINDOWS_REPLACEMENT_ATTACKER_SOURCE_SHA256 = '01ccc521cf6784f92cc33bbc4846b218625d61cb3b7dcbd9ed9366f50d12f6fa';
const WINDOWS_REPLACEMENT_ATTACKER_SHA256 = 'd2c8cdc127ff1e44f5207b437337223f01e9266c4a2ab375a43ffde09df296cf';
const sha256Digest = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const completedScenarios = new Map<string, number>();
const expectedScenarios = [
  'ordinary-directory', 'ordinary-file', 'distinct-identity',
  'protected-root', 'protected-data', 'protected-env',
  'publication', 'ready-denial', 'recovery', 'identity-swap',
  'broad-publication', 'broad-root', 'broad-data', 'broad-env', 'broad-ancestor', 'explicit-deny',
  process.platform === 'win32' ? 'inherited-dacl' : 'inherited-darwin-acl',
  ...(process.platform === 'win32' ? ['foreign-owner'] : []),
  'packaged-helper-integrity',
  ...(process.platform === 'win32'
    ? [
      'atomic-publication', 'preprotocol-cleanup', 'invalid-handle-cleanup',
      'identity-mismatch-cleanup', 'contents-cleanup', 'cleanup-swap',
      'bootstrap-first-launch', 'bootstrap-aba', 'settling-race',
      'helper-build-provenance', 'helper-manifest', 'installed-authority-mutation',
      'old-broker-marker', 'authority-pipe-spoof', 'authority-version',
      'authority-client', 'authority-replay', 'authority-frames', 'authority-lifecycle',
      'no-runtime-compiler', 'forged-control-pipes', 'extra-child-denied',
      'job-assignment-failure', 'job-kill-on-close', 'launcher-unload', 'handle-leak',
    ]
    : []),
  'reparse', 'replacement-barrier', 'inspection-handle-swap',
  'config-off', 'config-on', 'config-absence', 'config-disappearance',
  'config-broad-file', 'config-broad-directory', 'config-reparse', 'config-replacement',
];

function completeScenario(name: string): void {
  assert.equal(expectedScenarios.includes(name), true, `unexpected native scenario ${name}`);
  const count = (completedScenarios.get(name) ?? 0) + 1;
  assert.equal(count, 1, `native scenario ${name} completed more than once`);
  completedScenarios.set(name, count);
}

function isFixedInvalidRoot(error: unknown, reason = 'INVALID_ROOT'): boolean {
  return error instanceof ConnectRootError
    && error.reason === reason
    && error.message === `the explicit stack root is unavailable or is not owned by the caller [reason=${reason}]`;
}

function isFixedPublicIdentityError(error: unknown): boolean {
  return error instanceof PublicInstanceIdentityError
    && error.message === 'the public instance identity is unavailable or invalid';
}

after(async () => {
  if (process.platform !== 'darwin' && process.platform !== 'win32') return;
  const counters = Object.fromEntries(expectedScenarios.map((name) => [name, completedScenarios.get(name) ?? 0]));
  process.stdout.write(`# PROPR_NATIVE_AUTHORITY_SUMMARY ${JSON.stringify({ version: 1, platform: process.platform, counters })}\n`);
  await closeWindowsAuthorityCapability();
});

function nativeFixtureParent(prefix: string): string {
  const base = process.platform === 'win32' ? userInfo().homedir : tmpdir();
  return realpathSync(mkdtempSync(join(base, prefix)));
}

test('native ordinary file and directory authority is accepted without an extended ACL', { timeout: 15_000 }, async (t) => {
  if (!nativeOnly(t)) return;
  const parent = nativeFixtureParent('propr native ordinary ');
  const directory = join(parent, 'protected directory');
  const file = join(directory, 'protected file');
  try {
    mkdirSync(directory, { mode: 0o700 });
    writeFileSync(file, 'ordinary\n', { mode: 0o600 });
    chmodSync(directory, 0o700);
    chmodSync(file, 0o600);
    if (process.platform === 'win32') {
      await protectWindowsSetupEntries([
        { path: parent, kind: 'directory' },
        { path: directory, kind: 'directory' },
        { path: file, kind: 'file' },
      ]);
    }
    for (const [path, kind] of [[directory, 'data'], [file, 'env']] as const) {
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        await assert.doesNotReject(assertNativeEntryAuthority(
          nativeConnectRootAuthorityInspector, process.platform, path, kind, fd,
        ));
        completeScenario(kind === 'data' ? 'ordinary-directory' : 'ordinary-file');
        if (process.platform === 'darwin') {
          const identity = stableAuthorityIdentity(fd);
          assert.equal(
            nativeConnectRootAuthorityInspector.inspectDarwinAcl(path, fd, identity).acl,
            '!#acl 1\n',
          );
        }
      } finally {
        closeSync(fd);
      }
    }
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('native broker carries distinct file identities losslessly', { timeout: 15_000 }, async (t) => {
  if (!nativeOnly(t)) return;
  const parent = nativeFixtureParent('propr-native-identity-');
  const firstPath = join(parent, 'first');
  const secondPath = join(parent, 'second');
  writeFileSync(firstPath, 'first', { mode: 0o600 });
  writeFileSync(secondPath, 'second', { mode: 0o600 });
  if (process.platform === 'win32') {
    await protectWindowsSetupEntries([
      { path: parent, kind: 'directory' },
      { path: firstPath, kind: 'file' },
      { path: secondPath, kind: 'file' },
    ]);
  }
  const firstFd = openSync(firstPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  const secondFd = openSync(secondPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const firstIdentity = stableAuthorityIdentity(firstFd);
    const secondIdentity = stableAuthorityIdentity(secondFd);
    assert.notDeepEqual(firstIdentity, secondIdentity);
    if (process.platform === 'darwin') {
      const first = nativeConnectRootAuthorityInspector.inspectDarwinAcl(firstPath, firstFd, firstIdentity);
      const second = nativeConnectRootAuthorityInspector.inspectDarwinAcl(secondPath, secondFd, secondIdentity);
      assert.notEqual(`${first.device}:${first.file}`, `${second.device}:${second.file}`);
    } else {
      const inspections = await nativeConnectRootAuthorityInspector.inspectWindowsAcls!([
        { path: firstPath, kind: 'env', expectedIdentity: firstIdentity, pinnedFd: firstFd },
        { path: secondPath, kind: 'env', expectedIdentity: secondIdentity, pinnedFd: secondFd },
      ]);
      assert.notEqual(inspections[0].fileId, inspections[1].fileId);
      assert.equal(BigInt(inspections[0].volumeSerialNumber), BigInt(inspections[0].verifiedVolumeSerialNumber));
      assert.equal(BigInt(inspections[0].fileId), BigInt(inspections[0].verifiedFileId));
      assert.equal(BigInt(inspections[1].volumeSerialNumber), BigInt(inspections[1].verifiedVolumeSerialNumber));
      assert.equal(BigInt(inspections[1].fileId), BigInt(inspections[1].verifiedFileId));
    }
    completeScenario('distinct-identity');
  } finally {
    closeSync(secondFd);
    closeSync(firstFd);
    rmSync(parent, { recursive: true, force: true });
  }
});

function nativeOnly(t: { skip(message?: string): void }): boolean {
  if (process.platform === 'darwin' || process.platform === 'win32') return true;
  t.skip('native authority evidence runs only on macOS and Windows');
  return false;
}

function run(executable: string, args: string[]): void {
  const result = spawnSync(executable, args, { shell: false, encoding: 'utf8', windowsHide: true });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
}

function createWindowsJunction(linkPath: string, targetPath: string): void {
  assert.equal(process.platform, 'win32');
  const executable = join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = [
    "$ErrorActionPreference='Stop'",
    '$link=[Environment]::GetEnvironmentVariable(\'PROPR_TEST_LINK\',\'Process\')',
    '$target=[Environment]::GetEnvironmentVariable(\'PROPR_TEST_TARGET\',\'Process\')',
    'if([string]::IsNullOrEmpty($link)-or[string]::IsNullOrEmpty($target)){throw \'missing junction operand\'}',
    '[void](New-Item -ItemType Junction -Path $link -Target $target)',
  ].join(';');
  const result = spawnSync(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    shell: false,
    env: {
      SystemRoot: process.env.SystemRoot,
      PROPR_TEST_LINK: linkPath,
      PROPR_TEST_TARGET: targetPath,
    },
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
}

async function makeStack(parent: string, name = 'stack'): Promise<string> {
  const root = join(parent, name);
  mkdirSync(join(root, 'data'), { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  chmodSync(join(root, 'data'), 0o700);
  writeFileSync(join(root, '.env'), 'PROPR_STACK=native\n', { mode: 0o600 });
  chmodSync(join(root, '.env'), 0o600);
  if (process.platform === 'win32') {
    await protectWindowsSetupEntries([
      { path: parent, kind: 'directory' },
      { path: root, kind: 'directory' },
      { path: join(root, 'data'), kind: 'directory' },
      { path: join(root, '.env'), kind: 'file' },
    ]);
  }
  return root;
}

async function assertPublishedNative(path: string, links = 1): Promise<void> {
  const stat = lstatSync(path);
  assert.equal(stat.isFile(), true);
  assert.equal(stat.isSymbolicLink(), false);
  assert.equal(stat.nlink, links);
  if (process.platform === 'darwin') {
    assert.equal(stat.mode & 0o777, 0o644);
    assert.equal(stat.uid, process.getuid!());
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await assertNativeEntryAuthority(nativeConnectRootAuthorityInspector, process.platform, path, 'env', fd);
  } finally {
    closeSync(fd);
  }
}

function grantBroadWrite(path: string, directory: boolean): void {
  if (process.platform === 'darwin') {
    run('/bin/chmod', ['+a', 'everyone allow write,writeattr,writeextattr,writesecurity', path]);
    return;
  }
  const script = [
    "$ErrorActionPreference='Stop'",
    '$p=$env:PROPR_TEST_TARGET',
    '$acl=Get-Acl -LiteralPath $p',
    '$everyone=[System.Security.Principal.SecurityIdentifier]::new("S-1-1-0")',
    `$inherit=[System.Security.AccessControl.InheritanceFlags]'${directory ? 'ContainerInherit, ObjectInherit' : 'None'}'`,
    '$rule=[System.Security.AccessControl.FileSystemAccessRule]::new($everyone,[System.Security.AccessControl.FileSystemRights]::Modify,$inherit,[System.Security.AccessControl.PropagationFlags]::None,[System.Security.AccessControl.AccessControlType]::Allow)',
    '[void]$acl.AddAccessRule($rule)',
    'Set-Acl -LiteralPath $p -AclObject $acl',
  ].join(';');
  const executable = join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = spawnSync(executable, ['-NoProfile', '-NonInteractive', '-Command', script], {
    shell: false, env: { SystemRoot: process.env.SystemRoot, PROPR_TEST_TARGET: path }, encoding: 'utf8', windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
}

function grantBroadDeny(path: string, directory: boolean): void {
  if (process.platform === 'darwin') {
    run('/bin/chmod', ['+a', 'everyone deny write,writeattr,writeextattr,writesecurity', path]);
    return;
  }
  const script = [
    "$ErrorActionPreference='Stop'",
    '$p=$env:PROPR_TEST_TARGET',
    '$acl=Get-Acl -LiteralPath $p',
    '$everyone=[System.Security.Principal.SecurityIdentifier]::new("S-1-1-0")',
    `$inherit=[System.Security.AccessControl.InheritanceFlags]'${directory ? 'ContainerInherit, ObjectInherit' : 'None'}'`,
    '$rule=[System.Security.AccessControl.FileSystemAccessRule]::new($everyone,[System.Security.AccessControl.FileSystemRights]::Modify,$inherit,[System.Security.AccessControl.PropagationFlags]::None,[System.Security.AccessControl.AccessControlType]::Deny)',
    '[void]$acl.AddAccessRule($rule)',
    'Set-Acl -LiteralPath $p -AclObject $acl',
  ].join(';');
  const executable = join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = spawnSync(executable, ['-NoProfile', '-NonInteractive', '-Command', script], {
    shell: false, env: { SystemRoot: process.env.SystemRoot, PROPR_TEST_TARGET: path }, encoding: 'utf8', windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
}

function mutateWindowsAcl(path: string, operation: 'inherit' | 'administrator-owner'): void {
  assert.equal(process.platform, 'win32');
  const action = operation === 'inherit'
    ? '$acl.SetAccessRuleProtection($false,$true)'
    : '$acl.SetOwner([System.Security.Principal.SecurityIdentifier]::new("S-1-5-32-544"))';
  const script = [
    "$ErrorActionPreference='Stop'",
    '$p=$env:PROPR_TEST_TARGET',
    '$acl=Get-Acl -LiteralPath $p',
    action,
    'Set-Acl -LiteralPath $p -AclObject $acl',
  ].join(';');
  const executable = join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = spawnSync(executable, ['-NoProfile', '-NonInteractive', '-Command', script], {
    shell: false, env: { SystemRoot: process.env.SystemRoot, PROPR_TEST_TARGET: path }, encoding: 'utf8', windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
}

test('native root/env/data/identity authority accepts the protected object and rejects broad grants', { timeout: 45_000 }, async (t) => {
  if (!nativeOnly(t)) return;
  const parent = nativeFixtureParent('propr-native-authority-');
  const broadReason = process.platform === 'win32' ? /BROAD_WRITE/ : /explicit stack root|write authority/;
  try {
    const root = await makeStack(parent);
    for (const [path, kind, scenario] of [
      [root, 'root', 'protected-root'],
      [join(root, 'data'), 'data', 'protected-data'],
      [join(root, '.env'), 'env', 'protected-env'],
    ] as const) {
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        await assert.doesNotReject(assertNativeEntryAuthority(
          nativeConnectRootAuthorityInspector, process.platform, path, kind, fd,
        ));
        completeScenario(scenario);
      } finally {
        closeSync(fd);
      }
    }
    assert.equal(await withOwnedConnectRootSnapshot(root, (snapshot) => (
      getOrCreateSnapshotPublicInstanceIdentity(snapshot.identityDirectory, () => ID)
    ), { parseEnvFile: () => ({}) }), ID);
    const finalPath = join(root, 'data', PUBLIC_INSTANCE_IDENTITY_FILENAME);
    await assertPublishedNative(finalPath);

    const publicationRoot = await makeStack(parent, 'publication-state');
    let temporaryChecked = false;
    assert.equal(await withOwnedConnectRootSnapshot(publicationRoot, (snapshot) => (
      getOrCreatePublicInstanceIdentityPinned(snapshot.identityDirectory, {
        role: 'host',
        generate: () => ID,
        onBoundary: async (boundary) => {
          if (boundary !== 'temporary-synced' || temporaryChecked) return;
          const name = readdirSync(join(publicationRoot, 'data'))
            .find((entry) => entry.startsWith(`.${PUBLIC_INSTANCE_IDENTITY_FILENAME}.creating-v1-`));
          assert.ok(name);
          await assertPublishedNative(join(publicationRoot, 'data', name));
          temporaryChecked = true;
        },
      })
    ), { parseEnvFile: () => ({}) }), ID);
    assert.equal(temporaryChecked, true);
    const publishedPath = join(publicationRoot, 'data', PUBLIC_INSTANCE_IDENTITY_FILENAME);
    await assertPublishedNative(publishedPath);
    completeScenario('publication');

    const crashReady = join(publicationRoot, 'data', READY);
    linkSync(publishedPath, crashReady);
    await assertPublishedNative(publishedPath, 2);
    await assertPublishedNative(crashReady, 2);
    assert.equal(await withOwnedConnectRootSnapshot(publicationRoot, (snapshot) => (
      getOrCreateSnapshotPublicInstanceIdentity(snapshot.identityDirectory)
    ), { parseEnvFile: () => ({}) }), ID);
    await assertPublishedNative(publishedPath);
    assert.throws(() => lstatSync(crashReady), /ENOENT/);
    completeScenario('recovery');

    if (process.platform === 'darwin') {
      const readyRoot = await makeStack(parent, 'ready-denial-root');
      const readyPath = join(readyRoot, 'data', READY);
      const finalReadyPath = join(readyRoot, 'data', PUBLIC_INSTANCE_IDENTITY_FILENAME);
      const fixtureStop = new Error('production READY fixture captured');
      await assert.rejects(withOwnedConnectRootSnapshot(readyRoot, (snapshot) => (
        getOrCreatePublicInstanceIdentityPinned(snapshot.identityDirectory, {
          role: 'host',
          generate: () => ID,
          onBoundary: async (boundary) => {
            if (boundary === 'recovery-published') throw fixtureStop;
          },
        })
      ), { parseEnvFile: () => ({}) }), (error) => error === fixtureStop);
      await assertPublishedNative(readyPath);
      const productionIdentity = (() => {
        const productionFd = openSync(readyPath, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          return stableAuthorityIdentity(productionFd);
        } finally {
          closeSync(productionFd);
        }
      })();

      // First prove the untouched production READY entry is accepted and fully
      // recovered. Move that exact inode back to the production recovery slot so
      // the ACL is the sole variable in the denial half of the fixture.
      assert.equal(await withOwnedConnectRootSnapshot(readyRoot, (snapshot) => (
        getOrCreateSnapshotPublicInstanceIdentity(snapshot.identityDirectory)
      ), { parseEnvFile: () => ({}) }), ID);
      assert.throws(() => lstatSync(readyPath), /ENOENT/);
      const recoveredFd = openSync(finalReadyPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        assert.deepEqual(stableAuthorityIdentity(recoveredFd), productionIdentity);
      } finally {
        closeSync(recoveredFd);
      }
      renameSync(finalReadyPath, readyPath);
      await assertPublishedNative(readyPath);
      const heldReadyFd = openSync(readyPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        assert.deepEqual(stableAuthorityIdentity(heldReadyFd), productionIdentity);
        grantBroadWrite(readyPath, false);
        assert.deepEqual(stableAuthorityIdentity(heldReadyFd), productionIdentity);
        await assert.rejects(withOwnedConnectRootSnapshot(readyRoot, (snapshot) => (
          getOrCreateSnapshotPublicInstanceIdentity(snapshot.identityDirectory)
        ), { parseEnvFile: () => ({}) }), isFixedPublicIdentityError);
      } finally {
        closeSync(heldReadyFd);
      }
      completeScenario('ready-denial');
    } else {
      const readyPath = join(root, 'data', READY);
      writeFileSync(readyPath, `${JSON.stringify({ schemaVersion: 1, publicInstanceIdentity: ID })}\n`, { mode: 0o644 });
      await protectWindowsSetupEntry(readyPath, 'file');
      grantBroadWrite(readyPath, false);
      await assert.rejects(withOwnedConnectRootSnapshot(root, (snapshot) => (
        getOrCreateSnapshotPublicInstanceIdentity(snapshot.identityDirectory)
      ), { parseEnvFile: () => ({}) }), broadReason);
      completeScenario('ready-denial');
      unlinkSync(readyPath);
    }

    let identityReplaced = false;
    let identitySwapProven = false;
    await assert.rejects(withOwnedConnectRootSnapshot(root, async (snapshot) => {
      try {
        return await getOrCreatePublicInstanceIdentityPinned(snapshot.identityDirectory, {
          role: 'host',
          onBoundary: async (boundary) => {
            if (boundary !== 'identity-read-statted' || identityReplaced) return;
            identityReplaced = true;
            const path = join(root, 'data', PUBLIC_INSTANCE_IDENTITY_FILENAME);
            const before = lstatSync(path, { bigint: true });
            const detached = `${path}.detached`;
            renameSync(path, detached);
            writeFileSync(path, `${JSON.stringify({ schemaVersion: 1, publicInstanceIdentity: ID })}\n`, { mode: 0o644 });
            chmodSync(path, 0o644);
            if (process.platform === 'win32') await protectWindowsSetupEntry(path, 'file');
            const held = lstatSync(detached, { bigint: true });
            const replacement = lstatSync(path, { bigint: true });
            assert.equal(held.dev, before.dev);
            assert.equal(held.ino, before.ino);
            assert.notEqual(`${replacement.dev}:${replacement.ino}`, `${before.dev}:${before.ino}`);
            identitySwapProven = true;
          },
        });
      } catch {
        throw new PublicInstanceIdentityError();
      }
    }, { parseEnvFile: () => ({}) }), isFixedPublicIdentityError);
    assert.equal(identityReplaced, true);
    assert.equal(identitySwapProven, true);
    completeScenario('identity-swap');

    grantBroadWrite(join(root, 'data', PUBLIC_INSTANCE_IDENTITY_FILENAME), false);
    await assert.rejects(withOwnedConnectRootSnapshot(root, (snapshot) => (
      getOrCreateSnapshotPublicInstanceIdentity(snapshot.identityDirectory)
    ), { parseEnvFile: () => ({}) }), process.platform === 'darwin' ? isFixedPublicIdentityError : broadReason);
    completeScenario('broad-publication');

    for (const [name, relative, directory] of [
      ['broad-root', '', true],
      ['broad-data', 'data', true],
      ['broad-env', '.env', false],
    ] as const) {
      const candidate = await makeStack(parent, name);
      grantBroadWrite(relative ? join(candidate, relative) : candidate, directory);
      await assert.rejects(
        withOwnedConnectRootSnapshot(candidate, () => undefined, { parseEnvFile: () => ({}) }),
        process.platform === 'darwin' ? isFixedInvalidRoot : broadReason,
      );
      completeScenario(name);
    }

    const denied = await makeStack(parent, 'explicit-deny-root');
    grantBroadDeny(denied, true);
    await assert.doesNotReject(withOwnedConnectRootSnapshot(denied, () => undefined, { parseEnvFile: () => ({}) }));
    completeScenario('explicit-deny');

    const unsafeAncestor = join(parent, 'broad-ancestor');
    mkdirSync(unsafeAncestor, { mode: 0o700 });
    if (process.platform === 'win32') await protectWindowsSetupEntry(unsafeAncestor, 'directory');
    const descendant = await makeStack(unsafeAncestor, 'descendant');
    grantBroadWrite(unsafeAncestor, true);
    await assert.rejects(
      withOwnedConnectRootSnapshot(descendant, () => undefined, { parseEnvFile: () => ({}) }),
      process.platform === 'darwin' ? isFixedInvalidRoot : broadReason,
    );
    completeScenario('broad-ancestor');

    if (process.platform === 'win32') {
      const inherited = await makeStack(parent, 'inherited-root');
      mutateWindowsAcl(inherited, 'inherit');
      await assert.rejects(
        withOwnedConnectRootSnapshot(inherited, () => undefined, { parseEnvFile: () => ({}) }),
        /INHERITED_WRITE|DACL_NOT_PROTECTED/,
      );
      completeScenario('inherited-dacl');

      const foreignOwned = await makeStack(parent, 'foreign-owner-root');
      mutateWindowsAcl(foreignOwned, 'administrator-owner');
      await assert.rejects(withOwnedConnectRootSnapshot(foreignOwned, () => undefined, { parseEnvFile: () => ({}) }), /OWNER_MISMATCH/);
      completeScenario('foreign-owner');
    } else {
      const inheritanceDirectory = join(parent, 'darwin-inherited-acl');
      mkdirSync(inheritanceDirectory, { mode: 0o700 });
      run('/bin/chmod', [
        '+a',
        'everyone allow write,writeattr,writeextattr,writesecurity,file_inherit,directory_inherit',
        inheritanceDirectory,
      ]);
      const inheritedFile = join(inheritanceDirectory, 'inherited-file');
      writeFileSync(inheritedFile, 'identity fixture\n', { mode: 0o644 });
      chmodSync(inheritedFile, 0o644);
      const inheritedFd = openSync(inheritedFile, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const identity = stableAuthorityIdentity(inheritedFd);
        const inspection = nativeConnectRootAuthorityInspector.inspectDarwinAcl(
          inheritedFile,
          inheritedFd,
          identity,
        );
        assert.match(inspection.acl, /(?:^|,)inherited(?:,|:)/m);
        await assert.rejects(assertNativeEntryAuthority(
          nativeConnectRootAuthorityInspector,
          process.platform,
          inheritedFile,
          'env',
          inheritedFd,
        ));
        completeScenario('inherited-darwin-acl');
      } finally {
        closeSync(inheritedFd);
      }
    }
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('native helper replacement is rejected before attacker bytes can execute', { timeout: 105_000 }, async (t) => {
  if (!nativeOnly(t)) return;
  const platformArch = process.platform === 'win32' ? 'win32-x64' : `${process.platform}-${process.arch}`;
  const executableName = process.platform === 'win32' ? 'connect-authority-broker.exe' : 'connect-authority-broker';
  const artifact = join(process.cwd(), 'packages', 'cli', 'dist', 'native', 'prebuilds', platformArch, executableName);
  const backup = `${artifact}.trusted-test-backup-${process.pid}`;
  const marker = join(tmpdir(), `propr-attacker-marker-${process.pid}`);
  const firstBoundaryMarker = join(dirname(artifact), 'packaged-broker-attacker-executed');
  const parent = nativeFixtureParent('propr-native-helper-');
  const target = join(parent, 'target');
  writeFileSync(target, 'target\n', { mode: 0o600 });
  if (process.platform === 'win32') await protectWindowsSetupEntries([
    { path: parent, kind: 'directory' }, { path: target, kind: 'file' },
  ]);
  const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  let artifactMoved = false;
  try {
    if (process.platform === 'win32') await closeWindowsAuthorityCapability();
    renameSync(artifact, backup);
    artifactMoved = true;
    if (process.platform === 'darwin') {
      writeFileSync(artifact, `#!/bin/sh\nprintf attacker > "${marker}"\n`, { mode: 0o700 });
      chmodSync(artifact, 0o700);
    } else {
      copyFileSync(join(process.cwd(), 'test', 'fixtures', 'windowsAuthorityReplacementAttacker.exe'), artifact);
    }
    await assert.rejects(assertNativeEntryAuthority(
      nativeConnectRootAuthorityInspector, process.platform, target, 'env', fd,
    ), /authority|broker|integrity|unavailable/);
    assert.throws(() => lstatSync(marker), /ENOENT/);
    assert.throws(() => lstatSync(firstBoundaryMarker), /ENOENT/);
    if (process.platform === 'win32') completeScenario('old-broker-marker');
  } finally {
    closeSync(fd);
    if (artifactMoved) {
      try { unlinkSync(artifact); } catch { /* The replacement may already be absent. */ }
      renameSync(backup, artifact);
    }
    rmSync(marker, { force: true });
    rmSync(firstBoundaryMarker, { force: true });
    rmSync(parent, { recursive: true, force: true });
  }
  assert.ok(readFileSync(artifact).byteLength > 0);
  if (process.platform === 'darwin') completeScenario('packaged-helper-integrity');

  if (process.platform === 'win32') {
    assert.deepEqual(WINDOWS_SUPERVISOR_STAGE_VALUES, [
      'BUILD_COMPILER', 'BUILD_SOURCE', 'BUILD_OUTPUT', 'MANIFEST', 'HELPER_OPEN',
      'HELPER_IDENTITY', 'HELPER_HASH', 'TRANSPORT_SPAWN', 'JOB_ASSIGN', 'PROTOCOL_INIT',
      'READY', 'PRE_CHALLENGE', 'BATCH_LAUNCH', 'FD_DUPLICATE', 'BATCH_RESPONSE',
      'POST_CHALLENGE', 'SHUTDOWN',
    ]);
    for (const stage of WINDOWS_SUPERVISOR_STAGE_VALUES) {
      assert.deepEqual(await exerciseWindowsAuthorityStageFailureForNativeTest(stage), {
        version: 1,
        status: 'failed',
        stage,
        publicError: 'Windows system authority capability is unavailable',
      });
      if (stage === 'JOB_ASSIGN') completeScenario('job-assignment-failure');
    }
    completeScenario('preprotocol-cleanup');
    assert.throws(
      () => exerciseWindowsAuthorityStageFailureForNativeTest(
        'UNKNOWN' as (typeof WINDOWS_SUPERVISOR_STAGE_VALUES)[number],
      ),
      /unknown Windows authority stage/,
    );
    const command = join(process.env.SystemRoot!, 'System32', 'cmd.exe');
    const packagedBootstrapPath = join(process.cwd(), 'packages', 'cli', 'dist', 'native', 'prebuilds',
      'win32-x64', 'connect-authority-bootstrap.exe');
    const packagedBootstrapBackup = `${packagedBootstrapPath}.trusted-test-backup-${process.pid}`;
    const sourceBootstrapPath = join(process.cwd(), 'packages', 'cli', 'native', 'prebuilds',
      'win32-x64', 'connect-authority-bootstrap.exe');
    const sourceBootstrapBackup = `${sourceBootstrapPath}.trusted-test-backup-${process.pid}`;
    const bootstrapMarker = join(dirname(packagedBootstrapPath), 'packaged-broker-attacker-executed');
    const replacementAttacker = join(process.cwd(), 'test', 'fixtures', 'windowsAuthorityReplacementAttacker.exe');
    const originalBootstrapBytes = readFileSync(packagedBootstrapPath);
    const assertBootstrapNegative = async (replacement: Buffer, expected: RegExp) => {
      await closeWindowsAuthorityCapability();
      renameSync(packagedBootstrapPath, packagedBootstrapBackup);
      try {
        writeFileSync(packagedBootstrapPath, replacement, { flag: 'wx', mode: 0o600 });
        await assert.rejects(exerciseWindowsAuthorityCapabilityForNativeTest(), expected);
        assert.throws(() => lstatSync(bootstrapMarker), /ENOENT/);
      } finally {
        rmSync(packagedBootstrapPath, { force: true });
        renameSync(packagedBootstrapBackup, packagedBootstrapPath);
      }
    };
    await closeWindowsAuthorityCapability();
    renameSync(packagedBootstrapPath, packagedBootstrapBackup);
    renameSync(sourceBootstrapPath, sourceBootstrapBackup);
    try {
      await assert.rejects(exerciseWindowsAuthorityCapabilityForNativeTest(), /HELPER_OPEN|capability|authority/);
    } finally {
      renameSync(sourceBootstrapBackup, sourceBootstrapPath);
      renameSync(packagedBootstrapBackup, packagedBootstrapPath);
    }
    await assertBootstrapNegative(Buffer.from('tampered packaged bootstrap'), /HELPER_HASH|capability|authority/);
    let wrongIdentityObserved = false;
    try {
      await assert.rejects(exerciseWindowsAuthorityCapabilityForNativeTest({
        onBootstrapFirstLaunch: (bootstrapPath) => {
          const detached = `${bootstrapPath}.wrong-identity`;
          renameSync(bootstrapPath, detached);
          writeFileSync(bootstrapPath, originalBootstrapBytes, { flag: 'wx', mode: 0o600 });
          wrongIdentityObserved = true;
        },
      }), /HELPER_IDENTITY|capability|authority/);
      assert.equal(wrongIdentityObserved, true);
    } finally {
      rmSync(packagedBootstrapPath, { force: true });
      if (existsSync(`${packagedBootstrapPath}.wrong-identity`)) {
        renameSync(`${packagedBootstrapPath}.wrong-identity`, packagedBootstrapPath);
      }
    }
    let maliciousReplacementObserved = false;
    try {
      await assert.rejects(exerciseWindowsAuthorityCapabilityForNativeTest({
        onBootstrapFirstLaunch: (bootstrapPath) => {
          const detached = `${bootstrapPath}.first-launch-trusted`;
          renameSync(bootstrapPath, detached);
          copyFileSync(replacementAttacker, bootstrapPath);
          maliciousReplacementObserved = true;
        },
      }), /HELPER_IDENTITY|HELPER_HASH|capability|authority/);
      assert.equal(maliciousReplacementObserved, true);
      assert.throws(() => lstatSync(bootstrapMarker), /ENOENT/);
    } finally {
      rmSync(packagedBootstrapPath, { force: true });
      if (existsSync(`${packagedBootstrapPath}.first-launch-trusted`)) {
        renameSync(`${packagedBootstrapPath}.first-launch-trusted`, packagedBootstrapPath);
      }
      rmSync(bootstrapMarker, { force: true });
    }
    let postVerificationAttackObserved = false;
    const postVerificationDetached = `${packagedBootstrapPath}.post-verification-detached`;
    try {
      await assert.rejects(exerciseWindowsAuthorityCapabilityForNativeTest({
        onBootstrapCreateProcess: (bootstrapPath) => {
          postVerificationAttackObserved = true;
          assert.throws(() => renameSync(bootstrapPath, postVerificationDetached));
          assert.throws(() => copyFileSync(replacementAttacker, bootstrapPath));
          assert.throws(() => lstatSync(bootstrapMarker), /ENOENT/);
          throw new Error('bootstrap post-verification pre-CreateProcess lease observed');
        },
      }), /capability|authority|lease observed/);
      assert.equal(postVerificationAttackObserved, true);
      assert.throws(() => lstatSync(bootstrapMarker), /ENOENT/);
    } finally {
      if (existsSync(postVerificationDetached)) {
        rmSync(packagedBootstrapPath, { force: true });
        renameSync(postVerificationDetached, packagedBootstrapPath);
      }
      rmSync(bootstrapMarker, { force: true });
    }
    const packagedBrokerPath = join(process.cwd(), 'packages', 'cli', 'dist', 'native', 'prebuilds',
      'win32-x64', 'connect-authority-broker.exe');
    const outerDetached = `${packagedBrokerPath}.outer-final-check-detached`;
    let outerFinalGapObserved = false;
    try {
      await assert.rejects(exerciseWindowsAuthorityCapabilityForNativeTest({
        onOuterAuthorityCreateProcess: (outerPath) => {
          outerFinalGapObserved = true;
          assert.equal(outerPath, packagedBrokerPath);
          assert.throws(() => renameSync(outerPath, outerDetached));
          assert.throws(() => copyFileSync(replacementAttacker, outerPath));
          assert.throws(() => lstatSync(bootstrapMarker), /ENOENT/);
          throw new Error('outer authority exact final-check pre-CreateProcess lease observed');
        },
      }), /capability|authority|lease observed/);
      assert.equal(outerFinalGapObserved, true);
      assert.throws(() => lstatSync(bootstrapMarker), /ENOENT/);
    } finally {
      if (existsSync(outerDetached)) {
        rmSync(packagedBrokerPath, { force: true });
        renameSync(outerDetached, packagedBrokerPath);
      }
      rmSync(bootstrapMarker, { force: true });
    }
    completeScenario('bootstrap-first-launch');

    const packagedSupervisorPath = join(process.cwd(), 'packages', 'cli', 'dist', 'native', 'prebuilds',
      'win32-anycpu', 'connect-authority-supervisor.exe');
    const sourceSupervisorPath = join(process.cwd(), 'packages', 'cli', 'native', 'prebuilds',
      'win32-anycpu', 'connect-authority-supervisor.exe');
    const packagedSupervisorBackup = `${packagedSupervisorPath}.trusted-test-backup-${process.pid}`;
    const sourceSupervisorBackup = `${sourceSupervisorPath}.trusted-test-backup-${process.pid}`;
    const supervisorBytes = readFileSync(packagedSupervisorPath);
    await closeWindowsAuthorityCapability();
    renameSync(packagedSupervisorPath, packagedSupervisorBackup);
    renameSync(sourceSupervisorPath, sourceSupervisorBackup);
    try {
      await assert.rejects(exerciseWindowsAuthorityCapabilityForNativeTest(), /HELPER_OPEN|capability|authority/);
    } finally {
      renameSync(sourceSupervisorBackup, sourceSupervisorPath);
      renameSync(packagedSupervisorBackup, packagedSupervisorPath);
    }
    renameSync(packagedSupervisorPath, packagedSupervisorBackup);
    try {
      writeFileSync(packagedSupervisorPath, 'tampered packaged supervisor', { flag: 'wx', mode: 0o600 });
      await assert.rejects(exerciseWindowsAuthorityCapabilityForNativeTest(), /HELPER_HASH|capability|authority/);
    } finally {
      rmSync(packagedSupervisorPath, { force: true });
      renameSync(packagedSupervisorBackup, packagedSupervisorPath);
    }
    let supervisorWrongIdentityObserved = false;
    try {
      await assert.rejects(exerciseWindowsAuthorityCapabilityForNativeTest({
        onSupervisorStarting: ({ helperPath }) => {
          const detached = `${helperPath}.wrong-identity`;
          renameSync(helperPath, detached);
          writeFileSync(helperPath, supervisorBytes, { flag: 'wx', mode: 0o600 });
          supervisorWrongIdentityObserved = true;
        },
      }), /HELPER_IDENTITY|capability|authority/);
      assert.equal(supervisorWrongIdentityObserved, true);
    } finally {
      rmSync(packagedSupervisorPath, { force: true });
      if (existsSync(`${packagedSupervisorPath}.wrong-identity`)) {
        renameSync(`${packagedSupervisorPath}.wrong-identity`, packagedSupervisorPath);
      }
    }
    const preLockControl = nativeFixtureParent('propr-bootstrap-before-lock-');
    try {
      await assert.rejects(exerciseWindowsAuthorityCapabilityForNativeTest({
        onPackagedBrokerLocked: (packagedBrokerPath) => {
          const attacker = join(process.cwd(), 'test', 'fixtures', 'windowsAuthorityReplacementAttacker.exe');
          const attackerSource = join(process.cwd(), 'test', 'fixtures', 'windowsAuthorityReplacementAttacker.c');
          const marker = join(dirname(packagedBrokerPath), 'packaged-broker-attacker-executed');
          assert.equal(sha256Digest(readFileSync(attackerSource)), WINDOWS_REPLACEMENT_ATTACKER_SOURCE_SHA256);
          assert.equal(sha256Digest(readFileSync(attacker)), WINDOWS_REPLACEMENT_ATTACKER_SHA256);
          assert.throws(() => renameSync(packagedBrokerPath, `${packagedBrokerPath}.trusted-detached`));
          assert.throws(() => copyFileSync(attacker, packagedBrokerPath));
          assert.throws(() => lstatSync(marker), /ENOENT/);
          throw new Error('packaged broker pre-CreateProcess lease observed');
        },
      }), /capability|authority|lease observed/);
      completeScenario('packaged-helper-integrity');
    } finally {
      rmSync(preLockControl, { recursive: true, force: true });
    }

    const buildEvidenceReceipt = process.env.PROPR_WINDOWS_BUILD_EVIDENCE_RECEIPT;
    assert.ok(buildEvidenceReceipt, 'hosted production build evidence receipt is required');
    const buildEvidence = JSON.parse(readFileSync(buildEvidenceReceipt, 'utf8')) as {
      version?: number;
      stages?: Array<Record<string, unknown>>;
    };
    assert.equal(buildEvidence.version, 2);
    assert.deepEqual(buildEvidence.stages?.map((item) => item.stage), [
      'BUILD_COMPILER', 'BUILD_SOURCE', 'BUILD_OUTPUT',
    ]);
    assert.deepEqual(buildEvidence.stages?.map((item) => [
      item.nonceAuthenticated, item.hookAuthenticated, item.mutationAttempted, item.mutationDenied,
      item.childAndJobsTerminated, item.publishedArtifactsChanged, item.baselineArtifactsChanged,
      item.stagingResidueChanged,
    ]), [
      [true, true, true, true, true, 0, 0, 0],
      [true, true, true, true, true, 0, 0, 0],
      [true, true, true, true, true, 0, 0, 0],
    ]);
    completeScenario('atomic-publication');

    const startupControl = nativeFixtureParent('propr-supervisor-startup-swap-');
    try {
      let swapFired = false;
      let startupDirectory = '';
      await assert.rejects(exerciseWindowsAuthorityCapabilityForNativeTest({
        onSupervisorSpawned: (stagedPath) => {
          startupDirectory = dirname(stagedPath);
          swapFired = true;
          assert.throws(() => renameSync(stagedPath, `${stagedPath}.startup-detached`));
          assert.throws(() => copyFileSync(command, stagedPath));
          throw new Error('native launcher lease barrier observed');
        },
      }), /capability|authority|lease barrier/);
      assert.equal(swapFired, true, 'startup swap hook did not execute');
      assert.throws(() => lstatSync(startupDirectory), /ENOENT/);
      completeScenario('identity-mismatch-cleanup');
      completeScenario('cleanup-swap');
    } finally {
      await closeWindowsAuthorityCapability();
      rmSync(startupControl, { recursive: true, force: true });
    }

    let invalidHandleCleanupDirectory = '';
    await assert.rejects(exerciseWindowsAuthorityCapabilityForNativeTest({
      testFailureStage: 'JOB_ASSIGN',
      onSupervisorStarting: ({ stagedPath }) => {
        invalidHandleCleanupDirectory = dirname(stagedPath);
        writeFileSync(join(invalidHandleCleanupDirectory, 'unexpected-cleanup-content'), 'content');
      },
    }), /JOB_ASSIGN|capability|authority/);
    assert.throws(() => lstatSync(invalidHandleCleanupDirectory), /ENOENT/);
    completeScenario('invalid-handle-cleanup');
    completeScenario('contents-cleanup');

    const deniedHooks = { write: false, delete: false, rename: false, replace: false };
    const deniedHelperHooks = { write: false, delete: false, rename: false, replace: false };
    let heldHelperPath = '';

    const provenance = exerciseWindowsHelperProvenanceForNativeTest();
    assert.equal(provenance.version, 2);
    assert.equal(provenance.protocolVersion, 2);
    assert.match(provenance.sourceSha256, /^[0-9a-f]{64}$/);
    assert.match(provenance.launcherSourceSha256, /^[0-9a-f]{64}$/);
    assert.match(provenance.helperSha256, /^[0-9a-f]{64}$/);
    assert.match(provenance.launcherSha256, /^[0-9a-f]{64}$/);
    assert.match(provenance.bootstrapSourceSha256, /^[0-9a-f]{64}$/);
    assert.match(provenance.bootstrapSha256, /^[0-9a-f]{64}$/);
    assert.equal(provenance.signerPinsBound, provenance.trustMode === 'production-signed');
    assert.equal(provenance.noRuntimeCompilerWorkspace, true);

    const buildLeaseDirectory = nativeFixtureParent('propr-build-input-leases-');
    const bootstrapPath = join(process.cwd(), 'packages', 'cli', 'dist', 'native', 'prebuilds',
      'win32-x64', 'connect-authority-bootstrap.exe');
    const bootstrapFd = openSync(bootstrapPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const buildInputs = ['compiler.exe', 'linker.exe', 'reference.dll', 'source.cs', 'include.h', 'library.lib']
      .map((name) => join(buildLeaseDirectory, name));
    const leaseManifest = join(buildLeaseDirectory, 'inputs.lease');
    const progressKeyPath = join(buildLeaseDirectory, 'progress.key');
    const progressKey = Buffer.alloc(32, 0x5a);
    const progressNonce = 'ab'.repeat(32);
    const writeLeaseManifest = (tool = false) => {
      const body = `PROPR_BUILD_LEASE_V1\n${buildInputs.map((path, index) =>
        tool && index === 0
          ? `T ${sha256Digest(readFileSync(path))} E ${'0'.repeat(64)} ${'0'.repeat(64)} ${path}\n`
          : `F ${sha256Digest(readFileSync(path))} ${path}\n`).join('')}`;
      writeFileSync(leaseManifest, body, { mode: 0o600 });
      return sha256Digest(body);
    };
    try {
      for (const path of buildInputs) writeFileSync(path, `trusted:${basename(path)}\n`, { mode: 0o600 });
      writeFileSync(progressKeyPath, progressKey, { mode: 0o600 });
      await protectWindowsSetupEntries([
        { path: buildLeaseDirectory, kind: 'directory' },
        ...buildInputs.map((path) => ({ path, kind: 'file' as const })),
      ]);
      await closeWindowsAuthorityCapability();
      const leaseArgs = (digest: string) => [
        'lease-build-inputs-v1', leaseManifest, digest, '1', '1', '0', String(buildInputs.length), '0',
        String(buildInputs.reduce((total, path) => total + Number(lstatSync(path).size), 0)), progressNonce,
      ];
      const runLeaseSync = (digest: string) => {
        const progressKeyFd = openSync(progressKeyPath, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          return spawnSync(bootstrapPath, leaseArgs(digest), {
            shell: false, windowsHide: true, env: {}, encoding: 'buffer', input: Buffer.from('X'),
            stdio: ['pipe', 'pipe', 'pipe', bootstrapFd, progressKeyFd],
          });
        } finally {
          closeSync(progressKeyFd);
        }
      };
      const expectedProgress = () => {
        const totalBytes = buildInputs.reduce((total, path) => total + Number(lstatSync(path).size), 0);
        const body = `PROPR_BUILD_LEASE_PROGRESS_V2 1/1 ${buildInputs.length}/${buildInputs.length} ${totalBytes}/${totalBytes} ${progressNonce}`;
        return Buffer.from(`${body} ${createHmac('sha256', progressKey).update(body).digest('hex')}\n`);
      };
      let manifestDigest = writeLeaseManifest();
      let leaseResult = runLeaseSync(manifestDigest);
      assert.equal(leaseResult.status, 0);
      assert.deepEqual(leaseResult.stdout, expectedProgress());
      assert.deepEqual(leaseResult.stderr, Buffer.alloc(0));

      manifestDigest = writeLeaseManifest();
      writeFileSync(buildInputs[3], 'same-user source replacement\n');
      leaseResult = runLeaseSync(manifestDigest);
      assert.equal(leaseResult.status, 23);
      assert.deepEqual(leaseResult.stdout, Buffer.alloc(0));
      assert.deepEqual(leaseResult.stderr, Buffer.alloc(0));

      writeFileSync(buildInputs[3], `trusted:${basename(buildInputs[3])}\n`);
      await protectWindowsSetupEntry(buildInputs[3], 'file');
      copyFileSync(join(process.cwd(), 'test', 'fixtures', 'windowsAuthorityReplacementAttacker.exe'), buildInputs[0]);
      await protectWindowsSetupEntry(buildInputs[0], 'file');
      manifestDigest = writeLeaseManifest(true);
      leaseResult = runLeaseSync(manifestDigest);
      assert.equal(leaseResult.status, 23, 'unsigned wrong-signer tool passed the catalog/signature rule');

      writeFileSync(buildInputs[0], `trusted:${basename(buildInputs[0])}\n`);
      await protectWindowsSetupEntry(buildInputs[0], 'file');
      grantBroadWrite(buildInputs[2], false);
      manifestDigest = writeLeaseManifest();
      leaseResult = runLeaseSync(manifestDigest);
      assert.equal(leaseResult.status, 23, 'arbitrary writable input ACL passed the native rule');
      await protectWindowsSetupEntry(buildInputs[2], 'file');

      manifestDigest = writeLeaseManifest();
      const liveProgressKeyFd = openSync(progressKeyPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      const leaseChild = spawn(bootstrapPath, leaseArgs(manifestDigest), {
        shell: false, windowsHide: true, env: {}, stdio: ['pipe', 'pipe', 'pipe', bootstrapFd, liveProgressKeyFd],
      });
      closeSync(liveProgressKeyFd);
      await new Promise<void>((resolveReady, rejectReady) => {
        const timer = setTimeout(() => rejectReady(new Error('build lease barrier timed out')), 5_000);
        leaseChild.once('error', rejectReady);
        leaseChild.stdout.once('data', (chunk) => {
          clearTimeout(timer);
          if (!Buffer.from(chunk).equals(expectedProgress())) rejectReady(new Error('build lease readiness malformed'));
          else resolveReady();
        });
      });
      for (const path of buildInputs) {
        assert.throws(() => writeFileSync(path, 'ABA attacker'));
        assert.throws(() => unlinkSync(path));
        assert.throws(() => renameSync(path, `${path}.attacker`));
      }
      leaseChild.stdin.end(Buffer.from('X'));
      const leaseExit = await new Promise<number | null>((resolveExit) => leaseChild.once('exit', resolveExit));
      assert.equal(leaseExit, 0);
    } finally {
      closeSync(bootstrapFd);
      rmSync(buildLeaseDirectory, { recursive: true, force: true });
    }

    const attackerResultPath = join(tmpdir(), `propr-control-handle-attacker-${process.pid}.json`);
    rmSync(attackerResultPath, { force: true });
    let concurrentRequest: Promise<Awaited<ReturnType<typeof exerciseWindowsAuthorityCapabilityForNativeTest>>> | undefined;
    let installedServiceIdentity: InstalledAuthorityIdentity | undefined;
    let installedPackagedBrokerPath: string | undefined;
    const locked = await exerciseWindowsAuthorityCapabilityForNativeTest({
      onInstalledAuthorityAuthorized: async ({
        imagePath, volumeSerialNumber, fileId, sha256, authenticodeLeafSha256,
        authenticodeSpkiSha256, servicePid, packagedBrokerPath,
      }) => {
        assert.match(imagePath, /^[A-Za-z]:\\Program Files\\ProPR Connect Authority\\ProPRConnectAuthority\.exe$/i);
        assert.equal(servicePid > 0 && servicePid !== process.pid, true);
        assert.match(volumeSerialNumber, /^(?:0|[1-9]\d*)$/);
        assert.match(fileId, /^(?:0|[1-9]\d*)$/);
        assert.equal(sha256Digest(readFileSync(imagePath)), sha256);
        assert.match(authenticodeLeafSha256, /^[0-9a-f]{64}$/);
        assert.match(authenticodeSpkiSha256, /^[0-9a-f]{64}$/);
        const serviceDetached = `${imagePath}.same-user-detached`;
        const brokerDetached = `${packagedBrokerPath}.same-user-detached`;
        assert.throws(() => writeFileSync(imagePath, 'same-user write'));
        assert.throws(() => unlinkSync(imagePath));
        assert.throws(() => renameSync(imagePath, serviceDetached));
        assert.throws(() => copyFileSync(replacementAttacker, imagePath));
        assert.throws(() => writeFileSync(packagedBrokerPath, 'same-user write'));
        assert.throws(() => unlinkSync(packagedBrokerPath));
        assert.throws(() => renameSync(packagedBrokerPath, brokerDetached));
        assert.throws(() => copyFileSync(replacementAttacker, packagedBrokerPath));
        assert.throws(() => lstatSync(bootstrapMarker), /ENOENT/);
        completeScenario('installed-authority-mutation');

        await new Promise<void>((resolveSpoof, rejectSpoof) => {
          const server = createServer();
          server.once('error', () => resolveSpoof());
          server.listen(WINDOWS_CONNECT_AUTHORITY_PIPE, () => {
            server.close();
            rejectSpoof(new Error('same-user pipe server replaced the installed authority'));
          });
        });

        const rawRejected = (body: Buffer) => new Promise<void>((resolveRejected, rejectRejected) => {
          const socket = connect(WINDOWS_CONNECT_AUTHORITY_PIPE);
          let received = 0;
          const timer = setTimeout(() => { socket.destroy(); rejectRejected(new Error('authority frame did not settle')); }, 5_000);
          socket.once('connect', () => socket.write(body));
          socket.on('data', (chunk) => { received += chunk.byteLength; });
          socket.once('error', () => { clearTimeout(timer); resolveRejected(); });
          socket.once('close', () => {
            clearTimeout(timer);
            if (received === 0) resolveRejected();
            else rejectRejected(new Error('rejected authority frame received a success receipt'));
          });
        });
        const frameDocument = (document: unknown) => {
          const json = Buffer.from(JSON.stringify(document));
          const framed = Buffer.alloc(json.byteLength + 4);
          framed.writeUInt32LE(json.byteLength, 0);
          json.copy(framed, 4);
          return framed;
        };
        const staleFrame = frameDocument({
          artifactPath: packagedBrokerPath, artifactSha256: sha256Digest(readFileSync(packagedBrokerPath)),
          kind: 'authorize-launch', nonce: '3'.repeat(64), requestId: '4'.repeat(32),
          serviceVersion: '2.9.0', version: 3,
        });
        const staleReceipt = await new Promise<Record<string, unknown>>((resolveReceipt, rejectReceipt) => {
          const socket = connect(WINDOWS_CONNECT_AUTHORITY_PIPE);
          let received = Buffer.alloc(0);
          let authenticated = false;
          const timer = setTimeout(() => { socket.destroy(); rejectReceipt(new Error('version mismatch did not settle')); }, 5_000);
          const authentication = frameDocument({
            kind: 'authenticate-server', nonce: '1'.repeat(64), requestId: '2'.repeat(32), version: 3,
          });
          socket.once('connect', () => socket.write(authentication));
          socket.on('data', (chunk) => {
            received = Buffer.concat([received, chunk]);
            while (received.byteLength >= 4) {
              const length = received.readUInt32LE(0);
              if (length < 2 || length > 4096 || received.byteLength < length + 4) return;
              const document = JSON.parse(received.subarray(4, length + 4).toString('utf8')) as Record<string, unknown>;
              received = received.subarray(length + 4);
              if (!authenticated) {
                assert.equal(document.kind, 'server-authenticated');
                assert.equal(document.requestId, '2'.repeat(32));
                assert.equal(document.nonce, '1'.repeat(64));
                assert.equal(document.serverPid, String(servicePid));
                assert.equal(document.accountSid, 'S-1-5-18');
                assert.match(String(document.serviceSid), /^S-1-5-80-(?:(?:0|[1-9]\d{0,9})-){4}(?:0|[1-9]\d{0,9})$/);
                authenticated = true;
                socket.write(staleFrame);
              } else {
                clearTimeout(timer);
                socket.destroy();
                resolveReceipt(document);
              }
            }
          });
          socket.once('error', rejectReceipt);
        });
        assert.deepEqual(staleReceipt, {
          kind: 'version-mismatch', nonce: '3'.repeat(64), requestId: '4'.repeat(32),
          serviceVersion: '3.0.0', version: 3,
        });
        completeScenario('authority-version');
        completeScenario('authority-client');

        const expectedService: InstalledAuthorityIdentity = {
          serviceVersion: '3.0.0', imagePath, volumeSerialNumber, fileId, sha256,
          authenticodeLeafSha256, authenticodeSpkiSha256,
        };
        installedServiceIdentity = expectedService;
        installedPackagedBrokerPath = packagedBrokerPath;
        const replayId = '5'.repeat(32);
        const abandoned = await acquireInstalledWindowsLaunchLease({
          path: packagedBrokerPath, sha256: sha256Digest(readFileSync(packagedBrokerPath)),
        }, expectedService, { requestId: replayId, nonce: '6'.repeat(64) });
        await assert.rejects(abandoned.release());
        await assert.rejects(acquireInstalledWindowsLaunchLease({
          path: packagedBrokerPath, sha256: sha256Digest(readFileSync(packagedBrokerPath)),
        }, expectedService, { requestId: replayId, nonce: '7'.repeat(64) }));
        completeScenario('authority-replay');

        const oversized = Buffer.alloc(4);
        oversized.writeUInt32LE(4097, 0);
        await rawRejected(oversized);
        await rawRejected(frameDocument({ version: 3, unexpected: true }));
        completeScenario('authority-frames');
      },
      onSupervisorStarting: ({
        stagedPath, helperPath, environmentKeys, executable, packagedBrokerPath, constantArgv, manifest,
      }) => {
        heldHelperPath = helperPath;
        assert.deepEqual(environmentKeys, []);
        assert.equal(environmentKeys.some((key) => key.startsWith('PROPR_')), false);
        assert.equal(environmentKeys.includes(stagedPath), false);
        assert.deepEqual(constantArgv, ['--lease-validation-v2']);
        assert.notEqual(executable, stagedPath);
        assert.match(executable, /prebuilds[\\/]win32-x64[\\/]connect-authority-broker\.exe$/i);
        assert.match(packagedBrokerPath, /prebuilds[\\/]win32-x64[\\/]connect-authority-broker\.exe$/i);
        assert.equal(manifest.protocolVersion, 2);
        assert.equal(manifest.pe.architecture, 'anycpu');
        assert.equal(manifest.pe.managed, true);
        assert.ok(['vs2026-18.9-x64', 'vs2026-18.9-arm64', 'vs2022-17.14-x64'].includes(manifest.build.toolchainProfile));
        assert.deepEqual(manifest.build.toolSigners.map((item) => [item.name, item.signatureKind]), [
          ['compiler', 'E'], ['native-compiler', 'E'], ['native-linker', 'E'],
        ]);
        for (const signer of manifest.build.toolSigners) {
          assert.match(signer.authenticodeLeafSha256, /^[0-9a-f]{64}$/);
          assert.match(signer.authenticodeSpkiSha256, /^[0-9a-f]{64}$/);
        }
        const dependencyPolicies = {
          'vs2026-18.9-x64': [
            { name: 'roslyn-runtime', sha256: 'd4630911fcc8edd9ea0581c2d905270790b0f3de2b212d4f8a9a8b2164d016e5', files: 111, bytes: '35634755' },
            { name: 'msvc-host-runtime', sha256: '779b6b9ee8d67c416e88a3cb0ec65b83cfb89c1159b8c458183cf2def96bcb13', files: 84, bytes: '126253430' },
          ],
          'vs2026-18.9-arm64': [
            { name: 'roslyn-runtime', sha256: '65c926bb608189705239c90f011b52a1f493d569d00027468cdb5961aa21d026', files: 111, bytes: '35633203' },
            { name: 'msvc-host-runtime', sha256: '779b6b9ee8d67c416e88a3cb0ec65b83cfb89c1159b8c458183cf2def96bcb13', files: 84, bytes: '126253430' },
          ],
          'vs2022-17.14-x64': [
          {
            name: 'roslyn-runtime',
            sha256: '72f9aafb187eb7db512466571374fc33d22d3120d1341c2bc6315c4e5e8b2209',
            files: 111,
            bytes: '38581501',
          },
          {
            name: 'msvc-host-runtime',
            sha256: 'b2e20ac87ae5c38d72a2c6c6d2dbcfb013978b9e0240717656cd14b2d7957ac2',
            files: 53,
            bytes: '62411793',
          },
          ],
        } as const;
        assert.deepEqual(manifest.build.toolDependencies, [
          ...dependencyPolicies[manifest.build.toolchainProfile as keyof typeof dependencyPolicies],
          {
            name: 'wix-runtime',
            sha256: '732cdbb86eda6156f859cda583c0e1632e0c1a213aaabc6bee052e335549b298',
            files: 33,
            bytes: '31929694',
          },
        ]);
      },
      onSupervisorSpawned: (stagedPath, supervisorPid) => {
        assert.match(stagedPath, /broker-[0-9a-f-]+\.exe$/);
        assert.equal(Number.isInteger(supervisorPid) && supervisorPid > 0, true);
      },
      onRequestLocked: async (stagedPath, supervisorPid) => {
        const fixture = join(process.cwd(), 'test', 'fixtures', 'windowsAuthorityHandleAttacker.mjs');
        const attacker = spawn(process.execPath, [fixture, attackerResultPath, String(supervisorPid)], {
          stdio: 'ignore', windowsHide: true, env: { SystemRoot: process.env.SystemRoot },
        });
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('unrelated hostile process timed out')), 8_000);
          attacker.once('error', reject);
          attacker.once('exit', () => { clearTimeout(timer); resolve(); });
        });
        assert.equal(existsSync(attackerResultPath), true, 'unrelated hostile process did not complete');
        const attackerResult = JSON.parse(readFileSync(attackerResultPath, 'utf8')) as {
          inheritedControlHandle: boolean;
          advertisedCapability: boolean;
          deniedRights: { duplicate: boolean; vmRead: boolean; query: boolean };
        };
        assert.deepEqual(attackerResult, {
          inheritedControlHandle: false,
          advertisedCapability: false,
          deniedRights: { duplicate: false, vmRead: false, query: false },
        });
        completeScenario('forged-control-pipes');
        completeScenario('extra-child-denied');
        deniedHooks.write = true;
        assert.throws(() => writeFileSync(stagedPath, 'attacker'));
        deniedHooks.delete = true;
        assert.throws(() => unlinkSync(stagedPath));
        deniedHooks.rename = true;
        assert.throws(() => renameSync(stagedPath, `${stagedPath}.attacker`));
        deniedHooks.replace = true;
        assert.throws(() => copyFileSync(command, stagedPath));
        deniedHelperHooks.write = true;
        assert.throws(() => writeFileSync(heldHelperPath, 'attacker'));
        deniedHelperHooks.delete = true;
        assert.throws(() => unlinkSync(heldHelperPath));
        deniedHelperHooks.rename = true;
        assert.throws(() => renameSync(heldHelperPath, `${heldHelperPath}.attacker`));
        deniedHelperHooks.replace = true;
        assert.throws(() => copyFileSync(command, heldHelperPath));
        concurrentRequest = exerciseWindowsAuthorityCapabilityForNativeTest();
      },
    });
    rmSync(attackerResultPath, { force: true });
    assert.deepEqual(deniedHooks, { write: true, delete: true, rename: true, replace: true });
    assert.deepEqual(deniedHelperHooks, { write: true, delete: true, rename: true, replace: true });
    assert.equal(locked.stage, 'READY', 'hosted positive startup did not reach READY');
    assert.deepEqual(JSON.parse(locked.output.toString('utf8')), { version: 1, ready: true });
    assert.throws(() => renameSync(locked.stagedPath, `${locked.stagedPath}.between-requests`));
    const betweenRequests = await concurrentRequest!;
    assert.equal(betweenRequests.stagedPath, locked.stagedPath);
    assert.equal(betweenRequests.supervisorPid, locked.supervisorPid);
    assert.deepEqual(JSON.parse(betweenRequests.output.toString('utf8')), { version: 1, ready: true });

    const lockedIdentity = lstatSync(locked.stagedPath, { bigint: true });
    let replacementFired = false;
    let replacementChangedIdentity = false;
    let pathRestored = false;
    await assert.rejects(exerciseWindowsAuthorityCapabilityForNativeTest({
      onRequestLocked: async (stagedPath, supervisorPid) => {
        process.kill(supervisorPid);
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline) {
          try { process.kill(supervisorPid, 0); } catch { break; }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        const detached = `${stagedPath}.trusted-detached`;
        renameSync(stagedPath, detached);
        copyFileSync(command, stagedPath);
        replacementFired = true;
        const attackerIdentity = lstatSync(stagedPath, { bigint: true });
        replacementChangedIdentity = attackerIdentity.dev !== lockedIdentity.dev || attackerIdentity.ino !== lockedIdentity.ino;
        unlinkSync(stagedPath);
        renameSync(detached, stagedPath);
        const restoredIdentity = lstatSync(stagedPath, { bigint: true });
        pathRestored = restoredIdentity.dev === lockedIdentity.dev && restoredIdentity.ino === lockedIdentity.ino;
      },
    }), /capability/);
    assert.equal(replacementFired, true);
    assert.equal(replacementChangedIdentity, true);
    assert.equal(pathRestored, true);
    const restarted = await exerciseWindowsAuthorityCapabilityForNativeTest();
    assert.notEqual(restarted.stagedPath, locked.stagedPath);
    assert.deepEqual(JSON.parse(restarted.output.toString('utf8')), { version: 1, ready: true });
    let eventLoopTicked = false;
    setTimeout(() => { eventLoopTicked = true; }, 0);
    const responsive = await exerciseWindowsAuthorityCapabilityForNativeTest();
    assert.equal(eventLoopTicked, true, 'documented stream exchange blocked the event loop');
    assert.equal(responsive.supervisorPid, restarted.supervisorPid);
    const aborted = new AbortController();
    aborted.abort(new Error('native cancellation sentinel'));
    await assert.rejects(
      exerciseWindowsAuthorityCapabilityForNativeTest({ signal: aborted.signal }),
      /native cancellation sentinel/,
    );
    const afterAbort = await exerciseWindowsAuthorityCapabilityForNativeTest();
    assert.equal(afterAbort.supervisorPid, restarted.supervisorPid, 'preflight abort mutated the live capability');
    completeScenario('bootstrap-aba');

    let hardlinkBarrierFired = false;
    await assert.rejects(exerciseWindowsAuthorityCapabilityForNativeTest({
      onRequestLocked: (stagedPath) => {
        linkSync(stagedPath, `${stagedPath}.attacker-hardlink`);
        hardlinkBarrierFired = lstatSync(stagedPath, { bigint: true }).nlink === 2n;
      },
    }), /capability/);
    assert.equal(hardlinkBarrierFired, true, 'hard-link mutation barrier did not alter the held helper');

    const afterHardlink = await exerciseWindowsAuthorityCapabilityForNativeTest();
    let reparseBarrierFired = false;
    await assert.rejects(exerciseWindowsAuthorityCapabilityForNativeTest({
      onRequestLocked: async (stagedPath, supervisorPid) => {
        process.kill(supervisorPid);
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline) {
          try { process.kill(supervisorPid, 0); } catch { break; }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        const stagedDirectory = dirname(stagedPath);
        const detachedDirectory = `${stagedDirectory}.trusted-detached`;
        const attackerDirectory = `${stagedDirectory}.attacker-target`;
        mkdirSync(attackerDirectory);
        copyFileSync(command, join(attackerDirectory, basename(stagedPath)));
        renameSync(stagedDirectory, detachedDirectory);
        createWindowsJunction(stagedDirectory, attackerDirectory);
        reparseBarrierFired = lstatSync(stagedDirectory).isSymbolicLink();
        rmSync(stagedDirectory, { recursive: true, force: true });
        renameSync(detachedDirectory, stagedDirectory);
        rmSync(attackerDirectory, { recursive: true, force: true });
      },
    }), /capability/);
    assert.equal(reparseBarrierFired, true, 'reparse mutation barrier did not alter the helper path boundary');
    const afterReparse = await exerciseWindowsAuthorityCapabilityForNativeTest();
    assert.notEqual(afterReparse.stagedPath, afterHardlink.stagedPath);

    await assert.rejects(exerciseWindowsAuthorityCapabilityForNativeTest({ args: ['batch-v1'] }), /capability/);
    const afterRejectedCommand = await exerciseWindowsAuthorityCapabilityForNativeTest();
    assert.equal(afterRejectedCommand.stagedPath, afterReparse.stagedPath);

    const unboundResponse = await exerciseWindowsAuthorityCapabilityControlForNativeTest({ mode: 'unparsed-response' });
    assert.ok(unboundResponse.byteLength > 0, 'unparsed response hook did not fire');
    await assert.rejects(exerciseWindowsAuthorityCapabilityForNativeTest(), /capability/);
    const protocolRestarted = await exerciseWindowsAuthorityCapabilityForNativeTest();
    assert.notEqual(protocolRestarted.stagedPath, afterRejectedCommand.stagedPath);
    assert.deepEqual(JSON.parse(protocolRestarted.output.toString('utf8')), { version: 1, ready: true });

    for (const mode of ['replay', 'wrong-request-id', 'wrong-identity', 'malformed', 'partial-frame', 'eof'] as const) {
      await assert.rejects(
        exerciseWindowsAuthorityCapabilityControlForNativeTest({ mode }),
        /capability|malformed|extra output/,
      );
      const recovered = await exerciseWindowsAuthorityCapabilityForNativeTest();
      assert.deepEqual(JSON.parse(recovered.output.toString('utf8')), { version: 1, ready: true });
    }
    for (const mode of [
      'extra-frame', 'stderr', 'stdout-error', 'stdin-error', 'process-error',
      'unexpected-eof', 'unexpected-exit', 'timeout', 'abort',
    ] as const) {
      const poisoned = exerciseWindowsAuthorityCapabilityControlForNativeTest({ mode });
      const queued = exerciseWindowsAuthorityCapabilityForNativeTest();
      await assert.rejects(poisoned, /capability|malformed|extra output|timed out|aborted|settling/);
      await assert.rejects(queued, /capability/);
      const recovered = await exerciseWindowsAuthorityCapabilityForNativeTest();
      assert.deepEqual(JSON.parse(recovered.output.toString('utf8')), { version: 1, ready: true });
    }
    completeScenario('settling-race');
    const afterFramingRecovery = await exerciseWindowsAuthorityCapabilityForNativeTest();

    process.kill(afterFramingRecovery.supervisorPid);
    const crashDeadline = Date.now() + 5_000;
    while (Date.now() < crashDeadline) {
      try { process.kill(afterFramingRecovery.supervisorPid, 0); } catch { break; }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.throws(() => process.kill(afterFramingRecovery.authorityPid, 0));
    completeScenario('job-kill-on-close');
    await assert.rejects(exerciseWindowsAuthorityCapabilityForNativeTest(), /capability/);
    const [queuedFirst, queuedSecond] = await Promise.all([
      Promise.resolve().then(() => exerciseWindowsAuthorityCapabilityForNativeTest()),
      Promise.resolve().then(() => exerciseWindowsAuthorityCapabilityForNativeTest()),
    ]);
    assert.equal(queuedSecond.stagedPath, queuedFirst.stagedPath);
    assert.equal(queuedSecond.supervisorPid, queuedFirst.supervisorPid);

    await closeWindowsAuthorityCapability();
    assert.throws(() => lstatSync(queuedSecond.directory), /ENOENT/);
    assert.throws(() => process.kill(queuedSecond.supervisorPid, 0));
    assert.throws(() => process.kill(queuedSecond.authorityPid, 0));
    completeScenario('launcher-unload');
    completeScenario('handle-leak');

    const helperManifestPath = join(dirname(heldHelperPath), 'connect-authority-supervisor.manifest.json');
    const helperManifestBytes = readFileSync(helperManifestPath);
    try {
      writeFileSync(helperManifestPath, '{"attacker":true}\n');
      await assert.rejects(exerciseWindowsAuthorityCapabilityForNativeTest(), /MANIFEST|capability|authority/);
      completeScenario('helper-manifest');
      const provenanceAttack = JSON.parse(helperManifestBytes.toString('utf8')) as Record<string, unknown>;
      provenanceAttack.sourceSha256 = '0'.repeat(64);
      writeFileSync(helperManifestPath, `${JSON.stringify(provenanceAttack)}\n`);
      await assert.rejects(exerciseWindowsAuthorityCapabilityForNativeTest(), /MANIFEST|capability|authority/);
      completeScenario('helper-build-provenance');
    } finally {
      writeFileSync(helperManifestPath, helperManifestBytes);
    }
    const afterManifestAttacks = await exerciseWindowsAuthorityCapabilityForNativeTest();
    await closeWindowsAuthorityCapability();
    assert.throws(() => lstatSync(afterManifestAttacks.directory), /ENOENT/);

    const compilerHookDirectory = nativeFixtureParent('propr-runtime-compiler-hook-');
    const compilerHookMarker = join(compilerHookDirectory, 'invoked');
    const previousPath = process.env.PATH;
    const previousPathext = process.env.PATHEXT;
    try {
      for (const tool of ['powershell', 'csc', 'cl', 'link']) {
        writeFileSync(join(compilerHookDirectory, `${tool}.cmd`), `@echo hook>"${compilerHookMarker}"\r\n@exit /b 91\r\n`);
      }
      process.env.PATH = compilerHookDirectory;
      process.env.PATHEXT = '.CMD';
      const hookAttempt = await exerciseWindowsAuthorityCapabilityForNativeTest();
      await closeWindowsAuthorityCapability();
      assert.throws(() => lstatSync(compilerHookMarker), /ENOENT/);
      assert.throws(() => lstatSync(hookAttempt.directory), /ENOENT/);
      completeScenario('no-runtime-compiler');
    } finally {
      if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
      if (previousPathext === undefined) delete process.env.PATHEXT; else process.env.PATHEXT = previousPathext;
      rmSync(compilerHookDirectory, { recursive: true, force: true });
    }

    assert.ok(installedServiceIdentity && installedPackagedBrokerPath);
    const replayWindowProof = spawnSync(installedServiceIdentity.imagePath!, ['--validation-replay-window-v1'], {
      shell: false, windowsHide: true, encoding: 'utf8', timeout: 5_000,
    });
    assert.equal(replayWindowProof.status, 0, replayWindowProof.stderr);
    assert.equal(replayWindowProof.stderr, '');
    assert.deepEqual(JSON.parse(replayWindowProof.stdout), {
      bounded: true, concurrent: true, expiry: true, version: 1,
    });

    const partialClients = Array.from({ length: 8 }, () => new Promise<void>((resolveClosed, rejectClosed) => {
      const socket = connect(WINDOWS_CONNECT_AUTHORITY_PIPE);
      const timer = setTimeout(() => { socket.destroy(); rejectClosed(new Error('partial authority client did not expire')); }, 8_000);
      socket.once('connect', () => {
        const partial = Buffer.alloc(5);
        partial.writeUInt32LE(128, 0);
        partial[4] = 0x7b;
        socket.write(partial);
      });
      socket.once('error', (error) => { clearTimeout(timer); rejectClosed(error); });
      socket.once('close', () => { clearTimeout(timer); resolveClosed(); });
    }));
    await Promise.all(partialClients);
    const afterStarvation = await acquireInstalledWindowsLaunchLease({
      path: installedPackagedBrokerPath,
      sha256: sha256Digest(readFileSync(installedPackagedBrokerPath)),
    }, installedServiceIdentity);
    await assert.rejects(afterStarvation.release());

    const lifecycleSocket = connect(WINDOWS_CONNECT_AUTHORITY_PIPE);
    await new Promise<void>((resolveConnected, rejectConnected) => {
      lifecycleSocket.once('connect', resolveConnected);
      lifecycleSocket.once('error', rejectConnected);
    });
    const partialFrame = Buffer.alloc(5);
    partialFrame.writeUInt32LE(128, 0);
    partialFrame[4] = 0x7b;
    lifecycleSocket.write(partialFrame);
    const lifecycleClosed = new Promise<void>((resolveClosed) => lifecycleSocket.once('close', () => resolveClosed()));
    const serviceControl = join(process.env.SystemRoot ?? String.raw`C:\Windows`, 'System32', 'sc.exe');
    const stopped = spawnSync(serviceControl, ['stop', 'ProPRConnectAuthority'], {
      shell: false, windowsHide: true, encoding: 'utf8', timeout: 15_000,
    });
    assert.equal(stopped.status, 0, 'installed authority service could not be stopped during a partial request');
    await lifecycleClosed;
    const squatterFrame = (document: unknown) => {
      const body = Buffer.from(JSON.stringify(document));
      const value = Buffer.alloc(body.byteLength + 4);
      value.writeUInt32LE(body.byteLength, 0);
      body.copy(value, 4);
      return value;
    };
    const squatter = createServer((socket) => {
      // A same-user owner may claim every old receipt field. The installed
      // verifier must reject its kernel PID/session/image/ACL before trusting it.
      socket.on('data', () => socket.write(squatterFrame({
        accountSid: 'S-1-5-18', daclProtected: true,
        fileId: installedServiceIdentity!.fileId, imagePath: installedServiceIdentity!.imagePath,
        kind: 'server-authenticated', nonce: '1'.repeat(64), requestId: '2'.repeat(32),
        serverPid: String(process.pid), serviceSid: 'S-1-5-80-1-2-3-4-5',
        sha256: installedServiceIdentity!.sha256, version: 3,
        volumeSerialNumber: installedServiceIdentity!.volumeSerialNumber,
      })));
    });
    await new Promise<void>((resolveListening, rejectListening) => {
      squatter.once('error', rejectListening);
      squatter.listen(WINDOWS_CONNECT_AUTHORITY_PIPE, resolveListening);
    });
    try {
      await assert.rejects(acquireInstalledWindowsLaunchLease({
        path: installedPackagedBrokerPath,
        sha256: sha256Digest(readFileSync(installedPackagedBrokerPath)),
      }, installedServiceIdentity));
    } finally {
      await new Promise<void>((resolveClosed) => squatter.close(() => resolveClosed()));
    }
    completeScenario('authority-pipe-spoof');
    await assert.rejects(new Promise<void>((resolveUnexpected, rejectAbsent) => {
      const socket = connect(WINDOWS_CONNECT_AUTHORITY_PIPE);
      socket.once('connect', () => { socket.destroy(); resolveUnexpected(); });
      socket.once('error', rejectAbsent);
    }));
    assert.throws(() => lstatSync(bootstrapMarker), /ENOENT/);
    const started = spawnSync(serviceControl, ['start', 'ProPRConnectAuthority'], {
      shell: false, windowsHide: true, encoding: 'utf8', timeout: 15_000,
    });
    assert.equal(started.status, 0, 'installed authority service could not be restarted after lifecycle evidence');
    const restartDeadline = Date.now() + 10_000;
    while (true) {
      try {
        await new Promise<void>((resolveConnected, rejectConnected) => {
          const socket = connect(WINDOWS_CONNECT_AUTHORITY_PIPE);
          socket.once('connect', () => { socket.destroy(); resolveConnected(); });
          socket.once('error', rejectConnected);
        });
        break;
      } catch {
        if (Date.now() >= restartDeadline) throw new Error('installed authority service did not restart');
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
      }
    }
    completeScenario('authority-lifecycle');
  }
});

test('native reparse, replacement, and inspection-path swap never authorize another held object', { timeout: 20_000 }, async (t) => {
  if (!nativeOnly(t)) return;
  const parent = nativeFixtureParent('propr-native-swap-');
  try {
    const root = await makeStack(parent, 'real');
    const alias = join(parent, 'alias');
    if (process.platform === 'win32') {
      createWindowsJunction(alias, root);
    } else {
      symlinkSync(root, alias, 'dir');
    }
    await assert.rejects(
      withOwnedConnectRootSnapshot(alias, () => undefined, { parseEnvFile: () => ({}) }),
      (error) => isFixedInvalidRoot(error, 'REPARSE_POINT'),
    );
    completeScenario('reparse');

    let replaced = false;
    await assert.rejects(withOwnedConnectRootSnapshot(root, () => undefined, {
      parseEnvFile: () => ({}),
      onBoundary: async (boundary) => {
        if (boundary !== 'acquired' || replaced) return;
        replaced = true;
        if (process.platform === 'win32') {
          const envPath = join(root, '.env');
          renameSync(envPath, `${envPath}.detached`);
          writeFileSync(envPath, 'PROPR_STACK=replacement\n', { mode: 0o600 });
          await protectWindowsSetupEntry(envPath, 'file');
        } else {
          renameSync(root, `${root}.detached`);
          await makeStack(parent, 'real');
        }
      },
    }), (error) => process.platform === 'win32'
      ? error instanceof ConnectRootError && ['NAMED_REPLACED', 'INVALID_ROOT'].includes(error.reason)
      : isFixedInvalidRoot(error));
    assert.equal(replaced, true);
    completeScenario('replacement-barrier');

    const unsafeRoot = await makeStack(parent, 'unsafe');
    const unsafe = join(unsafeRoot, '.env');
    grantBroadWrite(unsafe, false);
    const safe = join(unsafeRoot, '.env.safe');
    writeFileSync(safe, 'PROPR_STACK=safe\n', { mode: 0o600 });
    chmodSync(safe, 0o600);
    if (process.platform === 'win32') await protectWindowsSetupEntry(safe, 'file');
    let swapped = false;
    let heldInspectionProven = false;
    const inspector = {
      inspectDarwinAcl(path: string, fd: number, identity: { device: string; file: string }) {
        if (!swapped && path === unsafe) {
          const before = stableAuthorityIdentity(fd);
          swapped = true;
          renameSync(unsafe, `${unsafe}.held`);
          renameSync(safe, unsafe);
          const namedFd = openSync(unsafe, constants.O_RDONLY | constants.O_NOFOLLOW);
          try {
            assert.deepEqual(stableAuthorityIdentity(fd), before);
            assert.notDeepEqual(stableAuthorityIdentity(namedFd), before);
            assert.deepEqual(identity, before);
            heldInspectionProven = true;
          } finally {
            closeSync(namedFd);
          }
        }
        return nativeConnectRootAuthorityInspector.inspectDarwinAcl(path, fd, identity);
      },
      async inspectWindowsAcl(path: string, identity: { device: string; file: string }, fd?: number, kind?: 'ancestor' | 'home' | 'root' | 'data' | 'env') {
        if (!swapped && path === unsafe) { swapped = true; renameSync(unsafe, `${unsafe}.held`); renameSync(safe, unsafe); }
        return nativeConnectRootAuthorityInspector.inspectWindowsAcl(path, identity, fd, kind);
      },
      async inspectWindowsAcls(entries: Parameters<NonNullable<typeof nativeConnectRootAuthorityInspector.inspectWindowsAcls>>[0]) {
        if (!swapped && entries.some((entry) => entry.path === unsafe)) {
          swapped = true;
          renameSync(unsafe, `${unsafe}.held`);
          renameSync(safe, unsafe);
        }
        return await nativeConnectRootAuthorityInspector.inspectWindowsAcls!(entries);
      },
    };
    await assert.rejects(withOwnedConnectRootSnapshot(unsafeRoot, () => undefined, {
      authorityInspector: inspector,
      parseEnvFile: () => ({}),
    }), process.platform === 'win32' ? /BROAD_WRITE/ : isFixedInvalidRoot);
    assert.equal(swapped, true);
    if (process.platform === 'darwin') assert.equal(heldInspectionProven, true);
    completeScenario('inspection-handle-swap');
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('native persisted tunnel config authority rejects broad ACLs and replacement', { timeout: 30_000 }, async (t) => {
  if (!nativeOnly(t)) return;
  const parent = nativeFixtureParent('propr-native-config-');
  const home = join(parent, 'home');
  const configDir = join(home, '.propr');
  const configPath = join(configDir, 'config.json');
  const root = process.platform === 'win32' ? 'C:\\Work\\Stack' : '/work/stack';
  try {
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    chmodSync(home, 0o700);
    chmodSync(configDir, 0o700);
    writeFileSync(configPath, JSON.stringify({
      profiles: { default: { githubToken: 'native-secret-sentinel' } },
      tunnelEnabledByRoot: { [root]: false },
    }), { mode: 0o600 });
    chmodSync(configPath, 0o600);
    if (process.platform === 'win32') {
      await protectWindowsSetupEntry(parent, 'directory');
      await protectWindowsSetupEntry(home, 'directory');
      await protectWindowsSetupEntry(configDir, 'directory');
      await protectWindowsSetupEntry(configPath, 'file');
    }
    const requested = process.platform === 'win32' ? 'c:\\WORK\\STACK' : root;
    assert.equal(await readTrustedConnectTunnelOverride(requested, { trustedHome: home }), false);
    completeScenario('config-off');

    writeFileSync(configPath, JSON.stringify({ tunnelEnabledByRoot: { [root]: true } }), { mode: 0o600 });
    chmodSync(configPath, 0o600);
    if (process.platform === 'win32') await protectWindowsSetupEntry(configPath, 'file');
    assert.equal(await readTrustedConnectTunnelOverride(requested, { trustedHome: home }), true);
    completeScenario('config-on');

    unlinkSync(configPath);
    assert.equal(await readTrustedConnectTunnelOverride(requested, { trustedHome: home }), undefined);
    completeScenario('config-absence');
    writeFileSync(configPath, JSON.stringify({
      tunnelEnabledByRoot: { [root]: false },
    }), { mode: 0o600 });
    chmodSync(configPath, 0o600);
    if (process.platform === 'win32') await protectWindowsSetupEntry(configPath, 'file');

    let disappeared = false;
    await assert.rejects(readTrustedConnectTunnelOverride(requested, {
      trustedHome: home,
      onBoundary: async (boundary) => {
        if (boundary === 'config-before-open') {
          disappeared = true;
          unlinkSync(configPath);
        }
      },
    }));
    assert.equal(disappeared, true);
    completeScenario('config-disappearance');
    writeFileSync(configPath, JSON.stringify({
      tunnelEnabledByRoot: { [root]: false },
    }), { mode: 0o600 });
    chmodSync(configPath, 0o600);
    if (process.platform === 'win32') await protectWindowsSetupEntry(configPath, 'file');

    grantBroadWrite(configPath, false);
    await assert.rejects(
      readTrustedConnectTunnelOverride(requested, { trustedHome: home }),
      process.platform === 'win32' ? /BROAD_WRITE/ : /unsafe|write authority/,
    );
    completeScenario('config-broad-file');
    if (process.platform === 'win32') await protectWindowsSetupEntry(configPath, 'file');
    else run('/bin/chmod', ['-a#', '0', configPath]);

    grantBroadWrite(configDir, true);
    await assert.rejects(
      readTrustedConnectTunnelOverride(requested, { trustedHome: home }),
      process.platform === 'win32' ? /BROAD_WRITE/ : /unsafe|write authority/,
    );
    completeScenario('config-broad-directory');
    if (process.platform === 'win32') await protectWindowsSetupEntry(configDir, 'directory');
    else run('/bin/chmod', ['-a#', '0', configDir]);

    const reparseHome = join(parent, 'reparse-home');
    mkdirSync(reparseHome, { mode: 0o700 });
    chmodSync(reparseHome, 0o700);
    if (process.platform === 'win32') {
      await protectWindowsSetupEntry(reparseHome, 'directory');
      createWindowsJunction(join(reparseHome, '.propr'), configDir);
    } else {
      symlinkSync(configDir, join(reparseHome, '.propr'), 'dir');
    }
    await assert.rejects(
      readTrustedConnectTunnelOverride(requested, { trustedHome: reparseHome }),
      /CONFIG_DIRECTORY_REPARSE/,
    );
    completeScenario('config-reparse');

    let swapped = false;
    await assert.rejects(readTrustedConnectTunnelOverride(requested, {
      trustedHome: home,
      onBoundary: async (boundary) => {
        if (boundary !== 'config-opened' || swapped) return;
        swapped = true;
        renameSync(configPath, `${configPath}.detached`);
        writeFileSync(configPath, JSON.stringify({ tunnelEnabledByRoot: { [root]: true } }), { mode: 0o600 });
        chmodSync(configPath, 0o600);
        if (process.platform === 'win32') await protectWindowsSetupEntry(configPath, 'file');
      },
    }), /NAMED_REPLACED|unsafe/);
    assert.equal(swapped, true);
    completeScenario('config-replacement');
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
