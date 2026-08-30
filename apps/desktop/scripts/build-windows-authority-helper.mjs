import { createHash } from 'node:crypto';
import { fork } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, realpath, rename, rm, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import {
  buildWindowsNativeLauncher,
  cleanupWindowsAuthorityBuildStaging,
  inspectWindowsNativeLauncherPe,
  sealWindowsAuthorityDirectory,
  WINDOWS_NATIVE_BOOTSTRAP,
  WINDOWS_NATIVE_BUILD_BOOTSTRAP,
  WINDOWS_NATIVE_LAUNCHER,
} from './build-windows-native-launcher.mjs';

const desktopRoot = fileURLToPath(new URL('..', import.meta.url));
export const WINDOWS_AUTHORITY_SOURCE = join(desktopRoot, 'src', 'native', 'propr-windows-authority.cs');
export const WINDOWS_AUTHORITY_BUILD_DIRECTORY = join(desktopRoot, 'build', 'windows-authority');
export const WINDOWS_AUTHORITY_EXECUTABLE = join(WINDOWS_AUTHORITY_BUILD_DIRECTORY, 'propr-windows-authority.exe');
export const WINDOWS_AUTHORITY_MANIFEST = join(WINDOWS_AUTHORITY_BUILD_DIRECTORY, 'propr-windows-authority.manifest.json');
export const WINDOWS_AUTHORITY_BUILD_STAGES = Object.freeze(['BUILD_COMPILER', 'BUILD_SOURCE', 'BUILD_OUTPUT']);
export const WINDOWS_AUTHORITY_COMPILER_SUBSTAGES = Object.freeze([
  'DIRECTORY_PROBE', 'CATALOG_ENUMERATION', 'MEMBER_TAG', 'CATALOG_HASH', 'POLICY_NAME', 'POLICY_HASH', 'POLICY_TUPLE', 'WINTRUST_POLICY',
  'REVOCATION', 'CATALOG_LEASE', 'SIGNER_PARSE', 'EXACT_PUBLISHER', 'ROOT_PIN', 'CERTIFICATE_PIN',
  'SPKI_PIN', 'COMPILER_OPEN', 'REFERENCE_OPEN', 'SIGNER_CATALOG', 'BOOTSTRAP_READ', 'BOOTSTRAP_AUTH',
  'LAUNCHER_AUTH', 'OPEN', 'FILE_META', 'OWNER', 'DACL', 'DACL_PROTECTED', 'ARCH', 'HASH',
  'SAME_IMAGE', 'LEASE', 'SOURCE_COPY', 'SPAWN',
  'COMPILE', 'LINK', 'EXIT', 'TIMEOUT', 'OUTPUT_LIMIT', 'IMAGE', 'OUTPUT_VALIDATION',
]);
const MAX_SOURCE_BYTES = 256 * 1024;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_BUILD_INPUT_BYTES = 32 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024;
const WINDOWS_BUILD_CHILD_TIMEOUT_MS = 6 * 60_000;
const WINDOWS_BUILD_CHILD_ARGUMENT = '--windows-authority-build-child-v1';
const WINDOWS_BUILD_CHILD_SCHEMA_VERSION = 1;
const WINDOWS_BUILD_CHILD_MAX_MESSAGES = 6;
const WINDOWS_BUILD_CHILD_MAX_MESSAGE_BYTES = 2 * 1024;
export const WINDOWS_BUILD_CHILD_EVIDENCE = Object.freeze([
  'STARTED', 'BOOTSTRAP_AUTHENTICATED', 'LAUNCHER_AUTHENTICATED', 'COMPILER_STARTED', 'PUBLISHED',
]);
const WINDOWS_LAUNCHER_AUTH_PREDICATES = Object.freeze([
  'OPEN', 'FILE_META', 'OWNER', 'DACL', 'DACL_PROTECTED', 'ARCH', 'HASH',
]);
const WINDOWS_BUILD_AUTH_FAILURES = Object.freeze([
  'BOOTSTRAP_AUTH', 'LAUNCHER_AUTH', ...WINDOWS_LAUNCHER_AUTH_PREDICATES, 'SAME_IMAGE',
]);
const WINDOWS_CLEANUP_DIAGNOSTIC = 'BUILD_COMPILER:LEASE';
const SYSTEM_DIRECTORY_RECORD_BYTES = 2 + (520 * 2);
const MICROSOFT_COMPILER_CATALOG_POLICY = Object.freeze([
  'csc.exe', 'System.dll', 'System.Web.Extensions.dll',
].map(name => Object.freeze({
  name,
  catalogName: process.arch === 'arm64'
    ? 'Package_2_for_KB5066128~31bf3856ad364e35~arm64~~10.0.9321.3.cat'
    : 'Package_4_for_KB5066128~31bf3856ad364e35~amd64~~10.0.9321.3.cat',
  certificateSha256: '1308aad34660d785a76b7360c31308d8835cf5721c364a6f5aedcba85eb5b3de',
  spkiSha256: 'a693625901b3bb9292a8c61aa3b75e80027d578ee01501005a4761dabbf1b7d1',
  catalogSha256: process.arch === 'arm64'
    ? 'fd4c63e1001a82816e4ac3cdc76af05a7a02096a7101b4ddd3963d23ab773b85'
    : 'f447c801fde63f353448d90567363190964bb2e716c271256dba5859aaece7ef',
})));
const require = createRequire(import.meta.url);
const boundedCompilerDiagnostics = diagnostics => Array.isArray(diagnostics)
  ? diagnostics.filter(value => typeof value === 'string' && (
    /^(?:propr_windows_launcher\.(?:cc|obj)|link):\d+:(?:C|LNK)\d{4}$/.test(value)
      || /^member:[A-Za-z0-9_.~-]{1,64}$/.test(value)
      || /^catalog:[A-Za-z0-9_.~-]{1,180}\.cat$/.test(value)
      || /^catalog-sha256:[a-f0-9]{64}$/.test(value)
  )).slice(0, 8)
  : [];

const windowsAuthorityFailure = (stage, substage, diagnostics = []) => {
  const boundedSubstage = stage === 'BUILD_COMPILER' && WINDOWS_AUTHORITY_COMPILER_SUBSTAGES.includes(substage)
    ? `:${substage}` : '';
  const error = new Error(`Windows authority helper build failed [win-authority:${stage}${boundedSubstage}]`);
  error.stage = stage;
  if (boundedSubstage) error.substage = substage;
  error.diagnostics = Object.freeze(stage === 'BUILD_COMPILER' ? boundedCompilerDiagnostics(diagnostics) : []);
  error.cleanupDiagnostics = Object.freeze([]);
  return error;
};

const fail = (stage, substage, diagnostics = []) => {
  throw windowsAuthorityFailure(stage, substage, diagnostics);
};

const addCleanupDiagnostic = error => {
  const primary = error instanceof Error ? error : windowsAuthorityFailure('BUILD_COMPILER', 'EXIT');
  primary.cleanupDiagnostics = Object.freeze([WINDOWS_CLEANUP_DIAGNOSTIC]);
  return primary;
};

export const preserveWindowsAuthorityCompilerFailure = (error, fallback = 'DIRECTORY_PROBE') => {
  if (typeof error === 'object' && error !== null) {
    if (error.stage === 'BUILD_COMPILER' && WINDOWS_AUTHORITY_COMPILER_SUBSTAGES.includes(error.substage)) {
      fail('BUILD_COMPILER', error.substage, error.diagnostics);
    }
    if (WINDOWS_AUTHORITY_COMPILER_SUBSTAGES.includes(error.code)) {
      fail('BUILD_COMPILER', error.code, error.diagnostics);
    }
  }
  fail('BUILD_COMPILER', fallback);
};

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const isProofArray = (value, pattern) => Array.isArray(value) && value.length === 3
  && value.every(entry => typeof entry === 'string' && pattern.test(entry));
const samePath = (left, right) => process.platform === 'win32'
  ? left.toLowerCase() === right.toLowerCase()
  : left === right;

export const validateWindowsAuthoritySource = bytes => {
  if (!Buffer.isBuffer(bytes) || bytes.length <= 0 || bytes.length > MAX_SOURCE_BYTES
    || Buffer.from(bytes.toString('utf8'), 'utf8').compare(bytes) !== 0
    || !bytes.toString('utf8').includes('public static int Main(string[] args)')) fail('BUILD_SOURCE');
  return sha256(bytes);
};

const validateTree = async (root, target, stage) => {
  const canonicalRoot = await realpath(root).catch(() => fail(stage));
  const canonicalTarget = await realpath(target).catch(() => fail(stage));
  if (!samePath(resolve(root), canonicalRoot) || !samePath(resolve(target), canonicalTarget)) fail(stage);
  const inside = relative(canonicalRoot, canonicalTarget);
  if (!inside || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) fail(stage);
  let cursor = canonicalRoot;
  for (const component of inside.split(sep)) {
    cursor = join(cursor, component);
    const entry = await lstat(cursor).catch(() => fail(stage));
    if (entry.isSymbolicLink() || (!entry.isDirectory() && cursor !== canonicalTarget)) fail(stage);
  }
  const targetStats = await stat(canonicalTarget).catch(() => fail(stage));
  if (!targetStats.isFile() || targetStats.size <= 0) fail(stage);
  return canonicalTarget;
};

const readHeldBuildOutput = async (root, target) => {
  const canonical = await validateTree(root, target, 'BUILD_OUTPUT');
  const pathStats = await lstat(canonical, { bigint: true }).catch(() => fail('BUILD_OUTPUT'));
  if (!pathStats.isFile() || pathStats.isSymbolicLink() || pathStats.nlink !== 1n
    || pathStats.size <= 0n || pathStats.size > BigInt(MAX_OUTPUT_BYTES)) fail('BUILD_OUTPUT');
  const handle = await open(canonical, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW).catch(() => fail('BUILD_OUTPUT'));
  try {
    const before = await handle.stat({ bigint: true });
    if (before.dev !== pathStats.dev || before.ino !== pathStats.ino || before.size !== pathStats.size
      || before.nlink !== pathStats.nlink) fail('BUILD_OUTPUT');
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
      || after.nlink !== before.nlink || BigInt(bytes.length) !== before.size) fail('BUILD_OUTPUT');
    return bytes;
  } finally { await handle.close(); }
};

export const decodeWindowsSystemDirectoryRecord = record => {
  if (!Buffer.isBuffer(record) || record.length !== SYSTEM_DIRECTORY_RECORD_BYTES) fail('BUILD_COMPILER');
  const length = record.readUInt16LE(0);
  if (length < 3 || length >= 520) fail('BUILD_COMPILER');
  const pathBytes = record.subarray(2, 2 + (length * 2));
  if (record.subarray(2 + (length * 2)).some(byte => byte !== 0)) fail('BUILD_COMPILER');
  const path = pathBytes.toString('utf16le');
  if (!/^[A-Za-z]:\\[^\0]+$/.test(path) || path.startsWith('\\\\') || path.includes('\0')
    || path.indexOf(':', 2) >= 0) fail('BUILD_COMPILER');
  return path;
};

export const nativeLauncherAuthenticationSubstage = error => error?.code === 'MODULE_IMAGE'
  ? 'SAME_IMAGE' : WINDOWS_LAUNCHER_AUTH_PREDICATES.includes(error?.code)
    ? error.code : 'LAUNCHER_AUTH';

const loadAuthenticatedNativeLauncher = async (launcher, evidence = () => undefined) => {
  const buildBootstrapBytes = await readHeldBuildOutput(
    WINDOWS_AUTHORITY_BUILD_DIRECTORY, launcher.buildBootstrap.path,
  ).catch(() => fail('BUILD_COMPILER', 'BOOTSTRAP_READ'));
  try {
    if (buildBootstrapBytes.length !== launcher.buildBootstrap.size
        || sha256(buildBootstrapBytes) !== launcher.buildBootstrap.sha256) fail('BUILD_COMPILER', 'BOOTSTRAP_AUTH');
    inspectWindowsNativeLauncherPe(buildBootstrapBytes, process.arch);
  } catch { fail('BUILD_COMPILER', 'BOOTSTRAP_AUTH'); }
  let bootstrap;
  try { bootstrap = require(launcher.buildBootstrap.path); }
  catch { fail('BUILD_COMPILER', 'BOOTSTRAP_AUTH'); }
  if (!bootstrap || typeof bootstrap.loadVerifiedModule !== 'function') fail('BUILD_COMPILER', 'BOOTSTRAP_AUTH');
  evidence('BOOTSTRAP_AUTHENTICATED');
  try {
    const nativeLauncher = bootstrap.loadVerifiedModule({
      path: launcher.path,
      size: launcher.size,
      sha256: launcher.sha256,
      production: false,
      authenticationMode: 'held-build-artifact',
      publisher: null,
      signerCertificateSha256: null,
      signerSpkiSha256: null,
    });
    evidence('LAUNCHER_AUTHENTICATED');
    return nativeLauncher;
  } catch (error) { return fail('BUILD_COMPILER', nativeLauncherAuthenticationSubstage(error)); }
};

export const resolveWindowsCompilerLayout = async (env, probe) => {
  // The native boundary returns one fixed-size UTF-16 record from
  // GetSystemWindowsDirectoryW, after opening and authenticating the canonical
  // system PowerShell image. Environment roots are disagreement checks only.
  let reportedRoot;
  try {
    reportedRoot = await Promise.resolve().then(() => probe(env));
  } catch (error) { preserveWindowsAuthorityCompilerFailure(error); }
  const canonicalRoot = await realpath(reportedRoot).catch(() => fail('BUILD_COMPILER', 'DIRECTORY_PROBE'));
  if (!samePath(resolve(reportedRoot), canonicalRoot)) fail('BUILD_COMPILER', 'DIRECTORY_PROBE');
  for (const hint of [env.SystemRoot, env.windir]) {
    if (hint && (!isAbsolute(hint) || !samePath(await realpath(hint)
      .catch(() => fail('BUILD_COMPILER', 'DIRECTORY_PROBE')), canonicalRoot))) {
      fail('BUILD_COMPILER', 'DIRECTORY_PROBE');
    }
  }
  const layouts = ['Framework64', 'Framework'];
  let compilerFound = false;
  for (const layout of layouts) {
    const framework = join(canonicalRoot, 'Microsoft.NET', layout, 'v4.0.30319');
    const compiler = join(framework, 'csc.exe');
    const systemReference = join(framework, 'System.dll');
    const webReference = join(framework, 'System.Web.Extensions.dll');
    try {
      const canonicalCompiler = await validateTree(canonicalRoot, compiler, 'BUILD_COMPILER');
      compilerFound = true;
      return {
        systemRoot: canonicalRoot,
        compiler: canonicalCompiler,
        framework,
        systemReference: await validateTree(canonicalRoot, systemReference, 'BUILD_COMPILER'),
        webReference: await validateTree(canonicalRoot, webReference, 'BUILD_COMPILER'),
      };
    } catch { /* try the other trusted SystemRoot framework layout */ }
  }
  return fail('BUILD_COMPILER', compilerFound ? 'REFERENCE_OPEN' : 'COMPILER_OPEN');
};

const holdBuildInput = async (root, path, name) => {
  const canonical = await validateTree(root, path, 'BUILD_COMPILER');
  const pathStats = await lstat(canonical, { bigint: true }).catch(() => fail('BUILD_COMPILER'));
  if (!pathStats.isFile() || pathStats.isSymbolicLink() || pathStats.nlink < 1n || pathStats.size <= 0n
    || pathStats.size > BigInt(MAX_BUILD_INPUT_BYTES)) fail('BUILD_COMPILER');
  const handle = await open(canonical, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
    .catch(() => fail('BUILD_COMPILER'));
  try {
    const before = await handle.stat({ bigint: true });
    const bytes = await handle.readFile();
    if (before.dev !== pathStats.dev || before.ino !== pathStats.ino || before.size !== pathStats.size
      || before.nlink < 1n || before.nlink !== pathStats.nlink || BigInt(bytes.length) !== before.size) fail('BUILD_COMPILER');
    return { name, path: canonical, handle, before, bytes, sha256: sha256(bytes) };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
};

const reverifyBuildInput = async input => {
  const after = await input.handle.stat({ bigint: true }).catch(() => fail('BUILD_COMPILER'));
  const pathStats = await lstat(input.path, { bigint: true }).catch(() => fail('BUILD_COMPILER'));
  if (after.dev !== input.before.dev || after.ino !== input.before.ino || after.size !== input.before.size
    || after.nlink < 1n || after.nlink !== input.before.nlink || pathStats.dev !== after.dev || pathStats.ino !== after.ino
    || pathStats.size !== after.size || pathStats.nlink !== after.nlink) fail('BUILD_COMPILER');
  const bytes = await readHeldExactlyForBuild(input.handle, Number(after.size));
  if (sha256(bytes) !== input.sha256) fail('BUILD_COMPILER');
};

const readHeldExactlyForBuild = async (handle, size, stage = 'BUILD_COMPILER') => {
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const result = await handle.read(bytes, offset, size - offset, offset).catch(() => fail(stage));
    if (result.bytesRead <= 0) fail(stage);
    offset += result.bytesRead;
  }
  return bytes;
};

const holdSourceInput = async () => {
  const canonical = await realpath(WINDOWS_AUTHORITY_SOURCE).catch(() => fail('BUILD_SOURCE'));
  if (!samePath(canonical, resolve(WINDOWS_AUTHORITY_SOURCE))) fail('BUILD_SOURCE');
  const pathStats = await lstat(canonical, { bigint: true }).catch(() => fail('BUILD_SOURCE'));
  if (!pathStats.isFile() || pathStats.isSymbolicLink() || pathStats.nlink !== 1n
      || pathStats.size <= 0n || pathStats.size > BigInt(MAX_SOURCE_BYTES)) fail('BUILD_SOURCE');
  const handle = await open(canonical, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW).catch(() => fail('BUILD_SOURCE'));
  try {
    const before = await handle.stat({ bigint: true });
    const bytes = await readHeldExactlyForBuild(handle, Number(before.size), 'BUILD_SOURCE');
    if (before.dev !== pathStats.dev || before.ino !== pathStats.ino || before.size !== pathStats.size
        || before.nlink !== 1n || BigInt(bytes.length) !== before.size) fail('BUILD_SOURCE');
    return { path: canonical, handle, before, bytes, sha256: validateWindowsAuthoritySource(bytes) };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
};

const reverifySourceInput = async source => {
  const after = await source.handle.stat({ bigint: true }).catch(() => fail('BUILD_SOURCE'));
  const pathStats = await lstat(source.path, { bigint: true }).catch(() => fail('BUILD_SOURCE'));
  if (after.dev !== source.before.dev || after.ino !== source.before.ino || after.size !== source.before.size
      || after.nlink !== 1n || pathStats.dev !== after.dev || pathStats.ino !== after.ino
      || pathStats.size !== after.size || pathStats.nlink !== 1n) fail('BUILD_SOURCE');
  const bytes = await readHeldExactlyForBuild(source.handle, Number(after.size), 'BUILD_SOURCE');
  if (sha256(bytes) !== source.sha256) fail('BUILD_SOURCE');
};

const compilerSubstage = error => {
  const code = typeof error === 'object' && error !== null && typeof error.code === 'string' ? error.code : '';
  return WINDOWS_AUTHORITY_COMPILER_SUBSTAGES.includes(code) ? code : 'SPAWN';
};

export const inspectAnyCpuPe = bytes => {
  if (!Buffer.isBuffer(bytes) || bytes.length < 512 || bytes.length > MAX_OUTPUT_BYTES
    || bytes.readUInt16LE(0) !== 0x5a4d) fail('BUILD_OUTPUT');
  const peOffset = bytes.readUInt32LE(0x3c);
  if (peOffset < 0x40 || peOffset + 248 > bytes.length || bytes.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0') {
    fail('BUILD_OUTPUT');
  }
  const machine = bytes.readUInt16LE(peOffset + 4);
  const sectionCount = bytes.readUInt16LE(peOffset + 6);
  const optionalSize = bytes.readUInt16LE(peOffset + 20);
  const optional = peOffset + 24;
  if (machine !== 0x14c || sectionCount <= 0 || sectionCount > 96
    || optionalSize < 224 || bytes.readUInt16LE(optional) !== 0x10b) fail('BUILD_OUTPUT');
  const clrDirectory = optional + 96 + (14 * 8);
  const clrRva = bytes.readUInt32LE(clrDirectory);
  if (clrDirectory + 8 > optional + optionalSize || clrRva === 0 || bytes.readUInt32LE(clrDirectory + 4) < 72) fail('BUILD_OUTPUT');
  const sectionTable = optional + optionalSize;
  let clrOffset = -1;
  for (let index = 0; index < sectionCount; index += 1) {
    const section = sectionTable + (index * 40);
    if (section + 40 > bytes.length) fail('BUILD_OUTPUT');
    const virtualSize = bytes.readUInt32LE(section + 8);
    const virtualAddress = bytes.readUInt32LE(section + 12);
    const rawSize = bytes.readUInt32LE(section + 16);
    const rawAddress = bytes.readUInt32LE(section + 20);
    const span = Math.max(virtualSize, rawSize);
    if (clrRva >= virtualAddress && clrRva < virtualAddress + span) clrOffset = rawAddress + clrRva - virtualAddress;
  }
  if (clrOffset < 0 || clrOffset + 20 > bytes.length) fail('BUILD_OUTPUT');
  const corFlags = bytes.readUInt32LE(clrOffset + 16);
  if ((corFlags & 0x1) === 0 || (corFlags & (0x2 | 0x10 | 0x20000)) !== 0) fail('BUILD_OUTPUT');
  return { format: 'PE32', architecture: 'anycpu', machine: 'I386', clr: true };
};

const writeAtomic = async (target, bytes) => {
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  const handle = await open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, target);
};

const buildWindowsAuthorityHelperInner = async (env, launcher, evidence = () => undefined) => {
  if (process.platform !== 'win32') return { skipped: true };
  if (launcher.skipped) fail('BUILD_COMPILER', 'DIRECTORY_PROBE');
  evidence('STARTED');
  const nativeLauncher = await loadAuthenticatedNativeLauncher(launcher, evidence);
  if (WINDOWS_BUILD_AUTH_FAILURES.includes(env.PROPR_WINDOWS_AUTHORITY_TEST_AUTH_FAILURE)) {
    fail('BUILD_COMPILER', env.PROPR_WINDOWS_AUTHORITY_TEST_AUTH_FAILURE);
  }
  const { systemRoot, compiler, framework, systemReference, webReference } = await resolveWindowsCompilerLayout(
    env,
    probeEnv => {
      if (!nativeLauncher || typeof nativeLauncher.probeSystemDirectory !== 'function') {
        return fail('BUILD_COMPILER', 'DIRECTORY_PROBE');
      }
      let record;
      try { record = nativeLauncher.probeSystemDirectory({ systemRoot: probeEnv.SystemRoot ?? '', windir: probeEnv.windir ?? '',
        fault: probeEnv.PROPR_WINDOWS_AUTHORITY_TEST_DIRECTORY_PROBE_FAULT ?? null }); }
      catch (error) { return preserveWindowsAuthorityCompilerFailure(error,
        compilerSubstage(error) === 'SPAWN' ? 'DIRECTORY_PROBE' : compilerSubstage(error)); }
      try { return decodeWindowsSystemDirectoryRecord(record); }
      catch { return fail('BUILD_COMPILER', 'DIRECTORY_PROBE'); }
    },
  );
  const sourceInput = await holdSourceInput();
  const sourceSha256 = sourceInput.sha256;
  await mkdir(WINDOWS_AUTHORITY_BUILD_DIRECTORY, { recursive: true });
  const privateOutputDirectory = await mkdtemp(join(WINDOWS_AUTHORITY_BUILD_DIRECTORY, 'compile-'));
  await chmod(privateOutputDirectory, 0o700).catch(() => fail('BUILD_OUTPUT'));
  const temporaryOutput = join(privateOutputDirectory, 'propr-windows-authority.exe');
  const buildInputs = [];
  let result;
  let primaryFailure;
  try {
    try { buildInputs.push(await holdBuildInput(systemRoot, compiler, 'csc.exe')); }
    catch { fail('BUILD_COMPILER', 'COMPILER_OPEN'); }
    try {
      buildInputs.push(await holdBuildInput(systemRoot, systemReference, 'System.dll'));
      buildInputs.push(await holdBuildInput(systemRoot, webReference, 'System.Web.Extensions.dll'));
    } catch { fail('BUILD_COMPILER', 'REFERENCE_OPEN'); }
    await Promise.all(buildInputs.map(reverifyBuildInput)).catch(() => fail('BUILD_COMPILER', 'LEASE'));
    await reverifySourceInput(sourceInput);
    const frameworkIdentity = framework.toLowerCase().endsWith(`${sep}framework64${sep}v4.0.30319`.toLowerCase())
      ? 'Framework64-v4.0.30319'
      : 'Framework-v4.0.30319';
    if (!nativeLauncher || typeof nativeLauncher.compileHeld !== 'function') fail('BUILD_COMPILER', 'SPAWN');
    let compileProof;
    evidence('COMPILER_STARTED');
    try {
      compileProof = nativeLauncher.compileHeld({
        systemRoot,
        paths: buildInputs.map(input => input.path),
        sizes: buildInputs.map(input => Number(input.before.size)),
        sha256: buildInputs.map(input => input.sha256),
        source: sourceInput.bytes,
        output: temporaryOutput,
        cwd: privateOutputDirectory,
        fault: env.PROPR_WINDOWS_AUTHORITY_TEST_COMPILER_FAULT ?? null,
      });
    } catch (error) { fail('BUILD_COMPILER', compilerSubstage(error), error?.diagnostics); }
    await Promise.all(buildInputs.map(reverifyBuildInput)).catch(() => fail('BUILD_COMPILER', 'LEASE'));
    await reverifySourceInput(sourceInput);
    const output = await readHeldBuildOutput(privateOutputDirectory, temporaryOutput);
    const pe = inspectAnyCpuPe(output);
    if (output.length <= 0 || output.length > MAX_OUTPUT_BYTES
      || compileProof.size !== output.length || compileProof.sha256 !== sha256(output)
      || !/^[a-f0-9]{64}$/.test(String(compileProof.compilerCertificateSha256))
      || !/^[a-f0-9]{64}$/.test(String(compileProof.compilerSpkiSha256))
      || !/^[a-f0-9]{64}$/.test(String(compileProof.compilerRootSpkiSha256))
      || !/^[a-f0-9]{16}$/.test(String(compileProof.compilerVolumeSerial))
      || !/^[a-f0-9]{32}$/.test(String(compileProof.compilerFileId128))
      || !isProofArray(compileProof.inputCertificateSha256, /^[a-f0-9]{64}$/)
      || !isProofArray(compileProof.inputSpkiSha256, /^[a-f0-9]{64}$/)
      || !isProofArray(compileProof.inputRootSpkiSha256, /^[a-f0-9]{64}$/)
      || !isProofArray(compileProof.inputCatalogName, /^[A-Za-z0-9_.~-]{1,180}\.cat$/)
      || !isProofArray(compileProof.inputCatalogSha256, /^[a-f0-9]{64}$/)
      || !isProofArray(compileProof.inputCatalogVolumeSerial, /^[a-f0-9]{16}$/)
      || !isProofArray(compileProof.inputCatalogFileId128, /^[a-f0-9]{32}$/)
      || buildInputs.some((input, index) => {
        const approved = MICROSOFT_COMPILER_CATALOG_POLICY.find(entry => entry.name === input.name);
        return !approved || compileProof.inputCertificateSha256[index] !== approved.certificateSha256
          || compileProof.inputSpkiSha256[index] !== approved.spkiSha256
          || compileProof.inputCatalogName[index] !== approved.catalogName
          || compileProof.inputCatalogSha256[index] !== approved.catalogSha256;
      })) fail('BUILD_OUTPUT');
    await writeAtomic(WINDOWS_AUTHORITY_EXECUTABLE, output);
    const publishedOutput = await readHeldBuildOutput(WINDOWS_AUTHORITY_BUILD_DIRECTORY, WINDOWS_AUTHORITY_EXECUTABLE);
    if (!publishedOutput.equals(output)) fail('BUILD_OUTPUT');
    const manifest = {
      schemaVersion: 1,
      name: 'propr-windows-authority.exe',
      format: pe.format,
      architecture: pe.architecture,
      machine: pe.machine,
      clr: pe.clr,
      size: output.length,
      sha256: sha256(output),
      sourceSha256,
      protocol: 'propr-windows-authority-v1',
      trust: 'unsigned-validation',
      publisher: null,
      signerPins: [],
      signerCertificateSha256: null,
      signerSpkiSha256: null,
      launcher: {
        name: launcher.name,
        format: launcher.format,
        architecture: launcher.architecture,
        machine: launcher.machine,
        size: launcher.size,
        sha256: launcher.sha256,
        trust: 'unsigned-validation',
        publisher: null,
        signerPins: [],
        signerCertificateSha256: null,
        signerSpkiSha256: null,
      },
      bootstrap: {
        name: launcher.bootstrap.name,
        format: launcher.bootstrap.format,
        architecture: launcher.bootstrap.architecture,
        machine: launcher.bootstrap.machine,
        size: launcher.bootstrap.size,
        sha256: launcher.bootstrap.sha256,
        trust: 'unsigned-validation',
        publisher: null,
        signerPins: [],
        signerCertificateSha256: null,
        signerSpkiSha256: null,
      },
      compiler: {
        kind: 'windows-catalog-authorized-dotnet-framework-csc-v1',
        framework: frameworkIdentity,
        signerCertificateSha256: compileProof.compilerCertificateSha256,
        signerSpkiSha256: compileProof.compilerSpkiSha256,
        signerRootSpkiSha256: compileProof.compilerRootSpkiSha256,
        volumeSerial: compileProof.compilerVolumeSerial,
        fileId128: compileProof.compilerFileId128,
        inputs: buildInputs.map((input, index) => ({
          name: input.name,
          size: Number(input.before.size),
          sha256: input.sha256,
          signerCertificateSha256: compileProof.inputCertificateSha256[index],
          signerSpkiSha256: compileProof.inputSpkiSha256[index],
          signerRootSpkiSha256: compileProof.inputRootSpkiSha256[index],
          catalogName: compileProof.inputCatalogName[index],
          catalogSha256: compileProof.inputCatalogSha256[index],
          catalogVolumeSerial: compileProof.inputCatalogVolumeSerial[index],
          catalogFileId128: compileProof.inputCatalogFileId128[index],
        })),
      },
    };
    await writeAtomic(WINDOWS_AUTHORITY_MANIFEST, Buffer.from(`${JSON.stringify(manifest)}\n`, 'utf8'));
    evidence('PUBLISHED');
    result = { skipped: false, executable: WINDOWS_AUTHORITY_EXECUTABLE, manifest: WINDOWS_AUTHORITY_MANIFEST, ...manifest };
  } catch (error) { primaryFailure = error; }
  await Promise.all(buildInputs.map(input => input.handle.close().catch(() => undefined)));
  await sourceInput.handle.close().catch(() => undefined);
  let cleanupFailed = false;
  await rm(privateOutputDirectory, { recursive: true, force: true }).catch(() => { cleanupFailed = true; });
  if (primaryFailure) throw cleanupFailed ? addCleanupDiagnostic(primaryFailure) : primaryFailure;
  if (cleanupFailed) fail('BUILD_COMPILER', 'LEASE');
  return result;
};

const hasExactKeys = (value, keys) => typeof value === 'object' && value !== null && !Array.isArray(value)
  && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
const validNativeDescriptor = value => hasExactKeys(value, ['architecture', 'format', 'machine', 'sha256', 'size'])
  && Number.isSafeInteger(value.size) && value.size > 0 && value.size <= MAX_OUTPUT_BYTES
  && /^[a-f0-9]{64}$/.test(value.sha256) && value.format === 'PE'
  && value.architecture === process.arch
  && value.machine === (process.arch === 'arm64' ? 'ARM64' : process.arch === 'x64' ? 'AMD64' : '');

const nativeDescriptor = value => ({
  architecture: value.architecture,
  format: value.format,
  machine: value.machine,
  sha256: value.sha256,
  size: value.size,
});

const buildChildRequest = launcher => ({
  schemaVersion: WINDOWS_BUILD_CHILD_SCHEMA_VERSION,
  type: 'build',
  launcher: nativeDescriptor(launcher),
  bootstrap: nativeDescriptor(launcher.bootstrap),
  buildBootstrap: nativeDescriptor(launcher.buildBootstrap),
});

const decodeBuildChildRequest = message => {
  if (!hasExactKeys(message, ['bootstrap', 'buildBootstrap', 'launcher', 'schemaVersion', 'type'])
      || message.schemaVersion !== WINDOWS_BUILD_CHILD_SCHEMA_VERSION || message.type !== 'build'
      || !validNativeDescriptor(message.launcher) || !validNativeDescriptor(message.bootstrap)
      || !validNativeDescriptor(message.buildBootstrap)) fail('BUILD_COMPILER', 'EXIT');
  return {
    skipped: false,
    path: WINDOWS_NATIVE_LAUNCHER,
    name: 'propr-windows-launcher.node',
    ...message.launcher,
    bootstrap: {
      path: WINDOWS_NATIVE_BOOTSTRAP,
      name: 'propr-windows-bootstrap.node',
      ...message.bootstrap,
    },
    buildBootstrap: {
      path: WINDOWS_NATIVE_BUILD_BOOTSTRAP,
      ...message.buildBootstrap,
    },
  };
};

const boundedIpcRecord = message => {
  try { return Buffer.byteLength(JSON.stringify(message), 'utf8') <= WINDOWS_BUILD_CHILD_MAX_MESSAGE_BYTES; }
  catch { return false; }
};

const validEvidenceRecord = message => hasExactKeys(message, ['schemaVersion', 'type', 'value'])
  && message.schemaVersion === WINDOWS_BUILD_CHILD_SCHEMA_VERSION && message.type === 'evidence'
  && WINDOWS_BUILD_CHILD_EVIDENCE.includes(message.value);

const validResultRecord = message => {
  if (message?.schemaVersion !== WINDOWS_BUILD_CHILD_SCHEMA_VERSION || message?.type !== 'result') return false;
  if (message.status === 'success') {
    return hasExactKeys(message, ['schemaVersion', 'status', 'type']);
  }
  return message.status === 'failure'
    && hasExactKeys(message, [
      'cleanupDiagnostics', 'diagnostics', 'schemaVersion', 'stage', 'status', 'substage', 'type',
    ])
    && WINDOWS_AUTHORITY_BUILD_STAGES.includes(message.stage)
    && (message.stage === 'BUILD_COMPILER'
      ? WINDOWS_AUTHORITY_COMPILER_SUBSTAGES.includes(message.substage) : message.substage === null)
    && Array.isArray(message.diagnostics)
    && message.diagnostics.length <= 8
    && boundedCompilerDiagnostics(message.diagnostics).length === message.diagnostics.length
    && Array.isArray(message.cleanupDiagnostics) && message.cleanupDiagnostics.length <= 1
    && message.cleanupDiagnostics.every(value => value === WINDOWS_CLEANUP_DIAGNOSTIC);
};

const normalizeWindowsAuthorityFailure = (error, fallback = 'EXIT') => {
  if (error instanceof Error && WINDOWS_AUTHORITY_BUILD_STAGES.includes(error.stage)) {
    const normalized = error.stage === 'BUILD_COMPILER'
      && WINDOWS_AUTHORITY_COMPILER_SUBSTAGES.includes(error.substage)
      ? windowsAuthorityFailure(error.stage, error.substage, error.diagnostics)
      : error.stage !== 'BUILD_COMPILER' ? windowsAuthorityFailure(error.stage) : windowsAuthorityFailure('BUILD_COMPILER', fallback);
    if (Array.isArray(error.buildChildEvidence)
        && error.buildChildEvidence.every(value => WINDOWS_BUILD_CHILD_EVIDENCE.includes(value))) {
      normalized.buildChildEvidence = Object.freeze([...error.buildChildEvidence]);
    }
    return Array.isArray(error.cleanupDiagnostics) && error.cleanupDiagnostics.includes(WINDOWS_CLEANUP_DIAGNOSTIC)
      ? addCleanupDiagnostic(normalized) : normalized;
  }
  return windowsAuthorityFailure('BUILD_COMPILER', fallback);
};

const failureRecord = error => {
  const failure = normalizeWindowsAuthorityFailure(error);
  return {
    schemaVersion: WINDOWS_BUILD_CHILD_SCHEMA_VERSION,
    type: 'result',
    status: 'failure',
    stage: failure.stage,
    substage: failure.substage ?? null,
    diagnostics: failure.diagnostics,
    cleanupDiagnostics: failure.cleanupDiagnostics,
  };
};

const failureFromRecord = record => {
  const failure = windowsAuthorityFailure(record.stage, record.substage, record.diagnostics);
  return record.cleanupDiagnostics.length > 0 ? addCleanupDiagnostic(failure) : failure;
};

const buildChildEnvironment = env => {
  const childEnvironment = {};
  for (const name of ['SystemRoot', 'windir']) {
    const value = env[name];
    if (typeof value === 'string' && value.length <= 520 && !value.includes('\0')) childEnvironment[name] = value;
  }
  for (const name of [
    'PROPR_WINDOWS_AUTHORITY_TEST_AUTH_FAILURE',
    'PROPR_WINDOWS_AUTHORITY_TEST_COMPILER_FAULT',
    'PROPR_WINDOWS_AUTHORITY_TEST_DIRECTORY_PROBE_FAULT',
  ]) {
    const value = env[name];
    if (typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value)) childEnvironment[name] = value;
  }
  return childEnvironment;
};

const sendBuildChildRecord = record => new Promise((resolveSend, rejectSend) => {
  if (typeof process.send !== 'function' || !boundedIpcRecord(record)) {
    rejectSend(windowsAuthorityFailure('BUILD_COMPILER', 'EXIT'));
    return;
  }
  process.send(record, error => { if (error) rejectSend(error); else resolveSend(); });
});

const runWindowsBuildChild = (env, launcher) => new Promise((resolveChild, rejectChild) => {
  let child;
  try {
    child = fork(fileURLToPath(import.meta.url), [WINDOWS_BUILD_CHILD_ARGUMENT], {
      cwd: desktopRoot,
      env: buildChildEnvironment(env),
      execArgv: [],
      serialization: 'json',
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
  } catch {
    rejectChild(windowsAuthorityFailure('BUILD_COMPILER', 'SPAWN'));
    return;
  }
  const evidence = [];
  let resultRecord;
  let protocolFailed = false;
  let spawnFailed = false;
  let timedOut = false;
  let messageCount = 0;
  const terminate = () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  };
  const timer = setTimeout(() => { timedOut = true; terminate(); }, WINDOWS_BUILD_CHILD_TIMEOUT_MS);
  child.on('message', message => {
    messageCount += 1;
    if (messageCount > WINDOWS_BUILD_CHILD_MAX_MESSAGES || !boundedIpcRecord(message)) {
      protocolFailed = true;
      terminate();
      return;
    }
    if (validEvidenceRecord(message)) {
      if (resultRecord || message.value !== WINDOWS_BUILD_CHILD_EVIDENCE[evidence.length]) {
        protocolFailed = true;
        terminate();
        return;
      }
      evidence.push(message.value);
      process.stderr.write(`[win-authority:BUILD_CHILD:${message.value}]\n`);
      return;
    }
    if (!resultRecord && validResultRecord(message)) {
      resultRecord = message;
      if (message.status === 'failure') terminate();
    } else { protocolFailed = true; terminate(); }
  });
  child.once('error', () => { spawnFailed = true; terminate(); });
  child.once('close', (code, signal) => {
    clearTimeout(timer);
    if (timedOut) rejectChild(windowsAuthorityFailure('BUILD_COMPILER', 'TIMEOUT'));
    else if (spawnFailed) rejectChild(windowsAuthorityFailure('BUILD_COMPILER', 'SPAWN'));
    else if (protocolFailed || !resultRecord) rejectChild(windowsAuthorityFailure('BUILD_COMPILER', 'EXIT'));
    else if (resultRecord.status === 'failure') {
      const failure = failureFromRecord(resultRecord);
      failure.buildChildEvidence = Object.freeze(evidence);
      rejectChild(failure);
    }
    else if (code !== 0 || signal !== null
      || evidence.length !== WINDOWS_BUILD_CHILD_EVIDENCE.length) rejectChild(windowsAuthorityFailure('BUILD_COMPILER', 'EXIT'));
    else resolveChild(Object.freeze(evidence));
  });
  child.send(buildChildRequest(launcher), error => {
    if (error) { spawnFailed = true; terminate(); }
  });
});

const readPublishedWindowsAuthorityResult = async launcher => {
  const [output, manifestBytes] = await Promise.all([
    readHeldBuildOutput(WINDOWS_AUTHORITY_BUILD_DIRECTORY, WINDOWS_AUTHORITY_EXECUTABLE),
    readHeldBuildOutput(WINDOWS_AUTHORITY_BUILD_DIRECTORY, WINDOWS_AUTHORITY_MANIFEST),
  ]).catch(() => fail('BUILD_OUTPUT'));
  if (manifestBytes.length > MAX_MANIFEST_BYTES || manifestBytes.at(-1) !== 0x0a
      || Buffer.from(manifestBytes.toString('utf8'), 'utf8').compare(manifestBytes) !== 0) fail('BUILD_OUTPUT');
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.subarray(0, -1).toString('utf8'));
  } catch { fail('BUILD_OUTPUT'); }
  if (`${JSON.stringify(manifest)}\n` !== manifestBytes.toString('utf8')
      || manifest?.schemaVersion !== 1 || manifest.name !== 'propr-windows-authority.exe'
      || manifest.size !== output.length || manifest.sha256 !== sha256(output)
      || manifest.launcher?.size !== launcher.size || manifest.launcher?.sha256 !== launcher.sha256
      || manifest.bootstrap?.size !== launcher.bootstrap.size
      || manifest.bootstrap?.sha256 !== launcher.bootstrap.sha256) fail('BUILD_OUTPUT');
  inspectAnyCpuPe(output);
  return { skipped: false, executable: WINDOWS_AUTHORITY_EXECUTABLE, manifest: WINDOWS_AUTHORITY_MANIFEST, ...manifest };
};

export const buildWindowsAuthorityHelper = async (env = process.env) => {
  if (process.platform !== 'win32') return { skipped: true };
  let primaryFailure;
  let result;
  let childEvidence;
  try {
    const launcher = await buildWindowsNativeLauncher({ restage: true });
    childEvidence = await runWindowsBuildChild(env, launcher);
    result = await readPublishedWindowsAuthorityResult(launcher);
  } catch (error) { primaryFailure = normalizeWindowsAuthorityFailure(error); }

  let cleanupFailure;
  await cleanupWindowsAuthorityBuildStaging({
    fault: env.PROPR_WINDOWS_AUTHORITY_TEST_CLEANUP_FAULT === 'after-remove' ? 'after-remove' : null,
  }).catch(error => { cleanupFailure = normalizeWindowsAuthorityFailure(error, 'LEASE'); });
  if (primaryFailure) throw cleanupFailure ? addCleanupDiagnostic(primaryFailure) : primaryFailure;
  if (cleanupFailure) throw cleanupFailure;
  await sealWindowsAuthorityDirectory();
  return { ...result, buildChildEvidence: childEvidence };
};

const runBuildChildEntrypoint = async () => {
  let handled = false;
  process.once('message', async message => {
    if (handled) return;
    handled = true;
    let record;
    try {
      const launcher = decodeBuildChildRequest(message);
      const evidence = value => {
        const evidenceRecord = { schemaVersion: WINDOWS_BUILD_CHILD_SCHEMA_VERSION, type: 'evidence', value };
        if (typeof process.send === 'function' && validEvidenceRecord(evidenceRecord)) process.send(evidenceRecord);
      };
      await buildWindowsAuthorityHelperInner(process.env, launcher, evidence);
      record = { schemaVersion: WINDOWS_BUILD_CHILD_SCHEMA_VERSION, type: 'result', status: 'success' };
    } catch (error) { record = failureRecord(error); }
    try { await sendBuildChildRecord(record); }
    catch { process.exitCode = 1; }
    if (record.status === 'failure') process.exitCode = 1;
    process.disconnect();
  });
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === WINDOWS_BUILD_CHILD_ARGUMENT) await runBuildChildEntrypoint();
  else buildWindowsAuthorityHelper().then(result => {
    if (!result.skipped) process.stdout.write('Windows authority helper built and verified\n');
  }).catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : 'Windows authority helper build failed'}\n`);
    for (const diagnostic of error?.diagnostics ?? []) {
      process.stderr.write(`Windows native build diagnostic [win-authority-build:${diagnostic}]\n`);
    }
    for (const diagnostic of error?.cleanupDiagnostics ?? []) {
      process.stderr.write(`Windows authority cleanup diagnostic [win-authority:${diagnostic}]\n`);
    }
    process.exitCode = 1;
  });
}
