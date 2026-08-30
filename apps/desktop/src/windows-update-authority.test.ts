import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { copyFile, link, lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  crashWindowsLockedArtifactForTest,
  authenticateWindowsAuthorityHelperForTest,
  compileStageFromNativeLaunchErrorForTest,
  decodeWindowsAuthorityFramesForTest,
  encodeWindowsAuthorityFrameForTest,
  inspectWindowsAuthorityHelperPeForTest,
  ensureWindowsPrivateDirectory,
  injectWindowsAuthorityHeldFaultForTest,
  injectWindowsAuthorityProtocolFaultForTest,
  injectWindowsAuthorityTransportFaultForTest,
  inspectWindowsPrivatePath,
  openWindowsLockedArtifact,
  parseWindowsAuthorityStartupFailureForTest,
  parseWindowsAuthorityHelperManifestForTest,
  probeWindowsAuthorityCompile,
  probeWindowsAuthorityCompileFailureForTest,
  probeWindowsAuthorityBootstrapStageForTest,
  probeWindowsAuthorityProcessImageMismatchForTest,
  probeWindowsAuthorityNativeBoundaryForTest,
  probeWindowsAuthorityNativeLaunchStageForTest,
  probeWindowsAuthorityUnknownNativeLaunchStageForTest,
  probeWindowsAuthorityStartupFailureForTest,
  protectWindowsPrivateFile,
  shutdownWindowsAuthorityBrokerForTest,
  smokeWindowsUpdateAuthority,
  validateBootstrapIdentityRecordForTest,
  windowsAuthorityBrokerStatsForTest,
  WINDOWS_AUTHORITY_COMPILE_STAGES,
  WINDOWS_NATIVE_LAUNCH_FAILURE_CODES,
} from './windows-update-authority';
import {
  invokeWindowsAclTool,
  prepareWindowsAuthorityBuildDirectory,
  resolveWindowsAclTool,
  sealWindowsAuthorityDirectory,
} from '../scripts/build-windows-native-launcher.mjs';

const execFileAsync = promisify(execFile);
const windowsOnly = { skip: process.platform !== 'win32' };
const kernelPowerShell = String.raw`\\?\GLOBALROOT\SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe`;
const kernelIcacls = String.raw`\\?\GLOBALROOT\SystemRoot\System32\icacls.exe`;
test('native Windows exact production C# compile probe reaches ready', windowsOnly, async () => {
  assert.equal(await probeWindowsAuthorityCompile(), 'READY');
});

test('native Windows compile probe bounds startup failure to an enumerated non-secret stage', windowsOnly, async () => {
  assert.equal(await probeWindowsAuthorityCompileFailureForTest(), 'BUILD_OUTPUT');
  assert.equal(await probeWindowsAuthorityStartupFailureForTest(), 'ready_protocol');
});

test('native launch errors map only the fixed code allowlist to redacted transport stages', () => {
  assert.deepEqual(WINDOWS_NATIVE_LAUNCH_FAILURE_CODES, [
    'HELPER_OPEN',
    'HELPER_AUTHORITY',
    'PIPE_CREATE',
    'PROCESS_CREATE',
    'JOB_CREATE',
    'JOB_LIMIT',
    'JOB_ASSIGN',
    'IMAGE_QUERY',
    'IMAGE_OPEN',
    'IMAGE_AUTH',
    'PROCESS_RESUME',
    'PIPE_EXPORT',
  ]);
  for (const code of WINDOWS_NATIVE_LAUNCH_FAILURE_CODES) {
    assert.equal(compileStageFromNativeLaunchErrorForTest({
      code,
      message: 'forbidden-raw-message',
      errno: 1234,
      path: 'forbidden-path',
      sid: 'forbidden-sid',
      hash: 'forbidden-hash',
      acl: 'forbidden-acl',
      process: 'forbidden-process-data',
      secret: 'forbidden-secret',
    }), `TRANSPORT_${code}`);
  }
  for (const error of [
    { code: 'PROCESS_IMAGE' },
    { code: 'NATIVE_TEST_UNKNOWN', message: 'forbidden-raw-message' },
    { message: 'JOB_CREATE' },
    Object.create({ code: 'JOB_CREATE' }) as object,
    Object.defineProperty({}, 'code', { get: () => { throw new Error('forbidden-raw-message'); } }),
    null,
  ]) assert.equal(compileStageFromNativeLaunchErrorForTest(error), 'TRANSPORT_SPAWN');
});

const helperManifest = (overrides: Record<string, unknown> = {}): Buffer => Buffer.from(`${JSON.stringify({
  schemaVersion: 1,
  name: 'propr-windows-authority.exe',
  format: 'PE32',
  architecture: 'anycpu',
  machine: 'I386',
  clr: true,
  size: 4096,
  sha256: 'a'.repeat(64),
  sourceSha256: 'b'.repeat(64),
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
    size: 4096,
    sha256: 'f'.repeat(64),
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
    size: 4096,
    sha256: '9'.repeat(64),
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
  ...overrides,
})}\n`);

test('Windows helper manifest is fatal-UTF8, exact, architecture-bound, and distinguishes unsigned validation', () => {
  assert.equal(parseWindowsAuthorityHelperManifestForTest(helperManifest()).trust, 'unsigned-validation');
  const base = JSON.parse(helperManifest().toString());
  const certificate = '1'.repeat(64);
  const spki = '2'.repeat(64);
  const pins = [`certificate-sha256:${certificate}`, `spki-sha256:${spki}`].sort();
  const production = {
    trust: 'production-signed',
    publisher: 'CN=ProPR Test Publisher',
    signerPins: pins,
    signerCertificateSha256: certificate,
    signerSpkiSha256: spki,
    launcher: {
      ...base.launcher,
      trust: 'production-signed',
      publisher: 'CN=ProPR Test Publisher',
      signerPins: pins,
      signerCertificateSha256: certificate,
      signerSpkiSha256: spki,
    },
    bootstrap: {
      ...base.bootstrap,
      trust: 'production-signed',
      publisher: 'CN=ProPR Test Publisher',
      signerPins: pins,
      signerCertificateSha256: certificate,
      signerSpkiSha256: spki,
    },
  };
  assert.equal(parseWindowsAuthorityHelperManifestForTest(helperManifest(production)).trust, 'production-signed');
  assert.throws(() => parseWindowsAuthorityHelperManifestForTest(helperManifest({
    ...production, signerPins: [], launcher: { ...production.launcher, signerPins: [] },
  })), /compile_load:4/, 'production cannot omit its cryptographic pin');
  assert.throws(() => parseWindowsAuthorityHelperManifestForTest(helperManifest({
    ...production,
    launcher: { ...production.launcher, signerSpkiSha256: '3'.repeat(64) },
  })), /compile_load:4/, 'a same-subject launcher signed by a different key cannot satisfy production');
  assert.throws(() => parseWindowsAuthorityHelperManifestForTest(helperManifest({ sha256: '0'.repeat(63) })), /compile_load:4/);
  assert.throws(() => parseWindowsAuthorityHelperManifestForTest(helperManifest({ architecture: 'x64' })), /compile_load:4/);
  assert.throws(() => parseWindowsAuthorityHelperManifestForTest(helperManifest({ unexpected: true })), /compile_load:4/);
  assert.throws(() => parseWindowsAuthorityHelperManifestForTest(helperManifest({
    launcher: { ...base.launcher, architecture: 'arm64' },
  })), /compile_load:4/);
  assert.throws(() => parseWindowsAuthorityHelperManifestForTest(helperManifest({
    launcher: { ...base.launcher, sha256: '0'.repeat(63) },
  })), /compile_load:4/);
  assert.throws(() => parseWindowsAuthorityHelperManifestForTest(helperManifest({
    compiler: {
      ...base.compiler,
      catalogSha256: '8'.repeat(64),
    },
  })), /compile_load:4/, 'deferred compiler provenance fields cannot be injected into the fixed build record');
  assert.throws(() => parseWindowsAuthorityHelperManifestForTest(Buffer.from([0xc3, 0x28, 0x0a])), /compile_load:4/);
  assert.throws(() => parseWindowsAuthorityHelperManifestForTest(helperManifest().subarray(0, -1)), /compile_load:4/);
});

test('Windows build record accepts only the fixed framework layouts on x64 and ARM64', () => {
  const base = JSON.parse(helperManifest().toString()) as {
    launcher: Record<string, unknown>;
    bootstrap: Record<string, unknown>;
    compiler: Record<string, unknown>;
  };
  const cases = [
    { architecture: 'x64', machine: 'AMD64', framework: 'Framework64-v4.0.30319' },
    { architecture: 'arm64', machine: 'ARM64', framework: 'Framework-v4.0.30319' },
  ];
  for (const evidence of cases) {
    const parsed = parseWindowsAuthorityHelperManifestForTest(helperManifest({
      launcher: { ...base.launcher, architecture: evidence.architecture, machine: evidence.machine },
      bootstrap: { ...base.bootstrap, architecture: evidence.architecture, machine: evidence.machine },
      compiler: {
        ...base.compiler,
        framework: evidence.framework,
      },
    }));
    assert.equal(parsed.compiler.framework, evidence.framework);
    assert.equal(parsed.compiler.kind, 'windows-fixed-system-dotnet-framework-csc-v1');
  }
});

test('Windows helper PE inspection requires a managed PE32 AnyCPU-compatible image', () => {
  const pe = Buffer.alloc(1024);
  pe.writeUInt16LE(0x5a4d, 0);
  pe.writeUInt32LE(0x80, 0x3c);
  pe.write('PE\0\0', 0x80, 'ascii');
  pe.writeUInt16LE(0x14c, 0x84);
  pe.writeUInt16LE(1, 0x86);
  pe.writeUInt16LE(224, 0x94);
  pe.writeUInt16LE(0x10b, 0x98);
  pe.writeUInt32LE(0x2000, 0x98 + 96 + (14 * 8));
  pe.writeUInt32LE(72, 0x98 + 96 + (14 * 8) + 4);
  pe.writeUInt32LE(0x200, 0x178 + 8);
  pe.writeUInt32LE(0x2000, 0x178 + 12);
  pe.writeUInt32LE(0x200, 0x178 + 16);
  pe.writeUInt32LE(0x200, 0x178 + 20);
  pe.writeUInt32LE(0x1, 0x210);
  assert.doesNotThrow(() => inspectWindowsAuthorityHelperPeForTest(pe));
  const nativeOnly = Buffer.from(pe);
  nativeOnly.writeUInt32LE(0, 0x98 + 96 + (14 * 8));
  assert.throws(() => inspectWindowsAuthorityHelperPeForTest(nativeOnly), /compile_load:9/);
  const wrongMachine = Buffer.from(pe);
  wrongMachine.writeUInt16LE(0x8664, 0x84);
  assert.throws(() => inspectWindowsAuthorityHelperPeForTest(wrongMachine), /compile_load:9/);
  const required32Bit = Buffer.from(pe);
  required32Bit.writeUInt32LE(0x3, 0x210);
  assert.throws(() => inspectWindowsAuthorityHelperPeForTest(required32Bit), /compile_load:9/);
});

test('production verifier is kernel-rooted and never selected by the process command environment', async () => {
  const implementation = await readFile(fileURLToPath(new URL('./windows-update-authority.ts', import.meta.url)), 'utf8');
  assert.doesNotMatch(implementation, /require\(launcherProof\.path\)/);
  assert.doesNotMatch(implementation, /process\.env\.(?:SystemRoot|windir|COMSPEC|PATH)/i);
  assert.match(implementation, /GLOBALROOT\\SystemRoot\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe/);
  assert.match(implementation, /const child = spawn\(KERNEL_SYSTEM_POWERSHELL/);
  assert.match(implementation, /env: \{\}/);
  assert.doesNotMatch(implementation, /\bfsutil\b|queryfileid|Get-Item|-LiteralPath|Get-Acl/);
  assert.match(implementation, /stdio: \['pipe', 'pipe', 'pipe', heldHandle\.fd\]/);
  assert.match(implementation, /\$heldHandle=\$native::_get_osfhandle\(3\)/);
  assert.match(implementation, /GetFileInformationByHandleEx/);
  assert.match(implementation, /GetSecurityInfo/);
  assert.match(implementation, /Get-HeldSecurity\(\[IntPtr\]\$handle, \[string\]\$role\)/);
  assert.match(implementation, /Get-HeldSecurity \$heldHandle 'package'/);
  assert.match(implementation, /Get-HeldSecurity \$selfHandle 'os'/);
  assert.match(implementation, /Get-HeldSecurity \$catalogHandle 'os'/);
  assert.match(implementation, /Get-HeldSecurity \$lease\.handle \$lease\.role/);
  assert.match(implementation, /Expand-FileAccessMask/);
  assert.doesNotMatch(implementation, /Get-AuthenticodeSignature\s+-Content/);
  assert.match(implementation, /WinVerifyTrust/);
  assert.match(implementation, /CryptQueryObject\(2,\$blob/);
  assert.match(implementation, /GCHandleType\]::Pinned/);
  assert.match(implementation, /Invoke-HeldCatalogTrust \$memberHandle/);
  assert.match(implementation, /CryptCATAdminCalcHashFromFileHandle2/);
  assert.match(implementation, /CryptCATAdminEnumCatalogFromHash/);
  assert.match(implementation, /selfCatalogFileId128/);
  assert.match(implementation, /record\.nodeDev === nodeIdentity\.dev && record\.nodeIno === nodeIdentity\.ino/);
  assert.match(implementation, /MICROSOFT_SYSTEM_ROOT_SPKI_SHA256\.has\(selfRootSpkiSha256\)/);
  assert.ok(implementation.indexOf('acquireBootstrapPackageAuthority(')
    < implementation.indexOf('require(bootstrapProof.path)'));
  assert.match(implementation, /bootstrap\.loadVerifiedModule\(\{/);
});

test('bootstrap authority rejects a forged or split held-object identity record', () => {
  const policy = { size: 4096, sha256: 'a'.repeat(64) };
  const identity = { dev: '1234', ino: '5678' };
  const record = {
    sha256: policy.sha256,
    size: policy.size,
    volumeSerial: '1'.repeat(16),
    fileId128: '2'.repeat(32),
    nodeDev: identity.dev,
    nodeIno: identity.ino,
    ownerSid: 'S-1-5-18',
    daclProtected: true,
    reparseTag: '00000000',
    subject: null,
    certificate: null,
    selfSubject: 'CN=Microsoft Windows, O=Microsoft Corporation, L=Redmond, S=Washington, C=US',
    selfCertificate: 'certificate',
    selfRootCertificate: 'root',
    selfCatalogName: 'Microsoft-Windows-PowerShell-ServerCore-Package~31bf3856ad364e35~amd64~~10.0.26100.32230.cat',
    selfCatalogSha256: '2d2ac25e4f3cc782a886422964dffc851a66af354220923d96153738867d7866',
    selfCatalogVolumeSerial: '4'.repeat(16),
    selfCatalogFileId128: '5'.repeat(32),
  };
  assert.equal(validateBootstrapIdentityRecordForTest(record, policy, identity), true);
  assert.equal(validateBootstrapIdentityRecordForTest({ ...record, nodeIno: '5679' }, policy, identity), false);
  assert.equal(validateBootstrapIdentityRecordForTest({ ...record, fileId128: '2'.repeat(31) }, policy, identity), false);
  assert.equal(validateBootstrapIdentityRecordForTest({ ...record, ownerSid: 'S-1-5-21-1-2-3-4' }, policy, identity), false);
  assert.equal(validateBootstrapIdentityRecordForTest({ ...record, daclProtected: false }, policy, identity), false);
  assert.equal(validateBootstrapIdentityRecordForTest({ ...record, systemAcl: true }, policy, identity), false);
  assert.equal(validateBootstrapIdentityRecordForTest({ ...record, unexpected: true }, policy, identity), false);
});

test('hostile Windows command environment cannot select a verifier or execute its observable initializer', windowsOnly,
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'propr-hostile-windows-root-'));
    const marker = join(root, 'fake-verifier-executed');
    const system32 = join(root, 'System32');
    const powershellDirectory = join(system32, 'WindowsPowerShell', 'v1.0');
    const prior = Object.fromEntries(['SystemRoot', 'windir', 'COMSPEC', 'PATH'].map(name => [name, process.env[name]]));
    try {
      await mkdir(powershellDirectory, { recursive: true });
      const observable = `@echo off\r\ntype nul > "${marker}"\r\nexit /b 127\r\n`;
      await writeFile(join(powershellDirectory, 'powershell.exe'), observable);
      await writeFile(join(system32, 'fsutil.exe'), observable);
      await writeFile(join(root, 'cmd.exe'), observable);
      process.env.SystemRoot = root;
      process.env.windir = root;
      process.env.COMSPEC = join(root, 'cmd.exe');
      process.env.PATH = `${powershellDirectory};${system32};${root}`;
      const helper = await authenticateWindowsAuthorityHelperForTest();
      await helper.executableHandle.close();
      await helper.launcherHandle.close();
      await helper.bootstrapHandle.close();
      await helper.manifestHandle.close();
      await assert.rejects(readFile(marker), error => (error as NodeJS.ErrnoException).code === 'ENOENT');
    } finally {
      for (const [name, value] of Object.entries(prior)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      await rm(root, { recursive: true, force: true });
    }
  });

test('native pre-load swap barrier never transfers control to replacement N-API initialization', windowsOnly, async () => {
  for (const fault of ['barrier-before-module-load-swap', 'barrier-before-module-load-write',
    'barrier-before-module-load-delete'] as const) {
    const helper = await authenticateWindowsAuthorityHelperForTest(undefined, undefined, undefined, undefined, fault);
    await helper.executableHandle.close();
    await helper.launcherHandle.close();
    await helper.bootstrapHandle.close();
    await helper.manifestHandle.close();
  }
});

test('OS package authority never executes a malicious replacement bootstrap initializer', windowsOnly, async () => {
  const source = await authenticateWindowsAuthorityHelperForTest();
  const sourceDirectory = dirname(source.executable);
  await source.executableHandle.close();
  await source.launcherHandle.close();
  await source.bootstrapHandle.close();
  await source.manifestHandle.close();
  const root = await mkdtemp(join(tmpdir(), 'propr-malicious-bootstrap-'));
  const marker = join(root, 'initializer-executed');
  const publisher = 'CN=ProPR Malicious Fixture';
  const certificate = '1'.repeat(64);
  const spki = '2'.repeat(64);
  const pins = [`certificate-sha256:${certificate}`, `spki-sha256:${spki}`].sort();
  try {
    const executable = join(root, 'propr-windows-authority.exe');
    const launcher = join(root, 'propr-windows-launcher.node');
    const bootstrap = join(root, 'propr-windows-bootstrap.node');
    const manifestPath = join(root, 'propr-windows-authority.manifest.json');
    const malicious = join(sourceDirectory, '..', '..', 'src', 'native', 'windows-launcher', 'build', 'Release',
      'propr_windows_malicious_bootstrap.node');
    await copyFile(source.executable, executable);
    await copyFile(join(sourceDirectory, 'propr-windows-launcher.node'), launcher);
    await copyFile(malicious, bootstrap);
    const manifest = JSON.parse(await readFile(join(sourceDirectory, 'propr-windows-authority.manifest.json'), 'utf8'));
    const maliciousBytes = await readFile(bootstrap);
    for (const record of [manifest, manifest.launcher, manifest.bootstrap]) {
      record.trust = 'production-signed';
      record.publisher = publisher;
      record.signerPins = pins;
      record.signerCertificateSha256 = certificate;
      record.signerSpkiSha256 = spki;
    }
    manifest.bootstrap.size = maliciousBytes.length;
    manifest.bootstrap.sha256 = createHash('sha256').update(maliciousBytes).digest('hex');
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
    await sealWindowsAuthorityDirectory(root);
    process.env.PROPR_WINDOWS_MALICIOUS_BOOTSTRAP_SIDE_EFFECT = marker;
    await assert.rejects(
      authenticateWindowsAuthorityHelperForTest(root, undefined, publisher, pins, undefined, false),
      /compile_load:(?:5|6|7|8)/,
    );
    await assert.rejects(readFile(marker), error => (error as NodeJS.ErrnoException).code === 'ENOENT');
  } finally {
    delete process.env.PROPR_WINDOWS_MALICIOUS_BOOTSTRAP_SIDE_EFFECT;
    await prepareWindowsAuthorityBuildDirectory(root).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test('raw production verifier accepts held invalid-UTF16 PE bytes then rejects a real same-root wrong leaf', windowsOnly, async () => {
  const source = await authenticateWindowsAuthorityHelperForTest();
  const sourceDirectory = dirname(source.executable);
  await source.executableHandle.close();
  await source.launcherHandle.close();
  await source.bootstrapHandle.close();
  await source.manifestHandle.close();
  const root = await mkdtemp(join(tmpdir(), 'propr-real-wrong-leaf-'));
  const signingScript = join(root, 'sign-hostile-fixture.ps1');
  let certificateState: { root: string; actual: string; expected: string } | undefined;
  try {
    for (const name of ['propr-windows-authority.exe', 'propr-windows-launcher.node',
      'propr-windows-bootstrap.node', 'propr-windows-authority.manifest.json']) {
      await copyFile(join(sourceDirectory, name), join(root, name));
    }
    await writeFile(signingScript, String.raw`
$ErrorActionPreference='Stop'
$fixture=$args[0]
$ca=New-SelfSignedCertificate -Type Custom -Subject 'CN=ProPR Raw Fixture Root' -KeyUsage CertSign,CRLSign,DigitalSignature -KeyExportPolicy Exportable -TextExtension @('2.5.29.19={critical}{text}ca=1&pathlength=1') -CertStoreLocation Cert:\CurrentUser\My
$actual=New-SelfSignedCertificate -Type Custom -Subject 'CN=ProPR Raw Fixture Leaf' -Signer $ca -KeyUsage DigitalSignature -KeyExportPolicy Exportable -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.3') -CertStoreLocation Cert:\CurrentUser\My
$expected=New-SelfSignedCertificate -Type Custom -Subject 'CN=ProPR Raw Fixture Leaf' -Signer $ca -KeyUsage DigitalSignature -KeyExportPolicy Exportable -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.3') -CertStoreLocation Cert:\CurrentUser\My
$roots=New-Object Security.Cryptography.X509Certificates.X509Store('Root','CurrentUser');$roots.Open('ReadWrite');$roots.Add($ca);$roots.Close()
$publishers=New-Object Security.Cryptography.X509Certificates.X509Store('TrustedPublisher','CurrentUser');$publishers.Open('ReadWrite');$publishers.Add($actual);$publishers.Close()
foreach($name in @('propr-windows-authority.exe','propr-windows-launcher.node','propr-windows-bootstrap.node')) {
  $path=Join-Path $fixture $name
  $stream=[IO.File]::Open($path,[IO.FileMode]::Append,[IO.FileAccess]::Write,[IO.FileShare]::None)
  try{$invalidUtf16=[byte[]](0,216,255);$stream.Write($invalidUtf16,0,$invalidUtf16.Length)}finally{$stream.Dispose()}
  $signed=Set-AuthenticodeSignature -LiteralPath $path -Certificate $actual -HashAlgorithm SHA256
  if($signed.Status -ne 'Valid'){throw 'fixture signing failed'}
}
@{root=$ca.Thumbprint;actual=$actual.Thumbprint;expected=$expected.Thumbprint;actualRaw=[Convert]::ToBase64String($actual.RawData);expectedRaw=[Convert]::ToBase64String($expected.RawData)}|ConvertTo-Json -Compress
`, 'utf8');
    const { stdout } = await execFileAsync(kernelPowerShell,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', signingScript, root],
      { env: {}, windowsHide: true, maxBuffer: 64 * 1024 });
    const signed = JSON.parse(stdout.trim()) as {
      root: string; actual: string; expected: string; actualRaw: string; expectedRaw: string;
    };
    certificateState = signed;
    const actual = new X509Certificate(Buffer.from(signed.actualRaw, 'base64'));
    const expected = new X509Certificate(Buffer.from(signed.expectedRaw, 'base64'));
    const identity = (certificate: X509Certificate) => {
      const certificateSha256 = certificate.fingerprint256.replaceAll(':', '').toLowerCase();
      const spkiSha256 = createHash('sha256').update(
        certificate.publicKey.export({ format: 'der', type: 'spki' }),
      ).digest('hex');
      return {
        publisher: certificate.subject,
        certificateSha256,
        spkiSha256,
        pins: [`certificate-sha256:${certificateSha256}`, `spki-sha256:${spkiSha256}`].sort(),
      };
    };
    const actualIdentity = identity(actual);
    const expectedIdentity = identity(expected);
    const manifestPath = join(root, 'propr-windows-authority.manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const applyIdentity = (signer: ReturnType<typeof identity>) => {
      for (const record of [manifest, manifest.launcher, manifest.bootstrap]) {
        record.trust = 'production-signed';
        record.publisher = signer.publisher;
        record.signerPins = signer.pins;
        record.signerCertificateSha256 = signer.certificateSha256;
        record.signerSpkiSha256 = signer.spkiSha256;
      }
    };
    for (const [record, name] of [[manifest, 'propr-windows-authority.exe'],
      [manifest.launcher, 'propr-windows-launcher.node'], [manifest.bootstrap, 'propr-windows-bootstrap.node']] as const) {
      const bytes = await readFile(join(root, name));
      record.size = bytes.length;
      record.sha256 = createHash('sha256').update(bytes).digest('hex');
    }
    applyIdentity(actualIdentity);
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
    await rm(signingScript, { force: true });
    await sealWindowsAuthorityDirectory(root);
    const accepted = await authenticateWindowsAuthorityHelperForTest(
      root, undefined, actualIdentity.publisher, actualIdentity.pins, undefined, false,
    );
    await accepted.executableHandle.close();
    await accepted.launcherHandle.close();
    await accepted.bootstrapHandle.close();
    await accepted.manifestHandle.close();
    await prepareWindowsAuthorityBuildDirectory(root);
    applyIdentity(expectedIdentity);
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
    await sealWindowsAuthorityDirectory(root);
    await assert.rejects(
      authenticateWindowsAuthorityHelperForTest(
        root, undefined, expectedIdentity.publisher, expectedIdentity.pins, undefined, false,
      ),
      /compile_load:(?:5|6|7|8)/,
    );
    assert.equal(windowsAuthorityBrokerStatsForTest().activeProcessCount, 0);
  } finally {
    await prepareWindowsAuthorityBuildDirectory(root).catch(() => undefined);
    if (certificateState) {
      const cleanup = `$values=@('${certificateState.root}','${certificateState.actual}','${certificateState.expected}');`
        + "foreach($storeName in @('My','Root','TrustedPublisher')){$store=New-Object Security.Cryptography.X509Certificates.X509Store($storeName,'CurrentUser');$store.Open('ReadWrite');foreach($certificate in @($store.Certificates)){if($values -contains $certificate.Thumbprint){$store.Remove($certificate)}};$store.Close()}";
      await execFileAsync(kernelPowerShell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', cleanup],
        { env: {}, windowsHide: true }).catch(() => undefined);
    }
    await rm(root, { recursive: true, force: true });
  }
});

test('bootstrap authority rejects real unprotected, current-owner, explicit-write, and inherited-write ACL attacks', windowsOnly,
  async t => {
    await shutdownWindowsAuthorityBrokerForTest();
    const sourceDirectory = fileURLToPath(new URL('../build/windows-authority', import.meta.url));
    const malicious = fileURLToPath(new URL(
      './native/windows-launcher/build/Release/propr_windows_malicious_bootstrap.node', import.meta.url,
    ));
    const { stdout } = await execFileAsync(kernelPowerShell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      '[Security.Principal.WindowsIdentity]::GetCurrent().User.Value'], { env: {}, windowsHide: true });
    const currentSid = stdout.trim();
    const canonicalIcacls = await resolveWindowsAclTool(kernelIcacls);
    assert.match(currentSid, /^S-1-(?:\d+-){1,14}\d+$/);
    for (const scenario of ['unprotected-dacl', 'current-owner', 'explicit-write', 'inherited-write'] as const) {
      await t.test(scenario, async () => {
        const root = await mkdtemp(join(tmpdir(), 'propr-bootstrap-acl-'));
        const marker = join(root, 'initializer-executed');
        try {
          for (const name of ['propr-windows-authority.exe', 'propr-windows-launcher.node']) {
            await copyFile(join(sourceDirectory, name), join(root, name));
          }
          const bootstrap = join(root, 'propr-windows-bootstrap.node');
          await copyFile(malicious, bootstrap);
          const manifest = JSON.parse(await readFile(join(sourceDirectory, 'propr-windows-authority.manifest.json'), 'utf8'));
          const bytes = await readFile(bootstrap);
          manifest.bootstrap.size = bytes.length;
          manifest.bootstrap.sha256 = createHash('sha256').update(bytes).digest('hex');
          await writeFile(join(root, 'propr-windows-authority.manifest.json'), `${JSON.stringify(manifest)}\n`);
          await sealWindowsAuthorityDirectory(root);
          if (scenario === 'unprotected-dacl') {
            await invokeWindowsAclTool(canonicalIcacls, [bootstrap, '/inheritance:e', '/Q']);
          } else if (scenario === 'current-owner') {
            await invokeWindowsAclTool(canonicalIcacls,
              [root, '/setowner', `*${currentSid}`, '/T', '/C', '/Q']);
          } else if (scenario === 'explicit-write') {
            await invokeWindowsAclTool(canonicalIcacls, [bootstrap, '/grant', `*${currentSid}:M`, '/Q']);
          } else {
            await invokeWindowsAclTool(canonicalIcacls,
              [root, '/inheritance:e', '/grant', `*${currentSid}:(OI)(CI)M`, '/Q']);
          }
          process.env.PROPR_WINDOWS_MALICIOUS_BOOTSTRAP_SIDE_EFFECT = marker;
          await assert.rejects(
            authenticateWindowsAuthorityHelperForTest(root, undefined, undefined, undefined, undefined, true),
            /compile_load:(?:6|7)/,
          );
          await assert.rejects(readFile(marker), error => (error as NodeJS.ErrnoException).code === 'ENOENT');
          assert.equal(windowsAuthorityBrokerStatsForTest().activeProcessCount, 0);
        } finally {
          delete process.env.PROPR_WINDOWS_MALICIOUS_BOOTSTRAP_SIDE_EFFECT;
          await prepareWindowsAuthorityBuildDirectory(root).catch(() => undefined);
          await rm(root, { recursive: true, force: true });
        }
      });
    }
  });

test('native ACL policy rejects real arbitrary SID, object, callback, and conditional allow ACEs', windowsOnly, async () => {
  const helper = await authenticateWindowsAuthorityHelperForTest();
  try {
    assert.equal(typeof helper.launcher.dangerousAclForTest, 'function');
    for (const sddl of [
      'O:SYG:SYD:(A;;GW;;;S-1-5-21-111111111-222222222-333333333-4444)',
      'O:SYG:SYD:(OA;;GW;00000000-0000-0000-0000-000000000001;;S-1-5-21-111111111-222222222-333333333-4444)',
      'O:SYG:SYD:(XA;;GW;;;S-1-5-21-111111111-222222222-333333333-4444)',
      'O:SYG:SYD:(XA;;GW;;;S-1-5-21-111111111-222222222-333333333-4444;(@User.Title == "untrusted"))',
    ]) assert.equal(helper.launcher.dangerousAclForTest?.({ sddl }), true);
    assert.equal(helper.launcher.dangerousAclForTest?.({
      sddl: 'O:SYG:SYD:(A;;GR;;;BU)(D;;GW;;;BU)',
    }), true, 'an explicit deny after an explicit allow is non-canonical and must fail closed');
    assert.equal(helper.launcher.dangerousAclForTest?.({
      sddl: 'O:SYG:SYD:(D;;GW;;;BU)(A;;GR;;;BU)',
    }), false, 'canonical deny/allow order with no effective untrusted write is safe');
    assert.equal(helper.launcher.dangerousAclForTest?.({
      sddl: 'O:SYG:SYD:AI(A;ID;GRGX;;;BU)',
    }), false, 'a safely inherited OS read/execute ACE does not need a protected DACL');
    for (const rights of ['GW', 'WD', 'WO', 'DC']) {
      assert.equal(helper.launcher.dangerousAclForTest?.({
        sddl: `O:SYG:SYD:AI(A;ID;${rights};;;BU)`,
      }), true, `inherited untrusted ${rights} authority must be rejected`);
    }
  } finally {
    await helper.executableHandle.close();
    await helper.launcherHandle.close();
    await helper.bootstrapHandle.close();
    await helper.manifestHandle.close();
  }
});

test('native Windows bootstrap reports every injected real boundary including early exit', windowsOnly, async () => {
  for (const stage of WINDOWS_AUTHORITY_COMPILE_STAGES) {
    assert.equal(await probeWindowsAuthorityBootstrapStageForTest(stage), stage);
  }
  assert.equal(await probeWindowsAuthorityProcessImageMismatchForTest(), 'HELPER_IDENTITY');
});

test('native Windows launcher injects every fixed redacted transport stage and cleans up', windowsOnly, async () => {
  for (const code of WINDOWS_NATIVE_LAUNCH_FAILURE_CODES) {
    assert.equal(await probeWindowsAuthorityNativeLaunchStageForTest(code), `TRANSPORT_${code}`);
    assert.equal(windowsAuthorityBrokerStatsForTest().activeProcessCount, 0);
  }
  assert.equal(await probeWindowsAuthorityUnknownNativeLaunchStageForTest(), 'TRANSPORT_SPAWN');
  assert.equal(windowsAuthorityBrokerStatsForTest().activeProcessCount, 0);
});

test('native Windows helper authentication rejects manifest/output/compiler, link, reparse, and same-name ABA faults', windowsOnly, async t => {
  const source = await authenticateWindowsAuthorityHelperForTest();
  const sourceDirectory = dirname(source.executable);
  await source.executableHandle.close();
  await source.launcherHandle.close();
  await source.bootstrapHandle.close();
  await source.manifestHandle.close();
  await assert.rejects(
    authenticateWindowsAuthorityHelperForTest(sourceDirectory, undefined, 'CN=Expected Production Publisher'),
    /compile_load:4/,
    'an unsigned validation helper must never satisfy a production-publisher expectation',
  );
  const sourceManifest = join(sourceDirectory, 'propr-windows-authority.manifest.json');

  const fixture = async () => {
    const root = await mkdtemp(join(tmpdir(), 'propr-win-helper-'));
    const executable = join(root, 'propr-windows-authority.exe');
    const manifest = join(root, 'propr-windows-authority.manifest.json');
    const launcher = join(root, 'propr-windows-launcher.node');
    const bootstrap = join(root, 'propr-windows-bootstrap.node');
    await copyFile(source.executable, executable);
    await copyFile(join(sourceDirectory, 'propr-windows-launcher.node'), launcher);
    await copyFile(join(sourceDirectory, 'propr-windows-bootstrap.node'), bootstrap);
    await copyFile(sourceManifest, manifest);
    return { root, executable, manifest, launcher, bootstrap };
  };

  for (const scenario of ['manifest', 'output', 'compiler', 'hardlink', 'reparse', 'same-name-aba',
    'launcher-output', 'launcher-hardlink', 'launcher-reparse', 'launcher-same-name-aba',
    'bootstrap-output', 'bootstrap-hardlink', 'bootstrap-reparse', 'bootstrap-same-name-aba'] as const) {
    await t.test(scenario, async () => {
      const current = await fixture();
      let sealed = false;
      try {
        if (scenario === 'manifest') {
          const bytes = await readFile(current.manifest);
          bytes[12] ^= 1;
          await writeFile(current.manifest, bytes);
        } else if (scenario === 'output') {
          const bytes = await readFile(current.executable);
          bytes[bytes.length - 1] ^= 1;
          await writeFile(current.executable, bytes);
        } else if (scenario === 'compiler') {
          const value = JSON.parse(await readFile(current.manifest, 'utf8'));
          value.compiler.kind = 'path-lookup-csc';
          await writeFile(current.manifest, `${JSON.stringify(value)}\n`);
        } else if (scenario === 'hardlink') {
          await link(current.executable, join(current.root, 'alternate.exe'));
        } else if (scenario === 'reparse') {
          await rm(current.executable);
          await symlink(source.executable, current.executable, 'file');
        } else if (scenario === 'launcher-output') {
          const bytes = await readFile(current.launcher);
          bytes[bytes.length - 1] ^= 1;
          await writeFile(current.launcher, bytes);
        } else if (scenario === 'launcher-hardlink') {
          await link(current.launcher, join(current.root, 'alternate.node'));
        } else if (scenario === 'launcher-reparse') {
          await rm(current.launcher);
          await symlink(join(sourceDirectory, 'propr-windows-launcher.node'), current.launcher, 'file');
        } else if (scenario === 'bootstrap-output') {
          const bytes = await readFile(current.bootstrap);
          bytes[bytes.length - 1] ^= 1;
          await writeFile(current.bootstrap, bytes);
        } else if (scenario === 'bootstrap-hardlink') {
          await link(current.bootstrap, join(current.root, 'alternate-bootstrap.node'));
        } else if (scenario === 'bootstrap-reparse') {
          await rm(current.bootstrap);
          await symlink(join(sourceDirectory, 'propr-windows-bootstrap.node'), current.bootstrap, 'file');
        }
        const isReparse = scenario === 'reparse' || scenario === 'launcher-reparse' || scenario === 'bootstrap-reparse';
        const barrier = scenario === 'same-name-aba' || scenario === 'launcher-same-name-aba'
          || scenario === 'bootstrap-same-name-aba' ? async () => {
          await prepareWindowsAuthorityBuildDirectory(current.root);
          const target = scenario === 'same-name-aba' ? current.executable
            : scenario === 'launcher-same-name-aba' ? current.launcher : current.bootstrap;
          const sourcePath = scenario === 'same-name-aba' ? source.executable
            : join(sourceDirectory, scenario === 'launcher-same-name-aba'
              ? 'propr-windows-launcher.node' : 'propr-windows-bootstrap.node');
          await rename(target, join(current.root, scenario === 'same-name-aba' ? 'displaced.exe'
            : scenario === 'launcher-same-name-aba' ? 'displaced.node' : 'displaced-bootstrap.node'));
          await copyFile(sourcePath, target);
          await sealWindowsAuthorityDirectory(current.root);
          sealed = true;
        } : undefined;
        if (!barrier && !isReparse) {
          await sealWindowsAuthorityDirectory(current.root);
          sealed = true;
        }
        await assert.rejects(authenticateWindowsAuthorityHelperForTest(current.root, barrier), /compile_load:(?:4|7|8|9)/);
      } finally {
        if (sealed) await prepareWindowsAuthorityBuildDirectory(current.root).catch(() => undefined);
        await rm(current.root, { recursive: true, force: true });
      }
    });
  }
});

test('native Windows parent boundary denies post-hash and post-create mutation and fails closed before READY', windowsOnly,
  async () => {
    for (const fault of ['barrier-after-hash-delete', 'barrier-after-hash-swap', 'barrier-after-hash-write',
      'barrier-before-create-delete', 'barrier-before-create-swap', 'barrier-before-create-write',
      'barrier-after-process-delete', 'barrier-after-process-swap', 'barrier-after-process-write'] as const) {
      assert.equal(await probeWindowsAuthorityNativeBoundaryForTest(fault), 'READY');
      assert.equal(windowsAuthorityBrokerStatsForTest().activeProcessCount, 0);
    }
    assert.equal(await probeWindowsAuthorityNativeBoundaryForTest('extra-child'), 'READY');
    assert.equal(windowsAuthorityBrokerStatsForTest().activeProcessCount, 0);
    for (const [fault, stage] of [
      ['job-assignment', 'TRANSPORT_JOB_ASSIGN'],
      ['parent-image-proof', 'TRANSPORT_IMAGE_AUTH'],
      ['pipe-substitution', 'TRANSPORT_IMAGE_AUTH'],
    ] as const) {
      assert.equal(await probeWindowsAuthorityNativeBoundaryForTest(fault), stage);
      assert.equal(windowsAuthorityBrokerStatsForTest().activeProcessCount, 0);
    }
  });

test('native Windows direct broker fails closed on live stderr, slowloris, and response timeout faults', windowsOnly, async () => {
  assert.equal(await injectWindowsAuthorityTransportFaultForTest('stderr'), 'stdio_protocol');
  assert.equal(await injectWindowsAuthorityTransportFaultForTest('slowloris'), 'timeout');
  assert.equal(await injectWindowsAuthorityTransportFaultForTest('timeout'), 'timeout');
});

test('native Windows explicit inherited fault environment executes stderr and process-image faults', windowsOnly, async () => {
  assert.equal(await injectWindowsAuthorityTransportFaultForTest('stderr'), 'stdio_protocol');
  assert.equal(await probeWindowsAuthorityProcessImageMismatchForTest(), 'HELPER_IDENTITY');
});

test('Windows broker framing accepts partial JSON and rejects extra frames and strict compile failures', () => {
  const compileFailure = '{"version":1,"type":"error","reason":"compile_load","scenario":0}\n';
  const encoded = encodeWindowsAuthorityFrameForTest(compileFailure.slice(0, -1));
  const frames = decodeWindowsAuthorityFramesForTest([
    encoded.subarray(0, 3),
    encoded.subarray(3, 19),
    encoded.subarray(19),
  ]);
  const failure = parseWindowsAuthorityStartupFailureForTest(frames[0]);
  assert.equal(
    failure.message,
    'Verified update cache authority inspection failed [win-authority:compile_load:0]',
  );
  assert.throws(
    () => decodeWindowsAuthorityFramesForTest([Buffer.concat([encoded, encoded])]),
    error => error instanceof Error
      && error.message === 'Verified update cache authority inspection failed [win-authority:stdio_protocol:16]',
  );
  assert.throws(
    () => decodeWindowsAuthorityFramesForTest([encoded.subarray(0, -1)]),
    error => error instanceof Error
      && error.message === 'Verified update cache authority inspection failed [win-authority:stdio_protocol:16]',
  );
});

test('native Windows authority binds protected owner DACL and complete file identity', windowsOnly, async () => {
  const root = await mkdtemp(join(tmpdir(), 'propr-win-authority-'));
  try {
    const cache = join(root, 'cache');
    await ensureWindowsPrivateDirectory(cache);
    const artifact = join(cache, 'artifact');
    await writeFile(artifact, 'trusted');
    await protectWindowsPrivateFile(artifact);
    const first = await inspectWindowsPrivatePath(artifact);
    const second = await inspectWindowsPrivatePath(artifact);
    assert.match(first.identity.volumeSerial, /^[a-f0-9]{16}$/);
    assert.match(first.identity.fileId128, /^[a-f0-9]{32}$/);
    assert.deepEqual(first.identity, second.identity);
    assert.equal(first.links, '1');
    assert.equal(first.reparseTag, '00000000');
    assert.equal(first.daclProtected, true);
    assert.match(first.ownerSid, /^S-1-/);
    assert.deepEqual(await smokeWindowsUpdateAuthority(artifact), [
      'compile-load',
      'owner-sid',
      'dacl-protection',
      'file-id-info',
      'same-handle-sha256-sha1',
      'reparse-query',
      'no-share-lock',
      'ready-protocol',
      'held-read',
      'clean-shutdown',
    ]);
    const stats = windowsAuthorityBrokerStatsForTest();
    assert.equal(stats.compileCount, 1, 'all smoke and authority requests must share one compiled helper process');
    assert.equal(stats.activeProcessCount, 1);
    assert.ok(stats.requestCount >= 8);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('native Windows purpose policy accepts empty setup files but requires exact non-empty artifacts', windowsOnly, async () => {
  const root = await mkdtemp(join(tmpdir(), 'propr-win-purpose-'));
  try {
    const cache = join(root, 'cache');
    await ensureWindowsPrivateDirectory(cache);
    const setupPath = join(cache, 'partial');
    await writeFile(setupPath, Buffer.alloc(0), { flag: 'wx' });
    await protectWindowsPrivateFile(setupPath);
    const empty = await inspectWindowsPrivatePath(setupPath);
    assert.equal(empty.size, '0');
    const emptyHeld = await openWindowsLockedArtifact(setupPath, 0, undefined, undefined, empty.identity);
    assert.equal(emptyHeld.inspection.size, '0');
    await assert.rejects(emptyHeld.read(0, 1), /win-authority:request_protocol:1/);
    await emptyHeld.verify();
    await emptyHeld.close();
    await assert.rejects(openWindowsLockedArtifact(setupPath, 1), /win-authority:type_link_size:5/);

    await writeFile(setupPath, Buffer.from('A'), { flag: 'r+' });
    const written = await inspectWindowsPrivatePath(setupPath);
    assert.deepEqual(written.identity, empty.identity, 'later setup write must retain the protected file identity');
    const artifactSha256 = createHash('sha256').update('A').digest('hex');
    const held = await openWindowsLockedArtifact(
      setupPath,
      1,
      undefined,
      undefined,
      written.identity,
      artifactSha256,
    );
    await held.close();
    await assert.rejects(
      openWindowsLockedArtifact(setupPath, 1, undefined, undefined, written.identity, '0'.repeat(64)),
      /win-authority:hash_read:11/,
    );

    const oversized = join(cache, 'oversized');
    await writeFile(oversized, Buffer.alloc(0), { flag: 'wx' });
    await protectWindowsPrivateFile(oversized);
    await truncate(oversized, 1024 * 1024 * 1024 + 64 * 1024 + 1);
    await assert.rejects(inspectWindowsPrivatePath(oversized), /win-authority:type_link_size:5/);

    assert.equal(await injectWindowsAuthorityProtocolFaultForTest('wrong-purpose', setupPath, 1), 'request_protocol');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('native Windows broker serializes a concurrent queue within one practical aggregate latency budget', windowsOnly, async () => {
  const root = await mkdtemp(join(tmpdir(), 'propr-win-queue-'));
  try {
    const cache = join(root, 'cache');
    await ensureWindowsPrivateDirectory(cache);
    const artifact = join(cache, 'artifact');
    await writeFile(artifact, 'trusted-A');
    await protectWindowsPrivateFile(artifact);
    const started = Date.now();
    const results = await Promise.all(Array.from(
      { length: 16 },
      () => inspectWindowsPrivatePath(artifact),
    ));
    assert.ok(Date.now() - started < 30_000, '16 warm requests must finish within 30 seconds on hosted Windows');
    assert.ok(results.every(result => result.identity.fileId128 === results[0].identity.fileId128));
    assert.equal(windowsAuthorityBrokerStatsForTest().compileCount, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('native Windows queued cancellation is bounded and does not disturb the held authority handle', windowsOnly, async () => {
  const root = await mkdtemp(join(tmpdir(), 'propr-win-cancel-'));
  try {
    const cache = join(root, 'cache');
    await ensureWindowsPrivateDirectory(cache);
    const artifact = join(cache, 'artifact');
    await writeFile(artifact, 'trusted-A');
    await protectWindowsPrivateFile(artifact);
    const held = await openWindowsLockedArtifact(artifact, 9);
    const controller = new AbortController();
    const cancelled = inspectWindowsPrivatePath(artifact, false, controller.signal);
    let queuedResolved = false;
    const queued = inspectWindowsPrivatePath(artifact).then(result => {
      queuedResolved = true;
      return result;
    });
    controller.abort();
    await assert.rejects(cancelled, error => error instanceof Error && error.name === 'AbortError');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(queuedResolved, false, 'queued authority work must wait until the held capability closes');
    assert.equal((await held.read(0, 9)).toString(), 'trusted-A');
    assert.equal(windowsAuthorityBrokerStatsForTest().queuedEntries, 1);
    await held.close();
    assert.equal((await queued).identity.fileId128, held.inspection.identity.fileId128);
    assert.equal(windowsAuthorityBrokerStatsForTest().queuedEntries, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('native Windows authority rejects foreign owner, every untrusted writer ACE, inherited ACEs, and junctions', windowsOnly, async t => {
  for (const scenario of ['owner', 'broad', 'arbitrary-sid', 'inherited', 'junction'] as const) {
    await t.test(scenario, async () => {
      const root = await mkdtemp(join(tmpdir(), 'propr-win-authority-'));
      try {
        const cache = join(root, 'cache');
        if (scenario === 'inherited') {
          await execFileAsync('icacls.exe', [root, '/grant', '*S-1-5-32-545:(OI)(CI)M']);
          await mkdir(cache);
        } else {
          await ensureWindowsPrivateDirectory(cache);
        }
        if (scenario === 'owner') {
          await execFileAsync('icacls.exe', [cache, '/setowner', '*S-1-5-32-544']);
        } else if (scenario === 'broad') {
          await execFileAsync('icacls.exe', [cache, '/grant', '*S-1-5-32-545:(OI)(CI)M']);
        } else if (scenario === 'arbitrary-sid') {
          await execFileAsync('icacls.exe', [cache, '/grant', '*S-1-5-32-546:(OI)(CI)M']);
        } else if (scenario === 'junction') {
          const target = join(root, 'target');
          await mkdir(target);
          const junction = join(cache, 'junction');
          await symlink(target, junction, 'junction');
          const junctionStats = await lstat(junction);
          assert.equal(junctionStats.isSymbolicLink(), true, 'fixture must be a real junction reparse point');
          await assert.rejects(inspectWindowsPrivatePath(junction, true), /win-authority:reparse_point:4/);
          return;
        }
        await assert.rejects(inspectWindowsPrivatePath(cache, true), /authority inspection failed/);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

test('native Windows held reader denies replace/delete while exact bytes are consumed', windowsOnly, async () => {
  const root = await mkdtemp(join(tmpdir(), 'propr-win-handoff-'));
  try {
    const cache = join(root, 'cache');
    await ensureWindowsPrivateDirectory(cache);
    const artifact = join(cache, 'artifact');
    await writeFile(artifact, 'trusted-A');
    await protectWindowsPrivateFile(artifact);
    const locked = await openWindowsLockedArtifact(artifact, 9);
    try {
      assert.equal(locked.inspection.sha256.length, 64);
      assert.equal(locked.inspection.sha1.length, 40);
      await assert.rejects(rename(artifact, join(cache, 'displaced')));
      await assert.rejects(writeFile(artifact, 'attacker-B'));
      await assert.rejects(rm(artifact));
      assert.equal((await locked.read(0, 9)).toString(), 'trusted-A');
      assert.deepEqual((await locked.verify()).identity, locked.inspection.identity);
    } finally {
      await locked.close();
    }
    assert.equal((await readFile(artifact)).toString(), 'trusted-A');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('native Windows exact-handle capability rejects hardlinks and emits only bounded reason codes', windowsOnly, async () => {
  const root = await mkdtemp(join(tmpdir(), 'propr-win-reasons-'));
  try {
    const cache = join(root, 'cache');
    await ensureWindowsPrivateDirectory(cache);
    const artifact = join(cache, 'artifact');
    await writeFile(artifact, 'trusted-A');
    await protectWindowsPrivateFile(artifact);
    await link(artifact, join(cache, 'second-link'));
    await assert.rejects(
      openWindowsLockedArtifact(artifact, 9),
      error => error instanceof Error
        && /^Verified update cache authority inspection failed \[win-authority:type_link_size:5\]$/.test(error.message)
        && !error.message.includes(root),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('native Windows capability reuses one compiled broker without accepting pathname B', windowsOnly, async () => {
  const root = await mkdtemp(join(tmpdir(), 'propr-win-restart-'));
  try {
    const cache = join(root, 'cache');
    await ensureWindowsPrivateDirectory(cache);
    const artifact = join(cache, 'artifact');
    await writeFile(artifact, 'trusted-A');
    await protectWindowsPrivateFile(artifact);
    const first = await openWindowsLockedArtifact(artifact, 9);
    assert.equal((await first.read(0, 9)).toString(), 'trusted-A');
    await first.close();
    const second = await openWindowsLockedArtifact(artifact, 9);
    try {
      assert.deepEqual(second.inspection.identity, first.inspection.identity);
      assert.equal((await second.read(0, 9)).toString(), 'trusted-A');
      await second.verify();
      assert.equal(windowsAuthorityBrokerStatsForTest().compileCount, 1);
    } finally {
      await second.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('native Windows close/reopen rejects a stale held ID instead of accepting an ABA capability', windowsOnly, async () => {
  const root = await mkdtemp(join(tmpdir(), 'propr-win-stale-id-'));
  try {
    const cache = join(root, 'cache');
    await ensureWindowsPrivateDirectory(cache);
    const artifact = join(cache, 'artifact');
    await writeFile(artifact, 'trusted-A');
    await protectWindowsPrivateFile(artifact);
    const closed = await openWindowsLockedArtifact(artifact, 9);
    await closed.close();
    const reopened = await openWindowsLockedArtifact(artifact, 9);
    assert.equal(await injectWindowsAuthorityHeldFaultForTest(reopened, 'stale-id'), 'request_protocol');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('native Windows broker crash releases its exact handle and restart reauthenticates A', windowsOnly, async () => {
  const root = await mkdtemp(join(tmpdir(), 'propr-win-crash-restart-'));
  try {
    const cache = join(root, 'cache');
    await ensureWindowsPrivateDirectory(cache);
    const artifact = join(cache, 'artifact');
    await writeFile(artifact, 'trusted-A');
    await protectWindowsPrivateFile(artifact);
    const crashed = await openWindowsLockedArtifact(artifact, 9);
    assert.equal(windowsAuthorityBrokerStatsForTest().compileCount, 1);
    const queuedA = inspectWindowsPrivatePath(artifact);
    const queuedB = inspectWindowsPrivatePath(artifact);
    await crashWindowsLockedArtifactForTest(crashed);
    await assert.rejects(queuedA, /win-authority:process_exit:19/);
    await assert.rejects(queuedB, /win-authority:process_exit:19/);
    await assert.rejects(crashed.read(0, 1), /win-authority:(?:clean_shutdown|process_exit)/);
    const restarted = await openWindowsLockedArtifact(artifact, 9);
    try {
      assert.equal(windowsAuthorityBrokerStatsForTest().compileCount, 2);
      assert.equal(windowsAuthorityBrokerStatsForTest().restartCount, 1);
      assert.deepEqual(restarted.inspection.identity, crashed.inspection.identity);
      assert.equal((await restarted.read(0, 9)).toString(), 'trusted-A');
    } finally {
      await restarted.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('native Windows live broker rejects frame, ID, purpose, and identity faults without stale target state', windowsOnly, async () => {
  const root = await mkdtemp(join(tmpdir(), 'propr-win-live-faults-'));
  try {
    const cache = join(root, 'cache');
    await ensureWindowsPrivateDirectory(cache);
    const artifactA = join(cache, 'artifact-A');
    const artifactB = join(cache, 'artifact-B');
    await writeFile(artifactA, 'trusted-A');
    await writeFile(artifactB, 'trusted-B');
    await protectWindowsPrivateFile(artifactA);
    await protectWindowsPrivateFile(artifactB);

    assert.equal(await injectWindowsAuthorityProtocolFaultForTest('partial-frame', artifactA, 9), 'accepted');
    assert.equal(await injectWindowsAuthorityProtocolFaultForTest('wrong-identity', artifactA, 9), 'final_verify');
    const displaced = join(cache, 'displaced');
    await rename(artifactA, displaced);
    await rename(displaced, artifactA);

    for (const fault of ['wrong-id', 'wrong-purpose'] as const) {
      const held = await openWindowsLockedArtifact(artifactA, 9);
      assert.equal(await injectWindowsAuthorityHeldFaultForTest(held, fault), 'request_protocol');
      await rename(artifactA, displaced);
      await rename(displaced, artifactA);
    }

    const identityA = (await inspectWindowsPrivatePath(artifactA)).identity;
    const beforeCancellation = windowsAuthorityBrokerStatsForTest().compileCount;
    const controller = new AbortController();
    await assert.rejects(
      openWindowsLockedArtifact(
        artifactA,
        9,
        async () => controller.abort(),
        controller.signal,
        identityA,
      ),
      error => error instanceof Error && error.name === 'AbortError',
    );
    await rename(artifactA, displaced);
    await rename(displaced, artifactA);
    await inspectWindowsPrivatePath(artifactA);
    assert.equal(windowsAuthorityBrokerStatsForTest().compileCount, beforeCancellation + 1);

    const beforeExtra = windowsAuthorityBrokerStatsForTest();
    assert.equal(await injectWindowsAuthorityProtocolFaultForTest('extra-frame', artifactA, 9), 'stdio_protocol');
    const restarted = await openWindowsLockedArtifact(artifactB, 9);
    try {
      assert.equal((await restarted.read(0, 9)).toString(), 'trusted-B');
      assert.equal(
        windowsAuthorityBrokerStatsForTest().compileCount,
        beforeExtra.compileCount + 1,
        'one replacement process must launch exactly one authenticated compiled helper',
      );
    } finally {
      await restarted.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('native Windows persistent broker is reaped without a handle or process leak', windowsOnly, async () => {
  await shutdownWindowsAuthorityBrokerForTest();
  const stats = windowsAuthorityBrokerStatsForTest();
  assert.equal(stats.activeProcessCount, 0);
  assert.equal(stats.queuedEntries, 0);
});
