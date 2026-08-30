import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  inspectAnyCpuPe,
  compileWindowsAuthorityDirect,
  nativeLauncherAuthenticationSubstage,
  preserveWindowsAuthorityCompilerFailure,
  buildWindowsAuthorityHelper,
  decodeWindowsSystemDirectoryRecord,
  resolveWindowsCompilerLayout,
  sanitizeWindowsCompilerDiagnostics,
  validateWindowsAuthoritySource,
  WINDOWS_AUTHORITY_COMPILER_SUBSTAGES,
  WINDOWS_AUTHORITY_EXECUTABLE,
  WINDOWS_AUTHORITY_MANIFEST,
  WINDOWS_AUTHORITY_SOURCE,
  WINDOWS_BUILD_CHILD_EVIDENCE,
} from './build-windows-authority-helper.mjs';
import {
  buildWindowsNativeLauncher,
  decodeWindowsCurrentTokenSid,
  decodeWindowsDirectoryOwnerSid,
  invokeWindowsAclTool,
  prepareWindowsAuthorityBuildDirectory,
  resolveWindowsAclTool,
  WINDOWS_NATIVE_BUILD_STAGING_DIRECTORY,
  WINDOWS_NATIVE_LAUNCHER_SOURCE_DIRECTORY,
} from './build-windows-native-launcher.mjs';
import {
  classifyWindowsNativeBuildFailure,
  sanitizeWindowsNativeBuildDiagnostics,
} from './build-windows-native-launcher.mjs';
import {
  inspectPackagedWindowsAuthority,
  refreshPackagedWindowsAuthorityManifest,
} from './inspect-packaged-windows-authority.mjs';

const windowsNativeBuildOnly = {
  skip: process.platform !== 'win32' || process.env.PROPR_WINDOWS_AUTHORITY_NATIVE_BUILD_TESTS !== '1',
};
const require = createRequire(import.meta.url);
const nativeBuildBootstrapPath = join(WINDOWS_NATIVE_LAUNCHER_SOURCE_DIRECTORY, 'build', 'Release',
  'propr_windows_build_bootstrap.node');
const execFileAsync = promisify(execFile);
const kernelTakeown = String.raw`\\?\GLOBALROOT\SystemRoot\System32\takeown.exe`;
const kernelIcacls = String.raw`\\?\GLOBALROOT\SystemRoot\System32\icacls.exe`;
const kernelWhoami = String.raw`\\?\GLOBALROOT\SystemRoot\System32\whoami.exe`;
const managedPe = () => {
  const bytes = Buffer.alloc(1024);
  bytes.writeUInt16LE(0x5a4d, 0);
  bytes.writeUInt32LE(0x80, 0x3c);
  bytes.write('PE\0\0', 0x80, 'ascii');
  bytes.writeUInt16LE(0x14c, 0x84);
  bytes.writeUInt16LE(1, 0x86);
  bytes.writeUInt16LE(224, 0x94);
  bytes.writeUInt16LE(0x10b, 0x98);
  bytes.writeUInt32LE(0x2000, 0x98 + 96 + (14 * 8));
  bytes.writeUInt32LE(72, 0x98 + 96 + (14 * 8) + 4);
  bytes.writeUInt32LE(0x200, 0x178 + 8);
  bytes.writeUInt32LE(0x2000, 0x178 + 12);
  bytes.writeUInt32LE(0x200, 0x178 + 16);
  bytes.writeUInt32LE(0x200, 0x178 + 20);
  bytes.writeUInt32LE(0x1, 0x210);
  return bytes;
};

const systemDirectoryRecord = path => {
  const output = Buffer.alloc(2 + (520 * 2));
  output.writeUInt16LE(path.length, 0);
  output.write(path, 2, 'utf16le');
  return output;
};

test('bounded Windows system-directory channel rejects NT aliases, malformed records, and trailing data', () => {
  assert.equal(decodeWindowsSystemDirectoryRecord(systemDirectoryRecord('C:\\Windows')), 'C:\\Windows');
  assert.throws(() => decodeWindowsSystemDirectoryRecord(systemDirectoryRecord('\\\\?\\GLOBALROOT\\SystemRoot')), /BUILD_COMPILER/);
  assert.throws(() => decodeWindowsSystemDirectoryRecord(Buffer.alloc(8)), /BUILD_COMPILER/);
  const trailing = systemDirectoryRecord('C:\\Windows');
  trailing[trailing.length - 1] = 1;
  assert.throws(() => decodeWindowsSystemDirectoryRecord(trailing), /BUILD_COMPILER/);
});

test('compiler failures expose only fixed non-secret authenticate-to-spawn substages', () => {
  assert.deepEqual(WINDOWS_AUTHORITY_COMPILER_SUBSTAGES, [
    'DIRECTORY_PROBE', 'CATALOG_ENUMERATION', 'MEMBER_TAG', 'CATALOG_HASH',
    'WINTRUST_POLICY', 'REVOCATION', 'CATALOG_LEASE', 'SIGNER_PARSE', 'EXACT_PUBLISHER', 'ROOT_PIN', 'CERTIFICATE_PIN',
    'SPKI_PIN', 'COMPILER_OPEN', 'REFERENCE_OPEN', 'SIGNER_CATALOG', 'BOOTSTRAP_READ', 'BOOTSTRAP_AUTH',
    'LAUNCHER_AUTH', 'OPEN', 'FILE_META', 'OWNER', 'DACL', 'DACL_PROTECTED', 'ARCH', 'HASH',
    'SAME_IMAGE', 'LEASE', 'SOURCE_COPY', 'SPAWN',
    'COMPILE', 'LINK', 'EXIT', 'TIMEOUT', 'OUTPUT_LIMIT', 'IMAGE', 'OUTPUT_VALIDATION',
  ]);
  assert.ok(WINDOWS_AUTHORITY_COMPILER_SUBSTAGES.every(stage => /^[A-Z_]{4,24}$/.test(stage)));
});

test('token SID parsing accepts one canonical non-system account record and rejects identity claims', () => {
  assert.equal(decodeWindowsCurrentTokenSid('"HOST\\runner","S-1-5-21-1-2-3-1001"\r\n'),
    'S-1-5-21-1-2-3-1001');
  assert.equal(decodeWindowsCurrentTokenSid('"AzureAD\\runner","S-1-12-1-1-2-3-4"\n'), 'S-1-12-1-1-2-3-4');
  assert.equal(decodeWindowsDirectoryOwnerSid('S-1-5-21-1-2-3-1001\r\n'), 'S-1-5-21-1-2-3-1001');
  for (const record of [
    '"SYSTEM","S-1-5-18"\r\n',
    '"Administrators","S-1-5-32-544"\r\n',
    '"service","S-1-5-80-1-2-3-4-5"\r\n',
    '"runner","S-1-5-21-1-2-3-4294967296"\r\n',
    '"runner","S-1-5-21-1-2-3-1001"\r\n"other","S-1-5-21-1-2-3-1002"\r\n',
    'runner,S-1-5-21-1-2-3-1001\r\n',
  ]) assert.throws(() => decodeWindowsCurrentTokenSid(record), /BOOTSTRAP_AUTH/);
  assert.throws(() => decodeWindowsDirectoryOwnerSid('S-1-5-18\r\n'), /BOOTSTRAP_AUTH/);
  assert.throws(() => decodeWindowsDirectoryOwnerSid('S-1-5-21-1-2-3-1001\r\nextra\r\n'), /BOOTSTRAP_AUTH/);
  assert.throws(() => decodeWindowsCurrentTokenSid(process.env.USERNAME), /BOOTSTRAP_AUTH/);
});

test('native launcher authentication failures map to fixed secret-free substages', () => {
  assert.equal(nativeLauncherAuthenticationSubstage({ code: 'MODULE_AUTHORITY' }), 'LAUNCHER_AUTH');
  assert.equal(nativeLauncherAuthenticationSubstage({ code: 'MODULE_ARGUMENT' }), 'LAUNCHER_AUTH');
  assert.equal(nativeLauncherAuthenticationSubstage({ code: 'MODULE_IMAGE' }), 'SAME_IMAGE');
  for (const predicate of ['OPEN', 'FILE_META', 'OWNER', 'DACL', 'DACL_PROTECTED', 'ARCH', 'HASH']) {
    assert.equal(nativeLauncherAuthenticationSubstage({ code: predicate }), predicate);
  }
  assert.equal(nativeLauncherAuthenticationSubstage(new Error('C:\\secret\\module.node')), 'LAUNCHER_AUTH');
});

test('node-gyp failures retain bounded secret-free compiler causes and evidence', () => {
  const compile = Object.assign(new Error('command failed'), {
    code: 1,
    stdout: '',
    stderr: String.raw`D:\a\propr\propr\apps\desktop\src\native\windows-launcher\propr_windows_launcher.cc(503,36): error C2065: 'SECRET_ENV_VALUE': undeclared identifier`,
  });
  assert.equal(classifyWindowsNativeBuildFailure(compile), 'COMPILE');
  assert.deepEqual(sanitizeWindowsNativeBuildDiagnostics(compile.stderr), [
    'propr_windows_launcher.cc:503:C2065',
  ]);
  assert.equal(classifyWindowsNativeBuildFailure(Object.assign(new Error('failed'), {
    code: 2,
    stderr: String.raw`D:\private\propr_windows_launcher.obj : fatal error LNK1120: 1 unresolved externals`,
  })), 'LINK');
  assert.equal(classifyWindowsNativeBuildFailure(Object.assign(new Error('spawn'), { code: 'ENOENT' })), 'SPAWN');
  assert.equal(classifyWindowsNativeBuildFailure(Object.assign(new Error('invalid spawn'), { code: 'EINVAL' })), 'SPAWN');
  assert.equal(classifyWindowsNativeBuildFailure(Object.assign(new Error('timeout'), {
    code: null, killed: true, signal: 'SIGTERM',
  })), 'TIMEOUT');
  assert.equal(classifyWindowsNativeBuildFailure(Object.assign(new Error('stdout maxBuffer length exceeded'), {
    code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
  })), 'OUTPUT_LIMIT');
  assert.equal(classifyWindowsNativeBuildFailure(Object.assign(new Error('signal'), {
    code: null, killed: false, signal: 'SIGABRT',
  })), 'EXIT');
});

test('native rebuild has one bounded hosted deadline, fixed progress evidence, and failure cleanup', async () => {
  const source = await readFile(new URL('./build-windows-native-launcher.mjs', import.meta.url), 'utf8');
  assert.match(source, /WINDOWS_NATIVE_REBUILD_TIMEOUT_MS = 6 \* 60_000/);
  assert.match(source, /timeout: WINDOWS_NATIVE_REBUILD_TIMEOUT_MS/);
  assert.match(source, /killSignal: 'SIGKILL'/);
  assert.match(source, /WINDOWS_NATIVE_REBUILD_MAX_BUFFER_BYTES = 64 \* 1024/);
  assert.match(source, /WINDOWS_NATIVE_REBUILD_PROGRESS_INTERVAL_MS = 60_000/);
  assert.match(source, /WINDOWS_NATIVE_REBUILD_PROGRESS_BUCKETS = 5/);
  assert.match(source, /nativeRebuildEvidence\('STARTED'\)/);
  assert.match(source, /nativeRebuildEvidence\(`ACTIVE_\$\{progressBucket\}`\)/);
  assert.match(source, /nativeRebuildEvidence\('PROCESS_COMPLETE'\)/);
  assert.match(source, /nativeRebuildEvidence\('OUTPUT_VERIFIED'\)/);
  assert.match(source, /nativeRebuildEvidence\('STAGED'\)/);
  assert.match(source, /rm\(nativeBuildDirectory, \{ recursive: true, force: true \}\)/);
  assert.match(source, /finally \{ clearInterval\(progress\); \}/);
  assert.doesNotMatch(source, /nativeRebuildEvidence\([^\n]*(?:stdout|stderr|process\.env)/);
});

test('build module authentication uses one bounded reaped child with compiler-cleanup grace and fixed records', async () => {
  const [source, workflow] = await Promise.all([
    readFile(new URL('./build-windows-authority-helper.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../../../.github/workflows/desktop-release-guard.yml', import.meta.url), 'utf8'),
  ]);
  assert.match(source, /WINDOWS_COMPILER_TIMEOUT_MS = 6 \* 60_000/);
  assert.match(source, /WINDOWS_BUILD_CHILD_TIMEOUT_MS = WINDOWS_COMPILER_TIMEOUT_MS \+ 30_000/);
  assert.match(source, /fork\(fileURLToPath\(import\.meta\.url\), \[WINDOWS_BUILD_CHILD_ARGUMENT\]/);
  assert.match(source, /stdio: \['ignore', 'ignore', 'ignore', 'ipc'\]/);
  assert.match(source, /child\.kill\('SIGKILL'\)/);
  assert.match(source, /child\.once\('close'/);
  assert.match(source, /WINDOWS_BUILD_CHILD_MAX_MESSAGES = 6/);
  assert.match(source, /WINDOWS_BUILD_CHILD_MAX_MESSAGE_BYTES = 2 \* 1024/);
  assert.doesNotMatch(source, /buildChildRequest\s*=\s*launcher\s*=>\s*\(\{[\s\S]{0,500}\bpath:/);
  assert.ok(source.indexOf('await cleanupWindowsAuthorityBuildStaging') < source.indexOf('await sealWindowsAuthorityDirectory'));
  assert.match(source, /if \(primaryFailure\) throw cleanupFailure \? addCleanupDiagnostic\(primaryFailure\) : primaryFailure/);
  assert.match(workflow, /platform: win32\s+arch: x64\s+runner: windows-2025/);
  assert.match(workflow, /platform: win32\s+arch: arm64\s+runner: windows-11-arm/);
  assert.ok((workflow.match(/PROPR_WINDOWS_AUTHORITY_NATIVE_BUILD_TESTS=1 npx tsx --test apps\/desktop\/scripts\/windows-authority-build\.test\.mjs/g) ?? []).length >= 2);
});

test('ACL tool launch maps synchronous throws and asynchronous rejections to one bounded spawn diagnostic', async () => {
  const canonical = String.raw`C:\Windows\System32\icacls.exe`;
  for (const invoke of [
    () => { throw Object.assign(new Error(String.raw`C:\private\sync detail`), { code: 'EINVAL' }); },
    async () => { throw Object.assign(new Error(String.raw`C:\private\async detail`), { code: 'EPERM' }); },
  ]) {
    await assert.rejects(
      invokeWindowsAclTool(canonical, ['/?'], invoke),
      error => error instanceof Error
        && error.message === 'Windows authority helper build failed [win-authority:BUILD_COMPILER:SPAWN]'
        && error.code === 'SPAWN'
        && !error.message.includes('private'),
    );
  }
  let observed;
  await invokeWindowsAclTool(canonical, ['/?'], async (tool, args, options) => { observed = { tool, args, options }; });
  assert.deepEqual(observed, {
    tool: canonical,
    args: ['/?'],
    options: { windowsHide: true, timeout: 30_000, maxBuffer: 64 * 1024, env: {} },
  });
});

test('fixed GLOBALROOT ACL tools resolve to normal held-identity DOS paths and execute', {
  skip: process.platform !== 'win32',
}, async () => {
  for (const [fixed, basename] of [[kernelTakeown, 'takeown.exe'], [kernelIcacls, 'icacls.exe'],
    [kernelWhoami, 'whoami.exe']]) {
    const canonical = await resolveWindowsAclTool(fixed);
    assert.match(canonical, /^[A-Za-z]:\\/);
    assert.equal(canonical.startsWith('\\\\'), false);
    assert.equal(canonical.toLowerCase().endsWith(`\\system32\\${basename}`), true);
    await invokeWindowsAclTool(canonical, ['/?']);
  }
});

test('compiler layout preserves recognized probe substages and redacts unknown failures', async () => {
  for (const substage of WINDOWS_AUTHORITY_COMPILER_SUBSTAGES) {
    const recognized = Object.assign(new Error('host detail must not escape'), {
      stage: 'BUILD_COMPILER',
      substage,
    });
    await assert.rejects(
      resolveWindowsCompilerLayout({}, async () => { throw recognized; }),
      error => error instanceof Error
        && error.message === `Windows authority helper build failed [win-authority:BUILD_COMPILER:${substage}]`
        && !error.message.includes('host detail'),
    );
  }
  await assert.rejects(
    resolveWindowsCompilerLayout({}, async () => { throw new Error('C:\\secret\\host-path'); }),
    error => error instanceof Error
      && error.message === 'Windows authority helper build failed [win-authority:BUILD_COMPILER:DIRECTORY_PROBE]'
      && !error.message.includes('secret'),
  );
});

test('every native build boundary preserves only the fixed secret-free compiler stage vocabulary', () => {
  for (const substage of WINDOWS_AUTHORITY_COMPILER_SUBSTAGES) {
    const exact = Object.assign(new Error('C:\\host-detail-must-not-be-rendered'), {
      stage: 'BUILD_COMPILER', substage, code: substage,
    });
    assert.throws(
      () => preserveWindowsAuthorityCompilerFailure(exact),
      error => error instanceof Error
        && error.message === `Windows authority helper build failed [win-authority:BUILD_COMPILER:${substage}]`
        && !error.message.includes('host-detail'),
    );
    assert.throws(
      () => preserveWindowsAuthorityCompilerFailure(Object.assign(new Error('raw native detail'), { code: substage })),
      error => error instanceof Error
        && error.message === `Windows authority helper build failed [win-authority:BUILD_COMPILER:${substage}]`
        && !error.message.includes('raw native detail'),
    );
  }
  assert.throws(
    () => preserveWindowsAuthorityCompilerFailure(new Error('C:\\secret\\compiler.log')),
    error => error instanceof Error
      && error.message === 'Windows authority helper build failed [win-authority:BUILD_COMPILER:DIRECTORY_PROBE]'
      && !error.message.includes('secret'),
  );
  const policy = Object.assign(new Error('raw certificate and host path'), {
    code: 'CATALOG_HASH',
    diagnostics: ['member:powershell.exe',
      'catalog:Microsoft-Windows-PowerShell.cat',
      `catalog-sha256:${'a'.repeat(64)}`,
      'catalog:C:\\Windows\\System32\\CatRoot\\secret.cat',
      'member:..\\powershell.exe',
      'CN=Microsoft Windows, C:\\host'],
  });
  assert.throws(() => preserveWindowsAuthorityCompilerFailure(policy), error => {
    assert.deepEqual(error.diagnostics, [
      'member:powershell.exe',
      'catalog:Microsoft-Windows-PowerShell.cat',
      `catalog-sha256:${'a'.repeat(64)}`,
    ]);
    return true;
  });
});

test('the current-owner exception exists only in the unshipped build bootstrap', async () => {
  const [binding, nativeBuild, nativeSource, runtime] = await Promise.all([
    readFile(new URL('../src/native/windows-launcher/binding.gyp', import.meta.url), 'utf8'),
    readFile(new URL('./build-windows-native-launcher.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../src/native/windows-launcher/propr_windows_launcher.cc', import.meta.url), 'utf8'),
    readFile(new URL('../src/windows-update-authority.ts', import.meta.url), 'utf8'),
  ]);
  assert.match(binding, /propr_windows_build_bootstrap/);
  assert.match(binding, /PROPR_WINDOWS_BUILD_BOOTSTRAP=1/);
  assert.match(nativeBuild, /buildBootstrap:/);
  assert.match(nativeBuild, /WINDOWS_NATIVE_BUILD_STAGING_DIRECTORY/);
  assert.match(nativeBuild, /publishHeldArtifact\(WINDOWS_NATIVE_BUILD_BOOTSTRAP, buildBootstrapBytes/);
  assert.match(nativeBuild, /cleanupWindowsAuthorityBuildStaging/);
  assert.match(nativeBuild, /await mkdir\(root, \{ recursive: true \}\)/);
  assert.match(nativeBuild, /KERNEL_TAKEOWN, \['\/F', root, '\/R', '\/SKIPSL'\]/);
  assert.match(nativeBuild, /KERNEL_WHOAMI/);
  assert.match(nativeBuild, /KERNEL_POWERSHELL/);
  assert.match(nativeBuild, /\['\/user', '\/fo', 'csv', '\/nh'\]/);
  assert.match(nativeBuild, /GetAccessControl/);
  assert.match(nativeBuild, /env: \{\}/);
  assert.match(nativeBuild, /`\*\$\{currentSid\}:\(OI\)\(CI\)M`/);
  assert.doesNotMatch(nativeBuild, /process\.env\.(?:USERNAME|USER|USERDOMAIN)/);
  assert.match(nativeBuild, /KERNEL_ICACLS, \[root, '\/reset', '\/T', '\/C', '\/Q'\]/);
  assert.match(nativeBuild, /KERNEL_ICACLS, \[target, '\/reset', '\/Q'\]/);
  assert.match(nativeBuild, /KERNEL_ICACLS, \[target, '\/inheritance:r', '\/Q'\]/);
  assert.match(nativeBuild, /KERNEL_ICACLS, \[target, '\/setowner', `\*\$\{currentSid\}`, '\/Q'\]/);
  assert.match(nativeBuild, /protectWindowsBuildArtifact\(WINDOWS_NATIVE_LAUNCHER, authorityOwnerSid\)/);
  assert.match(nativeBuild, /resolveWindowsAclTool\(tool\)/);
  assert.match(nativeBuild, /await invoke\(tool, args, \{/);
  assert.doesNotMatch(nativeBuild, /execFileAsync\(tool, args,[\s\S]{0,180}\.catch/);
  assert.doesNotMatch(nativeBuild, /copyFile\(builtBuildBootstrap/);
  assert.match(await readFile(new URL('./build-windows-authority-helper.mjs', import.meta.url), 'utf8'),
    /readHeldBuildOutput\([\s\S]*launcher\.buildBootstrap\.path[\s\S]*launcher\.buildBootstrap\.sha256/);
  assert.match(nativeSource, /authentication_mode == "held-build-artifact"/);
  assert.match(nativeSource, /DiagnoseSecureRegularFile\([\s\S]*held, expected_size, &held_id,[\s\S]*allow_current_build_owner/);
  assert.match(nativeSource,
    /SecureRegularFile\([\s\S]{0,80}held, expected_size, &held_id, allow_current_build_owner, allow_current_build_owner\)/);
  assert.match(nativeSource, /#if defined\(PROPR_WINDOWS_BUILD_BOOTSTRAP\)[\s\S]*Throw\(env, "OPEN"\)/);
  for (const predicate of ['FILE_META', 'OWNER', 'DACL', 'DACL_PROTECTED', 'ARCH', 'HASH']) {
    assert.match(nativeSource, new RegExp(`Throw\\(env, "${predicate}"\\)`));
  }
  assert.match(nativeSource, /SameIdentity\(held_id, loaded_id\)/);
  assert.match(runtime, /authenticationMode: 'runtime'/);
  assert.doesNotMatch(runtime, /held-build-artifact/);
});

test('absent Windows build roots are created before their DACL is protected', windowsNativeBuildOnly, async () => {
  const parent = await mkdtemp(join(tmpdir(), 'propr-absent-build-root-'));
  const root = join(parent, 'private', 'staging');
  try {
    await prepareWindowsAuthorityBuildDirectory(root);
    assert.equal((await lstat(root)).isDirectory(), true);
  } finally {
    await prepareWindowsAuthorityBuildDirectory(parent).catch(() => undefined);
    await rm(parent, { recursive: true, force: true });
  }
});

test('protected build staging removes hostile explicit and inherited ACEs and rejects a swapped root',
  windowsNativeBuildOnly, async () => {
    const launcher = await buildWindowsNativeLauncher();
    const buildBootstrap = require(nativeBuildBootstrapPath);
    const parent = await mkdtemp(join(tmpdir(), 'propr-hostile-precreated-root-'));
    const root = join(parent, 'staging');
    const artifact = join(root, 'propr-windows-launcher.node');
    const displaced = join(parent, 'protected-root');
    const canonicalIcacls = await resolveWindowsAclTool(kernelIcacls);
    const policy = {
      path: artifact,
      size: launcher.size,
      sha256: launcher.sha256,
      production: false,
      authenticationMode: 'held-build-artifact',
      publisher: null,
      signerCertificateSha256: null,
      signerSpkiSha256: null,
    };
    try {
      await invokeWindowsAclTool(canonicalIcacls,
        [parent, '/grant', '*S-1-5-32-545:(OI)(CI)M', '/Q']);
      await mkdir(root);
      await copyFile(launcher.path, artifact);
      await invokeWindowsAclTool(canonicalIcacls, [root, '/grant', '*S-1-5-32-546:(OI)(CI)M', '/T', '/C', '/Q']);
      await prepareWindowsAuthorityBuildDirectory(root);
      assert.equal(typeof buildBootstrap.loadVerifiedModule(policy).probeSystemDirectory, 'function',
        'reset plus inheritance removal leaves only the exact build identities');

      await rename(root, displaced);
      await mkdir(root);
      await copyFile(launcher.path, artifact);
      assert.throws(() => buildBootstrap.loadVerifiedModule(policy), error => error?.code === 'DACL',
        'a pathname swap cannot inherit the protected staging capability');
      await rm(root, { recursive: true, force: true });
      await rename(displaced, root);
    } finally {
      await prepareWindowsAuthorityBuildDirectory(parent).catch(() => undefined);
      await rm(parent, { recursive: true, force: true });
    }
  });

test('real filtered current token can read and authenticate exact build staging', windowsNativeBuildOnly, async t => {
  const whoami = await resolveWindowsAclTool(kernelWhoami);
  const { stdout } = await execFileAsync(whoami, ['/groups', '/fo', 'csv', '/nh'], {
    windowsHide: true, timeout: 30_000, maxBuffer: 64 * 1024, encoding: 'utf8', env: {},
  });
  const administrators = stdout.split(/\r?\n/).find(line => line.includes('S-1-5-32-544'));
  if (administrators?.includes('Enabled group')) {
    t.skip('current Windows test token is elevated');
    return;
  }
  const launcher = await buildWindowsNativeLauncher();
  const buildBootstrap = require(nativeBuildBootstrapPath);
  assert.equal(typeof buildBootstrap.loadVerifiedModule({
    path: launcher.path,
    size: launcher.size,
    sha256: launcher.sha256,
    production: false,
    authenticationMode: 'held-build-artifact',
    publisher: null,
    signerCertificateSha256: null,
    signerSpkiSha256: null,
  }).probeSystemDirectory, 'function');
});

test('hosted x64 and ARM64 stage the exact launcher predicate before compilation',
  windowsNativeBuildOnly, async () => {
    assert.ok(process.arch === 'x64' || process.arch === 'arm64');
    const launcher = await buildWindowsNativeLauncher({ restage: true });
    assert.equal(launcher.architecture, process.arch);
    const buildBootstrap = require(nativeBuildBootstrapPath);
    const authenticated = buildBootstrap.loadVerifiedModule({
      path: launcher.path,
      size: launcher.size,
      sha256: launcher.sha256,
      production: false,
      authenticationMode: 'held-build-artifact',
      publisher: null,
      signerCertificateSha256: null,
      signerSpkiSha256: null,
    });
    assert.equal(typeof authenticated.probeSystemDirectory, 'function',
      `${process.arch} staged launcher passes OPEN, FILE_META, OWNER, DACL, DACL_PROTECTED, ARCH, and HASH`);
  });

test('build-owner module authentication is compile-time-only and ACL-strict',
  windowsNativeBuildOnly, async () => {
    const launcher = await buildWindowsNativeLauncher();
    const buildBootstrap = require(nativeBuildBootstrapPath);
    const runtimeBootstrap = require(join(WINDOWS_NATIVE_LAUNCHER_SOURCE_DIRECTORY, 'build', 'Release',
      'propr_windows_bootstrap.node'));
    const policy = {
      path: launcher.path,
      size: launcher.size,
      sha256: launcher.sha256,
      production: false,
      publisher: null,
      signerCertificateSha256: null,
      signerSpkiSha256: null,
    };
    assert.throws(() => runtimeBootstrap.loadVerifiedModule({
      ...policy, authenticationMode: 'held-build-artifact',
    }), error => error?.code === 'MODULE_ARGUMENT');
    assert.throws(() => runtimeBootstrap.loadVerifiedModule({
      ...policy, authenticationMode: 'runtime',
    }), error => error?.code === 'MODULE_AUTHORITY', 'runtime rejects a current-owner authority module');
    assert.throws(() => buildBootstrap.loadVerifiedModule({
      ...policy, authenticationMode: 'runtime',
    }), error => error?.code === 'MODULE_ARGUMENT', 'build-only bootstrap rejects runtime mode confusion');
    assert.throws(() => buildBootstrap.loadVerifiedModule({
      ...policy, authenticationMode: 'held-build-artifact', production: true,
    }), error => error?.code === 'MODULE_ARGUMENT', 'production mode cannot reach the current-owner allowance');

    const root = await mkdtemp(join(tmpdir(), 'propr-build-owner-mode-'));
    const broad = join(root, 'propr-windows-launcher.node');
    try {
      await copyFile(launcher.path, broad);
      await invokeWindowsAclTool(await resolveWindowsAclTool(kernelIcacls),
        [broad, '/inheritance:r', '/grant:r', '*S-1-5-32-545:M', '/Q']);
      assert.throws(() => buildBootstrap.loadVerifiedModule({
        ...policy, path: broad, authenticationMode: 'held-build-artifact',
      }), error => error?.code === 'DACL');
      await prepareWindowsAuthorityBuildDirectory(root);
      await invokeWindowsAclTool(await resolveWindowsAclTool(kernelIcacls),
        [broad, '/grant', '*S-1-5-21-111111111-222222222-333333333-4444:M', '/Q']);
      assert.throws(() => buildBootstrap.loadVerifiedModule({
        ...policy, path: broad, authenticationMode: 'held-build-artifact',
      }), error => error?.code === 'DACL', 'a different user SID cannot gain staging write authority');
    } finally { await rm(root, { recursive: true, force: true }); }

  });

test('bounded build child unloads staging modules before cleanup and preserves authentication failures',
  windowsNativeBuildOnly, async () => {
    const exact = await buildWindowsAuthorityHelper(process.env);
    assert.deepEqual(exact.buildChildEvidence, WINDOWS_BUILD_CHILD_EVIDENCE);
    assert.equal(exact.compiler.kind, 'windows-fixed-system-dotnet-framework-csc-v1');
    assert.deepEqual(Object.keys(exact.compiler).sort(), ['framework', 'kind']);
    assert.match(exact.sourceSha256, /^[a-f0-9]{64}$/);
    assert.equal((await readdir(join(WINDOWS_AUTHORITY_EXECUTABLE, '..')))
      .some(name => name.startsWith('compile-') || name === '.build-staging'), false,
    'verified private compiler input/output and native staging leave no residue');
    await assert.rejects(lstat(WINDOWS_NATIVE_BUILD_STAGING_DIRECTORY), error => error?.code === 'ENOENT');

    for (const primary of ['BOOTSTRAP_AUTH', 'LAUNCHER_AUTH', 'OPEN', 'FILE_META', 'OWNER', 'DACL',
      'DACL_PROTECTED', 'ARCH', 'HASH', 'SAME_IMAGE']) {
      await assert.rejects(
        buildWindowsAuthorityHelper({
          ...process.env,
          PROPR_WINDOWS_AUTHORITY_TEST_AUTH_FAILURE: primary,
          PROPR_WINDOWS_AUTHORITY_TEST_CLEANUP_FAULT: 'after-remove',
        }),
        error => {
          assert.equal(error?.stage, 'BUILD_COMPILER');
          assert.equal(error?.substage, primary);
          assert.equal(error?.message,
            `Windows authority helper build failed [win-authority:BUILD_COMPILER:${primary}]`);
          assert.deepEqual(error?.buildChildEvidence,
            WINDOWS_BUILD_CHILD_EVIDENCE.slice(0, 3), 'both authenticated native modules loaded in the child');
          assert.deepEqual(error?.cleanupDiagnostics, ['BUILD_COMPILER:LEASE']);
          return true;
        },
      );
      await assert.rejects(lstat(WINDOWS_NATIVE_BUILD_STAGING_DIRECTORY), error => error?.code === 'ENOENT');
    }
  });

test('compiler layout treats SystemRoot and windir as disagreement checks and rejects reparse references', async () => {
  const canonicalTempRoot = await realpath(tmpdir());
  const root = await realpath(await mkdtemp(join(canonicalTempRoot, 'propr-system-directory-')));
  try {
    const framework = join(root, 'Microsoft.NET', 'Framework64', 'v4.0.30319');
    await mkdir(framework, { recursive: true });
    for (const name of ['csc.exe', 'System.dll', 'System.Web.Extensions.dll']) await writeFile(join(framework, name), name);
    await chmod(join(framework, 'csc.exe'), 0o700);
    const exact = await resolveWindowsCompilerLayout({ SystemRoot: root, windir: root }, async () => root);
    assert.equal(exact.systemRoot, await realpath(root));
    await assert.rejects(resolveWindowsCompilerLayout({ SystemRoot: root, windir: join(root, 'fake') }, async () => root),
      /BUILD_COMPILER/);
    await rm(join(framework, 'System.dll'));
    await symlink(join(framework, 'System.Web.Extensions.dll'), join(framework, 'System.dll'));
    await assert.rejects(resolveWindowsCompilerLayout({}, async () => root), /BUILD_COMPILER/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('x64 and ARM64 hosted builds use one fixed-path compiler argv with no shell or inherited environment', async () => {
  assert.ok(['x64', 'arm64'].includes(process.arch) || process.platform !== 'win32');
  const systemRoot = resolve('fixed-windows-root');
  const framework = join(systemRoot, 'Microsoft.NET', process.arch === 'arm64' ? 'Framework' : 'Framework64',
    'v4.0.30319');
  const cwd = join(resolve('private-build-root'), 'compile-fixed');
  const layout = {
    systemRoot,
    framework,
    compiler: join(framework, 'csc.exe'),
    systemReference: join(framework, 'System.dll'),
    webReference: join(framework, 'System.Web.Extensions.dll'),
  };
  const privatePaths = {
    cwd,
    output: join(cwd, 'propr-windows-authority.exe'),
    source: join(cwd, 'propr-windows-authority.cs'),
  };
  let invocation;
  await compileWindowsAuthorityDirect(layout, privatePaths, async (...args) => { invocation = args; });
  assert.deepEqual(invocation[0], layout.compiler);
  assert.deepEqual(invocation[1], [
    '/nologo', '/noconfig', '/target:exe', '/platform:anycpu', '/optimize+', '/checked+', '/warnaserror+',
    `/out:${privatePaths.output}`, `/reference:${layout.systemReference}`, `/reference:${layout.webReference}`,
    privatePaths.source,
  ]);
  assert.deepEqual(invocation[2].env, { SystemRoot: systemRoot, TEMP: cwd, TMP: cwd });
  assert.equal(invocation[2].shell, false);
  assert.equal(invocation[2].timeout, 6 * 60_000);
  assert.equal(invocation[2].maxBuffer, 64 * 1024);
  assert.equal(Object.hasOwn(invocation[2].env, 'PATH'), false);
});

test('direct compiler failures expose only an exit class and bounded CS codes', async () => {
  assert.deepEqual(sanitizeWindowsCompilerDiagnostics(
    'C:\\private\\source.cs(1): error cs0123 secret\nENV=value CS0456 CS0123'), ['CS0123', 'CS0456']);
  const systemRoot = resolve('fixed-windows-root');
  const framework = join(systemRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319');
  const cwd = join(resolve('private-build-root'), 'compile-fixed');
  await assert.rejects(compileWindowsAuthorityDirect({
    systemRoot,
    framework,
    compiler: join(framework, 'csc.exe'),
    systemReference: join(framework, 'System.dll'),
    webReference: join(framework, 'System.Web.Extensions.dll'),
  }, {
    cwd,
    output: join(cwd, 'propr-windows-authority.exe'),
    source: join(cwd, 'propr-windows-authority.cs'),
  }, async () => {
    const error = new Error('C:\\private\\compiler path and environment secret');
    error.code = 1;
    error.stdout = 'C:\\private\\source.cs(7): error CS0123: source secret';
    error.stderr = 'SystemRoot=C:\\private error CS0456';
    throw error;
  }), error => {
    assert.equal(error?.substage, 'COMPILE');
    assert.deepEqual(error?.diagnostics, ['CS0123', 'CS0456']);
    assert.equal(error?.message, 'Windows authority helper build failed [win-authority:BUILD_COMPILER:COMPILE]');
    assert.doesNotMatch(`${error?.message}\n${error?.diagnostics?.join('\n')}`, /private|source\.cs|SystemRoot|ENV=/i);
    return true;
  });
});

test('committed Windows broker source is nonempty strict UTF-8 with a real executable entrypoint', async () => {
  const source = await readFile(WINDOWS_AUTHORITY_SOURCE);
  assert.match(validateWindowsAuthoritySource(source), /^[a-f0-9]{64}$/);
  assert.throws(() => validateWindowsAuthoritySource(Buffer.alloc(0)), /BUILD_SOURCE/);
  assert.throws(() => validateWindowsAuthoritySource(Buffer.from([0xc3, 0x28])), /BUILD_SOURCE/);
  assert.throws(() => validateWindowsAuthoritySource(Buffer.from('public class SourceOnly {}')), /BUILD_SOURCE/);
});

test('compiled helper output gate rejects corrupt, native-only, and wrong-machine PE files', () => {
  const exact = managedPe();
  assert.deepEqual(inspectAnyCpuPe(exact), { format: 'PE32', architecture: 'anycpu', machine: 'I386', clr: true });
  const nativeOnly = Buffer.from(exact);
  nativeOnly.writeUInt32LE(0, 0x98 + 96 + (14 * 8));
  assert.throws(() => inspectAnyCpuPe(nativeOnly), /BUILD_OUTPUT/);
  const wrongMachine = Buffer.from(exact);
  wrongMachine.writeUInt16LE(0xaa64, 0x84);
  assert.throws(() => inspectAnyCpuPe(wrongMachine), /BUILD_OUTPUT/);
  const required32Bit = Buffer.from(exact);
  required32Bit.writeUInt32LE(0x3, 0x210);
  assert.throws(() => inspectAnyCpuPe(required32Bit), /BUILD_OUTPUT/);
});

test('packaged helper refresh and inspection bind the exact held manifest and signed helper bytes', async () => {
  // Darwin aliases /var to /private/var. Establish the fixture below the
  // explicitly held canonical temp root so child proofs use one namespace.
  const trustedTempRoot = await realpath(tmpdir());
  const root = await realpath(await mkdtemp(join(trustedTempRoot, 'propr-packaged-helper-')));
  const executable = join(root, 'propr-windows-authority.exe');
  const launcherPath = join(root, 'propr-windows-launcher.node');
  const bootstrapPath = join(root, 'propr-windows-bootstrap.node');
  const manifestPath = join(root, 'propr-windows-authority.manifest.json');
  try {
    const bytes = managedPe();
    const launcher = Buffer.from(bytes);
    launcher.writeUInt16LE(0x8664, 0x84);
    await writeFile(executable, bytes);
    await writeFile(launcherPath, launcher);
    await writeFile(bootstrapPath, launcher);
    await writeFile(manifestPath, `${JSON.stringify({
      schemaVersion: 1,
      name: 'propr-windows-authority.exe',
      format: 'PE32',
      architecture: 'anycpu',
      machine: 'I386',
      clr: true,
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      sourceSha256: 'a'.repeat(64),
      protocol: 'propr-windows-authority-v1',
      trust: 'unsigned-validation',
      publisher: null,
      signerPins: [],
      signerCertificateSha256: null,
      signerSpkiSha256: null,
      launcher: {
        name: 'propr-windows-launcher.node',
        format: 'PE',
        architecture: 'x64',
        machine: 'AMD64',
        size: launcher.length,
        sha256: createHash('sha256').update(launcher).digest('hex'),
        trust: 'unsigned-validation',
        publisher: null,
        signerPins: [],
        signerCertificateSha256: null,
        signerSpkiSha256: null,
      },
      bootstrap: {
        name: 'propr-windows-bootstrap.node',
        format: 'PE',
        architecture: 'x64',
        machine: 'AMD64',
        size: launcher.length,
        sha256: createHash('sha256').update(launcher).digest('hex'),
        trust: 'unsigned-validation',
        publisher: null,
        signerPins: [],
        signerCertificateSha256: null,
        signerSpkiSha256: null,
      },
      compiler: {
        kind: 'windows-fixed-system-dotnet-framework-csc-v1',
        framework: 'Framework64-v4.0.30319',
      },
    })}\n`);
    await refreshPackagedWindowsAuthorityManifest(executable, manifestPath, {
      PROPR_DESKTOP_PRODUCTION_RELEASE: '0',
    });
    const manifest = await inspectPackagedWindowsAuthority(executable, manifestPath);
    assert.equal(manifest.sha256, createHash('sha256').update(bytes).digest('hex'));
    const corrupt = Buffer.from(bytes);
    corrupt[700] ^= 1;
    await writeFile(executable, corrupt);
    await assert.rejects(inspectPackagedWindowsAuthority(executable, manifestPath), /inspection failed/);
    await writeFile(executable, bytes);
    const corruptLauncher = Buffer.from(launcher);
    corruptLauncher[700] ^= 1;
    await writeFile(launcherPath, corruptLauncher);
    await assert.rejects(inspectPackagedWindowsAuthority(executable, manifestPath), /inspection failed/);
    const wrongArchitecture = Buffer.from(launcher);
    wrongArchitecture.writeUInt16LE(0xaa64, 0x84);
    await writeFile(launcherPath, wrongArchitecture);
    await assert.rejects(inspectPackagedWindowsAuthority(executable, manifestPath), /inspection failed/);
    await writeFile(launcherPath, launcher);
    const corruptBootstrap = Buffer.from(launcher);
    corruptBootstrap[700] ^= 1;
    await writeFile(bootstrapPath, corruptBootstrap);
    await assert.rejects(inspectPackagedWindowsAuthority(executable, manifestPath), /inspection failed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
