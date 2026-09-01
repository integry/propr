import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  closeSync,
  constants,
  existsSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  openSync,
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
  readSnapshotPublicInstanceIdentity,
  readTrustedConnectTunnelOverride,
  TrustedConnectConfigError,
  withOwnedConnectRootSnapshot,
} from '../packages/cli/src/connectIdentity.js';
import { getOrCreatePublicInstanceIdentity as getApiIdentity } from '../packages/api/publicInstanceIdentity.js';
import {
  PUBLIC_IDENTITY_DIRECTORY_MODE,
  PUBLIC_IDENTITY_FILE_MODE,
  getOrCreatePublicInstanceIdentity,
  publicIdentityFilePermissionsAllowed,
  samePublicFileIdentity,
  type PublicIdentityBoundary,
} from '../packages/local-setup/src/publicInstanceIdentity.js';
import { PUBLIC_INSTANCE_IDENTITY_FILENAME } from '@propr/shared';
import {
  assertNativeWindowsEntriesAuthority,
  assertSafeDarwinAclOutput,
  assertSafeWindowsAuthority,
  stableAuthorityIdentity,
  type ConnectRootAuthorityInspector,
  type WindowsAuthorityInspection,
} from '../packages/cli/src/connectRootAuthority.js';

const IDS = {
  first: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  second: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  third: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  fourth: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
} as const;

test('exact identity comparison does not collapse adjacent values above Number.MAX_SAFE_INTEGER', () => {
  assert.equal(samePublicFileIdentity(
    { device: '7', file: '9007199254740992' },
    { device: '7', file: '9007199254740993' },
  ), false);
  assert.equal(samePublicFileIdentity(
    { device: '18446744073709551614', file: '18446744073709551615' },
    { device: '18446744073709551614', file: '18446744073709551615' },
  ), true);
  assert.throws(() => samePublicFileIdentity(
    { device: '7', file: '09007199254740992' },
    { device: '7', file: '9007199254740992' },
  ), /canonical/);
});

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

test('public identity persists across CLI/API restart and changes with replaced stack data', async () => {
  const root = temporaryRoot('propr-public-identity-');
  const data = join(root, 'data');
  privateDirectory(data);
  try {
    const first = await getCliIdentity(data, () => IDS.first);
    assert.equal(await getApiIdentity(data, () => IDS.second), first);
    assert.equal(await getCliIdentity(data, () => IDS.third), first);

    rmSync(data, { recursive: true });
    privateDirectory(data);
    const replacement = await getApiIdentity(data, () => IDS.fourth);
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
    assert.equal(await getCliIdentity(data, () => IDS.third), cli);
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
  test(`identity restart is durable after interruption at ${boundary}`, async () => {
    const root = temporaryRoot(`propr-public-identity-${boundary}-`);
    const data = join(root, 'data');
    privateDirectory(data);
    let interrupted = false;
    try {
      await assert.rejects(getOrCreatePublicInstanceIdentity(data, {
        generate: () => IDS.first,
        role: 'host',
        onBoundary: (current) => {
          if (!interrupted && current === boundary) {
            interrupted = true;
            throw new Error('simulated interruption');
          }
        },
      }), /simulated interruption/);
      const winner = await getApiIdentity(data, () => IDS.second);
      assert.ok(winner === IDS.first || winner === IDS.second);
      assert.equal(await getCliIdentity(data, () => IDS.third), winner);
      assert.ok(lstatSync(identityPath(data)).size > 0);
      assert.equal(lstatSync(identityPath(data)).nlink, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('creation modes are independent of umask', async () => {
  const root = temporaryRoot('propr-public-identity-umask-');
  const data = join(root, 'data');
  const previous = process.umask(0);
  try {
    assert.equal(await getCliIdentity(data, () => IDS.first), IDS.first);
    assert.equal(lstatSync(data).mode & 0o777, PUBLIC_IDENTITY_DIRECTORY_MODE);
    assert.equal(lstatSync(identityPath(data)).mode & 0o777, PUBLIC_IDENTITY_FILE_MODE);
  } finally {
    process.umask(previous);
    rmSync(root, { recursive: true, force: true });
  }
});

test('identity storage rejects the filesystem root before creating state', async () => {
  await assert.rejects(getApiIdentity('/', () => IDS.first), /filesystem root/);
});

test('identity storage rejects replaceable directories, symlinks, hardlinks, and unsafe modes', async () => {
  const root = temporaryRoot('propr-public-identity-malicious-');
  try {
    const unsafe = join(root, 'unsafe');
    mkdirSync(unsafe, { mode: 0o777 });
    chmodSync(unsafe, 0o777);
    await assert.rejects(getCliIdentity(unsafe), /identity/);

    const real = join(root, 'real');
    privateDirectory(real);
    const alias = join(root, 'alias');
    symlinkSync(real, alias, 'dir');
    await assert.rejects(getCliIdentity(alias), /identity/);

    assert.equal(await getCliIdentity(real, () => IDS.first), IDS.first);
    chmodSync(identityPath(real), 0o666);
    await assert.rejects(getApiIdentity(real), /permissions/);
    chmodSync(identityPath(real), PUBLIC_IDENTITY_FILE_MODE);
    linkSync(identityPath(real), join(real, 'identity-hardlink'));
    await assert.rejects(getApiIdentity(real), /single-link/);

    const special = join(root, 'special');
    privateDirectory(special);
    mkdirSync(identityPath(special), { mode: 0o700 });
    await assert.rejects(getApiIdentity(special), /regular file|identity file/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('identity repairs only the exact recovery/final same-inode crash remnant', async () => {
  const root = temporaryRoot('propr-public-identity-link-crash-');
  const data = join(root, 'data');
  privateDirectory(data);
  const recovery = join(data, `.${PUBLIC_INSTANCE_IDENTITY_FILENAME}.ready-v1`);
  try {
    assert.equal(await getCliIdentity(data, () => IDS.first), IDS.first);
    linkSync(identityPath(data), recovery);
    assert.equal(lstatSync(identityPath(data)).nlink, 2);
    assert.equal(await getApiIdentity(data, () => IDS.second), IDS.first);
    assert.equal(lstatSync(identityPath(data)).nlink, 1);
    assert.throws(() => lstatSync(recovery), /ENOENT/);

    linkSync(identityPath(data), join(data, 'hostile-unknown-hardlink'));
    await assert.rejects(getApiIdentity(data), /identity|single-link/);
    assert.equal(lstatSync(identityPath(data)).nlink, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('identity restart repairs interruption between temporary-to-READY link and unlink', {
  skip: process.platform !== 'linux',
}, async () => {
  const root = temporaryRoot('propr-public-identity-temporary-link-crash-');
  const data = join(root, 'data');
  privateDirectory(data);
  const temporary = join(
    data,
    `.${PUBLIC_INSTANCE_IDENTITY_FILENAME}.creating-v1-123-${IDS.first}`,
  );
  const recovery = join(data, `.${PUBLIC_INSTANCE_IDENTITY_FILENAME}.ready-v1`);
  try {
    writeFileSync(temporary, `${JSON.stringify({
      schemaVersion: 1,
      publicInstanceIdentity: IDS.second,
    })}\n`, { mode: PUBLIC_IDENTITY_FILE_MODE });
    chmodSync(temporary, PUBLIC_IDENTITY_FILE_MODE);
    linkSync(temporary, recovery);
    assert.equal(lstatSync(temporary).nlink, 2);

    assert.equal(await getApiIdentity(data, () => IDS.third), IDS.second);
    assert.equal(lstatSync(identityPath(data)).nlink, 1);
    assert.throws(() => lstatSync(temporary), /ENOENT/);
    assert.throws(() => lstatSync(recovery), /ENOENT/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('identity bounded reads reject growth and named replacement after the initial stat', async () => {
  const root = temporaryRoot('propr-public-identity-read-race-');
  const data = join(root, 'data');
  privateDirectory(data);
  try {
    assert.equal(await getCliIdentity(data, () => IDS.first), IDS.first);
    let grew = false;
    await assert.rejects(getOrCreatePublicInstanceIdentity(data, {
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
    await assert.rejects(getOrCreatePublicInstanceIdentity(data, {
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

test('status identity reads neither create nor repair snapshot state', async () => {
  const parent = temporaryRoot('propr-connect-read-only-identity-');
  const root = connectRoot(parent);
  try {
    await withOwnedConnectRootSnapshot(root, async (snapshot) => {
      await assert.rejects(readSnapshotPublicInstanceIdentity(snapshot.identityDirectory));
      assert.throws(() => lstatSync(identityPath(join(root, 'data'))), /ENOENT/);
      assert.equal(await getOrCreateSnapshotPublicInstanceIdentity(snapshot.identityDirectory, () => IDS.first), IDS.first);
      assert.equal(await readSnapshotPublicInstanceIdentity(snapshot.identityDirectory), IDS.first);
    }, { parseEnvFile: () => ({}) });
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('Connect root replacement never redirects env/data reads and fails closed', async () => {
  const parent = temporaryRoot('propr-connect-root-race-');
  const root = connectRoot(parent, 'ORIGINAL=value\n');
  const detached = join(parent, 'detached');
  let parsedBytes = '';
  try {
    await assert.rejects(withOwnedConnectRootSnapshot(root, async (snapshot) => {
      assert.equal(snapshot.envFileValues.ORIGINAL, 'value');
      assert.equal(await getOrCreateSnapshotPublicInstanceIdentity(snapshot.identityDirectory, () => IDS.first), IDS.first);
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

test('Connect data replacement before identity access never reads the replacement winner', async () => {
  const parent = temporaryRoot('propr-connect-data-race-');
  const root = connectRoot(parent);
  const data = join(root, 'data');
  const detachedData = join(root, 'data-detached');
  let observedIdentity = '';
  try {
    await assert.rejects(withOwnedConnectRootSnapshot(root, async (snapshot) => {
      observedIdentity = await getOrCreateSnapshotPublicInstanceIdentity(snapshot.identityDirectory, () => IDS.first);
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

test('Connect root authority rejects symlinks, unsafe modes, and Windows pathname simulation', async () => {
  const parent = temporaryRoot('propr-connect-root-validation-');
  const root = connectRoot(parent);
  const alias = join(parent, 'stack-alias');
  symlinkSync(root, alias, 'dir');
  const parseEnvFile = () => ({});
  try {
    await assert.rejects(withOwnedConnectRootSnapshot(undefined, () => undefined, { parseEnvFile }), ConnectRootError);
    await assert.rejects(withOwnedConnectRootSnapshot(alias, () => undefined, { parseEnvFile }), ConnectRootError);
    await assert.rejects(
      withOwnedConnectRootSnapshot(root, () => undefined, { parseEnvFile, platform: 'win32' }),
      ConnectRootError,
    );
    chmodSync(join(root, 'data'), 0o777);
    await assert.rejects(withOwnedConnectRootSnapshot(root, () => undefined, { parseEnvFile }), ConnectRootError);
    chmodSync(join(root, 'data'), 0o700);
    chmodSync(parent, 0o777);
    await assert.rejects(withOwnedConnectRootSnapshot(root, () => undefined, { parseEnvFile }), ConnectRootError);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

const WINDOWS_USER_SID = 'S-1-5-21-1000-1000-1000-1001';
const safeWindowsAuthority = (
  identity = { device: '1', file: '1' },
  kind: 'ancestor' | 'home' | 'root' | 'data' | 'env' = 'root',
  index = 0,
): WindowsAuthorityInspection => ({
  index,
  kind: kind === 'env' ? 'file' : 'directory',
  authorityKind: kind,
  currentUserSid: WINDOWS_USER_SID,
  ownerSid: WINDOWS_USER_SID,
  daclProtected: true,
  reparsePoint: false,
  volumeSerialNumber: identity.device,
  fileId: identity.file,
  verifiedVolumeSerialNumber: identity.device,
  verifiedFileId: identity.file,
  rules: [
    { identitySid: WINDOWS_USER_SID, inherited: false, accessType: 'allow', appliesToSelf: true, rights: '2032127' },
    { identitySid: 'S-1-5-18', inherited: false, accessType: 'allow', appliesToSelf: true, rights: '2032127' },
    { identitySid: 'S-1-5-32-544', inherited: false, accessType: 'allow', appliesToSelf: true, rights: '2032127' },
    { identitySid: 'S-1-1-0', inherited: true, accessType: 'allow', appliesToSelf: true, rights: '1179785' },
  ],
});

test('Windows DACL policy accepts only explicit narrow mutators and rejects inherited or broad writes', () => {
  assert.doesNotThrow(() => assertSafeWindowsAuthority(safeWindowsAuthority(), 'root'));
  for (const rule of [
    { identitySid: WINDOWS_USER_SID, inherited: true, accessType: 'allow' as const, appliesToSelf: true, rights: '2' },
    { identitySid: 'S-1-1-0', inherited: false, accessType: 'allow' as const, appliesToSelf: true, rights: '2' },
    { identitySid: 'S-1-5-11', inherited: false, accessType: 'allow' as const, appliesToSelf: true, rights: '268435456' },
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

test('Windows batch binding keeps descriptor identities, indexes, and types exact', async () => {
  const parent = temporaryRoot('propr-windows-full-identity-');
  const firstPath = join(parent, 'first');
  const secondPath = join(parent, 'second');
  writeFileSync(firstPath, 'A', { mode: 0o600 });
  writeFileSync(secondPath, 'B', { mode: 0o600 });
  const firstFd = openSync(firstPath, constants.O_RDONLY);
  const secondFd = openSync(secondPath, constants.O_RDONLY);
  const entries = [
    { path: firstPath, kind: 'env' as const, pinnedFd: firstFd },
    { path: secondPath, kind: 'env' as const, pinnedFd: secondFd },
  ];
  const firstIdentity = stableAuthorityIdentity(firstFd);
  const secondIdentity = stableAuthorityIdentity(secondFd);
  const exactInspector: ConnectRootAuthorityInspector = {
    inspectDarwinAcl: (_path, _fd, identity) => ({ version: 1, ...identity, acl: '!#acl 1\n' }),
    inspectWindowsAcl: async (_path, identity, _fd, kind = 'env') => safeWindowsAuthority(identity, kind),
    inspectWindowsAcls: async () => [
      safeWindowsAuthority(firstIdentity, 'env', 0),
      safeWindowsAuthority(secondIdentity, 'env', 1),
    ],
  };
  try {
    await assert.doesNotReject(assertNativeWindowsEntriesAuthority(exactInspector, entries));
    await assert.rejects(assertNativeWindowsEntriesAuthority({
      ...exactInspector,
      inspectWindowsAcls: async () => [
        safeWindowsAuthority(secondIdentity, 'env', 1),
        safeWindowsAuthority(firstIdentity, 'env', 0),
      ],
    }, entries), /unavailable/);
    await assert.rejects(assertNativeWindowsEntriesAuthority({
      ...exactInspector,
      inspectWindowsAcls: async () => [{
        ...safeWindowsAuthority(firstIdentity, 'env', 0),
        verifiedFileId: (BigInt(firstIdentity.file) + 1n).toString(),
      }, safeWindowsAuthority(secondIdentity, 'env', 1)],
    }, entries), /unavailable/);
    await assert.rejects(assertNativeWindowsEntriesAuthority({
      ...exactInspector,
      inspectWindowsAcls: async () => [{
        ...safeWindowsAuthority(firstIdentity, 'env', 0),
        unexpected: 'unbounded-schema-extension',
      } as WindowsAuthorityInspection, safeWindowsAuthority(secondIdentity, 'env', 1)],
    }, entries), /unavailable/);
  } finally {
    closeSync(secondFd);
    closeSync(firstFd);
    rmSync(parent, { recursive: true, force: true });
  }
});

test('Darwin ACL parser accepts absent/read-only ACLs and rejects write or unknown authority', () => {
  const uuid = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';
  assert.doesNotThrow(() => assertSafeDarwinAclOutput('!#acl 1\n'));
  assert.doesNotThrow(() => assertSafeDarwinAclOutput([
    '!#acl 1',
    `group:${uuid}:everyone:12:deny:delete`,
    `user:${uuid}:auditor:501:allow:read,readattr,readextattr,readsecurity`,
    '',
  ].join('\n')));
  assert.throws(() => assertSafeDarwinAclOutput([
    '!#acl 1',
    `group:${uuid}:staff:20:allow:write,append`,
  ].join('\n')), /write authority/);
  assert.throws(() => assertSafeDarwinAclOutput('!#acl 1\nunparseable acl'), /malformed/);
});

test('injected Windows and Darwin inspectors exercise the real root policy path', async () => {
  const parent = temporaryRoot('propr-connect-platform-authority-');
  const root = connectRoot(parent);
  const calls: string[] = [];
  const inspector: ConnectRootAuthorityInspector = {
    inspectDarwinAcl: (path, _fd, expectedIdentity) => {
      calls.push(`darwin:${path}`);
      return { version: 1, ...expectedIdentity, acl: '!#acl 1\n' };
    },
    inspectWindowsAcl: async (path, expectedIdentity, _fd, kind = 'env') => {
      calls.push(`win32:${path}`);
      return safeWindowsAuthority(expectedIdentity, kind);
    },
  };
  try {
    assert.equal(await withOwnedConnectRootSnapshot(root, (snapshot) => (
      getOrCreateSnapshotPublicInstanceIdentity(snapshot.identityDirectory, () => IDS.first)
    ), { platform: 'win32', authorityInspector: inspector, parseEnvFile: () => ({}) }), IDS.first);
    assert.ok(calls.some((entry) => entry.endsWith('/stack')));
    calls.length = 0;
    assert.equal((await withOwnedConnectRootSnapshot(root, (snapshot) => snapshot.envFileValues, {
      platform: 'darwin',
      authorityInspector: inspector,
      parseEnvFile: () => ({ safe: 'yes' }),
    })).safe, 'yes');
    assert.ok(calls.some((entry) => entry.startsWith('darwin:')));

    const rejecting: ConnectRootAuthorityInspector = {
      ...inspector,
      inspectWindowsAcl: async (_path, expectedIdentity, _fd, kind = 'env') => ({
        ...safeWindowsAuthority(expectedIdentity, kind),
        rules: [{ identitySid: 'S-1-1-0', inherited: true, accessType: 'allow', appliesToSelf: true, rights: '2' }],
      }),
    };
    await assert.rejects(withOwnedConnectRootSnapshot(root, () => undefined, {
      platform: 'win32', authorityInspector: rejecting, parseEnvFile: () => ({}),
    }), ConnectRootError);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('read-only Windows snapshot fails closed when native inspection cannot complete', async () => {
  const parent = temporaryRoot('propr-connect-windows-read-only-');
  const root = connectRoot(parent, 'PROPR_STACK=readonly\n');
  const data = join(root, 'data');
  writeFileSync(identityPath(data), `${JSON.stringify({
    schemaVersion: 1,
    publicInstanceIdentity: IDS.first,
  })}\n`, { mode: PUBLIC_IDENTITY_FILE_MODE });
  let nativeCalls = 0;
  const forbiddenInspector: ConnectRootAuthorityInspector = {
    inspectDarwinAcl: () => { nativeCalls += 1; throw new Error('native inspector executed'); },
    inspectWindowsAcl: async () => { nativeCalls += 1; throw new Error('native inspector executed'); },
    inspectWindowsAcls: async () => { nativeCalls += 1; throw new Error('native inspector executed'); },
  };
  try {
    await assert.rejects(withOwnedConnectRootSnapshot(root, async (snapshot) => ({
      diagnostic: snapshot.authorityDiagnostic,
      identity: await readSnapshotPublicInstanceIdentity(snapshot.identityDirectory),
      stack: snapshot.envFileValues.PROPR_STACK,
    }), {
      platform: 'win32',
      authorityInspector: forbiddenInspector,
      parseEnvFile: () => ({ PROPR_STACK: 'readonly' }),
    }), ConnectRootError);
    assert.ok(nativeCalls > 0);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('trusted Connect config read is bounded, root-specific, replacement-safe, and Windows-case distinct', async () => {
  const parent = temporaryRoot('propr-connect-trusted-config-');
  const home = join(parent, 'os-home');
  const configDir = join(home, '.propr');
  privateDirectory(configDir);
  const configPath = join(configDir, 'config.json');
  const root = '/trusted/stack';
  const writeConfig = (value: unknown) => {
    writeFileSync(configPath, JSON.stringify(value), { mode: 0o600 });
    chmodSync(configPath, 0o600);
  };
  try {
    writeConfig({
      githubToken: 'must-never-cross',
      tunnelEnabledByRoot: { [root]: false, '/other/stack': true },
    });
    assert.equal(await readTrustedConnectTunnelOverride(root, { trustedHome: home }), false);
    assert.equal(await readTrustedConnectTunnelOverride('/other/stack', { trustedHome: home }), true);
    assert.equal(await readTrustedConnectTunnelOverride('/unset/stack', { trustedHome: home }), undefined);
    writeConfig({ githubToken: 'must-never-cross', tunnelEnabledByRoot: { [root]: true } });
    assert.equal(await readTrustedConnectTunnelOverride(root, { trustedHome: home }), true);

    writeConfig({ tunnelEnabledByRoot: { 'C:\\Work\\Stack': false, 'c:\\work\\stack': true } });
    const inspector: ConnectRootAuthorityInspector = {
      inspectDarwinAcl: (_path, _fd, identity) => ({ version: 1, ...identity, acl: '!#acl 1\n' }),
      inspectWindowsAcl: async (_path, identity, _fd, kind = 'env') => safeWindowsAuthority(identity, kind),
    };
    assert.equal(await readTrustedConnectTunnelOverride('C:\\Work\\Stack', {
      platform: 'win32', trustedHome: home, authorityInspector: inspector,
    }), false);
    assert.equal(await readTrustedConnectTunnelOverride('c:\\work\\stack', {
      platform: 'win32', trustedHome: home, authorityInspector: inspector,
    }), true);
    assert.equal(await readTrustedConnectTunnelOverride('c:\\WORK\\STACK', {
      platform: 'win32', trustedHome: home, authorityInspector: inspector,
    }), undefined);

    writeConfig({ tunnelEnabledByRoot: { [root]: false } });
    let swapped = false;
    await assert.rejects(readTrustedConnectTunnelOverride(root, {
      trustedHome: home,
      onBoundary: (boundary) => {
        if (boundary !== 'config-opened' || swapped) return;
        swapped = true;
        renameSync(configPath, `${configPath}.detached`);
        writeConfig({ tunnelEnabledByRoot: { [root]: true } });
      },
    }), TrustedConnectConfigError);

    writeFileSync(configPath, '{malformed', { mode: 0o600 });
    await assert.rejects(readTrustedConnectTunnelOverride(root, { trustedHome: home }), TrustedConnectConfigError);
    writeConfig({ tunnelEnabledByRoot: { [root]: false } });
    chmodSync(configPath, 0o666);
    await assert.rejects(readTrustedConnectTunnelOverride(root, { trustedHome: home }), TrustedConnectConfigError);
    chmodSync(configPath, 0o000);
    await assert.rejects(readTrustedConnectTunnelOverride(root, { trustedHome: home }), TrustedConnectConfigError);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('trusted config authenticates absence only at the exact config child open', async () => {
  const root = '/trusted/stack';
  const boundaries = [
    'home-before-open',
    'home-opened',
    'config-directory-before-open',
    'config-directory-opened',
    'config-before-open',
    'config-opened',
  ] as const;
  for (const boundary of boundaries) {
    const parent = temporaryRoot(`propr-config-barrier-${boundary}-`);
    const home = join(parent, 'home');
    const configDir = join(home, '.propr');
    const configPath = join(configDir, 'config.json');
    privateDirectory(configDir);
    writeFileSync(configPath, JSON.stringify({ tunnelEnabledByRoot: { [root]: false } }), { mode: 0o600 });
    chmodSync(configPath, 0o600);
    let replaced = false;
    try {
      await assert.rejects(readTrustedConnectTunnelOverride(root, {
        trustedHome: home,
        onBoundary: (current) => {
          if (current !== boundary || replaced) return;
          replaced = true;
          if (current.startsWith('home-')) {
            renameSync(home, `${home}.detached`);
            privateDirectory(join(home, '.propr'));
            writeFileSync(configPath, JSON.stringify({ tunnelEnabledByRoot: { [root]: true } }), { mode: 0o600 });
          } else if (current.startsWith('config-directory-')) {
            renameSync(configDir, `${configDir}.detached`);
            privateDirectory(configDir);
            writeFileSync(configPath, JSON.stringify({ tunnelEnabledByRoot: { [root]: true } }), { mode: 0o600 });
          } else {
            renameSync(configPath, `${configPath}.detached`);
            writeFileSync(configPath, JSON.stringify({ tunnelEnabledByRoot: { [root]: true } }), { mode: 0o600 });
            chmodSync(configPath, 0o600);
          }
        },
      }), TrustedConnectConfigError, boundary);
      assert.equal(replaced, true, boundary);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  }

  const parent = temporaryRoot('propr-config-absence-');
  const home = join(parent, 'home');
  const configDir = join(home, '.propr');
  try {
    privateDirectory(home);
    assert.equal(lstatSync(home).isDirectory(), true);
    assert.equal(existsSync(configDir), false);
    assert.equal(await readTrustedConnectTunnelOverride(root, { trustedHome: home }), undefined);
    assert.equal(existsSync(configDir), false, 'an absent .propr directory is never created');

    privateDirectory(configDir);
    assert.equal(await readTrustedConnectTunnelOverride(root, { trustedHome: home }), undefined);
    rmSync(configDir, { recursive: true });
    assert.equal(await readTrustedConnectTunnelOverride(root, { trustedHome: home }), undefined);
    assert.equal(existsSync(configDir), false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }

  const windowsParent = temporaryRoot('propr-config-absence-windows-');
  const windowsHome = join(windowsParent, 'home');
  privateDirectory(windowsHome);
  const inspectedKinds: string[] = [];
  const windowsInspector: ConnectRootAuthorityInspector = {
    inspectDarwinAcl: (_path, _fd, identity) => ({ version: 1, ...identity, acl: '!#acl 1\n' }),
    inspectWindowsAcl: async (_path, identity, _fd, kind = 'env') => {
      inspectedKinds.push(kind);
      return safeWindowsAuthority(identity, kind);
    },
  };
  try {
    assert.equal(await readTrustedConnectTunnelOverride(root, {
      platform: 'win32',
      trustedHome: windowsHome,
      authorityInspector: windowsInspector,
    }), undefined);
    assert.ok(inspectedKinds.includes('home'));
    assert.equal(existsSync(join(windowsHome, '.propr')), false);
  } finally {
    rmSync(windowsParent, { recursive: true, force: true });
  }

  for (const race of ['home-aba', 'config-directory-aba', 'config-directory-symlink'] as const) {
    const raceParent = temporaryRoot(`propr-config-absence-${race}-`);
    const raceHome = join(raceParent, 'home');
    const raceConfigDir = join(raceHome, '.propr');
    const detachedHome = join(raceParent, 'home-detached');
    const detachedConfigDir = join(raceHome, '.propr-detached');
    privateDirectory(raceHome);
    if (race !== 'home-aba') privateDirectory(raceConfigDir);
    let raced = false;
    try {
      await assert.rejects(readTrustedConnectTunnelOverride(root, {
        trustedHome: raceHome,
        onBoundary: (current) => {
          if (current !== 'config-directory-before-open' || raced) return;
          raced = true;
          if (race === 'home-aba') {
            renameSync(raceHome, detachedHome);
            privateDirectory(raceHome);
          } else {
            renameSync(raceConfigDir, detachedConfigDir);
            if (race === 'config-directory-aba') privateDirectory(raceConfigDir);
            else symlinkSync(detachedConfigDir, raceConfigDir, 'dir');
          }
        },
      }), TrustedConnectConfigError, race);
      assert.equal(raced, true, race);
    } finally {
      rmSync(raceParent, { recursive: true, force: true });
    }
  }
});
