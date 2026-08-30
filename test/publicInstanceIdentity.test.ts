import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  ConnectRootError,
  getOrCreatePublicInstanceIdentity as getCliIdentity,
  getOrCreateSnapshotPublicInstanceIdentity,
  withOwnedConnectRootSnapshot,
} from '../packages/cli/src/connectIdentity.js';
import { getOrCreatePublicInstanceIdentity as getApiIdentity } from '../packages/api/publicInstanceIdentity.js';
import {
  PUBLIC_IDENTITY_DIRECTORY_MODE,
  PUBLIC_IDENTITY_FILE_MODE,
  getOrCreatePublicInstanceIdentity,
  publicIdentityFilePermissionsAllowed,
  type PublicIdentityBoundary,
} from '../packages/local-setup/src/publicInstanceIdentity.js';
import { PUBLIC_INSTANCE_IDENTITY_FILENAME } from '@propr/shared';
import {
  assertSafeDarwinAclOutput,
  assertSafeWindowsAuthority,
  type ConnectRootAuthorityInspector,
  type WindowsAuthorityInspection,
} from '../packages/cli/src/connectRootAuthority.js';

const IDS = {
  first: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  second: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  third: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  fourth: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
} as const;

function temporaryRoot(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: PUBLIC_IDENTITY_DIRECTORY_MODE });
  chmodSync(path, PUBLIC_IDENTITY_DIRECTORY_MODE);
}

function connectRoot(parent: string, env = 'PROPR_INSTANCE_ID=abc123\n'): string {
  const root = join(parent, 'stack');
  privateDirectory(join(root, 'data'));
  writeFileSync(join(root, '.env'), env, { mode: 0o600 });
  chmodSync(join(root, '.env'), 0o600);
  return root;
}

function identityPath(data: string): string {
  return join(data, PUBLIC_INSTANCE_IDENTITY_FILENAME);
}

test('public identity persists across CLI/API restart and changes with replaced stack data', () => {
  const root = temporaryRoot('propr-public-identity-');
  const data = join(root, 'data');
  privateDirectory(data);
  try {
    const first = getCliIdentity(data, () => IDS.first);
    assert.equal(getApiIdentity(data, () => IDS.second), first);
    assert.equal(getCliIdentity(data, () => IDS.third), first);

    rmSync(data, { recursive: true });
    privateDirectory(data);
    const replacement = getApiIdentity(data, () => IDS.fourth);
    assert.notEqual(replacement, first);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function runCreator(kind: 'cli' | 'api', data: string, id: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      '--import',
      'tsx',
      'test/fixtures/publicIdentityCreator.ts',
      kind,
      data,
      id,
    ], { cwd: process.cwd(), shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`creator exited ${code}: ${stderr}`));
    });
  });
}

test('concurrent CLI and API creators publish one complete durable winner', async () => {
  const root = temporaryRoot('propr-public-identity-concurrent-');
  const data = join(root, 'data');
  privateDirectory(data);
  try {
    const [cli, api] = await Promise.all([
      runCreator('cli', data, IDS.first),
      runCreator('api', data, IDS.second),
    ]);
    assert.equal(cli, api);
    assert.ok(cli === IDS.first || cli === IDS.second);
    assert.equal(getCliIdentity(data, () => IDS.third), cli);
    const bytes = readFileSync(identityPath(data), 'utf8');
    assert.ok(bytes.length > 0);
    assert.equal(JSON.parse(bytes).publicInstanceIdentity, cli);
    assert.equal(lstatSync(identityPath(data)).nlink, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const boundary of [
  'temporary-opened',
  'temporary-written',
  'temporary-synced',
  'recovery-published',
  'identity-published',
  'directory-synced',
] as const satisfies readonly PublicIdentityBoundary[]) {
  test(`identity restart is durable after interruption at ${boundary}`, () => {
    const root = temporaryRoot(`propr-public-identity-${boundary}-`);
    const data = join(root, 'data');
    privateDirectory(data);
    let interrupted = false;
    try {
      assert.throws(() => getOrCreatePublicInstanceIdentity(data, {
        generate: () => IDS.first,
        role: 'host',
        onBoundary: (current) => {
          if (!interrupted && current === boundary) {
            interrupted = true;
            throw new Error('simulated interruption');
          }
        },
      }), /simulated interruption/);
      const winner = getApiIdentity(data, () => IDS.second);
      assert.ok(winner === IDS.first || winner === IDS.second);
      assert.equal(getCliIdentity(data, () => IDS.third), winner);
      assert.ok(lstatSync(identityPath(data)).size > 0);
      assert.equal(lstatSync(identityPath(data)).nlink, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('creation modes are independent of umask', () => {
  const root = temporaryRoot('propr-public-identity-umask-');
  const data = join(root, 'data');
  const previous = process.umask(0);
  try {
    assert.equal(getCliIdentity(data, () => IDS.first), IDS.first);
    assert.equal(lstatSync(data).mode & 0o777, PUBLIC_IDENTITY_DIRECTORY_MODE);
    assert.equal(lstatSync(identityPath(data)).mode & 0o777, PUBLIC_IDENTITY_FILE_MODE);
  } finally {
    process.umask(previous);
    rmSync(root, { recursive: true, force: true });
  }
});

test('identity storage rejects replaceable directories, symlinks, hardlinks, and unsafe modes', () => {
  const root = temporaryRoot('propr-public-identity-malicious-');
  try {
    const unsafe = join(root, 'unsafe');
    mkdirSync(unsafe, { mode: 0o777 });
    chmodSync(unsafe, 0o777);
    assert.throws(() => getCliIdentity(unsafe), /identity/);

    const real = join(root, 'real');
    privateDirectory(real);
    const alias = join(root, 'alias');
    symlinkSync(real, alias, 'dir');
    assert.throws(() => getCliIdentity(alias), /identity/);

    assert.equal(getCliIdentity(real, () => IDS.first), IDS.first);
    chmodSync(identityPath(real), 0o666);
    assert.throws(() => getApiIdentity(real), /permissions/);
    chmodSync(identityPath(real), PUBLIC_IDENTITY_FILE_MODE);
    linkSync(identityPath(real), join(real, 'identity-hardlink'));
    assert.throws(() => getApiIdentity(real), /single-link/);

    const special = join(root, 'special');
    privateDirectory(special);
    mkdirSync(identityPath(special), { mode: 0o700 });
    assert.throws(() => getApiIdentity(special), /regular file|identity file/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('identity repairs only the exact recovery/final same-inode crash remnant', () => {
  const root = temporaryRoot('propr-public-identity-link-crash-');
  const data = join(root, 'data');
  privateDirectory(data);
  const recovery = join(data, `.${PUBLIC_INSTANCE_IDENTITY_FILENAME}.ready-v1`);
  try {
    assert.equal(getCliIdentity(data, () => IDS.first), IDS.first);
    linkSync(identityPath(data), recovery);
    assert.equal(lstatSync(identityPath(data)).nlink, 2);
    assert.equal(getApiIdentity(data, () => IDS.second), IDS.first);
    assert.equal(lstatSync(identityPath(data)).nlink, 1);
    assert.throws(() => lstatSync(recovery), /ENOENT/);

    linkSync(identityPath(data), join(data, 'hostile-unknown-hardlink'));
    assert.throws(() => getApiIdentity(data), /identity|single-link/);
    assert.equal(lstatSync(identityPath(data)).nlink, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('identity bounded reads reject growth and named replacement after the initial stat', () => {
  const root = temporaryRoot('propr-public-identity-read-race-');
  const data = join(root, 'data');
  privateDirectory(data);
  try {
    assert.equal(getCliIdentity(data, () => IDS.first), IDS.first);
    let grew = false;
    assert.throws(() => getOrCreatePublicInstanceIdentity(data, {
      role: 'host',
      onBoundary: (boundary) => {
        if (boundary === 'identity-read-statted' && !grew) {
          grew = true;
          appendFileSync(identityPath(data), 'growth');
        }
      },
    }), /changed|size|identity/);

    writeFileSync(identityPath(data), `${JSON.stringify({
      schemaVersion: 1,
      publicInstanceIdentity: IDS.first,
    })}\n`, { mode: PUBLIC_IDENTITY_FILE_MODE });
    let replaced = false;
    assert.throws(() => getOrCreatePublicInstanceIdentity(data, {
      role: 'host',
      onBoundary: (boundary) => {
        if (boundary !== 'identity-read-statted' || replaced) return;
        replaced = true;
        renameSync(identityPath(data), join(data, 'detached-identity'));
        writeFileSync(identityPath(data), `${JSON.stringify({
          schemaVersion: 1,
          publicInstanceIdentity: IDS.second,
        })}\n`, { mode: PUBLIC_IDENTITY_FILE_MODE });
      },
    }), /changed|identity|ENOENT/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the cross-container model accepts a host-readable root-owned file only', () => {
  const hostOwner = 1000;
  assert.equal(publicIdentityFilePermissionsAllowed({ uid: 0, mode: 0o100644 }, hostOwner, 'linux'), true);
  assert.equal(publicIdentityFilePermissionsAllowed({ uid: 0, mode: 0o100600 }, hostOwner, 'linux'), false);
  assert.equal(publicIdentityFilePermissionsAllowed({ uid: hostOwner, mode: 0o100644 }, hostOwner, 'linux'), true);
  assert.equal(publicIdentityFilePermissionsAllowed({ uid: hostOwner, mode: 0o100600 }, hostOwner, 'linux'), false);
  assert.equal(publicIdentityFilePermissionsAllowed({ uid: 2000, mode: 0o100644 }, hostOwner, 'linux'), false);
  assert.equal(publicIdentityFilePermissionsAllowed({ uid: 0, mode: 0o100666 }, hostOwner, 'linux'), false);
});

test('Connect root replacement never redirects env/data reads and fails closed', () => {
  const parent = temporaryRoot('propr-connect-root-race-');
  const root = connectRoot(parent, 'ORIGINAL=value\n');
  const detached = join(parent, 'detached');
  let parsedBytes = '';
  try {
    assert.throws(() => withOwnedConnectRootSnapshot(root, (snapshot) => {
      assert.equal(snapshot.envFileValues.ORIGINAL, 'value');
      assert.equal(getOrCreateSnapshotPublicInstanceIdentity(snapshot.identityDirectory, () => IDS.first), IDS.first);
    }, {
      parseEnvFile: (contents) => {
        parsedBytes = contents;
        return { ORIGINAL: 'value' };
      },
      onBoundary: (boundary) => {
        if (boundary !== 'acquired') return;
        renameSync(root, detached);
        connectRoot(parent, 'REPLACEMENT_SENTINEL=never-read\n');
      },
    }), ConnectRootError);
    assert.equal(parsedBytes, 'ORIGINAL=value\n');
    assert.equal(parsedBytes.includes('REPLACEMENT_SENTINEL'), false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('Connect data replacement before identity access never reads the replacement winner', () => {
  const parent = temporaryRoot('propr-connect-data-race-');
  const root = connectRoot(parent);
  const data = join(root, 'data');
  const detachedData = join(root, 'data-detached');
  let observedIdentity = '';
  try {
    assert.throws(() => withOwnedConnectRootSnapshot(root, (snapshot) => {
      observedIdentity = getOrCreateSnapshotPublicInstanceIdentity(snapshot.identityDirectory, () => IDS.first);
    }, {
      parseEnvFile: () => ({}),
      onBoundary: (boundary) => {
        if (boundary !== 'env-read') return;
        renameSync(data, detachedData);
        privateDirectory(data);
        writeFileSync(identityPath(data), `${JSON.stringify({
          schemaVersion: 1,
          publicInstanceIdentity: IDS.second,
        })}\n`, { mode: PUBLIC_IDENTITY_FILE_MODE });
      },
    }), ConnectRootError);
    assert.equal(observedIdentity, IDS.first);
    assert.notEqual(observedIdentity, IDS.second);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('Connect root authority rejects symlinks, unsafe modes, and Windows pathname simulation', () => {
  const parent = temporaryRoot('propr-connect-root-validation-');
  const root = connectRoot(parent);
  const alias = join(parent, 'stack-alias');
  symlinkSync(root, alias, 'dir');
  const parseEnvFile = () => ({});
  try {
    assert.throws(() => withOwnedConnectRootSnapshot(undefined, () => undefined, { parseEnvFile }), ConnectRootError);
    assert.throws(() => withOwnedConnectRootSnapshot(alias, () => undefined, { parseEnvFile }), ConnectRootError);
    assert.throws(
      () => withOwnedConnectRootSnapshot(root, () => undefined, { parseEnvFile, platform: 'win32' }),
      ConnectRootError,
    );
    chmodSync(join(root, 'data'), 0o777);
    assert.throws(() => withOwnedConnectRootSnapshot(root, () => undefined, { parseEnvFile }), ConnectRootError);
    chmodSync(join(root, 'data'), 0o700);
    chmodSync(parent, 0o777);
    assert.throws(() => withOwnedConnectRootSnapshot(root, () => undefined, { parseEnvFile }), ConnectRootError);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

const WINDOWS_USER_SID = 'S-1-5-21-1000-1000-1000-1001';
const safeWindowsAuthority = (): WindowsAuthorityInspection => ({
  currentUserSid: WINDOWS_USER_SID,
  ownerSid: WINDOWS_USER_SID,
  daclProtected: true,
  reparsePoint: false,
  rules: [
    { identitySid: WINDOWS_USER_SID, inherited: false, accessType: 'allow', rights: '2032127' },
    { identitySid: 'S-1-5-18', inherited: false, accessType: 'allow', rights: '2032127' },
    { identitySid: 'S-1-5-32-544', inherited: false, accessType: 'allow', rights: '2032127' },
    { identitySid: 'S-1-1-0', inherited: true, accessType: 'allow', rights: '1179785' },
  ],
});

test('Windows DACL policy accepts only explicit narrow mutators and rejects inherited or broad writes', () => {
  assert.doesNotThrow(() => assertSafeWindowsAuthority(safeWindowsAuthority(), 'root'));
  for (const rule of [
    { identitySid: WINDOWS_USER_SID, inherited: true, accessType: 'allow' as const, rights: '2' },
    { identitySid: 'S-1-1-0', inherited: false, accessType: 'allow' as const, rights: '2' },
    { identitySid: 'S-1-5-11', inherited: false, accessType: 'allow' as const, rights: '268435456' },
  ]) {
    assert.throws(() => assertSafeWindowsAuthority({
      ...safeWindowsAuthority(),
      rules: [rule],
    }, 'root'), /authority|grant/);
  }
  assert.throws(() => assertSafeWindowsAuthority({
    ...safeWindowsAuthority(),
    ownerSid: 'S-1-5-18',
  }, 'root'), /authority/);
  assert.throws(() => assertSafeWindowsAuthority({
    ...safeWindowsAuthority(),
    daclProtected: false,
  }, 'data'), /authority/);
  assert.throws(() => assertSafeWindowsAuthority({
    ...safeWindowsAuthority(),
    reparsePoint: true,
  }, 'root'), /authority/);
});

test('Darwin ACL parser accepts absent/read-only ACLs and rejects write or unknown authority', () => {
  assert.doesNotThrow(() => assertSafeDarwinAclOutput('drwx------ 2 caller staff 64 Aug 29 00:00 /private/root\n'));
  assert.doesNotThrow(() => assertSafeDarwinAclOutput([
    'drwx------ 2 caller staff 64 Aug 29 00:00 /private/root',
    ' 0: group:everyone deny delete',
    ' 1: user:auditor allow read,readattr,readextattr,readsecurity',
    '',
  ].join('\n')));
  assert.throws(() => assertSafeDarwinAclOutput([
    'drwx------ 2 caller staff 64 Aug 29 00:00 /private/root',
    ' 0: group:staff allow add_file,add_subdirectory',
  ].join('\n')), /write authority/);
  assert.throws(() => assertSafeDarwinAclOutput('drwx------ root\n unparseable acl'), /malformed/);
});

test('injected Windows and Darwin inspectors exercise the real root policy path', () => {
  const parent = temporaryRoot('propr-connect-platform-authority-');
  const root = connectRoot(parent);
  const calls: string[] = [];
  const inspector: ConnectRootAuthorityInspector = {
    inspectDarwinAcl: (path) => {
      calls.push(`darwin:${path}`);
      return `drwx------ 2 caller staff 64 Aug 29 00:00 ${path}\n`;
    },
    inspectWindowsAcl: (path) => {
      calls.push(`win32:${path}`);
      return safeWindowsAuthority();
    },
  };
  try {
    assert.equal(withOwnedConnectRootSnapshot(root, (snapshot) => (
      getOrCreateSnapshotPublicInstanceIdentity(snapshot.identityDirectory, () => IDS.first)
    ), { platform: 'win32', authorityInspector: inspector, parseEnvFile: () => ({}) }), IDS.first);
    assert.ok(calls.some((entry) => entry.endsWith('/stack')));
    calls.length = 0;
    assert.equal(withOwnedConnectRootSnapshot(root, (snapshot) => snapshot.envFileValues, {
      platform: 'darwin',
      authorityInspector: inspector,
      parseEnvFile: () => ({ safe: 'yes' }),
    }).safe, 'yes');
    assert.ok(calls.some((entry) => entry.startsWith('darwin:')));

    const rejecting: ConnectRootAuthorityInspector = {
      ...inspector,
      inspectWindowsAcl: () => ({
        ...safeWindowsAuthority(),
        rules: [{ identitySid: 'S-1-1-0', inherited: true, accessType: 'allow', rights: '2' }],
      }),
    };
    assert.throws(() => withOwnedConnectRootSnapshot(root, () => undefined, {
      platform: 'win32', authorityInspector: rejecting, parseEnvFile: () => ({}),
    }), ConnectRootError);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
