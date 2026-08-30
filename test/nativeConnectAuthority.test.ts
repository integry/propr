import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  ConnectRootError,
  getOrCreateSnapshotPublicInstanceIdentity,
  readTrustedConnectTunnelOverride,
  withOwnedConnectRootSnapshot,
} from '../packages/cli/src/connectIdentity.js';
import {
  nativeConnectRootAuthorityInspector,
  protectWindowsSetupEntry,
} from '../packages/cli/src/connectRootAuthority.js';
import { PUBLIC_INSTANCE_IDENTITY_FILENAME } from '@propr/shared';
import { getOrCreatePublicInstanceIdentityPinned } from '@propr/local-setup';

const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const READY = `.${PUBLIC_INSTANCE_IDENTITY_FILENAME}.ready-v1`;

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

function makeStack(parent: string, name = 'stack'): string {
  const root = join(parent, name);
  mkdirSync(join(root, 'data'), { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  chmodSync(join(root, 'data'), 0o700);
  writeFileSync(join(root, '.env'), 'PROPR_STACK=native\n', { mode: 0o600 });
  chmodSync(join(root, '.env'), 0o600);
  if (process.platform === 'win32') {
    protectWindowsSetupEntry(parent, 'directory');
    protectWindowsSetupEntry(root, 'directory');
    protectWindowsSetupEntry(join(root, 'data'), 'directory');
    protectWindowsSetupEntry(join(root, '.env'), 'file');
  }
  return root;
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

    const readyPath = join(root, 'data', READY);
    writeFileSync(readyPath, `${JSON.stringify({ schemaVersion: 1, publicInstanceIdentity: ID })}\n`, { mode: 0o600 });
    chmodSync(readyPath, 0o600);
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
    }
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('native reparse, replacement, and inspection-path swap never authorize another held object', (t) => {
  if (!nativeOnly(t)) return;
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'propr-native-swap-')));
  try {
    const root = makeStack(parent, 'real');
    const alias = join(parent, 'alias');
    if (process.platform === 'win32') {
      run(process.env.ComSpec!, ['/d', '/s', '/c', `mklink /J "${alias}" "${root}"`]);
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
      inspectDarwinAcl(path: string, fd: number) {
        if (!swapped && path === unsafe) { swapped = true; renameSync(unsafe, `${unsafe}.held`); renameSync(safe, unsafe); }
        return nativeConnectRootAuthorityInspector.inspectDarwinAcl(path, fd);
      },
      inspectWindowsAcl(path: string, identity: { device: string; file: string }) {
        if (!swapped && path === unsafe) { swapped = true; renameSync(unsafe, `${unsafe}.held`); renameSync(safe, unsafe); }
        return nativeConnectRootAuthorityInspector.inspectWindowsAcl(path, identity);
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
      run(process.env.ComSpec!, ['/d', '/s', '/c', `mklink /J "${join(reparseHome, '.propr')}" "${configDir}"`]);
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
