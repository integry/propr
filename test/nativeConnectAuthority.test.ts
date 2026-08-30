import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, closeSync, constants, copyFileSync, linkSync, lstatSync, mkdtempSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import {
  ConnectRootError,
  getOrCreateSnapshotPublicInstanceIdentity,
  readTrustedConnectTunnelOverride,
  withOwnedConnectRootSnapshot,
} from '../packages/cli/dist/connectIdentity.js';
import {
  nativeConnectRootAuthorityInspector,
  assertNativeEntryAuthority,
  exerciseWindowsAuthorityBootstrapForNativeTest,
  protectWindowsSetupEntries,
  protectWindowsSetupEntry,
  stableAuthorityIdentity,
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
    ? ['bootstrap-before-lock', 'bootstrap-after-lock', 'bootstrap-during-launch', 'bootstrap-aba']
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

after(() => {
  if (process.platform !== 'darwin' && process.platform !== 'win32') return;
  const counters = Object.fromEntries(expectedScenarios.map((name) => [name, completedScenarios.get(name) ?? 0]));
  process.stdout.write(`# PROPR_NATIVE_AUTHORITY_SUMMARY ${JSON.stringify({ version: 1, platform: process.platform, counters })}\n`);
});

function nativeFixtureParent(prefix: string): string {
  const base = process.platform === 'win32' ? userInfo().homedir : tmpdir();
  return realpathSync(mkdtempSync(join(base, prefix)));
}

test('native ordinary file and directory authority is accepted without an extended ACL', { timeout: 15_000 }, (t) => {
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
      protectWindowsSetupEntries([
        { path: parent, kind: 'directory' },
        { path: directory, kind: 'directory' },
        { path: file, kind: 'file' },
      ]);
    }
    for (const [path, kind] of [[directory, 'data'], [file, 'env']] as const) {
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        assert.doesNotThrow(() => assertNativeEntryAuthority(
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

test('native broker carries distinct file identities losslessly', { timeout: 15_000 }, (t) => {
  if (!nativeOnly(t)) return;
  const parent = nativeFixtureParent('propr-native-identity-');
  const firstPath = join(parent, 'first');
  const secondPath = join(parent, 'second');
  writeFileSync(firstPath, 'first', { mode: 0o600 });
  writeFileSync(secondPath, 'second', { mode: 0o600 });
  if (process.platform === 'win32') {
    protectWindowsSetupEntries([
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
      const inspections = nativeConnectRootAuthorityInspector.inspectWindowsAcls!([
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

function makeStack(parent: string, name = 'stack'): string {
  const root = join(parent, name);
  mkdirSync(join(root, 'data'), { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  chmodSync(join(root, 'data'), 0o700);
  writeFileSync(join(root, '.env'), 'PROPR_STACK=native\n', { mode: 0o600 });
  chmodSync(join(root, '.env'), 0o600);
  if (process.platform === 'win32') {
    protectWindowsSetupEntries([
      { path: parent, kind: 'directory' },
      { path: root, kind: 'directory' },
      { path: join(root, 'data'), kind: 'directory' },
      { path: join(root, '.env'), kind: 'file' },
    ]);
  }
  return root;
}

function assertPublishedNative(path: string, links = 1): void {
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
    assertNativeEntryAuthority(nativeConnectRootAuthorityInspector, process.platform, path, 'env', fd);
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

test('native root/env/data/identity authority accepts the protected object and rejects broad grants', { timeout: 45_000 }, (t) => {
  if (!nativeOnly(t)) return;
  const parent = nativeFixtureParent('propr-native-authority-');
  const broadReason = process.platform === 'win32' ? /BROAD_WRITE/ : /explicit stack root|write authority/;
  try {
    const root = makeStack(parent);
    for (const [path, kind, scenario] of [
      [root, 'root', 'protected-root'],
      [join(root, 'data'), 'data', 'protected-data'],
      [join(root, '.env'), 'env', 'protected-env'],
    ] as const) {
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        assert.doesNotThrow(() => assertNativeEntryAuthority(
          nativeConnectRootAuthorityInspector, process.platform, path, kind, fd,
        ));
        completeScenario(scenario);
      } finally {
        closeSync(fd);
      }
    }
    assert.equal(withOwnedConnectRootSnapshot(root, (snapshot) => (
      getOrCreateSnapshotPublicInstanceIdentity(snapshot.identityDirectory, () => ID)
    ), { parseEnvFile: () => ({}) }), ID);
    const finalPath = join(root, 'data', PUBLIC_INSTANCE_IDENTITY_FILENAME);
    assertPublishedNative(finalPath);

    const publicationRoot = makeStack(parent, 'publication-state');
    let temporaryChecked = false;
    assert.equal(withOwnedConnectRootSnapshot(publicationRoot, (snapshot) => (
      getOrCreatePublicInstanceIdentityPinned(snapshot.identityDirectory, {
        role: 'host',
        generate: () => ID,
        onBoundary: (boundary) => {
          if (boundary !== 'temporary-synced' || temporaryChecked) return;
          const name = readdirSync(join(publicationRoot, 'data'))
            .find((entry) => entry.startsWith(`.${PUBLIC_INSTANCE_IDENTITY_FILENAME}.creating-v1-`));
          assert.ok(name);
          assertPublishedNative(join(publicationRoot, 'data', name));
          temporaryChecked = true;
        },
      })
    ), { parseEnvFile: () => ({}) }), ID);
    assert.equal(temporaryChecked, true);
    const publishedPath = join(publicationRoot, 'data', PUBLIC_INSTANCE_IDENTITY_FILENAME);
    assertPublishedNative(publishedPath);
    completeScenario('publication');

    const crashReady = join(publicationRoot, 'data', READY);
    linkSync(publishedPath, crashReady);
    assertPublishedNative(publishedPath, 2);
    assertPublishedNative(crashReady, 2);
    assert.equal(withOwnedConnectRootSnapshot(publicationRoot, (snapshot) => (
      getOrCreateSnapshotPublicInstanceIdentity(snapshot.identityDirectory)
    ), { parseEnvFile: () => ({}) }), ID);
    assertPublishedNative(publishedPath);
    assert.throws(() => lstatSync(crashReady), /ENOENT/);
    completeScenario('recovery');

    const readyPath = join(root, 'data', READY);
    // The policy-valid 0644 state must pass before ACL authority is the only
    // changed variable; otherwise this fixture proves only a mode rejection.
    writeFileSync(readyPath, `${JSON.stringify({ schemaVersion: 1, publicInstanceIdentity: ID })}\n`, { mode: 0o644 });
    chmodSync(readyPath, 0o644);
    if (process.platform === 'win32') protectWindowsSetupEntry(readyPath, 'file');
    grantBroadWrite(readyPath, false);
    assert.throws(() => withOwnedConnectRootSnapshot(root, (snapshot) => (
      getOrCreateSnapshotPublicInstanceIdentity(snapshot.identityDirectory)
    ), { parseEnvFile: () => ({}) }), broadReason);
    completeScenario('ready-denial');
    unlinkSync(readyPath);

    let identityReplaced = false;
    assert.throws(() => withOwnedConnectRootSnapshot(root, (snapshot) => (
      getOrCreatePublicInstanceIdentityPinned(snapshot.identityDirectory, {
        role: 'host',
        onBoundary: (boundary) => {
          if (boundary !== 'identity-read-statted' || identityReplaced) return;
          identityReplaced = true;
          const path = join(root, 'data', PUBLIC_INSTANCE_IDENTITY_FILENAME);
          renameSync(path, `${path}.detached`);
          writeFileSync(path, `${JSON.stringify({ schemaVersion: 1, publicInstanceIdentity: ID })}\n`, { mode: 0o644 });
          chmodSync(path, 0o644);
          if (process.platform === 'win32') protectWindowsSetupEntry(path, 'file');
        },
      })
    ), { parseEnvFile: () => ({}) }));
    assert.equal(identityReplaced, true);
    completeScenario('identity-swap');

    grantBroadWrite(join(root, 'data', PUBLIC_INSTANCE_IDENTITY_FILENAME), false);
    assert.throws(() => withOwnedConnectRootSnapshot(root, (snapshot) => (
      getOrCreateSnapshotPublicInstanceIdentity(snapshot.identityDirectory)
    ), { parseEnvFile: () => ({}) }), broadReason);
    completeScenario('broad-publication');

    for (const [name, relative, directory] of [
      ['broad-root', '', true],
      ['broad-data', 'data', true],
      ['broad-env', '.env', false],
    ] as const) {
      const candidate = makeStack(parent, name);
      grantBroadWrite(relative ? join(candidate, relative) : candidate, directory);
      assert.throws(
        () => withOwnedConnectRootSnapshot(candidate, () => undefined, { parseEnvFile: () => ({}) }),
        broadReason,
      );
      completeScenario(name);
    }

    const denied = makeStack(parent, 'explicit-deny-root');
    grantBroadDeny(denied, true);
    assert.doesNotThrow(() => withOwnedConnectRootSnapshot(denied, () => undefined, { parseEnvFile: () => ({}) }));
    completeScenario('explicit-deny');

    const unsafeAncestor = join(parent, 'broad-ancestor');
    mkdirSync(unsafeAncestor, { mode: 0o700 });
    if (process.platform === 'win32') protectWindowsSetupEntry(unsafeAncestor, 'directory');
    const descendant = makeStack(unsafeAncestor, 'descendant');
    grantBroadWrite(unsafeAncestor, true);
    assert.throws(
      () => withOwnedConnectRootSnapshot(descendant, () => undefined, { parseEnvFile: () => ({}) }),
      broadReason,
    );
    completeScenario('broad-ancestor');

    if (process.platform === 'win32') {
      const inherited = makeStack(parent, 'inherited-root');
      mutateWindowsAcl(inherited, 'inherit');
      assert.throws(
        () => withOwnedConnectRootSnapshot(inherited, () => undefined, { parseEnvFile: () => ({}) }),
        /INHERITED_WRITE|DACL_NOT_PROTECTED/,
      );
      completeScenario('inherited-dacl');

      const foreignOwned = makeStack(parent, 'foreign-owner-root');
      mutateWindowsAcl(foreignOwned, 'administrator-owner');
      assert.throws(() => withOwnedConnectRootSnapshot(foreignOwned, () => undefined, { parseEnvFile: () => ({}) }), /OWNER_MISMATCH/);
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
        assert.throws(() => assertNativeEntryAuthority(
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

test('native helper replacement is rejected before attacker bytes can execute', { timeout: 30_000 }, (t) => {
  if (!nativeOnly(t)) return;
  const platformArch = `${process.platform}-${process.arch}`;
  const executableName = process.platform === 'win32' ? 'connect-authority-broker.exe' : 'connect-authority-broker';
  const artifact = join(process.cwd(), 'packages', 'cli', 'dist', 'native', 'prebuilds', platformArch, executableName);
  const backup = `${artifact}.trusted-test-backup-${process.pid}`;
  const marker = join(tmpdir(), `propr-attacker-marker-${process.pid}`);
  const parent = nativeFixtureParent('propr-native-helper-');
  const target = join(parent, 'target');
  writeFileSync(target, 'target\n', { mode: 0o600 });
  if (process.platform === 'win32') protectWindowsSetupEntries([
    { path: parent, kind: 'directory' }, { path: target, kind: 'file' },
  ]);
  const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  let artifactMoved = false;
  try {
    renameSync(artifact, backup);
    artifactMoved = true;
    if (process.platform === 'darwin') {
      writeFileSync(artifact, `#!/bin/sh\nprintf attacker > "${marker}"\n`, { mode: 0o700 });
      chmodSync(artifact, 0o700);
    } else {
      writeFileSync(artifact, Buffer.from('attacker-not-an-executable'), { mode: 0o600 });
    }
    assert.throws(() => assertNativeEntryAuthority(
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
  completeScenario('packaged-helper-integrity');

  if (process.platform === 'win32') {
    const command = join(process.env.SystemRoot!, 'System32', 'cmd.exe');
    const preLockControl = nativeFixtureParent('propr-bootstrap-before-lock-');
    try {
      const preLockMarker = join(preLockControl, 'attacker-executed');
      assert.throws(() => exerciseWindowsAuthorityBootstrapForNativeTest({
        args: ['/d', '/c', `echo attacker>"${preLockMarker}"`],
        onStaged: (stagedPath) => {
          renameSync(stagedPath, `${stagedPath}.trusted-detached`);
          copyFileSync(command, stagedPath);
        },
      }), /bootstrap|authority/);
      assert.throws(() => lstatSync(preLockMarker), /ENOENT/);
      completeScenario('bootstrap-before-lock');
    } finally {
      rmSync(preLockControl, { recursive: true, force: true });
    }

    for (const [boundary, scenario, mode] of [
      ['after-lock', 'bootstrap-after-lock', 'replace'],
      ['during-launch', 'bootstrap-during-launch', 'replace'],
      ['before-launch', 'bootstrap-aba', 'aba'],
    ] as const) {
      const control = nativeFixtureParent(`propr-bootstrap-${mode}-`);
      try {
        const readyPath = join(control, 'ready');
        const continuePath = join(control, 'continue');
        const resultPath = join(control, 'result.json');
        const fixture = join(process.cwd(), 'test', 'fixtures', 'windowsAuthoritySwapAttacker.mjs');
        const output = exerciseWindowsAuthorityBootstrapForNativeTest({
          args: boundary === 'during-launch' ? ['ping-hold'] : ['ping'],
          barrier: { boundary, readyPath, continuePath },
          onStaged: (stagedPath) => {
            const attacker = spawn(process.execPath, [
              fixture, stagedPath, command, readyPath, continuePath, resultPath, mode,
            ], { stdio: 'ignore', windowsHide: true });
            attacker.unref();
          },
        });
        assert.deepEqual(JSON.parse(output.toString('utf8')), { version: 1, ready: true });
        const result = JSON.parse(readFileSync(resultPath, 'utf8')) as {
          attempted: boolean; replaced: boolean; restored: boolean; code: string;
        };
        assert.equal(result.attempted, true);
        assert.equal(result.replaced, false, `staged replacement unexpectedly succeeded (${result.code})`);
        assert.equal(result.restored, false);
        completeScenario(scenario);
      } finally {
        rmSync(control, { recursive: true, force: true });
      }
    }
  }
});

test('native reparse, replacement, and inspection-path swap never authorize another held object', { timeout: 20_000 }, (t) => {
  if (!nativeOnly(t)) return;
  const parent = nativeFixtureParent('propr-native-swap-');
  try {
    const root = makeStack(parent, 'real');
    const alias = join(parent, 'alias');
    if (process.platform === 'win32') {
      createWindowsJunction(alias, root);
    } else {
      symlinkSync(root, alias, 'dir');
    }
    assert.throws(
      () => withOwnedConnectRootSnapshot(alias, () => undefined, { parseEnvFile: () => ({}) }),
      /REPARSE_POINT/,
    );
    completeScenario('reparse');

    let replaced = false;
    assert.throws(() => withOwnedConnectRootSnapshot(root, () => undefined, {
      parseEnvFile: () => ({}),
      onBoundary: (boundary) => {
        if (boundary !== 'acquired' || replaced) return;
        replaced = true;
        if (process.platform === 'win32') {
          const envPath = join(root, '.env');
          renameSync(envPath, `${envPath}.detached`);
          writeFileSync(envPath, 'PROPR_STACK=replacement\n', { mode: 0o600 });
          protectWindowsSetupEntry(envPath, 'file');
        } else {
          renameSync(root, `${root}.detached`);
          makeStack(parent, 'real');
        }
      },
    }), /NAMED_REPLACED|explicit stack root/);
    assert.equal(replaced, true);
    completeScenario('replacement-barrier');

    const unsafeRoot = makeStack(parent, 'unsafe');
    const unsafe = join(unsafeRoot, '.env');
    grantBroadWrite(unsafe, false);
    const safe = join(unsafeRoot, '.env.safe');
    writeFileSync(safe, 'PROPR_STACK=safe\n', { mode: 0o600 });
    chmodSync(safe, 0o600);
    if (process.platform === 'win32') protectWindowsSetupEntry(safe, 'file');
    let swapped = false;
    const inspector = {
      inspectDarwinAcl(path: string, fd: number, identity: { device: string; file: string }) {
        if (!swapped && path === unsafe) { swapped = true; renameSync(unsafe, `${unsafe}.held`); renameSync(safe, unsafe); }
        return nativeConnectRootAuthorityInspector.inspectDarwinAcl(path, fd, identity);
      },
      inspectWindowsAcl(path: string, identity: { device: string; file: string }, fd?: number, kind?: 'ancestor' | 'home' | 'root' | 'data' | 'env') {
        if (!swapped && path === unsafe) { swapped = true; renameSync(unsafe, `${unsafe}.held`); renameSync(safe, unsafe); }
        return nativeConnectRootAuthorityInspector.inspectWindowsAcl(path, identity, fd, kind);
      },
      inspectWindowsAcls(entries: Parameters<NonNullable<typeof nativeConnectRootAuthorityInspector.inspectWindowsAcls>>[0]) {
        if (!swapped && entries.some((entry) => entry.path === unsafe)) {
          swapped = true;
          renameSync(unsafe, `${unsafe}.held`);
          renameSync(safe, unsafe);
        }
        return nativeConnectRootAuthorityInspector.inspectWindowsAcls!(entries);
      },
    };
    assert.throws(() => withOwnedConnectRootSnapshot(unsafeRoot, () => undefined, {
      authorityInspector: inspector,
      parseEnvFile: () => ({}),
    }), process.platform === 'win32' ? /BROAD_WRITE/ : /write authority/);
    assert.equal(swapped, true);
    completeScenario('inspection-handle-swap');
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('native persisted tunnel config authority rejects broad ACLs and replacement', { timeout: 30_000 }, (t) => {
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
      protectWindowsSetupEntry(parent, 'directory');
      protectWindowsSetupEntry(home, 'directory');
      protectWindowsSetupEntry(configDir, 'directory');
      protectWindowsSetupEntry(configPath, 'file');
    }
    const requested = process.platform === 'win32' ? 'c:\\WORK\\STACK' : root;
    assert.equal(readTrustedConnectTunnelOverride(requested, { trustedHome: home }), false);
    completeScenario('config-off');

    writeFileSync(configPath, JSON.stringify({ tunnelEnabledByRoot: { [root]: true } }), { mode: 0o600 });
    chmodSync(configPath, 0o600);
    if (process.platform === 'win32') protectWindowsSetupEntry(configPath, 'file');
    assert.equal(readTrustedConnectTunnelOverride(requested, { trustedHome: home }), true);
    completeScenario('config-on');

    unlinkSync(configPath);
    assert.equal(readTrustedConnectTunnelOverride(requested, { trustedHome: home }), undefined);
    completeScenario('config-absence');
    writeFileSync(configPath, JSON.stringify({
      tunnelEnabledByRoot: { [root]: false },
    }), { mode: 0o600 });
    chmodSync(configPath, 0o600);
    if (process.platform === 'win32') protectWindowsSetupEntry(configPath, 'file');

    let disappeared = false;
    assert.throws(() => readTrustedConnectTunnelOverride(requested, {
      trustedHome: home,
      onBoundary: (boundary) => {
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
    if (process.platform === 'win32') protectWindowsSetupEntry(configPath, 'file');

    grantBroadWrite(configPath, false);
    assert.throws(
      () => readTrustedConnectTunnelOverride(requested, { trustedHome: home }),
      process.platform === 'win32' ? /BROAD_WRITE/ : /unsafe|write authority/,
    );
    completeScenario('config-broad-file');
    if (process.platform === 'win32') protectWindowsSetupEntry(configPath, 'file');
    else run('/bin/chmod', ['-a#', '0', configPath]);

    grantBroadWrite(configDir, true);
    assert.throws(
      () => readTrustedConnectTunnelOverride(requested, { trustedHome: home }),
      process.platform === 'win32' ? /BROAD_WRITE/ : /unsafe|write authority/,
    );
    completeScenario('config-broad-directory');
    if (process.platform === 'win32') protectWindowsSetupEntry(configDir, 'directory');
    else run('/bin/chmod', ['-a#', '0', configDir]);

    const reparseHome = join(parent, 'reparse-home');
    mkdirSync(reparseHome, { mode: 0o700 });
    chmodSync(reparseHome, 0o700);
    if (process.platform === 'win32') {
      protectWindowsSetupEntry(reparseHome, 'directory');
      createWindowsJunction(join(reparseHome, '.propr'), configDir);
    } else {
      symlinkSync(configDir, join(reparseHome, '.propr'), 'dir');
    }
    assert.throws(
      () => readTrustedConnectTunnelOverride(requested, { trustedHome: reparseHome }),
      /CONFIG_DIRECTORY_REPARSE/,
    );
    completeScenario('config-reparse');

    let swapped = false;
    assert.throws(() => readTrustedConnectTunnelOverride(requested, {
      trustedHome: home,
      onBoundary: (boundary) => {
        if (boundary !== 'config-opened' || swapped) return;
        swapped = true;
        renameSync(configPath, `${configPath}.detached`);
        writeFileSync(configPath, JSON.stringify({ tunnelEnabledByRoot: { [root]: true } }), { mode: 0o600 });
        chmodSync(configPath, 0o600);
        if (process.platform === 'win32') protectWindowsSetupEntry(configPath, 'file');
      },
    }), /NAMED_REPLACED|unsafe/);
    assert.equal(swapped, true);
    completeScenario('config-replacement');
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
