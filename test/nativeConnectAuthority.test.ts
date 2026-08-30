import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, closeSync, constants, linkSync, lstatSync, mkdtempSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  ConnectRootError,
  getOrCreateSnapshotPublicInstanceIdentity,
  readTrustedConnectTunnelOverride,
  withOwnedConnectRootSnapshot,
} from '../packages/cli/dist/connectIdentity.js';
import {
  nativeConnectRootAuthorityInspector,
  assertNativeEntryAuthority,
  protectWindowsSetupEntries,
  protectWindowsSetupEntry,
  stableAuthorityIdentity,
} from '../packages/cli/dist/connectRootAuthority.js';
import { PUBLIC_INSTANCE_IDENTITY_FILENAME } from '@propr/shared';
import { getOrCreatePublicInstanceIdentityPinned } from '@propr/local-setup';

const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const READY = `.${PUBLIC_INSTANCE_IDENTITY_FILENAME}.ready-v1`;

test('native ordinary file and directory authority is accepted without an extended ACL', (t) => {
  if (!nativeOnly(t)) return;
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'propr native ordinary ')));
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

test('native broker carries distinct file identities losslessly', (t) => {
  if (!nativeOnly(t)) return;
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'propr-native-identity-')));
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
      assert.equal(BigInt(inspections[0].fileId), BigInt(inspections[0].verifiedFileId));
      assert.equal(BigInt(inspections[1].fileId), BigInt(inspections[1].verifiedFileId));
    }
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

test('native root/env/data/identity authority accepts the protected object and rejects broad grants', (t) => {
  if (!nativeOnly(t)) return;
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'propr-native-authority-')));
  try {
    const root = makeStack(parent);
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

    const crashReady = join(publicationRoot, 'data', READY);
    linkSync(publishedPath, crashReady);
    assertPublishedNative(publishedPath, 2);
    assertPublishedNative(crashReady, 2);
    assert.equal(withOwnedConnectRootSnapshot(publicationRoot, (snapshot) => (
      getOrCreateSnapshotPublicInstanceIdentity(snapshot.identityDirectory)
    ), { parseEnvFile: () => ({}) }), ID);
    assertPublishedNative(publishedPath);
    assert.throws(() => lstatSync(crashReady), /ENOENT/);

    const readyPath = join(root, 'data', READY);
    // The policy-valid 0644 state must pass before ACL authority is the only
    // changed variable; otherwise this fixture proves only a mode rejection.
    writeFileSync(readyPath, `${JSON.stringify({ schemaVersion: 1, publicInstanceIdentity: ID })}\n`, { mode: 0o644 });
    chmodSync(readyPath, 0o644);
    if (process.platform === 'win32') protectWindowsSetupEntry(readyPath, 'file');
    grantBroadWrite(readyPath, false);
    assert.throws(() => withOwnedConnectRootSnapshot(root, (snapshot) => (
      getOrCreateSnapshotPublicInstanceIdentity(snapshot.identityDirectory)
    ), { parseEnvFile: () => ({}) }));
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

    grantBroadWrite(join(root, 'data', PUBLIC_INSTANCE_IDENTITY_FILENAME), false);
    assert.throws(() => withOwnedConnectRootSnapshot(root, (snapshot) => (
      getOrCreateSnapshotPublicInstanceIdentity(snapshot.identityDirectory)
    ), { parseEnvFile: () => ({}) }));

    for (const [name, relative, directory] of [
      ['broad-root', '', true],
      ['broad-data', 'data', true],
      ['broad-env', '.env', false],
    ] as const) {
      const candidate = makeStack(parent, name);
      grantBroadWrite(relative ? join(candidate, relative) : candidate, directory);
      assert.throws(() => withOwnedConnectRootSnapshot(candidate, () => undefined, { parseEnvFile: () => ({}) }));
    }

    const denied = makeStack(parent, 'explicit-deny-root');
    grantBroadDeny(denied, true);
    assert.doesNotThrow(() => withOwnedConnectRootSnapshot(denied, () => undefined, { parseEnvFile: () => ({}) }));

    const unsafeAncestor = join(parent, 'broad-ancestor');
    mkdirSync(unsafeAncestor, { mode: 0o700 });
    if (process.platform === 'win32') protectWindowsSetupEntry(unsafeAncestor, 'directory');
    const descendant = makeStack(unsafeAncestor, 'descendant');
    grantBroadWrite(unsafeAncestor, true);
    assert.throws(() => withOwnedConnectRootSnapshot(descendant, () => undefined, { parseEnvFile: () => ({}) }));

    if (process.platform === 'win32') {
      const inherited = makeStack(parent, 'inherited-root');
      mutateWindowsAcl(inherited, 'inherit');
      assert.throws(() => withOwnedConnectRootSnapshot(inherited, () => undefined, { parseEnvFile: () => ({}) }));

      const foreignOwned = makeStack(parent, 'foreign-owner-root');
      mutateWindowsAcl(foreignOwned, 'administrator-owner');
      assert.throws(() => withOwnedConnectRootSnapshot(foreignOwned, () => undefined, { parseEnvFile: () => ({}) }));
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
      } finally {
        closeSync(inheritedFd);
      }
    }
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('native helper replacement is rejected before attacker bytes can execute', (t) => {
  if (!nativeOnly(t)) return;
  const platformArch = `${process.platform}-${process.arch}`;
  const executableName = process.platform === 'win32' ? 'connect-authority-broker.exe' : 'connect-authority-broker';
  const artifact = join(process.cwd(), 'packages', 'cli', 'dist', 'native', 'prebuilds', platformArch, executableName);
  const backup = `${artifact}.trusted-test-backup-${process.pid}`;
  const marker = join(tmpdir(), `propr-attacker-marker-${process.pid}`);
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'propr-native-helper-')));
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
});

test('native reparse, replacement, and inspection-path swap never authorize another held object', (t) => {
  if (!nativeOnly(t)) return;
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'propr-native-swap-')));
  try {
    const root = makeStack(parent, 'real');
    const alias = join(parent, 'alias');
    if (process.platform === 'win32') {
      createWindowsJunction(alias, root);
    } else {
      symlinkSync(root, alias, 'dir');
    }
    assert.throws(() => withOwnedConnectRootSnapshot(alias, () => undefined, { parseEnvFile: () => ({}) }), ConnectRootError);

    let replaced = false;
    assert.throws(() => withOwnedConnectRootSnapshot(root, () => undefined, {
      parseEnvFile: () => ({}),
      onBoundary: (boundary) => {
        if (boundary !== 'acquired' || replaced) return;
        replaced = true;
        renameSync(root, `${root}.detached`);
        makeStack(parent, 'real');
      },
    }), ConnectRootError);

    const unsafe = join(parent, 'unsafe');
    renameSync(root, unsafe);
    grantBroadWrite(unsafe, true);
    const safe = makeStack(parent, 'safe');
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
    };
    assert.throws(() => withOwnedConnectRootSnapshot(unsafe, () => undefined, {
      authorityInspector: inspector,
      parseEnvFile: () => ({}),
    }), ConnectRootError);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('native persisted tunnel config authority rejects broad ACLs and replacement', (t) => {
  if (!nativeOnly(t)) return;
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'propr-native-config-')));
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

    unlinkSync(configPath);
    assert.equal(readTrustedConnectTunnelOverride(requested, { trustedHome: home }), undefined);
    writeFileSync(configPath, JSON.stringify({
      tunnelEnabledByRoot: { [root]: false },
    }), { mode: 0o600 });
    chmodSync(configPath, 0o600);
    if (process.platform === 'win32') protectWindowsSetupEntry(configPath, 'file');

    assert.throws(() => readTrustedConnectTunnelOverride(requested, {
      trustedHome: home,
      onBoundary: (boundary) => {
        if (boundary === 'config-before-open') unlinkSync(configPath);
      },
    }));
    writeFileSync(configPath, JSON.stringify({
      tunnelEnabledByRoot: { [root]: false },
    }), { mode: 0o600 });
    chmodSync(configPath, 0o600);
    if (process.platform === 'win32') protectWindowsSetupEntry(configPath, 'file');

    grantBroadWrite(configPath, false);
    assert.throws(() => readTrustedConnectTunnelOverride(requested, { trustedHome: home }));
    if (process.platform === 'win32') protectWindowsSetupEntry(configPath, 'file');
    else run('/bin/chmod', ['-a#', '0', configPath]);

    grantBroadWrite(configDir, true);
    assert.throws(() => readTrustedConnectTunnelOverride(requested, { trustedHome: home }));
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
    assert.throws(() => readTrustedConnectTunnelOverride(requested, { trustedHome: reparseHome }));

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
    }));
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
