import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  inspectAnyCpuPe,
  nativeLauncherAuthenticationSubstage,
  preserveWindowsAuthorityCompilerFailure,
  buildWindowsAuthorityHelper,
  decodeWindowsSystemDirectoryRecord,
  resolveWindowsCompilerLayout,
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
const microsoftWindowsSubjectRdns = [
  '310b3009060355040613025553',
  '311330110603550408130a57617368696e67746f6e',
  '3110300e060355040713075265646d6f6e64',
  '311e301c060355040a13154d6963726f736f667420436f72706f726174696f6e',
  '311a3018060355040313114d6963726f736f66742057696e646f7773',
];
const microsoftWindowsSubjectDer = `3070${microsoftWindowsSubjectRdns.join('')}`;
const compilerInputEvidence = (name, sha256) => ({
  name,
  size: 1,
  sha256,
  signerCertificateSha256: '1308aad34660d785a76b7360c31308d8835cf5721c364a6f5aedcba85eb5b3de',
  signerSpkiSha256: 'a693625901b3bb9292a8c61aa3b75e80027d578ee01501005a4761dabbf1b7d1',
  signerRootSpkiSha256: '3'.repeat(64),
  catalogName: '10.0.26100.33296.cat',
  catalogSha256: '7'.repeat(64),
  catalogVolumeSerial: '5'.repeat(16),
  catalogFileId128: '6'.repeat(32),
});

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

test('build module authentication uses one six-minute reaped child and fixed bounded records', async () => {
  const [source, workflow] = await Promise.all([
    readFile(new URL('./build-windows-authority-helper.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../../../.github/workflows/desktop-release-guard.yml', import.meta.url), 'utf8'),
  ]);
  assert.match(source, /WINDOWS_BUILD_CHILD_TIMEOUT_MS = 6 \* 60_000/);
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

test('dynamic build catalog authority is standalone, cache-only, held, and independent of servicing tuples', async () => {
  const [source, builder, runtime, broker, packagedInspector, releaseArchitecture] = await Promise.all([
    readFile(new URL('../src/native/windows-launcher/propr_windows_launcher.cc', import.meta.url), 'utf8'),
    readFile(new URL('./build-windows-authority-helper.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../src/windows-update-authority.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/native/propr-windows-authority.cs', import.meta.url), 'utf8'),
    readFile(new URL('./inspect-packaged-windows-authority.mjs', import.meta.url), 'utf8'),
    readFile(new URL('./release-architecture.mjs', import.meta.url), 'utf8'),
  ]);
  assert.equal(createHash('sha256').update(Buffer.from(microsoftWindowsSubjectDer, 'hex')).digest('hex'),
    'bd68f19a09e1bdede787648ed1d0fde5b77d7bece7b1f9430bcfba4d10ec058e');
  assert.match(source, /SignerContent::StandaloneCatalog/);
  assert.match(source, /WTD_CACHE_ONLY_URL_RETRIEVAL/);
  assert.match(source, /CERT_CHAIN_REVOCATION_CHECK_CACHE_ONLY/);
  assert.match(source, /CERT_TRUST_IS_REVOKED/);
  assert.match(source, /SameHeldCatalog\(catalogs\[index\], catalog_identities\[index\], catalog_hashes\[index\]\)/);
  assert.match(source, /const CERT_NAME_BLOB& subject = certificate->pCertInfo->Subject;/);
  assert.match(source, /subject_der == kMicrosoftWindowsSubjectDer/);
  assert.match(source, new RegExp(microsoftWindowsSubjectDer));
  assert.match(source, /MicrosoftSystemComponentAuthority\(wrong_subject, wrong_root\)/);
  assert.doesNotMatch(source, /kMicrosoftCatalogPolicy|ApprovedMicrosoftCatalog|NamedMicrosoftCatalog/);
  assert.doesNotMatch(builder, /MICROSOFT_COMPILER_CATALOG_POLICY|KB5066128/);
  assert.doesNotMatch(runtime, /MICROSOFT_COMPILER_CATALOG_POLICY/);
  assert.doesNotMatch(broker, /MICROSOFT_COMPILER_CATALOG|KB5066128/);
  assert.doesNotMatch(packagedInspector, /KB5066128|f447c801fde63f35|fd4c63e1001a8281/);
  assert.doesNotMatch(releaseArchitecture, /KB5066128|f447c801fde63f35|fd4c63e1001a8281/);
  assert.match(runtime, /MICROSOFT_SYSTEM_CATALOG_POLICY/,
    'the runtime bootstrap authority remains independently pinned');
  assert.doesNotMatch(source, /ExactMicrosoftSystemPublisher/);
  assert.match(source, /GUID driver_action = DRIVER_ACTION_VERIFY/);
  assert.match(source, /member\.pcCatalogContext = nullptr;/);
  assert.match(source, /member\.hCatAdmin = admin;/);
  assert.match(source, /ExactCatalogBinding\(acquired_admin, enumerated_catalog, supplied_admin, supplied_catalog,/);
  assert.doesNotMatch(source, /&DRIVER_ACTION_VERIFY/);
  assert.doesNotMatch(source, /compiler-(?:wrong-signer|same-root-wrong-certificate|same-root-wrong-signer|subject-spoof|wrong-spki|manifest-replacement)/);
  assert.doesNotMatch(source, /\(void\)presented/);
  assert.match(source, /certificate->size\(\) != 64 \|\| spki->size\(\) != 64/,
    'rotating leaf evidence remains exact and bounded in the proof');
  for (const code of WINDOWS_AUTHORITY_COMPILER_SUBSTAGES.slice(1, 12)) {
    assert.match(source, new RegExp(`"${code}"`));
  }
});

test('catalog signer authority pins Microsoft system-component publisher and root independent of servicing tuple',
  windowsNativeBuildOnly, async () => {
    await buildWindowsNativeLauncher();
    const native = require(join(WINDOWS_NATIVE_LAUNCHER_SOURCE_DIRECTORY, 'build', 'Release',
      'propr_windows_launcher.node'));
    assert.equal(typeof native.microsoftSystemComponentForTest, 'function');
    const policy = {
      subjectDer: microsoftWindowsSubjectDer,
      rootSpkiSha256: '02376d0908ac23041cc7d666d9daf192554f7fc36317aa9cb800908616b28af8',
    };
    assert.equal(native.microsoftSystemComponentForTest(policy), true);
    const reorderedDer = `3070${[...microsoftWindowsSubjectRdns].reverse().join('')}`;
    assert.equal(native.microsoftSystemComponentForTest({ ...policy, subjectDer: reorderedDer }), false);
    assert.equal(native.microsoftSystemComponentForTest({
      ...policy,
      subjectDer: `${microsoftWindowsSubjectDer.slice(0, -2)}74`,
    }), false, 'a Microsoft-looking subject under the same root is not authority');
    assert.equal(native.microsoftSystemComponentForTest({
      ...policy,
      rootSpkiSha256: '0'.repeat(64),
    }), false, 'an exact-looking publisher under a different chain is not authority');
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
      assert.equal(typeof buildBootstrap.loadVerifiedModule(policy).compileHeld, 'function',
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
  }).compileHeld, 'function');
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
    assert.equal(typeof authenticated.compileHeld, 'function',
      `${process.arch} staged launcher passes OPEN, FILE_META, OWNER, DACL, DACL_PROTECTED, ARCH, and HASH`);
  });

test('build-owner module authentication is compile-time-only, ACL-strict, and held-identity-bound',
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

    const loaded = buildBootstrap.loadVerifiedModule({
      ...policy,
      authenticationMode: 'held-build-artifact',
      fault: 'barrier-before-module-load-swap',
    });
    assert.equal(typeof loaded.compileHeld, 'function', 'the held no-write/delete/rename lease binds the loaded identity');
    for (const mutation of ['delete', 'swap', 'rename']) {
      const held = buildBootstrap.loadVerifiedModule({
        ...policy,
        authenticationMode: 'held-build-artifact',
        fault: `barrier-before-module-load-${mutation}`,
      });
      assert.equal(typeof held.compileHeld, 'function', `${mutation} is denied across the held load boundary`);
    }
  });

test('bounded build child unloads staging modules before cleanup and preserves authentication failures',
  windowsNativeBuildOnly, async () => {
    const exact = await buildWindowsAuthorityHelper(process.env);
    assert.deepEqual(exact.buildChildEvidence, WINDOWS_BUILD_CHILD_EVIDENCE);
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

test('native WinTrust catalog binding requires the exact retained SHA-256 admin and catalog pair',
  windowsNativeBuildOnly, async () => {
    for (const fault of [
      'catalog-binding-null-admin',
      'catalog-binding-mismatched-admin',
      'catalog-binding-released-early',
      'catalog-binding-wrong-hash-algorithm',
      'catalog-binding-foreign-catalog-context',
    ]) {
      await prepareWindowsAuthorityBuildDirectory();
      await Promise.all([
        rm(WINDOWS_AUTHORITY_EXECUTABLE, { force: true }),
        rm(WINDOWS_AUTHORITY_MANIFEST, { force: true }),
      ]);
      await assert.rejects(
        buildWindowsAuthorityHelper({
          ...process.env,
          PROPR_WINDOWS_AUTHORITY_TEST_DIRECTORY_PROBE_FAULT: fault,
        }),
        error => error instanceof Error
          && error.message === 'Windows authority helper build failed [win-authority:BUILD_COMPILER:WINTRUST_POLICY]'
          && !error.message.includes('\\') && !error.message.includes('C:'),
        `${fault} must fail before the production C# compiler is spawned`,
      );
    }
    const exact = await buildWindowsAuthorityHelper({
      ...process.env,
      PROPR_WINDOWS_AUTHORITY_TEST_DIRECTORY_PROBE_FAULT: 'catalog-binding-exact-held-pair',
    });
    assert.equal(exact.skipped, false);
    assert.match(exact.sourceSha256, /^[a-f0-9]{64}$/);
    assert.equal(exact.compiler.inputs.length, 3);
    await assert.rejects(lstat(WINDOWS_NATIVE_BUILD_STAGING_DIRECTORY), error => error?.code === 'ENOENT');
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

test('committed Windows broker source is nonempty strict UTF-8 with a real executable entrypoint', async () => {
  const source = await readFile(WINDOWS_AUTHORITY_SOURCE);
  assert.match(validateWindowsAuthoritySource(source), /^[a-f0-9]{64}$/);
  assert.throws(() => validateWindowsAuthoritySource(Buffer.alloc(0)), /BUILD_SOURCE/);
  assert.throws(() => validateWindowsAuthoritySource(Buffer.from([0xc3, 0x28])), /BUILD_SOURCE/);
  assert.throws(() => validateWindowsAuthoritySource(Buffer.from('public class SourceOnly {}')), /BUILD_SOURCE/);
});

test('native compiler leases defeat compiler, reference, and exact-source substitution barriers', windowsNativeBuildOnly, async () => {
  for (const fault of [
    'compiler-swap-after-open', 'reference-swap-after-open', 'compiler-swap-before-create',
    'reference-swap-before-create', 'compiler-swap-after-process', 'source-swap-after-copy', 'source-rename',
    'source-hardlink', 'source-reparse', 'source-truncate', 'source-replace',
  ]) {
    const result = await buildWindowsAuthorityHelper({
      ...process.env,
      PROPR_WINDOWS_AUTHORITY_TEST_COMPILER_FAULT: fault,
    });
    assert.equal(result.skipped, false);
    assert.match(result.sourceSha256, /^[a-f0-9]{64}$/);
    assert.match(result.compiler.fileId128, /^[a-f0-9]{32}$/);
    assert.match(result.compiler.signerCertificateSha256, /^[a-f0-9]{64}$/);
    assert.match(result.compiler.signerSpkiSha256, /^[a-f0-9]{64}$/);
    for (const input of result.compiler.inputs) {
      assert.match(input.catalogSha256, /^[a-f0-9]{64}$/);
      assert.match(input.catalogVolumeSerial, /^[a-f0-9]{16}$/);
      assert.match(input.catalogFileId128, /^[a-f0-9]{32}$/);
    }
  }
});

test('native compiler signer, image, job, exit, and output failures stay bounded and clean', windowsNativeBuildOnly, async () => {
  const cases = [
    ['compiler-nonmember', 'CATALOG_ENUMERATION'],
    ['compiler-wrong-catalog', 'CATALOG_LEASE'],
    ['compiler-unsigned-catalog', 'SIGNER_PARSE'],
    ['compiler-swapped-catalog', 'CATALOG_LEASE'],
    ['compiler-member-replacement', 'CATALOG_LEASE'],
    ['compiler-held-member-identity-mismatch', 'IMAGE'],
    ['compiler-held-catalog-identity-mismatch', 'LEASE'],
    ['compiler-job', 'IMAGE'],
    ['compiler-image', 'IMAGE'],
    ['compiler-exit', 'EXIT'],
    ['compiler-output', 'OUTPUT_VALIDATION'],
  ];
  for (const [fault, substage] of cases) {
    await prepareWindowsAuthorityBuildDirectory();
    await Promise.all([
      rm(WINDOWS_AUTHORITY_EXECUTABLE, { force: true }),
      rm(WINDOWS_AUTHORITY_MANIFEST, { force: true }),
    ]);
    await assert.rejects(
      buildWindowsAuthorityHelper({ ...process.env, PROPR_WINDOWS_AUTHORITY_TEST_COMPILER_FAULT: fault }),
      error => error instanceof Error
        && error.message === `Windows authority helper build failed [win-authority:BUILD_COMPILER:${substage}]`
        && !error.message.includes('\\') && !error.message.includes('C:'),
    );
    for (const unpublished of [WINDOWS_AUTHORITY_EXECUTABLE, WINDOWS_AUTHORITY_MANIFEST]) {
      await assert.rejects(readFile(unpublished), error => error?.code === 'ENOENT',
        `${fault} must not publish a compiler/helper artifact`);
    }
  }
});

test('native directory catalog failures expose their exact bounded offline-policy substage', windowsNativeBuildOnly, async () => {
  for (const substage of [
    'CATALOG_ENUMERATION', 'MEMBER_TAG', 'CATALOG_HASH', 'WINTRUST_POLICY', 'REVOCATION', 'CATALOG_LEASE',
    'SIGNER_PARSE', 'EXACT_PUBLISHER', 'ROOT_PIN', 'CERTIFICATE_PIN', 'SPKI_PIN',
  ]) {
    await assert.rejects(
      buildWindowsAuthorityHelper({
        ...process.env,
        PROPR_WINDOWS_AUTHORITY_TEST_DIRECTORY_PROBE_FAULT: `directory-${substage}`,
      }),
      error => error instanceof Error
        && error.message === `Windows authority helper build failed [win-authority:BUILD_COMPILER:${substage}]`
        && !error.message.includes('\\') && !error.message.includes('C:'),
    );
  }
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
        kind: 'windows-catalog-authorized-dotnet-framework-csc-v1',
        framework: 'Framework64-v4.0.30319',
        signerCertificateSha256: '1308aad34660d785a76b7360c31308d8835cf5721c364a6f5aedcba85eb5b3de',
        signerSpkiSha256: 'a693625901b3bb9292a8c61aa3b75e80027d578ee01501005a4761dabbf1b7d1',
        signerRootSpkiSha256: '3'.repeat(64),
        volumeSerial: '4'.repeat(16),
        fileId128: '5'.repeat(32),
        inputs: [
          compilerInputEvidence('csc.exe', 'b'.repeat(64)),
          compilerInputEvidence('System.dll', 'c'.repeat(64)),
          compilerInputEvidence('System.Web.Extensions.dll', 'd'.repeat(64)),
        ],
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
