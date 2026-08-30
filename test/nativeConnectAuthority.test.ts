import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, closeSync, constants, copyFileSync, existsSync, linkSync, lstatSync, mkdtempSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
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
  protectWindowsSetupEntries,
  protectWindowsSetupEntry,
  stableAuthorityIdentity,
  WINDOWS_SUPERVISOR_STAGE_VALUES,
  exerciseWindowsAuthorityStageFailureForNativeTest,
} from '../packages/cli/dist/connectRootAuthority.js';
import { PUBLIC_INSTANCE_IDENTITY_FILENAME } from '@propr/shared';
import { getOrCreatePublicInstanceIdentityPinned } from '@propr/local-setup';

const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const READY = `.${PUBLIC_INSTANCE_IDENTITY_FILENAME}.ready-v1`;
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
    ? ['bootstrap-after-lock', 'bootstrap-during-launch', 'bootstrap-aba', 'bootstrap-restart']
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

test('native helper replacement is rejected before attacker bytes can execute', { timeout: 45_000 }, async (t) => {
  if (!nativeOnly(t)) return;
  const platformArch = `${process.platform}-${process.arch}`;
  const executableName = process.platform === 'win32' ? 'connect-authority-broker.exe' : 'connect-authority-broker';
  const artifact = join(process.cwd(), 'packages', 'cli', 'dist', 'native', 'prebuilds', platformArch, executableName);
  const backup = `${artifact}.trusted-test-backup-${process.pid}`;
  const marker = join(tmpdir(), `propr-attacker-marker-${process.pid}`);
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
      writeFileSync(artifact, Buffer.from('attacker-not-an-executable'), { mode: 0o600 });
    }
    await assert.rejects(assertNativeEntryAuthority(
      nativeConnectRootAuthorityInspector, process.platform, target, 'env', fd,
    ), /authority|broker|integrity|unavailable/);
    assert.throws(() => lstatSync(marker), /ENOENT/);
  } finally {
    closeSync(fd);
    if (artifactMoved) {
      try { unlinkSync(artifact); } catch { /* The replacement may already be absent. */ }
      renameSync(backup, artifact);
    }
    rmSync(marker, { force: true });
    rmSync(parent, { recursive: true, force: true });
  }
  assert.ok(readFileSync(artifact).byteLength > 0);
  if (process.platform === 'darwin') completeScenario('packaged-helper-integrity');

  if (process.platform === 'win32') {
    assert.deepEqual(WINDOWS_SUPERVISOR_STAGE_VALUES, [
      'PATH_NAME', 'CHANNEL_CREATE', 'TEMP_WORKSPACE_CREATE', 'TEMP_WORKSPACE_DACL_APPLY',
      'TEMP_WORKSPACE_DACL_VERIFY', 'SOURCE_READ', 'SOURCE_UTF8', 'SCRIPT_PARSE',
      'REFERENCE_LOAD', 'TYPE_COMPILE', 'ENTRYPOINT_RESOLUTION', 'TEMP_WORKSPACE_CLEANUP',
      'PROTOCOL_INIT', 'JOB_CREATE', 'JOB_ASSIGN', 'PARENT_OPEN', 'PROCESS_DACL',
      'IMAGE_OPEN', 'IMAGE_HASH', 'IMAGE_IDENTITY', 'OWNER_DACL', 'REPARSE', 'LOCK',
      'READY_FRAME', 'PRE_CHALLENGE', 'BATCH_LAUNCH', 'FD_DUPLICATE', 'BATCH_RESPONSE',
      'POST_CHALLENGE', 'SHUTDOWN',
    ]);
    for (const stage of WINDOWS_SUPERVISOR_STAGE_VALUES) {
      assert.deepEqual(await exerciseWindowsAuthorityStageFailureForNativeTest(stage), {
        version: 1,
        status: 'failed',
        stage,
        publicError: 'Windows system authority capability is unavailable',
      });
    }
    assert.throws(
      () => exerciseWindowsAuthorityStageFailureForNativeTest(
        'UNKNOWN' as (typeof WINDOWS_SUPERVISOR_STAGE_VALUES)[number],
      ),
      /unknown Windows authority stage/,
    );
    const command = join(process.env.SystemRoot!, 'System32', 'cmd.exe');
    const preLockControl = nativeFixtureParent('propr-bootstrap-before-lock-');
    try {
      await assert.rejects(exerciseWindowsAuthorityCapabilityForNativeTest({
        onStaged: (stagedPath) => {
          renameSync(stagedPath, `${stagedPath}.trusted-detached`);
          copyFileSync(command, stagedPath);
        },
      }), /capability|authority/);
      completeScenario('packaged-helper-integrity');
    } finally {
      rmSync(preLockControl, { recursive: true, force: true });
    }

    const startupControl = nativeFixtureParent('propr-supervisor-startup-swap-');
    try {
      let swapFired = false;
      await assert.rejects(exerciseWindowsAuthorityCapabilityForNativeTest({
        onSupervisorSpawned: (stagedPath) => {
          const detached = `${stagedPath}.startup-detached`;
          renameSync(stagedPath, detached);
          copyFileSync(command, stagedPath);
          swapFired = true;
        },
      }), /capability|IMAGE_IDENTITY|LOCK/);
      assert.equal(swapFired, true, 'startup swap hook did not execute');
      completeScenario('bootstrap-during-launch');
    } finally {
      await closeWindowsAuthorityCapability();
      rmSync(startupControl, { recursive: true, force: true });
    }

    const deniedHooks = { write: false, delete: false, rename: false, replace: false };
    const attackerResultPath = join(tmpdir(), `propr-control-handle-attacker-${process.pid}.json`);
    rmSync(attackerResultPath, { force: true });
    let concurrentRequest: Promise<Awaited<ReturnType<typeof exerciseWindowsAuthorityCapabilityForNativeTest>>> | undefined;
    const locked = await exerciseWindowsAuthorityCapabilityForNativeTest({
      onSupervisorStarting: ({ stagedPath, environmentKeys, loaderCommandLength }) => {
        assert.deepEqual(environmentKeys, ['SystemRoot']);
        assert.equal(environmentKeys.some((key) => key.startsWith('PROPR_')), false);
        assert.equal(environmentKeys.includes(stagedPath), false);
        assert.ok(loaderCommandLength > 0 && loaderCommandLength < 8_192, 'supervisor loader exceeded its fixed launch bound');
      },
      onSupervisorSpawned: (stagedPath, supervisorPid) => {
        const query = spawnSync(join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), [
          '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
          '(Get-CimInstance Win32_Process -Filter (\'ProcessId=\'+$env:PROPR_TEST_PID)).CommandLine',
        ], {
          shell: false, windowsHide: true, encoding: 'utf8',
          env: { SystemRoot: process.env.SystemRoot, PROPR_TEST_PID: String(supervisorPid) },
          timeout: 5_000,
        });
        assert.equal(query.status, 0, query.stderr);
        assert.equal(query.stdout.includes('-Command'), true, 'supervisor command line was not inspected');
        assert.equal(query.stdout.includes('EncodedCommand'), false, 'supervisor restored EncodedCommand');
        assert.equal(query.stdout.includes(stagedPath), false);
        assert.equal(query.stdout.includes('PROPR_CAPABILITY'), false);
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
        deniedHooks.write = true;
        assert.throws(() => writeFileSync(stagedPath, 'attacker'));
        deniedHooks.delete = true;
        assert.throws(() => unlinkSync(stagedPath));
        deniedHooks.rename = true;
        assert.throws(() => renameSync(stagedPath, `${stagedPath}.attacker`));
        deniedHooks.replace = true;
        assert.throws(() => copyFileSync(command, stagedPath));
        concurrentRequest = exerciseWindowsAuthorityCapabilityForNativeTest();
      },
    });
    rmSync(attackerResultPath, { force: true });
    assert.deepEqual(deniedHooks, { write: true, delete: true, rename: true, replace: true });
    assert.equal(locked.stage, 'READY_FRAME', 'hosted positive startup did not reach READY_FRAME');
    assert.deepEqual(JSON.parse(locked.output.toString('utf8')), { version: 1, ready: true });
    assert.throws(() => renameSync(locked.stagedPath, `${locked.stagedPath}.between-requests`));
    const betweenRequests = await concurrentRequest!;
    assert.equal(betweenRequests.stagedPath, locked.stagedPath);
    assert.equal(betweenRequests.supervisorPid, locked.supervisorPid);
    assert.deepEqual(JSON.parse(betweenRequests.output.toString('utf8')), { version: 1, ready: true });
    completeScenario('bootstrap-after-lock');

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

    await assert.rejects(exerciseWindowsAuthorityCapabilityForNativeTest({ args: ['batch-v1'] }), /capability/);
    const afterRejectedCommand = await exerciseWindowsAuthorityCapabilityForNativeTest();
    assert.equal(afterRejectedCommand.stagedPath, restarted.stagedPath);

    const unboundResponse = await exerciseWindowsAuthorityCapabilityControlForNativeTest({ mode: 'unparsed-response' });
    assert.ok(unboundResponse.byteLength > 0, 'unparsed response hook did not fire');
    await assert.rejects(exerciseWindowsAuthorityCapabilityForNativeTest(), /capability/);
    const protocolRestarted = await exerciseWindowsAuthorityCapabilityForNativeTest();
    assert.notEqual(protocolRestarted.stagedPath, afterRejectedCommand.stagedPath);
    assert.deepEqual(JSON.parse(protocolRestarted.output.toString('utf8')), { version: 1, ready: true });

    for (const mode of [
      'replay', 'wrong-request-id', 'wrong-identity', 'malformed', 'extra-frame', 'partial-frame', 'eof',
    ] as const) {
      await assert.rejects(exerciseWindowsAuthorityCapabilityControlForNativeTest({ mode }), /capability|malformed|extra output/);
      const recovered = await exerciseWindowsAuthorityCapabilityForNativeTest();
      assert.deepEqual(JSON.parse(recovered.output.toString('utf8')), { version: 1, ready: true });
    }
    const afterFramingRecovery = await exerciseWindowsAuthorityCapabilityForNativeTest();

    process.kill(afterFramingRecovery.supervisorPid);
    const crashDeadline = Date.now() + 5_000;
    while (Date.now() < crashDeadline) {
      try { process.kill(afterFramingRecovery.supervisorPid, 0); } catch { break; }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await assert.rejects(exerciseWindowsAuthorityCapabilityForNativeTest(), /capability/);
    const [queuedFirst, queuedSecond] = await Promise.all([
      Promise.resolve().then(() => exerciseWindowsAuthorityCapabilityForNativeTest()),
      Promise.resolve().then(() => exerciseWindowsAuthorityCapabilityForNativeTest()),
    ]);
    assert.equal(queuedSecond.stagedPath, queuedFirst.stagedPath);
    assert.equal(queuedSecond.supervisorPid, queuedFirst.supervisorPid);
    completeScenario('bootstrap-restart');

    await closeWindowsAuthorityCapability();
    assert.throws(() => lstatSync(queuedSecond.directory), /ENOENT/);
    assert.throws(() => process.kill(queuedSecond.supervisorPid, 0));
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
