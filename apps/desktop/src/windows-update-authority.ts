import { createHash, randomBytes } from 'node:crypto';
import { constants as fsConstants, createReadStream, createWriteStream } from 'node:fs';
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TextDecoder } from 'node:util';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import type { Readable, Writable } from 'node:stream';

export interface WindowsFileIdentity {
  platform: 'win32';
  volumeSerial: string;
  fileId128: string;
}

export interface WindowsPrivatePathInspection {
  identity: WindowsFileIdentity;
  directory: boolean;
  links: string;
  size: string;
  reparseTag: string;
  ownerSid: string;
  daclProtected: true;
  aceCount: string;
  inheritedWriteAces: '0';
  broadWriteAces: '0';
}

export interface WindowsHeldVerification extends WindowsPrivatePathInspection {
  sha256: string;
  sha1: string;
}

export interface WindowsLockedArtifact {
  readonly inspection: WindowsHeldVerification;
  read(offset: number, length: number, signal?: AbortSignal): Promise<Buffer>;
  verify(signal?: AbortSignal): Promise<WindowsHeldVerification>;
  close(signal?: AbortSignal): Promise<void>;
}

export const WINDOWS_AUTHORITY_PROTOCOL_VERSION = 1 as const;
export const WINDOWS_AUTHORITY_REASON_CODES = Object.freeze([
  'compile_load',
  'request_protocol',
  'open_handle',
  'reparse_query',
  'reparse_point',
  'type_link_size',
  'owner_sid',
  'dacl_protection',
  'dacl_ace',
  'file_id_info',
  'no_share_lock',
  'hash_read',
  'ready_protocol',
  'held_read',
  'final_verify',
  'clean_shutdown',
  'stdio_protocol',
  'output_bound',
  'timeout',
  'process_exit',
] as const);

type WindowsAuthorityReason = typeof WINDOWS_AUTHORITY_REASON_CODES[number];
type BrokerOperation = 'inspect' | 'ensure-directory' | 'protect-directory' | 'protect-file';
type BrokerPurpose = 'setup' | 'artifact';

export const WINDOWS_AUTHORITY_COMPILE_STAGES = Object.freeze([
  'BUILD_COMPILER',
  'BUILD_SOURCE',
  'BUILD_OUTPUT',
  'TRANSPORT_SPAWN',
  'MANIFEST',
  'HELPER_OPEN',
  'HELPER_OWNER_DACL',
  'HELPER_REPARSE',
  'HELPER_IDENTITY',
  'HELPER_HASH',
  'PROTOCOL_INIT',
  'READY',
] as const);
export type WindowsAuthorityCompileStage = typeof WINDOWS_AUTHORITY_COMPILE_STAGES[number];

const BROKER_TIMEOUT_MS = 10_000;
const BROKER_STARTUP_TIMEOUT_MS = 60_000;
const BROKER_SESSION_TIMEOUT_MS = 10 * 60_000;
const BROKER_OUTPUT_BYTES = 16 * 1024;
const BROKER_PROTOCOL_LINE_BYTES = 2 * 1024 * 1024;
const BROKER_REQUEST_LINE_BYTES = 16 * 1024;
const BROKER_MAX_FRAMES = 8192;
const BROKER_MAX_INPUT_BYTES = 64 * 1024 * 1024;
const BROKER_MAX_OUTPUT_BYTES = 2 * 1024 * 1024 * 1024;
const BROKER_MAX_QUEUE_ENTRIES = 256;
const BROKER_ARTIFACT_BYTES = 1024 * 1024 * 1024;
const BROKER_SETUP_FILE_BYTES = 1024 * 1024 * 1024 + 64 * 1024;
const MAX_READ_BYTES = 1024 * 1024;
const reasonCodes = new Set<string>(WINDOWS_AUTHORITY_REASON_CODES);
const INSPECTION_KEYS = Object.freeze([
  'version', 'type', 'volumeSerial', 'fileId128', 'directory', 'links', 'size', 'reparseTag',
  'ownerSid', 'daclProtected', 'aceCount', 'inheritedWriteAces', 'broadWriteAces', 'sha256', 'sha1',
] as const);
const lockedArtifactProcesses = new WeakMap<WindowsLockedArtifact, LockedArtifactProcess>();

const HELPER_NAME = 'propr-windows-authority.exe';
const HELPER_MANIFEST_NAME = 'propr-windows-authority.manifest.json';
const LAUNCHER_NAME = 'propr-windows-launcher.node';
const HELPER_MAX_BYTES = 4 * 1024 * 1024;
const HELPER_MANIFEST_BYTES = 16 * 1024;
const HELPER_MANIFEST_KEYS = Object.freeze([
  'schemaVersion', 'name', 'format', 'architecture', 'machine', 'clr', 'size', 'sha256', 'sourceSha256',
  'protocol', 'trust', 'publisher', 'compiler',
  'signerPins', 'signerCertificateSha256', 'signerSpkiSha256',
  'launcher',
] as const);

interface WindowsNativeLauncherPolicy {
  name: typeof LAUNCHER_NAME;
  format: 'PE';
  architecture: 'x64' | 'arm64';
  machine: 'AMD64' | 'ARM64';
  size: number;
  sha256: string;
  trust: 'unsigned-validation' | 'production-signed';
  publisher: string | null;
  signerPins: readonly string[];
  signerCertificateSha256: string | null;
  signerSpkiSha256: string | null;
}

interface WindowsAuthorityHelperManifest {
  schemaVersion: 1;
  name: typeof HELPER_NAME;
  format: 'PE32';
  architecture: 'anycpu';
  machine: 'I386';
  clr: true;
  size: number;
  sha256: string;
  sourceSha256: string;
  protocol: 'propr-windows-authority-v1';
  trust: 'unsigned-validation' | 'production-signed';
  publisher: string | null;
  signerPins: readonly string[];
  signerCertificateSha256: string | null;
  signerSpkiSha256: string | null;
  launcher: WindowsNativeLauncherPolicy;
  compiler: {
    kind: 'kernel-system-directory-probe-dotnet-framework-csc';
    framework: string;
    inputs: readonly { name: string; size: number; sha256: string }[];
  };
}

interface AuthenticatedWindowsAuthorityHelper {
  executable: string;
  executableHandle: FileHandle;
  launcherHandle: FileHandle;
  manifestHandle: FileHandle;
  manifest: WindowsAuthorityHelperManifest;
  launcher: WindowsNativeLauncher;
}

interface NativeLaunchLease {
  lease: object;
  stdinFd: number;
  stdoutFd: number;
  stderrFd: number;
  pid: number;
  volumeSerial: string;
  fileId128: string;
}

interface WindowsNativeLauncher {
  launch(policy: Record<string, unknown>): NativeLaunchLease;
  status(lease: object): number | null;
  closeInput(lease: object): void;
  terminate(lease: object): void;
  close(lease: object): void;
  verifyModule(policy: Record<string, unknown>): Record<string, unknown>;
}

interface BrokerChild extends EventEmitter {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  exitCode: number | null;
  killed: boolean;
  imageVolumeSerial: string;
  imageFileId128: string;
  kill(): boolean;
  unref(): void;
}

const require = createRequire(import.meta.url);

const helperError = (stage: WindowsAuthorityCompileStage): WindowsAuthorityBootstrapError =>
  new WindowsAuthorityBootstrapError('MALFORMED_OUTPUT', WINDOWS_AUTHORITY_COMPILE_STAGES.indexOf(stage));

const helperDirectory = (): string => {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (resourcesPath && isAbsolute(resourcesPath)) return join(resourcesPath, 'windows-authority');
  return fileURLToPath(new URL('../build/windows-authority', import.meta.url));
};

const embeddedExpectedPublisher = (): string | undefined => {
  if (process.platform !== 'win32' || typeof __PROPR_DESKTOP_UPDATE_SIGNING_IDENTITY__ === 'undefined') return undefined;
  return __PROPR_DESKTOP_UPDATE_SIGNING_IDENTITY__ || undefined;
};

const embeddedExpectedSignerPins = (): readonly string[] => {
  if (process.platform !== 'win32' || typeof __PROPR_DESKTOP_WINDOWS_SIGNER_PINS__ === 'undefined') return [];
  return __PROPR_DESKTOP_WINDOWS_SIGNER_PINS__;
};

const exactRecordKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

export const parseWindowsAuthorityHelperManifestForTest = (bytes: Buffer): WindowsAuthorityHelperManifest => {
  if (!Buffer.isBuffer(bytes) || bytes.length <= 1 || bytes.length > HELPER_MANIFEST_BYTES
    || bytes[bytes.length - 1] !== 0x0a) throw helperError('MANIFEST');
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, -1)); }
  catch { throw helperError('MANIFEST'); }
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw helperError('MANIFEST'); }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw helperError('MANIFEST');
  const manifest = value as Record<string, unknown>;
  const compiler = manifest.compiler;
  const launcher = manifest.launcher;
  if (!exactRecordKeys(manifest, HELPER_MANIFEST_KEYS)
    || typeof compiler !== 'object' || compiler === null || Array.isArray(compiler)
    || typeof launcher !== 'object' || launcher === null || Array.isArray(launcher)
    || !exactRecordKeys(compiler as Record<string, unknown>, ['kind', 'framework', 'inputs'])
    || !exactRecordKeys(launcher as Record<string, unknown>, [
      'name', 'format', 'architecture', 'machine', 'size', 'sha256', 'trust', 'publisher', 'signerPins',
      'signerCertificateSha256', 'signerSpkiSha256',
    ])
    || manifest.schemaVersion !== 1 || manifest.name !== HELPER_NAME || manifest.format !== 'PE32'
    || manifest.architecture !== 'anycpu' || manifest.machine !== 'I386' || manifest.clr !== true
    || !Number.isSafeInteger(manifest.size) || Number(manifest.size) <= 0 || Number(manifest.size) > HELPER_MAX_BYTES
    || !/^[a-f0-9]{64}$/.test(String(manifest.sha256))
    || !/^[a-f0-9]{64}$/.test(String(manifest.sourceSha256))
    || manifest.protocol !== 'propr-windows-authority-v1'
    || !['unsigned-validation', 'production-signed'].includes(String(manifest.trust))
    || (manifest.trust === 'unsigned-validation' && manifest.publisher !== null)
    || (manifest.trust === 'production-signed'
      && (typeof manifest.publisher !== 'string' || manifest.publisher.length <= 0 || manifest.publisher.length > 512))
    || !Array.isArray(manifest.signerPins) || manifest.signerPins.length > 16
    || manifest.signerPins.some(pin => typeof pin !== 'string'
      || !/^(?:certificate|spki)-sha256:[a-f0-9]{64}$/.test(pin))
    || new Set(manifest.signerPins).size !== manifest.signerPins.length
    || manifest.signerPins.join(',') !== [...manifest.signerPins].sort().join(',')
    || (manifest.trust === 'unsigned-validation'
      && (manifest.signerPins.length !== 0 || manifest.signerCertificateSha256 !== null
        || manifest.signerSpkiSha256 !== null))
    || (manifest.trust === 'production-signed'
      && (manifest.signerPins.length === 0
        || !/^[a-f0-9]{64}$/.test(String(manifest.signerCertificateSha256))
        || !/^[a-f0-9]{64}$/.test(String(manifest.signerSpkiSha256))
        || !manifest.signerPins.some(pin => pin === `certificate-sha256:${manifest.signerCertificateSha256}`
          || pin === `spki-sha256:${manifest.signerSpkiSha256}`)))
    || (launcher as Record<string, unknown>).name !== LAUNCHER_NAME
    || (launcher as Record<string, unknown>).format !== 'PE'
    || !['x64', 'arm64'].includes(String((launcher as Record<string, unknown>).architecture))
    || ((launcher as Record<string, unknown>).architecture === 'x64'
      ? (launcher as Record<string, unknown>).machine !== 'AMD64'
      : (launcher as Record<string, unknown>).machine !== 'ARM64')
    || !Number.isSafeInteger((launcher as Record<string, unknown>).size)
    || Number((launcher as Record<string, unknown>).size) <= 0
    || Number((launcher as Record<string, unknown>).size) > HELPER_MAX_BYTES
    || !/^[a-f0-9]{64}$/.test(String((launcher as Record<string, unknown>).sha256))
    || (launcher as Record<string, unknown>).trust !== manifest.trust
    || (launcher as Record<string, unknown>).publisher !== manifest.publisher
    || JSON.stringify((launcher as Record<string, unknown>).signerPins) !== JSON.stringify(manifest.signerPins)
    || (launcher as Record<string, unknown>).signerCertificateSha256 !== manifest.signerCertificateSha256
    || (launcher as Record<string, unknown>).signerSpkiSha256 !== manifest.signerSpkiSha256
    || (compiler as Record<string, unknown>).kind !== 'kernel-system-directory-probe-dotnet-framework-csc'
    || !/^(?:Framework64|Framework)-v4\.0\.30319$/.test(String((compiler as Record<string, unknown>).framework))
    || !Array.isArray((compiler as Record<string, unknown>).inputs)
    || ((compiler as Record<string, unknown>).inputs as unknown[]).length !== 3
    || ((compiler as Record<string, unknown>).inputs as Record<string, unknown>[])
      .map(input => input?.name).join(',') !== 'csc.exe,System.dll,System.Web.Extensions.dll'
    || ((compiler as Record<string, unknown>).inputs as Record<string, unknown>[]).some(input =>
      typeof input !== 'object' || input === null || Array.isArray(input)
      || !exactRecordKeys(input, ['name', 'size', 'sha256']) || !Number.isSafeInteger(input.size)
      || Number(input.size) <= 0 || Number(input.size) > 32 * 1024 * 1024
      || !/^[a-f0-9]{64}$/.test(String(input.sha256)))) {
    throw helperError('MANIFEST');
  }
  return manifest as unknown as WindowsAuthorityHelperManifest;
};

export const inspectWindowsAuthorityHelperPeForTest = (bytes: Buffer): void => {
  if (!Buffer.isBuffer(bytes) || bytes.length < 512 || bytes.length > HELPER_MAX_BYTES
    || bytes.readUInt16LE(0) !== 0x5a4d) throw helperError('HELPER_HASH');
  const pe = bytes.readUInt32LE(0x3c);
  if (pe < 0x40 || pe + 248 > bytes.length || bytes.toString('ascii', pe, pe + 4) !== 'PE\0\0'
    || bytes.readUInt16LE(pe + 4) !== 0x14c || bytes.readUInt16LE(pe + 24) !== 0x10b) {
    throw helperError('HELPER_HASH');
  }
  const sectionCount = bytes.readUInt16LE(pe + 6);
  const optionalSize = bytes.readUInt16LE(pe + 20);
  const clrDirectory = pe + 24 + 96 + (14 * 8);
  const clrRva = bytes.readUInt32LE(clrDirectory);
  if (sectionCount <= 0 || sectionCount > 96 || optionalSize < 224
    || clrDirectory + 8 > pe + 24 + optionalSize || clrRva === 0
    || bytes.readUInt32LE(clrDirectory + 4) < 72) {
    throw helperError('HELPER_HASH');
  }
  const sectionTable = pe + 24 + optionalSize;
  let clrOffset = -1;
  for (let index = 0; index < sectionCount; index += 1) {
    const section = sectionTable + (index * 40);
    if (section + 40 > bytes.length) throw helperError('HELPER_HASH');
    const virtualSize = bytes.readUInt32LE(section + 8);
    const virtualAddress = bytes.readUInt32LE(section + 12);
    const rawSize = bytes.readUInt32LE(section + 16);
    const rawAddress = bytes.readUInt32LE(section + 20);
    const span = Math.max(virtualSize, rawSize);
    if (clrRva >= virtualAddress && clrRva < virtualAddress + span) {
      clrOffset = rawAddress + clrRva - virtualAddress;
    }
  }
  if (clrOffset < 0 || clrOffset + 20 > bytes.length) throw helperError('HELPER_HASH');
  const corFlags = bytes.readUInt32LE(clrOffset + 16);
  if ((corFlags & 0x1) === 0 || (corFlags & (0x2 | 0x10 | 0x20000)) !== 0) throw helperError('HELPER_HASH');
};

export const inspectWindowsNativeLauncherPeForTest = (bytes: Buffer, architecture: 'x64' | 'arm64'): void => {
  if (!Buffer.isBuffer(bytes) || bytes.length < 512 || bytes.length > HELPER_MAX_BYTES
    || bytes.readUInt16LE(0) !== 0x5a4d) throw helperError('HELPER_HASH');
  const pe = bytes.readUInt32LE(0x3c);
  const expectedMachine = architecture === 'arm64' ? 0xaa64 : 0x8664;
  if (pe < 0x40 || pe + 24 > bytes.length || bytes.toString('ascii', pe, pe + 4) !== 'PE\0\0'
    || bytes.readUInt16LE(pe + 4) !== expectedMachine) throw helperError('HELPER_HASH');
};

const readHeldExactly = async (handle: FileHandle, size: number, stage: WindowsAuthorityCompileStage): Promise<Buffer> => {
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const result = await handle.read(bytes, offset, size - offset, offset).catch(() => { throw helperError(stage); });
    if (result.bytesRead <= 0) throw helperError(stage);
    offset += result.bytesRead;
  }
  return bytes;
};

const proveCanonicalTree = async (root: string, target: string): Promise<{
  path: string;
  identity: { dev: bigint; ino: bigint; size: bigint; nlink: bigint };
}> => {
  const canonicalRoot = await realpath(root).catch(() => { throw helperError('HELPER_REPARSE'); });
  const canonicalTarget = await realpath(target).catch(() => { throw helperError('HELPER_REPARSE'); });
  const samePath = (left: string, right: string): boolean => process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
  if (!samePath(resolve(root), canonicalRoot) || !samePath(resolve(target), canonicalTarget)) throw helperError('HELPER_REPARSE');
  const inside = relative(canonicalRoot, canonicalTarget);
  if (!inside || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) throw helperError('HELPER_REPARSE');
  let cursor = canonicalRoot;
  for (const part of inside.split(sep)) {
    cursor = join(cursor, part);
    const stats = await lstat(cursor, { bigint: true }).catch(() => { throw helperError('HELPER_REPARSE'); });
    if (stats.isSymbolicLink() || (!stats.isDirectory() && cursor !== canonicalTarget)) throw helperError('HELPER_REPARSE');
  }
  const stats = await lstat(canonicalTarget, { bigint: true }).catch(() => { throw helperError('HELPER_REPARSE'); });
  return { path: canonicalTarget, identity: { dev: stats.dev, ino: stats.ino, size: stats.size, nlink: stats.nlink } };
};

const authenticateWindowsAuthorityHelper = async (
  directory = helperDirectory(),
  beforeOpenForTest?: () => void | Promise<void>,
  expectedPublisher = embeddedExpectedPublisher(),
  expectedSignerPins = embeddedExpectedSignerPins(),
): Promise<AuthenticatedWindowsAuthorityHelper> => {
  if (!isAbsolute(directory) || directory.indexOf(':', 2) >= 0) throw helperError('MANIFEST');
  const executableProof = await proveCanonicalTree(directory, join(directory, HELPER_NAME));
  const launcherProof = await proveCanonicalTree(directory, join(directory, LAUNCHER_NAME));
  const manifestProof = await proveCanonicalTree(directory, join(directory, HELPER_MANIFEST_NAME));
  await beforeOpenForTest?.();
  let executableHandle: FileHandle | undefined;
  let launcherHandle: FileHandle | undefined;
  let manifestHandle: FileHandle | undefined;
  try {
    manifestHandle = await open(manifestProof.path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
      .catch(() => { throw helperError('MANIFEST'); });
    const manifestStats = await manifestHandle.stat({ bigint: true });
    if (!manifestStats.isFile() || manifestStats.dev !== manifestProof.identity.dev || manifestStats.ino !== manifestProof.identity.ino
      || manifestStats.nlink !== 1n || manifestStats.size <= 1n
      || manifestStats.size > BigInt(HELPER_MANIFEST_BYTES)) throw helperError('MANIFEST');
    const manifest = parseWindowsAuthorityHelperManifestForTest(
      await readHeldExactly(manifestHandle, Number(manifestStats.size), 'MANIFEST'),
    );
    if (expectedPublisher
      ? manifest.trust !== 'production-signed' || manifest.publisher !== expectedPublisher
      : manifest.trust !== 'unsigned-validation' || manifest.publisher !== null) throw helperError('MANIFEST');
    if (expectedPublisher && JSON.stringify(manifest.signerPins) !== JSON.stringify(expectedSignerPins)) {
      throw helperError('MANIFEST');
    }
    executableHandle = await open(executableProof.path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
      .catch(() => { throw helperError('HELPER_OPEN'); });
    const before = await executableHandle.stat({ bigint: true });
    if (!before.isFile() || before.dev !== executableProof.identity.dev || before.ino !== executableProof.identity.ino
      || before.nlink !== 1n || before.size !== BigInt(manifest.size)) throw helperError('HELPER_IDENTITY');
    const bytes = await readHeldExactly(executableHandle, manifest.size, 'HELPER_HASH');
    inspectWindowsAuthorityHelperPeForTest(bytes);
    if (createHash('sha256').update(bytes).digest('hex') !== manifest.sha256) throw helperError('HELPER_HASH');
    const after = await executableHandle.stat({ bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.nlink !== after.nlink) throw helperError('HELPER_IDENTITY');
    launcherHandle = await open(launcherProof.path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
      .catch(() => { throw helperError('HELPER_OPEN'); });
    const launcherBefore = await launcherHandle.stat({ bigint: true });
    if (!launcherBefore.isFile() || launcherBefore.dev !== launcherProof.identity.dev
      || launcherBefore.ino !== launcherProof.identity.ino || launcherBefore.nlink !== 1n
      || launcherBefore.size !== BigInt(manifest.launcher.size)
      || manifest.launcher.architecture !== process.arch) throw helperError('HELPER_IDENTITY');
    const launcherBytes = await readHeldExactly(launcherHandle, manifest.launcher.size, 'HELPER_HASH');
    inspectWindowsNativeLauncherPeForTest(launcherBytes, manifest.launcher.architecture);
    if (createHash('sha256').update(launcherBytes).digest('hex') !== manifest.launcher.sha256) {
      throw helperError('HELPER_HASH');
    }
    const launcherAfter = await launcherHandle.stat({ bigint: true });
    if (launcherAfter.dev !== launcherBefore.dev || launcherAfter.ino !== launcherBefore.ino
      || launcherAfter.size !== launcherBefore.size || launcherAfter.nlink !== launcherBefore.nlink) {
      throw helperError('HELPER_IDENTITY');
    }
    let nativeLauncher: WindowsNativeLauncher;
    try { nativeLauncher = require(launcherProof.path) as WindowsNativeLauncher; }
    catch { throw helperError('HELPER_OPEN'); }
    if (!nativeLauncher || typeof nativeLauncher.launch !== 'function' || typeof nativeLauncher.verifyModule !== 'function') {
      throw helperError('HELPER_OPEN');
    }
    let moduleProof: Record<string, unknown>;
    try {
      moduleProof = nativeLauncher.verifyModule({
        path: launcherProof.path,
        size: manifest.launcher.size,
        sha256: manifest.launcher.sha256,
        production: manifest.launcher.trust === 'production-signed',
        publisher: manifest.launcher.publisher,
        signerCertificateSha256: manifest.launcher.signerCertificateSha256,
        signerSpkiSha256: manifest.launcher.signerSpkiSha256,
      });
    } catch { throw helperError('HELPER_IDENTITY'); }
    if (moduleProof.sha256 !== manifest.launcher.sha256
      || moduleProof.architecture !== manifest.launcher.architecture) throw helperError('HELPER_IDENTITY');
    return { executable: executableProof.path, executableHandle, launcherHandle, manifestHandle, manifest,
      launcher: nativeLauncher };
  } catch (error) {
    await executableHandle?.close().catch(() => undefined);
    await launcherHandle?.close().catch(() => undefined);
    await manifestHandle?.close().catch(() => undefined);
    throw error;
  }
};

export const authenticateWindowsAuthorityHelperForTest = authenticateWindowsAuthorityHelper;

const spawnBroker = (
  helper: AuthenticatedWindowsAuthorityHelper,
  injectedStage?: WindowsAuthorityCompileStage,
  transportFault?: 'stderr',
  imageFault?: 'process-image',
  nativeFault?: string,
): BrokerChild => {
  const native = helper.launcher.launch({
    path: helper.executable,
    size: helper.manifest.size,
    sha256: helper.manifest.sha256,
    production: helper.manifest.trust === 'production-signed',
    publisher: helper.manifest.publisher,
    signerCertificateSha256: helper.manifest.signerCertificateSha256,
    signerSpkiSha256: helper.manifest.signerSpkiSha256,
    // Fixed test-only enums are interpreted by the native boundary; no path,
    // capability, challenge, or secret is placed in argv or the child environment.
    fault: nativeFault ?? injectedStage ?? transportFault ?? imageFault ?? null,
  });
  return new NativeBrokerChild(helper.launcher, native);
};

class NativeBrokerChild extends EventEmitter implements BrokerChild {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  exitCode: number | null = null;
  killed = false;
  readonly imageVolumeSerial: string;
  readonly imageFileId128: string;
  private poll: NodeJS.Timeout | undefined;
  private outputEnded = 0;
  private closed = false;

  constructor(private readonly launcher: WindowsNativeLauncher, private readonly native: NativeLaunchLease) {
    super();
    this.imageVolumeSerial = native.volumeSerial;
    this.imageFileId128 = native.fileId128;
    this.stdin = createWriteStream('', { fd: native.stdinFd, autoClose: false });
    this.stdout = createReadStream('', { fd: native.stdoutFd, autoClose: false });
    this.stderr = createReadStream('', { fd: native.stderrFd, autoClose: false });
    this.stdin.once('finish', () => {
      try { this.launcher.closeInput(this.native.lease); } catch { /* process exit owns cleanup */ }
    });
    const ended = () => { this.outputEnded += 1; this.finishIfReady(); };
    this.stdout.once('end', ended);
    this.stderr.once('end', ended);
    this.poll = setInterval(() => this.pollExit(), 20);
    this.poll.unref();
  }

  private pollExit(): void {
    if (this.closed) return;
    try {
      const code = this.launcher.status(this.native.lease);
      if (code !== null) {
        this.exitCode = code;
        if (this.poll) clearInterval(this.poll);
        this.poll = undefined;
        this.finishIfReady();
      }
    } catch {
      if (this.poll) clearInterval(this.poll);
      this.poll = undefined;
      this.emit('error', new Error('Windows native launcher status failed'));
    }
  }

  private finishIfReady(): void {
    if (this.closed || this.exitCode === null || this.outputEnded !== 2) return;
    this.closed = true;
    try { this.launcher.close(this.native.lease); } catch { /* fixed close path */ }
    this.emit('close', this.exitCode);
  }

  kill(): boolean {
    if (this.closed || this.killed) return false;
    this.killed = true;
    try { this.launcher.terminate(this.native.lease); return true; } catch { return false; }
  }

  unref(): void { this.poll?.unref(); }
}

class WindowsAuthorityError extends Error {
  constructor(readonly reason: WindowsAuthorityReason, readonly scenario: number) {
    super(`Verified update cache authority inspection failed [win-authority:${reason}:${scenario}]`);
  }
}

export type WindowsAuthorityBootstrapFailureKind =
  | 'SPAWN_ERROR'
  | 'EXIT_NO_OUTPUT'
  | 'EXIT_AFTER_OUTPUT'
  | 'TIMEOUT'
  | 'MALFORMED_OUTPUT'
  | 'EXTRA_OUTPUT'
  | 'STAGE_CHANNEL'
  | 'WRITE_ERROR';

export class WindowsAuthorityBootstrapError extends WindowsAuthorityError {
  readonly stage: WindowsAuthorityCompileStage;

  constructor(readonly kind: WindowsAuthorityBootstrapFailureKind, stageIndex: number) {
    super('compile_load', stageIndex);
    this.stage = WINDOWS_AUTHORITY_COMPILE_STAGES[stageIndex] ?? 'TRANSPORT_SPAWN';
  }
}

const authorityError = (reason: WindowsAuthorityReason, scenario: number): WindowsAuthorityError =>
  new WindowsAuthorityError(reason, scenario);

const abortError = (): Error => Object.assign(new Error('Windows authority request aborted'), { name: 'AbortError' });

const throwIfAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw abortError();
};

const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

const parseFailure = (value: unknown, expectedId?: string): Error | undefined => {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  const keys = expectedId === undefined
    ? ['version', 'type', 'reason', 'scenario']
    : ['version', 'type', 'id', 'reason', 'scenario'];
  if (candidate.version !== WINDOWS_AUTHORITY_PROTOCOL_VERSION || candidate.type !== 'error'
    || !hasExactKeys(candidate, keys) || (expectedId !== undefined && candidate.id !== expectedId)
    || typeof candidate.reason !== 'string' || !reasonCodes.has(candidate.reason)
    || !Number.isInteger(candidate.scenario) || Number(candidate.scenario) < 0 || Number(candidate.scenario) > 99) {
    return undefined;
  }
  return authorityError(candidate.reason as WindowsAuthorityReason, Number(candidate.scenario));
};

const parseInspection = (
  value: unknown,
  directory: boolean,
  hashes: boolean,
): WindowsPrivatePathInspection | WindowsHeldVerification | undefined => {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== WINDOWS_AUTHORITY_PROTOCOL_VERSION
    || !/^[a-f0-9]{16}$/.test(String(candidate.volumeSerial))
    || !/^[a-f0-9]{32}$/.test(String(candidate.fileId128))
    || candidate.directory !== directory
    || !/^(0|[1-9]\d*)$/.test(String(candidate.links))
    || !/^(0|[1-9]\d*)$/.test(String(candidate.size))
    || (!hashes && !directory && BigInt(String(candidate.size)) > BigInt(BROKER_SETUP_FILE_BYTES))
    || !/^[a-f0-9]{8}$/.test(String(candidate.reparseTag))
    || candidate.reparseTag !== '00000000'
    || !/^S-1-(?:\d+-){1,14}\d+$/.test(String(candidate.ownerSid))
    || candidate.daclProtected !== true
    || !/^(0|[1-9]\d*)$/.test(String(candidate.aceCount))
    || candidate.inheritedWriteAces !== '0'
    || candidate.broadWriteAces !== '0'
    || (hashes && (!/^[a-f0-9]{64}$/.test(String(candidate.sha256))
      || !/^[a-f0-9]{40}$/.test(String(candidate.sha1))))) return undefined;
  const inspection: WindowsPrivatePathInspection = {
    identity: {
      platform: 'win32',
      volumeSerial: String(candidate.volumeSerial),
      fileId128: String(candidate.fileId128),
    },
    directory,
    links: String(candidate.links),
    size: String(candidate.size),
    reparseTag: String(candidate.reparseTag),
    ownerSid: String(candidate.ownerSid),
    daclProtected: true,
    aceCount: String(candidate.aceCount),
    inheritedWriteAces: '0',
    broadWriteAces: '0',
  };
  return hashes ? {
    ...inspection,
    sha256: String(candidate.sha256),
    sha1: String(candidate.sha1),
  } : inspection;
};

type BrokerRequestOperation = BrokerOperation | 'hold' | 'continue' | 'read' | 'verify' | 'close' | 'fault-stderr';
// After the authenticated image/challenge exchange, the persistent process
// accepts only four-byte-length-prefixed strict-UTF-8 versioned request frames. Node
// permits one in-flight frame at a time; a held capability owns the FIFO lease
// until close, so its native handle cannot be confused with another entry.
interface BrokerRequestFrame {
  version: typeof WINDOWS_AUTHORITY_PROTOCOL_VERSION;
  type: 'request';
  id: string;
  operation: BrokerRequestOperation;
  purpose: BrokerPurpose;
  path: string | null;
  directory: boolean | null;
  expectedBytes: number | null;
  expectedVolumeSerial: string | null;
  expectedFileId128: string | null;
  expectedSha256: string | null;
  challenge: string | null;
  barrier: string | null;
  offset: number | null;
  length: number | null;
}

interface FrameWaiter {
  resolve(value: Record<string, unknown>): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
  signal?: AbortSignal;
  abort?: () => void;
}

interface LockedArtifactProcess {
  session: WindowsAuthoritySession;
  exited: Promise<void>;
  challenge: string;
  heldId: string;
  purpose: BrokerPurpose;
  release(): void;
  timeout: NodeJS.Timeout;
}

let brokerSession: WindowsAuthoritySession | undefined;
let brokerStartup: Promise<WindowsAuthoritySession> | undefined;
let compileCount = 0;
let requestCount = 0;
let restartCount = 0;
let activeProcessCount = 0;
let lastClosedHeldId: string | undefined;
const brokerChildren = new Set<BrokerChild>();

const encodeProtocolFrame = (value: string): Buffer => {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= 0 || bytes.length > BROKER_REQUEST_LINE_BYTES) throw authorityError('request_protocol', 1);
  const prefix = Buffer.allocUnsafe(4);
  prefix.writeUInt32BE(bytes.length);
  return Buffer.concat([prefix, bytes]);
};

const decodeProtocolChunk = (buffered: Buffer, chunk: Buffer): {
  buffered: Buffer;
  frames: readonly Buffer[];
} => {
  let combined = buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk]);
  const frames: Buffer[] = [];
  while (combined.length >= 4) {
    const length = combined.readUInt32BE(0);
    if (length <= 0 || length > BROKER_PROTOCOL_LINE_BYTES) throw authorityError('output_bound', 17);
    if (combined.length < 4 + length) break;
    frames.push(combined.subarray(4, 4 + length));
    combined = combined.subarray(4 + length);
  }
  if (combined.length > BROKER_PROTOCOL_LINE_BYTES + 4) throw authorityError('output_bound', 17);
  return { buffered: Buffer.from(combined), frames };
};

class WindowsAuthoritySession {
  readonly exited: Promise<void>;
  private terminalError: Error | undefined;
  private buffered: Buffer = Buffer.alloc(0);
  private waiter: FrameWaiter | undefined;
  private stderrBytes = 0;
  private stderrBuffered = '';
  private bootstrapStages: WindowsAuthorityCompileStage[] = WINDOWS_AUTHORITY_COMPILE_STAGES.slice(0, 4);
  private bootstrapReady = false;
  private bootstrapResolve!: () => void;
  private readonly bootstrapCompleted = new Promise<void>(resolve => { this.bootstrapResolve = resolve; });
  private inputBytes = 0;
  private outputBytes = 0;
  private frames = 0;
  private closing = false;

  constructor(
    readonly child: BrokerChild,
    private readonly sharedQueue = true,
    private readonly helper?: AuthenticatedWindowsAuthorityHelper,
  ) {
    activeProcessCount++;
    brokerChildren.add(child);
    child.stdout.on('data', (chunk: Buffer) => this.consume(chunk));
    child.stderr.on('data', (chunk: Buffer) => this.consumeBootstrapStage(chunk));
    child.stdin.on('error', () => this.invalidate(this.bootstrapReady
      ? authorityError('stdio_protocol', 16) : this.bootstrapError('WRITE_ERROR')));
    child.on('error', () => this.invalidate(this.bootstrapReady
      ? authorityError('process_exit', 19) : this.bootstrapError('SPAWN_ERROR')));
    this.exited = new Promise(resolve => child.once('close', code => {
      activeProcessCount--;
      brokerChildren.delete(child);
      const clean = this.closing && code === 0 && this.stderrBuffered === '' && this.buffered.length === 0;
      this.fail(clean ? authorityError('clean_shutdown', 15)
        : this.bootstrapReady ? authorityError('process_exit', 19)
          : this.bootstrapError(this.outputBytes === 0 ? 'EXIT_NO_OUTPUT' : 'EXIT_AFTER_OUTPUT'), false);
      if (brokerSession === this) brokerSession = undefined;
      void this.helper?.executableHandle.close().catch(() => undefined);
      void this.helper?.launcherHandle.close().catch(() => undefined);
      void this.helper?.manifestHandle.close().catch(() => undefined);
      resolve();
    }));
    child.unref();
    (child.stdin as typeof child.stdin & { unref?(): void }).unref?.();
    (child.stdout as typeof child.stdout & { unref?(): void }).unref?.();
    (child.stderr as typeof child.stderr & { unref?(): void }).unref?.();
  }

  private bootstrapError(kind: WindowsAuthorityBootstrapFailureKind = 'EXIT_NO_OUTPUT'): WindowsAuthorityBootstrapError {
    return new WindowsAuthorityBootstrapError(kind, this.bootstrapStages.length - 1);
  }

  private consumeBootstrapStage(chunk: Buffer): void {
    if (this.terminalError) return;
    this.stderrBytes += chunk.length;
    if (this.stderrBytes > BROKER_OUTPUT_BYTES || this.bootstrapReady) {
      return this.invalidate(authorityError(this.stderrBytes > BROKER_OUTPUT_BYTES ? 'output_bound' : 'stdio_protocol',
        this.stderrBytes > BROKER_OUTPUT_BYTES ? 17 : 16));
    }
    this.stderrBuffered += chunk.toString('ascii');
    while (this.stderrBuffered.includes('\n')) {
      const newline = this.stderrBuffered.indexOf('\n');
      const line = this.stderrBuffered.slice(0, newline).replace(/\r$/, '');
      this.stderrBuffered = this.stderrBuffered.slice(newline + 1);
      const match = /^PROPR_BOOTSTRAP (\d{2}) ([A-Z_]+)$/.exec(line);
      const expectedIndex = this.bootstrapStages.length;
      const expectedStage = WINDOWS_AUTHORITY_COMPILE_STAGES[expectedIndex];
      if (!match || Number(match[1]) !== expectedIndex || match[2] !== expectedStage) {
        return this.invalidate(this.bootstrapError('STAGE_CHANNEL'));
      }
      this.bootstrapStages.push(expectedStage);
      if (expectedStage === 'READY') this.bootstrapResolve();
    }
    if (this.stderrBuffered.length > 128) this.invalidate(this.bootstrapError('STAGE_CHANNEL'));
  }

  async requireBootstrapReady(timeoutMs: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      this.bootstrapCompleted,
      new Promise<void>((_resolve, reject) => {
        timer = setTimeout(() => {
          const error = this.bootstrapError('TIMEOUT');
          this.invalidate(error);
          reject(error);
        }, timeoutMs);
      }),
    ]).finally(() => { if (timer) clearTimeout(timer); });
    if (this.terminalError || this.stderrBuffered !== ''
      || this.bootstrapStages.length !== WINDOWS_AUTHORITY_COMPILE_STAGES.length) {
      throw this.terminalError ?? this.bootstrapError('STAGE_CHANNEL');
    }
    this.bootstrapReady = true;
  }

  currentBootstrapStage(): WindowsAuthorityCompileStage {
    return this.bootstrapStages[this.bootstrapStages.length - 1];
  }

  private consume(chunk: Buffer): void {
    if (this.terminalError) return;
    this.outputBytes += chunk.length;
    if (this.outputBytes > BROKER_MAX_OUTPUT_BYTES) return this.invalidate(authorityError('output_bound', 17));
    let decoded: ReturnType<typeof decodeProtocolChunk>;
    try { decoded = decodeProtocolChunk(this.buffered, chunk); } catch (error) {
      return this.invalidate(this.bootstrapReady
        ? (error instanceof Error ? error : authorityError('stdio_protocol', 16))
        : this.bootstrapError('MALFORMED_OUTPUT'));
    }
    this.buffered = decoded.buffered;
    for (const frame of decoded.frames) {
      if (!this.waiter) return this.invalidate(this.bootstrapReady
        ? authorityError('stdio_protocol', 16) : this.bootstrapError('EXTRA_OUTPUT'));
      let value: unknown;
      try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(frame)); } catch {
        return this.invalidate(this.bootstrapReady
          ? authorityError('stdio_protocol', 16) : this.bootstrapError('MALFORMED_OUTPUT'));
      }
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return this.invalidate(this.bootstrapReady
          ? authorityError('stdio_protocol', 16) : this.bootstrapError('MALFORMED_OUTPUT'));
      }
      const waiter = this.waiter;
      this.waiter = undefined;
      clearTimeout(waiter.timer);
      if (waiter.signal && waiter.abort) waiter.signal.removeEventListener('abort', waiter.abort);
      waiter.resolve(value as Record<string, unknown>);
    }
  }

  private fail(error: Error, kill: boolean): void {
    this.terminalError ??= error;
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = undefined;
      clearTimeout(waiter.timer);
      if (waiter.signal && waiter.abort) waiter.signal.removeEventListener('abort', waiter.abort);
      waiter.reject(this.terminalError);
    }
    if (this.sharedQueue) rejectBrokerQueue(this.terminalError);
    if (kill && !this.child.killed) this.child.kill();
  }

  invalidate(error: Error): void { this.fail(error, true); }

  async receive(timeoutMs: number, signal?: AbortSignal, startup = false): Promise<Record<string, unknown>> {
    throwIfAborted(signal);
    if (this.terminalError) throw this.terminalError;
    if (this.waiter) throw authorityError('stdio_protocol', 16);
    return new Promise((resolve, reject) => {
      const waiter: FrameWaiter = {
        resolve,
        reject,
        signal,
        timer: setTimeout(() => this.invalidate(startup
          ? this.bootstrapError('TIMEOUT') : authorityError('timeout', 18)), timeoutMs),
      };
      if (signal) {
        waiter.abort = () => this.invalidate(abortError());
        signal.addEventListener('abort', waiter.abort, { once: true });
      }
      this.waiter = waiter;
    });
  }

  private async writeChunk(value: string | Buffer): Promise<void> {
    if (this.terminalError) throw this.terminalError;
    if (this.child.stdin.write(value)) return;
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        this.child.stdin.removeListener('drain', drained);
        this.child.stdin.removeListener('error', failed);
      };
      const drained = () => { cleanup(); resolve(); };
      const failed = () => { cleanup(); reject(this.terminalError ?? authorityError('stdio_protocol', 16)); };
      this.child.stdin.once('drain', drained);
      this.child.stdin.once('error', failed);
    });
  }

  async write(value: string | BrokerRequestFrame): Promise<void> {
    if (this.terminalError) throw this.terminalError;
    const frame = encodeProtocolFrame(typeof value === 'string' ? value : JSON.stringify(value));
    this.inputBytes += frame.length;
    if (this.inputBytes > BROKER_MAX_INPUT_BYTES || ++this.frames > BROKER_MAX_FRAMES) {
      this.invalidate(authorityError('output_bound', 17));
      throw authorityError('output_bound', 17);
    }
    await this.writeChunk(frame);
  }

  async writeRawForTest(chunks: readonly Buffer[]): Promise<void> {
    if (this.terminalError || chunks.length === 0
      || chunks.some(chunk => chunk.length === 0 || chunk.length > BROKER_REQUEST_LINE_BYTES + 4)) {
      throw authorityError('request_protocol', 1);
    }
    for (const chunk of chunks) await this.writeChunk(chunk);
  }

  async exchange(frame: BrokerRequestFrame, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const response = this.receive(BROKER_TIMEOUT_MS, signal);
    await this.write(frame);
    const value = await response;
    requestCount++;
    const failure = parseFailure(value, frame.id) ?? parseFailure(value);
    if (failure) throw failure;
    if (value.id !== frame.id) {
      this.invalidate(authorityError('stdio_protocol', 16));
      throw authorityError('stdio_protocol', 16);
    }
    return value;
  }

  async shutdown(): Promise<void> {
    if (this.child.exitCode !== null) return;
    this.closing = true;
    this.child.stdin.end();
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.exited,
        new Promise<void>(resolve => {
          timer = setTimeout(() => { this.child.kill(); resolve(); }, BROKER_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => hasExactKeys(value, keys);
const RESPONSE_INSPECTION_KEYS = Object.freeze([...INSPECTION_KEYS, 'id', 'challenge'] as const);

const requestFrame = (operation: BrokerRequestOperation, values: Partial<BrokerRequestFrame> = {}): BrokerRequestFrame => ({
  version: WINDOWS_AUTHORITY_PROTOCOL_VERSION,
  type: 'request',
  id: randomBytes(16).toString('hex'),
  operation,
  purpose: 'setup',
  path: null,
  directory: null,
  expectedBytes: null,
  expectedVolumeSerial: null,
  expectedFileId128: null,
  expectedSha256: null,
  challenge: null,
  barrier: null,
  offset: null,
  length: null,
  ...values,
});

interface StartBrokerOptions {
  injectedStage?: WindowsAuthorityCompileStage;
  countCompilation?: boolean;
  transportFault?: 'stderr';
  imageFault?: 'process-image';
  helperDirectory?: string;
  expectedPublisher?: string;
  nativeFault?: string;
}

const startBroker = async (options: StartBrokerOptions = {}): Promise<WindowsAuthoritySession> => {
  if (options.injectedStage && WINDOWS_AUTHORITY_COMPILE_STAGES.slice(0, 4).includes(options.injectedStage)) {
    throw helperError(options.injectedStage);
  }
  const helper = await authenticateWindowsAuthorityHelper(
    options.helperDirectory,
    undefined,
    options.expectedPublisher ?? embeddedExpectedPublisher(),
  );
  let child: BrokerChild;
  try {
    child = spawnBroker(helper, options.injectedStage, options.transportFault, options.imageFault, options.nativeFault);
  } catch {
    await helper.executableHandle.close().catch(() => undefined);
    await helper.launcherHandle.close().catch(() => undefined);
    await helper.manifestHandle.close().catch(() => undefined);
    throw new WindowsAuthorityBootstrapError('SPAWN_ERROR', WINDOWS_AUTHORITY_COMPILE_STAGES.indexOf('TRANSPORT_SPAWN'));
  }
  if (options.countCompilation !== false) {
    compileCount++;
    if (compileCount > 1) restartCount++;
  }
  const session = new WindowsAuthoritySession(child, options.countCompilation !== false, helper);
  const challenge = randomBytes(16).toString('hex');
  const startupDeadline = Date.now() + BROKER_STARTUP_TIMEOUT_MS;
  const readyPromise = session.receive(BROKER_STARTUP_TIMEOUT_MS, undefined, true);
  try {
    await session.write(JSON.stringify({
      version: WINDOWS_AUTHORITY_PROTOCOL_VERSION,
      type: 'start',
      challenge,
      protocol: 'propr-windows-authority-v1',
    }));
  } catch (error) {
    session.invalidate(error instanceof Error ? error : authorityError('compile_load', 0));
    throw error;
  }
  const ready = await readyPromise;
  const failure = parseFailure(ready);
  if (failure) {
    session.invalidate(failure);
    throw failure;
  }
  await session.requireBootstrapReady(Math.max(1, startupDeadline - Date.now()));
  if (!exactKeys(ready, ['version', 'type', 'challenge', 'protocol', 'maxRequestBytes', 'nativeSmoke', 'compileCount',
    'imageVolumeSerial', 'imageFileId128', 'imageSha256'])
    || ready.version !== WINDOWS_AUTHORITY_PROTOCOL_VERSION || ready.type !== 'ready'
    || ready.challenge !== challenge || ready.protocol !== 'propr-windows-authority-v1'
    || ready.maxRequestBytes !== BROKER_REQUEST_LINE_BYTES || ready.nativeSmoke !== true || ready.compileCount !== 1
    || !/^[a-f0-9]{16}$/.test(String(ready.imageVolumeSerial))
    || !/^[a-f0-9]{32}$/.test(String(ready.imageFileId128))
    || ready.imageVolumeSerial !== child.imageVolumeSerial || ready.imageFileId128 !== child.imageFileId128
    || ready.imageSha256 !== helper.manifest.sha256) {
    const error = new WindowsAuthorityBootstrapError('MALFORMED_OUTPUT', WINDOWS_AUTHORITY_COMPILE_STAGES.indexOf('READY'));
    session.invalidate(error);
    throw error;
  }
  return session;
};

const compileStageFromError = (error: unknown): WindowsAuthorityCompileStage => {
  if (error instanceof WindowsAuthorityError && error.reason === 'compile_load'
    && error.scenario >= 0 && error.scenario < WINDOWS_AUTHORITY_COMPILE_STAGES.length) {
    return WINDOWS_AUTHORITY_COMPILE_STAGES[error.scenario];
  }
  return 'TRANSPORT_SPAWN';
};

const runWindowsAuthorityCompileProbe = async (options: StartBrokerOptions = {}): Promise<WindowsAuthorityCompileStage> => {
  let session: WindowsAuthoritySession | undefined;
  try {
    session = await startBroker({ ...options, countCompilation: false });
    return 'READY';
  } catch (error) {
    return compileStageFromError(error);
  } finally {
    await session?.shutdown();
  }
};

/** Hosted smoke of the exact build-produced executable and READY handshake. */
export const probeWindowsAuthorityCompile = (): Promise<WindowsAuthorityCompileStage> =>
  runWindowsAuthorityCompileProbe();

export const probePackagedWindowsAuthorityHelper = (directory: string): Promise<WindowsAuthorityCompileStage> => {
  if (!isAbsolute(directory)) return Promise.reject(helperError('MANIFEST'));
  const expectedPublisher = process.env.PROPR_DESKTOP_PRODUCTION_RELEASE === '1'
    ? process.env.PROPR_DESKTOP_UPDATE_SIGNING_IDENTITY
    : undefined;
  if (process.env.PROPR_DESKTOP_PRODUCTION_RELEASE === '1' && !expectedPublisher) {
    return Promise.reject(helperError('MANIFEST'));
  }
  return runWindowsAuthorityCompileProbe({ helperDirectory: directory, expectedPublisher });
};

/** Native-test-only corrupt-output classification; no compiler diagnostics leave the build boundary. */
export const probeWindowsAuthorityCompileFailureForTest = (): Promise<WindowsAuthorityCompileStage> =>
  Promise.resolve('BUILD_OUTPUT');

/** Native-test-only failure injection at each fixed startup boundary. */
export const probeWindowsAuthorityBootstrapStageForTest = (stage: WindowsAuthorityCompileStage): Promise<WindowsAuthorityCompileStage> =>
  runWindowsAuthorityCompileProbe({ injectedStage: stage });

export const probeWindowsAuthorityProcessImageMismatchForTest = (): Promise<WindowsAuthorityCompileStage> =>
  runWindowsAuthorityCompileProbe({ imageFault: 'process-image' });

export const probeWindowsAuthorityNativeBoundaryForTest = (
  fault: 'barrier-after-hash-delete' | 'barrier-after-hash-swap' | 'barrier-after-hash-write'
    | 'barrier-before-create-delete' | 'barrier-before-create-swap' | 'barrier-before-create-write'
    | 'barrier-after-process-delete' | 'barrier-after-process-swap' | 'barrier-after-process-write'
    | 'extra-child' | 'job-assignment' | 'parent-image-proof' | 'pipe-substitution',
): Promise<WindowsAuthorityCompileStage> => runWindowsAuthorityCompileProbe({ nativeFault: fault });

/** Native-test-only startup failure against the exact compiled production child. */
export const probeWindowsAuthorityStartupFailureForTest = async (): Promise<WindowsAuthorityReason> => {
  const helper = await authenticateWindowsAuthorityHelper();
  const session = new WindowsAuthoritySession(spawnBroker(helper), false, helper);
  try {
    const response = session.receive(BROKER_STARTUP_TIMEOUT_MS, undefined, true);
    await session.write(JSON.stringify({
      version: WINDOWS_AUTHORITY_PROTOCOL_VERSION,
      type: 'start',
      challenge: randomBytes(16).toString('hex'),
      protocol: 'invalid-protocol',
    }));
    await response;
    throw authorityError('stdio_protocol', 16);
  } catch (error) {
    if (error instanceof WindowsAuthorityError && error.reason === 'ready_protocol') return 'ready_protocol';
    if (error instanceof WindowsAuthorityError && error.reason === 'compile_load'
      && error.scenario === WINDOWS_AUTHORITY_COMPILE_STAGES.indexOf('READY')) return 'ready_protocol';
    if (error instanceof WindowsAuthorityBootstrapError
      && error.stage === 'PROTOCOL_INIT') return 'ready_protocol';
    throw error;
  } finally {
    await session.shutdown();
  }
};

/** Native-test-only live transport faults with short local deadlines and fixed diagnostics. */
export const injectWindowsAuthorityTransportFaultForTest = async (
  kind: 'stderr' | 'slowloris' | 'timeout',
): Promise<WindowsAuthorityReason> => {
  const session = await startBroker({ countCompilation: false, transportFault: kind === 'stderr' ? 'stderr' : undefined });
  try {
    if (kind === 'stderr') {
      await session.exchange(requestFrame('fault-stderr'));
    } else {
      const response = session.receive(50);
      if (kind === 'slowloris') await session.writeRawForTest([Buffer.from([0, 0, 0, 100, 0x7b])]);
      await response;
    }
    throw authorityError('stdio_protocol', 16);
  } catch (error) {
    if (error instanceof WindowsAuthorityError) return error.reason;
    throw error;
  } finally { await session.shutdown(); }
};

const getBroker = async (): Promise<WindowsAuthoritySession> => {
  if (brokerSession) return brokerSession;
  brokerStartup ??= startBroker().then(session => {
    brokerSession = session;
    return session;
  }).finally(() => { brokerStartup = undefined; });
  return brokerStartup;
};

const retryableInfrastructureError = (error: unknown): boolean => error instanceof WindowsAuthorityError
  && ['ready_protocol', 'stdio_protocol', 'output_bound', 'timeout', 'process_exit', 'clean_shutdown'].includes(error.reason);

const withRestartOnce = async <T>(work: (session: WindowsAuthoritySession) => Promise<T>): Promise<T> => {
  let first: unknown;
  try { return await work(await getBroker()); } catch (error) { first = error; }
  if (!retryableInfrastructureError(first)) throw first;
  if (brokerSession) brokerSession.invalidate(first as Error);
  brokerSession = undefined;
  return work(await getBroker());
};

interface QueueEntry { signal?: AbortSignal; resolve(release: () => void): void; reject(error: Error): void; abort?: () => void }
const brokerQueue: QueueEntry[] = [];
let brokerLeaseActive = false;

const rejectBrokerQueue = (error: Error): void => {
  for (const entry of brokerQueue.splice(0)) {
    if (entry.signal && entry.abort) entry.signal.removeEventListener('abort', entry.abort);
    entry.reject(error);
  }
};

const dispatchLease = (): void => {
  if (brokerLeaseActive) return;
  const entry = brokerQueue.shift();
  if (!entry) return;
  if (entry.signal?.aborted) {
    entry.reject(abortError());
    dispatchLease();
    return;
  }
  brokerLeaseActive = true;
  if (entry.signal && entry.abort) entry.signal.removeEventListener('abort', entry.abort);
  let released = false;
  entry.resolve(() => {
    if (released) return;
    released = true;
    brokerLeaseActive = false;
    dispatchLease();
  });
};

const acquireLease = (signal?: AbortSignal): Promise<() => void> => {
  throwIfAborted(signal);
  if (brokerQueue.length >= BROKER_MAX_QUEUE_ENTRIES) return Promise.reject(authorityError('output_bound', 17));
  return new Promise((resolve, reject) => {
    const entry: QueueEntry = { signal, resolve, reject };
    if (signal) {
      entry.abort = () => {
        const index = brokerQueue.indexOf(entry);
        if (index >= 0) brokerQueue.splice(index, 1);
        reject(abortError());
      };
      signal.addEventListener('abort', entry.abort, { once: true });
    }
    brokerQueue.push(entry);
    dispatchLease();
  });
};

const runBroker = async (
  operation: BrokerOperation,
  path: string,
  directory: boolean,
  signal?: AbortSignal,
): Promise<WindowsPrivatePathInspection> => {
  const release = await acquireLease(signal);
  try {
    return await withRestartOnce(async session => {
      const request = requestFrame(operation, { purpose: 'setup', path, directory });
      const value = await session.exchange(request, signal);
      const inspected = parseInspection(value, directory, false);
      if (!inspected || value.type !== 'inspection' || value.challenge !== ''
        || !exactKeys(value, RESPONSE_INSPECTION_KEYS)) {
        session.invalidate(authorityError('stdio_protocol', 16));
        throw authorityError('stdio_protocol', 16);
      }
      return inspected;
    });
  } finally { release(); }
};

export const inspectWindowsPrivatePath = (
  path: string,
  directory = false,
  signal?: AbortSignal,
): Promise<WindowsPrivatePathInspection> => runBroker('inspect', path, directory, signal);

export const ensureWindowsPrivateDirectory = (
  path: string,
  signal?: AbortSignal,
): Promise<WindowsPrivatePathInspection> => runBroker('ensure-directory', path, true, signal);

export const protectWindowsPrivateDirectory = (
  path: string,
  signal?: AbortSignal,
): Promise<WindowsPrivatePathInspection> => runBroker('protect-directory', path, true, signal);

export const protectWindowsPrivateFile = (
  path: string,
  signal?: AbortSignal,
): Promise<WindowsPrivatePathInspection> => runBroker('protect-file', path, false, signal);

const openWindowsLockedArtifactAttempt = async (
  path: string,
  expectedBytes: number,
  expectedIdentity: WindowsFileIdentity,
  expectedSha256: string | undefined,
  beforeOpenForTest?: () => Promise<void>,
  signal?: AbortSignal,
  retry = true,
): Promise<WindowsLockedArtifact> => {
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0 || expectedBytes > BROKER_ARTIFACT_BYTES
    || !/^[a-f0-9]{16}$/.test(expectedIdentity.volumeSerial)
    || !/^[a-f0-9]{32}$/.test(expectedIdentity.fileId128)) throw authorityError('request_protocol', 1);
  const release = await acquireLease(signal);
  let session: WindowsAuthoritySession | undefined;
  let capabilityChallenge = randomBytes(16).toString('hex');
  let acquisitionBarrierRan = false;
  try {
    const activeSession = session = await getBroker();
    const barrierChallenge = beforeOpenForTest ? randomBytes(16).toString('hex') : null;
    const hold = requestFrame('hold', {
      // A zero-byte protected file is a setup capability. Every nonempty held
      // file is an artifact capability, whether its hash is being learned or
      // checked against an already authenticated digest.
      purpose: expectedBytes === 0 ? 'setup' : 'artifact',
      path,
      expectedBytes,
      expectedVolumeSerial: expectedIdentity.volumeSerial,
      expectedFileId128: expectedIdentity.fileId128,
      expectedSha256: expectedSha256 ?? null,
      challenge: capabilityChallenge,
      barrier: barrierChallenge,
    });
    let responsePromise = activeSession.receive(BROKER_TIMEOUT_MS, signal);
    await activeSession.write(hold);
    let ready = await responsePromise;
    if (barrierChallenge) {
      if (!exactKeys(ready, ['version', 'type', 'id', 'challenge'])
        || ready.version !== WINDOWS_AUTHORITY_PROTOCOL_VERSION || ready.type !== 'before-open'
        || ready.id !== hold.id || ready.challenge !== barrierChallenge) throw authorityError('ready_protocol', 12);
      try {
        await beforeOpenForTest!();
        acquisitionBarrierRan = true;
      } catch (error) {
        activeSession.invalidate(abortError());
        throw error;
      }
      const continuation = requestFrame('continue', {
        id: hold.id,
        purpose: hold.purpose,
        challenge: capabilityChallenge,
        barrier: barrierChallenge,
      });
      responsePromise = activeSession.receive(BROKER_TIMEOUT_MS, signal);
      await activeSession.write(continuation);
      ready = await responsePromise;
    }
    requestCount++;
    const failure = parseFailure(ready, hold.id);
    if (failure) throw failure;
    const initial = parseInspection(ready, false, true) as WindowsHeldVerification | undefined;
    if (!initial || ready.type !== 'held' || ready.id !== hold.id || ready.challenge !== capabilityChallenge
      || !exactKeys(ready, RESPONSE_INSPECTION_KEYS)) throw authorityError('ready_protocol', 12);

    let closed = false;
    let commandQueue = Promise.resolve();
    const sameInitial = (candidate: WindowsHeldVerification): boolean =>
      candidate.identity.volumeSerial === initial.identity.volumeSerial
      && candidate.identity.fileId128 === initial.identity.fileId128
      && candidate.links === initial.links && candidate.size === initial.size
      && candidate.reparseTag === initial.reparseTag && candidate.ownerSid === initial.ownerSid
      && candidate.aceCount === initial.aceCount
      && candidate.inheritedWriteAces === initial.inheritedWriteAces
      && candidate.broadWriteAces === initial.broadWriteAces
      && candidate.sha256 === initial.sha256 && candidate.sha1 === initial.sha1;
    const exchangeHeld = async (operation: 'read' | 'verify' | 'close', values: Partial<BrokerRequestFrame>, requestSignal?: AbortSignal) => {
      let value!: Record<string, unknown>;
      const run = commandQueue.then(async () => {
        throwIfAborted(requestSignal);
        value = await activeSession.exchange(requestFrame(operation, {
          id: hold.id,
          purpose: hold.purpose,
          challenge: capabilityChallenge,
          ...values,
        }), requestSignal);
      });
      commandQueue = run.catch(() => undefined);
      await run;
      return value;
    };
    const heldTimeout = setTimeout(() => {
      activeSession.invalidate(authorityError('timeout', 18));
      release();
    }, BROKER_SESSION_TIMEOUT_MS);
    const capability: WindowsLockedArtifact = {
      inspection: initial,
      read: async (offset, length, requestSignal) => {
        if (closed || !Number.isSafeInteger(offset) || offset < 0
          || !Number.isSafeInteger(length) || length <= 0 || length > MAX_READ_BYTES
          || offset + length > Number(initial.size)) throw authorityError('request_protocol', 1);
        const result = await exchangeHeld('read', { offset, length }, requestSignal);
        if (result.type !== 'bytes' || result.id !== hold.id || result.challenge !== capabilityChallenge
          || typeof result.bytes !== 'string'
          || !exactKeys(result, ['version', 'type', 'id', 'challenge', 'bytes'])) {
          activeSession.invalidate(authorityError('stdio_protocol', 16));
          throw authorityError('held_read', 13);
        }
        const bytes = Buffer.from(result.bytes, 'base64');
        if (bytes.length !== length || bytes.toString('base64') !== result.bytes) {
          activeSession.invalidate(authorityError('stdio_protocol', 16));
          throw authorityError('held_read', 13);
        }
        return bytes;
      },
      verify: async requestSignal => {
        if (closed) throw authorityError('final_verify', 14);
        const challenge = randomBytes(16).toString('hex');
        const result = await exchangeHeld('verify', { barrier: challenge }, requestSignal);
        const verified = parseInspection(result, false, true) as WindowsHeldVerification | undefined;
        if (!verified || result.type !== 'verified' || result.id !== hold.id || result.challenge !== challenge
          || !exactKeys(result, RESPONSE_INSPECTION_KEYS) || !sameInitial(verified)) {
          activeSession.invalidate(authorityError('stdio_protocol', 16));
          throw authorityError('final_verify', 14);
        }
        return verified;
      },
      close: async requestSignal => {
        if (closed) return;
        closed = true;
        clearTimeout(heldTimeout);
        try {
          const result = await exchangeHeld('close', {}, requestSignal);
          const final = parseInspection(result, false, true) as WindowsHeldVerification | undefined;
          if (!final || result.type !== 'closed' || result.id !== hold.id || result.challenge !== ''
            || !exactKeys(result, RESPONSE_INSPECTION_KEYS) || !sameInitial(final)) {
            throw authorityError('final_verify', 14);
          }
          lastClosedHeldId = hold.id;
        } catch (error) {
          activeSession.invalidate(error instanceof Error ? error : authorityError('clean_shutdown', 15));
          throw error;
        } finally {
          lockedArtifactProcesses.delete(capability);
          release();
        }
      },
    };
    lockedArtifactProcesses.set(capability, {
      session: activeSession,
      exited: activeSession.exited,
      challenge: capabilityChallenge,
      heldId: hold.id,
      purpose: hold.purpose,
      release,
      timeout: heldTimeout,
    });
    activeSession.exited.then(() => {
      clearTimeout(heldTimeout);
      release();
    }).catch(() => {
      clearTimeout(heldTimeout);
      release();
    });
    return capability;
  } catch (error) {
    release();
    if (signal?.aborted && session) session.invalidate(abortError());
    if (retry && !acquisitionBarrierRan && retryableInfrastructureError(error)) {
      if (brokerSession) brokerSession.invalidate(error as Error);
      brokerSession = undefined;
      return openWindowsLockedArtifactAttempt(
        path,
        expectedBytes,
        expectedIdentity,
        expectedSha256,
        beforeOpenForTest,
        signal,
        false,
      );
    }
    throw error;
  }
};

export const openWindowsLockedArtifact = (
  path: string,
  expectedBytes: number,
  beforeOpenForTest?: () => Promise<void>,
  signal?: AbortSignal,
  expectedIdentity?: WindowsFileIdentity,
  expectedSha256?: string,
): Promise<WindowsLockedArtifact> => (async () => {
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0 || expectedBytes > BROKER_ARTIFACT_BYTES) {
    throw authorityError('request_protocol', 1);
  }
  if (expectedSha256 !== undefined && !/^[a-f0-9]{64}$/.test(expectedSha256)) throw authorityError('request_protocol', 1);
  const setup = expectedIdentity ?? (await inspectWindowsPrivatePath(path)).identity;
  return openWindowsLockedArtifactAttempt(path, expectedBytes, setup, expectedSha256, beforeOpenForTest, signal);
})();

/** Native-test-only live protocol injection against the persistent child. */
export const injectWindowsAuthorityProtocolFaultForTest = async (
  kind: 'partial-frame' | 'extra-frame' | 'wrong-purpose' | 'wrong-identity',
  path: string,
  expectedBytes: number,
): Promise<WindowsAuthorityReason | 'accepted'> => {
  const setup = await inspectWindowsPrivatePath(path);
  const release = await acquireLease();
  try {
    const session = await getBroker();
    const inspect = requestFrame('inspect', { purpose: 'setup', path, directory: false });
    if (kind === 'partial-frame') {
      const response = session.receive(BROKER_TIMEOUT_MS);
      const frame = encodeProtocolFrame(JSON.stringify(inspect));
      const split = Math.floor(frame.length / 2);
      await session.writeRawForTest([frame.subarray(0, split), frame.subarray(split)]);
      const value = await response;
      const parsed = parseInspection(value, false, false);
      if (!parsed || value.id !== inspect.id || value.type !== 'inspection') throw authorityError('stdio_protocol', 16);
      return 'accepted';
    }
    if (kind === 'extra-frame') {
      const response = session.receive(BROKER_TIMEOUT_MS);
      const extra = requestFrame('inspect', {
        purpose: 'setup',
        path,
        directory: false,
      });
      await session.writeRawForTest([Buffer.concat([
        encodeProtocolFrame(JSON.stringify(inspect)),
        encodeProtocolFrame(JSON.stringify(extra)),
      ])]);
      await response;
      await session.exited;
      return 'stdio_protocol';
    }
    const request = kind === 'wrong-purpose'
      ? requestFrame('inspect', { purpose: 'artifact', path, directory: false })
      : requestFrame('hold', {
        purpose: 'setup',
        path,
        expectedBytes,
        expectedVolumeSerial: setup.identity.volumeSerial === '0000000000000000'
          ? 'ffffffffffffffff'
          : '0000000000000000',
        expectedFileId128: setup.identity.fileId128,
        expectedSha256: null,
        challenge: randomBytes(16).toString('hex'),
      });
    try {
      await session.exchange(request);
      throw authorityError('stdio_protocol', 16);
    } catch (error) {
      if (error instanceof WindowsAuthorityError) return error.reason;
      throw error;
    }
  } finally { release(); }
};

/** Native-test-only held-session ID/purpose confusion injection. */
export const injectWindowsAuthorityHeldFaultForTest = async (
  held: WindowsLockedArtifact,
  kind: 'wrong-id' | 'wrong-purpose' | 'stale-id',
): Promise<WindowsAuthorityReason> => {
  const process = lockedArtifactProcesses.get(held);
  if (!process) throw authorityError('request_protocol', 1);
  const frame = requestFrame('read', {
    id: kind === 'wrong-id' ? randomBytes(16).toString('hex')
      : kind === 'stale-id' ? (lastClosedHeldId ?? randomBytes(16).toString('hex')) : process.heldId,
    purpose: kind === 'wrong-purpose' ? (process.purpose === 'setup' ? 'artifact' : 'setup') : process.purpose,
    challenge: process.challenge,
    offset: 0,
    length: 1,
  });
  try {
    await process.session.exchange(frame);
    throw authorityError('stdio_protocol', 16);
  } catch (error) {
    if (!(error instanceof WindowsAuthorityError)) throw error;
    process.session.invalidate(error);
    await process.exited;
    clearTimeout(process.timeout);
    process.release();
    lockedArtifactProcesses.delete(held);
    return error.reason;
  }
};

/** Native-test-only crash injection used to prove that OS termination releases the exact target handle. */
export const crashWindowsLockedArtifactForTest = async (held: WindowsLockedArtifact): Promise<void> => {
  const process = lockedArtifactProcesses.get(held);
  if (!process) throw authorityError('request_protocol', 1);
  clearTimeout(process.timeout);
  process.session.invalidate(authorityError('process_exit', 19));
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      process.exited,
      new Promise<void>((_resolve, reject) => {
        timer = setTimeout(() => reject(authorityError('process_exit', 19)), BROKER_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  process.release();
  lockedArtifactProcesses.delete(held);
};

export const windowsAuthorityBrokerStatsForTest = (): Readonly<{
  compileCount: number;
  requestCount: number;
  restartCount: number;
  activeProcessCount: number;
  queuedEntries: number;
}> => Object.freeze({
  compileCount,
  requestCount,
  restartCount,
  activeProcessCount,
  queuedEntries: brokerQueue.length,
});

/** Test-only framing probe; it shares the production incremental binary decoder. */
export const decodeWindowsAuthorityFramesForTest = (
  chunks: readonly Buffer[],
  expectedFrames = 1,
): readonly Readonly<Record<string, unknown>>[] => {
  let buffered: Buffer = Buffer.alloc(0);
  const frames: Record<string, unknown>[] = [];
  for (const chunk of chunks) {
    const decoded = decodeProtocolChunk(buffered, chunk);
    buffered = decoded.buffered;
    for (const frame of decoded.frames) {
      let value: unknown;
      try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(frame)); }
      catch { throw authorityError('stdio_protocol', 16); }
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw authorityError('stdio_protocol', 16);
      }
      frames.push(value as Record<string, unknown>);
    }
  }
  if (buffered.length !== 0 || frames.length !== expectedFrames) throw authorityError('stdio_protocol', 16);
  return frames;
};

export const encodeWindowsAuthorityFrameForTest = (value: string): Buffer => encodeProtocolFrame(value);

export const parseWindowsAuthorityStartupFailureForTest = (frame: unknown): Error =>
  parseFailure(frame) ?? authorityError('stdio_protocol', 16);

export const shutdownWindowsAuthorityBrokerForTest = async (): Promise<void> => {
  const session = brokerSession ?? await brokerStartup?.catch(() => undefined);
  brokerSession = undefined;
  if (session) await session.shutdown();
};

process.once('exit', () => {
  for (const child of brokerChildren) if (!child.killed) child.kill();
});

export const smokeWindowsUpdateAuthority = async (path: string): Promise<readonly string[]> => {
  const setup = await inspectWindowsPrivatePath(path);
  const exactBytes = Number(setup.size);
  if (!Number.isSafeInteger(exactBytes) || exactBytes <= 0) throw authorityError('type_link_size', 5);
  const held = await openWindowsLockedArtifact(path, exactBytes, undefined, undefined, setup.identity);
  try {
    if (!/^[a-f0-9]{16}$/.test(held.inspection.identity.volumeSerial)
      || !/^[a-f0-9]{32}$/.test(held.inspection.identity.fileId128)
      || !/^[a-f0-9]{64}$/.test(held.inspection.sha256)
      || !/^[a-f0-9]{40}$/.test(held.inspection.sha1)
      || held.inspection.daclProtected !== true
      || held.inspection.reparseTag !== '00000000') throw authorityError('ready_protocol', 12);
    await held.read(0, Math.min(1, Number(held.inspection.size)));
    const verified = await held.verify();
    if (verified.identity.fileId128 !== held.inspection.identity.fileId128
      || verified.sha256 !== held.inspection.sha256 || verified.sha1 !== held.inspection.sha1) {
      throw authorityError('final_verify', 14);
    }
  } finally {
    await held.close();
  }
  return Object.freeze([
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
};
