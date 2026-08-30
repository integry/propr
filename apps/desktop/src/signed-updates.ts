import { createHash, createPublicKey, randomBytes, verify, X509Certificate } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants as fsConstants, type BigIntStats } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  opendir,
  readFile,
  readdir,
  rename,
  rmdir,
  rm,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { parseWindowsSignerPins } from './release-config';
import {
  ensureWindowsPrivateDirectory,
  inspectWindowsPrivatePath,
  openWindowsLockedArtifact,
  protectWindowsPrivateDirectory,
  protectWindowsPrivateFile,
  type WindowsFileIdentity,
  type WindowsLockedArtifact,
} from './windows-update-authority';

export interface SignedUpdateBytes {
  url: string;
  size: number;
  sha256: string;
}

export interface SignedUpdateArtifact extends SignedUpdateBytes {
  fileName: string;
  kind: 'zip' | 'nupkg';
}

export interface SignedUpdateSigner {
  type: 'apple-team-id' | 'authenticode-subject';
  identity: string;
  designatedRequirement?: string;
  certificateSha256?: string;
  spkiSha256?: string;
}

export interface SignedUpdateFeed {
  target: string;
  version: string;
  feed: SignedUpdateBytes;
  artifact: SignedUpdateArtifact;
  signer: SignedUpdateSigner;
}

export interface SignedUpdateManifest {
  schemaVersion: 2;
  channel: 'stable';
  manifestUrl: string;
  version: string;
  tag: string;
  publishedAt: string;
  feeds: Record<string, SignedUpdateFeed>;
}

export interface SignedUpdateRuntimeConfig {
  manifestUrl: string;
  publicKey: string;
  signingIdentity: string;
  windowsSignerPins: readonly string[];
}

export type SignedUpdateRequest = (url: string, init: RequestInit) => Promise<Response>;

export const SIGNED_UPDATE_DOWNLOAD_LIMITS = {
  manifestBytes: 512 * 1024,
  signatureBytes: 1024,
  feedBytes: 1024 * 1024,
  // Desktop packages should remain far below this; the cap bounds disk use even for signed misconfiguration.
  artifactBytes: 1024 * 1024 * 1024,
  metadataTimeoutMs: 30_000,
  artifactTimeoutMs: 10 * 60_000,
  squirrelReleaseBytes: 64 * 1024,
} as const;

export const SIGNED_UPDATE_CACHE_POLICY = {
  expiryMs: 10 * 60_000,
  metadataBytes: 16 * 1024,
  entryName: 'verified-update',
  artifactName: 'artifact',
  metadataName: 'entry.json',
  lockName: '.cache-lock',
  lockOwnerName: 'owner.json',
  // The namespace contains one signed artifact and its small metadata record only.
  namespaceBytes: 1024 * 1024 * 1024 + 64 * 1024,
  maxRootEntries: 2,
  maxEntryEntries: 2,
  inspectionEntryCap: 64,
  inspectionNameBytes: 16 * 1024,
  inspectionDepth: 3,
  inspectionElapsedMs: 250,
  cleanupEntryCap: 64,
  cleanupByteCap: 128 * 1024 * 1024,
  quarantineSlots: 4,
  quarantineGlobalNames: 256,
  quarantineGlobalBytes: 4 * 1024 * 1024 * 1024,
  quarantineMaxAgeMs: 7 * 24 * 60 * 60_000,
  quarantineStateBytes: 4096,
} as const;

const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SHA1_PATTERN = /^[a-fA-F0-9]{40}$/;
const TARGET_PATTERN = /^(darwin|win32)-(x64|arm64)$/;
const SQUIRREL_FILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}\.nupkg$/;
const execFileAsync = promisify(execFile);
const cacheLocks = new Map<string, Promise<void>>();

export interface SquirrelReleaseEntry {
  sha1: string;
  fileName: string;
  size: number;
}

export interface VerifiedUpdateArtifact {
  feedBytes: Buffer;
  artifact: SignedUpdateArtifact;
  /** One-shot application of the still-held, exact verified byte capability. */
  apply(): Promise<void>;
}

export interface HeldUpdateArtifactSource {
  readonly artifact: SignedUpdateArtifact;
  readonly feedBytes: Buffer;
  read(offset: number, length: number): Promise<Buffer>;
}

interface ExpectedDownloadBytes {
  size: number;
  sha256: string;
}

interface BoundedDownloadOptions {
  request: SignedUpdateRequest;
  url: string;
  label: string;
  maxBytes: number;
  timeoutMs: number;
  expected?: ExpectedDownloadBytes;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const parseHttpsUrl = (
  value: unknown,
  label: string,
  { allowQuery = true }: { allowQuery?: boolean } = {},
): string => {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute HTTPS URL`);
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || (!allowQuery && url.search)) {
    throw new Error(`${label} must be an HTTPS URL without credentials, a fragment${allowQuery ? '' : ', or a query'}`);
  }
  return url.toString();
};

const parseBytes = (value: unknown, label: string): SignedUpdateBytes => {
  if (!isRecord(value)) throw new Error(`${label} is invalid`);
  if (!Number.isSafeInteger(value.size) || Number(value.size) <= 0) {
    throw new Error(`${label} size is invalid`);
  }
  if (typeof value.sha256 !== 'string' || !SHA256_PATTERN.test(value.sha256)) {
    throw new Error(`${label} SHA-256 is invalid`);
  }
  return {
    url: parseHttpsUrl(value.url, `${label} URL`),
    size: Number(value.size),
    sha256: value.sha256,
  };
};

const parseFeed = (value: unknown, target: string, version: string): SignedUpdateFeed => {
  const label = `Signed update manifest feed ${target}`;
  if (!isRecord(value) || value.target !== target || value.version !== version) {
    throw new Error(`${label} does not bind its exact target and version`);
  }
  const feed = parseBytes(value.feed, `${label} metadata`);
  const parsedArtifact = parseBytes(value.artifact, `${label} artifact`);
  if (feed.size > SIGNED_UPDATE_DOWNLOAD_LIMITS.feedBytes) {
    throw new Error(`${label} metadata exceeds the runtime download limit`);
  }
  if (parsedArtifact.size > SIGNED_UPDATE_DOWNLOAD_LIMITS.artifactBytes) {
    throw new Error(`${label} artifact exceeds the runtime download limit`);
  }
  if (!isRecord(value.artifact)
    || typeof value.artifact.fileName !== 'string'
    || basename(value.artifact.fileName) !== value.artifact.fileName
    || (value.artifact.kind !== 'zip' && value.artifact.kind !== 'nupkg')) {
    throw new Error(`${label} artifact descriptor is invalid`);
  }
  const expectedKind = target.startsWith('darwin-') ? 'zip' : 'nupkg';
  const [, arch] = target.split('-');
  const expectedFileName = target.startsWith('darwin-')
    ? `ProPR-Desktop-${version}-macos-${arch}-zip`
    : `ProPR-Desktop-${version}-windows-${arch}-full.nupkg`;
  if (value.artifact.kind !== expectedKind
    || value.artifact.fileName !== expectedFileName
    || basename(new URL(parsedArtifact.url).pathname) !== value.artifact.fileName) {
    throw new Error(`${label} artifact does not match its target or URL`);
  }
  const expectedSignerType = target.startsWith('darwin-') ? 'apple-team-id' : 'authenticode-subject';
  if (!isRecord(value.signer)
    || value.signer.type !== expectedSignerType
    || typeof value.signer.identity !== 'string'
    || !value.signer.identity.trim()) {
    throw new Error(`${label} native signer is invalid`);
  }
  if (expectedSignerType === 'apple-team-id'
    && (typeof value.signer.designatedRequirement !== 'string' || !value.signer.designatedRequirement.trim())) {
    throw new Error(`${label} macOS designated requirement is invalid`);
  }
  if (expectedSignerType === 'authenticode-subject'
    && (typeof value.signer.certificateSha256 !== 'string'
      || !SHA256_PATTERN.test(value.signer.certificateSha256)
      || typeof value.signer.spkiSha256 !== 'string'
      || !SHA256_PATTERN.test(value.signer.spkiSha256))) {
    throw new Error(`${label} Windows signer fingerprint evidence is invalid`);
  }
  return {
    target,
    version,
    feed,
    artifact: {
      ...parsedArtifact,
      fileName: value.artifact.fileName,
      kind: value.artifact.kind,
    },
    signer: {
      type: value.signer.type as SignedUpdateSigner['type'],
      identity: value.signer.identity,
      ...(expectedSignerType === 'apple-team-id'
        ? { designatedRequirement: value.signer.designatedRequirement as string }
        : {
            certificateSha256: value.signer.certificateSha256 as string,
            spkiSha256: value.signer.spkiSha256 as string,
          }),
    },
  };
};

export const parseSignedUpdateManifest = (payload: Buffer): SignedUpdateManifest => {
  let value: unknown;
  try {
    value = JSON.parse(payload.toString('utf8'));
  } catch {
    throw new Error('Signed update manifest is not valid JSON');
  }
  if (!isRecord(value) || value.schemaVersion !== 2 || value.channel !== 'stable') {
    throw new Error('Signed update manifest has an unsupported schema or channel');
  }
  if (typeof value.version !== 'string' || !VERSION_PATTERN.test(value.version)) {
    throw new Error('Signed update manifest version is not canonical stable semver');
  }
  const manifestUrl = parseHttpsUrl(
    value.manifestUrl,
    'Signed update manifest URL',
    { allowQuery: false },
  );
  if (value.tag !== `desktop-v${value.version}`) {
    throw new Error('Signed update manifest tag does not match its version');
  }
  if (typeof value.publishedAt !== 'string' || !Number.isFinite(Date.parse(value.publishedAt))) {
    throw new Error('Signed update manifest publishedAt is invalid');
  }
  if (!isRecord(value.feeds)) throw new Error('Signed update manifest feeds are missing');

  const feeds: Record<string, SignedUpdateFeed> = {};
  for (const [target, candidate] of Object.entries(value.feeds)) {
    if (!TARGET_PATTERN.test(target)) throw new Error(`Signed update manifest feed ${target} is invalid`);
    feeds[target] = parseFeed(candidate, target, value.version);
  }
  return { ...value, manifestUrl, feeds } as unknown as SignedUpdateManifest;
};

export const verifySignedUpdateManifest = (
  payload: Buffer,
  signatureBase64: string,
  publicKeyBase64: string,
): SignedUpdateManifest => {
  let publicKey;
  try {
    publicKey = createPublicKey({
      key: Buffer.from(publicKeyBase64, 'base64'),
      format: 'der',
      type: 'spki',
    });
  } catch {
    throw new Error('Embedded update verification key is invalid');
  }
  if (publicKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('Embedded update verification key is not Ed25519');
  }
  const signature = Buffer.from(signatureBase64.trim(), 'base64');
  if (signature.length !== 64 || !verify(null, payload, publicKey, signature)) {
    throw new Error('Signed update manifest signature verification failed');
  }
  return parseSignedUpdateManifest(payload);
};

const compareVersions = (left: string, right: string): number => {
  const leftParts = left.split('.').map(Number);
  const rightParts = right.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  }
  return 0;
};

const verifyBytes = (bytes: Buffer, expected: SignedUpdateBytes, label: string): void => {
  if (bytes.length !== expected.size) throw new Error(`${label} size does not match the signed manifest`);
  const actualHash = createHash('sha256').update(bytes).digest('hex');
  if (actualHash !== expected.sha256) throw new Error(`${label} SHA-256 does not match the signed manifest`);
};

const responseContentLength = (response: Response, label: string): number | undefined => {
  const header = response.headers.get('content-length');
  if (header === null) return undefined;
  if (!/^(0|[1-9]\d*)$/.test(header)) throw new Error(`${label} has an invalid Content-Length header`);
  const length = Number(header);
  if (!Number.isSafeInteger(length)) throw new Error(`${label} has an invalid Content-Length header`);
  return length;
};

const validateDownloadResponse = (
  requestedUrl: string,
  response: Response,
  label: string,
  maxBytes: number,
  expected?: ExpectedDownloadBytes,
): void => {
  const requested = new URL(requestedUrl);
  let finalUrl: URL;
  try {
    finalUrl = new URL(response.url);
  } catch {
    throw new Error(`${label} response has no valid final URL`);
  }
  if (finalUrl.protocol !== 'https:' || finalUrl.username || finalUrl.password || finalUrl.origin !== requested.origin) {
    throw new Error(`${label} response redirected outside its signed HTTPS origin`);
  }

  const contentLength = responseContentLength(response, label);
  if (contentLength !== undefined && contentLength > maxBytes) {
    throw new Error(`${label} Content-Length exceeds the runtime download limit`);
  }
  if (contentLength !== undefined && expected && contentLength !== expected.size) {
    throw new Error(`${label} Content-Length does not match the signed size`);
  }
  if (!response.ok) throw new Error(`${label} request failed with HTTP ${response.status}`);
};

const withBoundedResponse = async <T>(
  options: BoundedDownloadOptions,
  consume: (response: Response, signal: AbortSignal) => Promise<T>,
): Promise<T> => {
  const { request, url, label, maxBytes, timeoutMs, expected } = options;
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  let response: Response | undefined;
  try {
    response = await request(url, {
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'follow',
      signal: controller.signal,
    });
    validateDownloadResponse(url, response, label, maxBytes, expected);
    return await consume(response, controller.signal);
  } catch (error) {
    controller.abort();
    if (response?.body && !response.body.locked) await response.body.cancel().catch(() => undefined);
    if (timedOut) throw new Error(`${label} request timed out and was aborted`);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
};

const consumeResponse = async (
  response: Response,
  signal: AbortSignal,
  { label, maxBytes, expected }: Pick<BoundedDownloadOptions, 'label' | 'maxBytes' | 'expected'>,
  consumeChunk: (chunk: Uint8Array) => Promise<void> | void,
): Promise<void> => {
  if (!response.body) {
    if (expected?.size) throw new Error(`${label} size does not match the signed size`);
    return;
  }

  const reader = response.body.getReader();
  const hash = expected ? createHash('sha256') : undefined;
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (signal.aborted) throw signal.reason;
      if (!value?.byteLength) continue;
      received += value.byteLength;
      if (received > maxBytes || (expected && received > expected.size)) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`${label} received bytes exceed the runtime download limit`);
      }
      hash?.update(value);
      await consumeChunk(value);
    }
  } finally {
    reader.releaseLock();
  }

  if (expected && received !== expected.size) throw new Error(`${label} size does not match the signed size`);
  if (expected && hash?.digest('hex') !== expected.sha256) {
    throw new Error(`${label} SHA-256 does not match the signed manifest`);
  }
};

export const fetchBoundedUpdateBytes = async (options: BoundedDownloadOptions): Promise<Buffer> => {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0) {
    throw new Error(`${options.label} runtime download limit is invalid`);
  }
  if (options.expected && options.expected.size > options.maxBytes) {
    throw new Error(`${options.label} signed size exceeds the runtime download limit`);
  }

  return withBoundedResponse(options, async (response, signal) => {
    const bytes = Buffer.alloc(options.expected?.size ?? options.maxBytes);
    let offset = 0;
    await consumeResponse(response, signal, options, chunk => {
      Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).copy(bytes, offset);
      offset += chunk.byteLength;
    });
    return bytes.subarray(0, offset);
  });
};

export const downloadBoundedUpdateFile = async (
  options: BoundedDownloadOptions & { destinationPath: string; expected: ExpectedDownloadBytes },
): Promise<void> => {
  if (options.expected.size > options.maxBytes) {
    throw new Error(`${options.label} signed size exceeds the runtime download limit`);
  }

  let file;
  try {
    file = await open(
      options.destinationPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600,
    );
    // On Windows the protected DACL must exist before any response bytes are written.
    await file.close();
    file = undefined;
    await protectPrivateFile(options.destinationPath);
    file = await open(options.destinationPath, fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW);
    await withBoundedResponse(options, async (response, signal) => {
      await consumeResponse(response, signal, options, async chunk => {
        const bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        let offset = 0;
        while (offset < bytes.length) {
          const { bytesWritten } = await file!.write(bytes, offset, bytes.length - offset);
          offset += bytesWritten;
        }
      });
    });
    await file.sync();
    await file.close();
    file = undefined;
  } catch (error) {
    await file?.close().catch(() => undefined);
    await rm(options.destinationPath, { force: true });
    throw error;
  }
};

export const parseSquirrelReleaseEntry = (
  feedBytes: Buffer,
  version: string,
  artifact: SignedUpdateArtifact,
): SquirrelReleaseEntry => {
  const fail = (): never => { throw new Error('Signed Windows update feed is invalid'); };
  const canonicalFileNames = new Set([
    `ProPR-Desktop-${version}-windows-x64-full.nupkg`,
    `ProPR-Desktop-${version}-windows-arm64-full.nupkg`,
  ]);
  if (!VERSION_PATTERN.test(version)
    || artifact.kind !== 'nupkg'
    || !canonicalFileNames.has(artifact.fileName)
    || feedBytes.length === 0
    || feedBytes.length > SIGNED_UPDATE_DOWNLOAD_LIMITS.squirrelReleaseBytes) fail();

  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(feedBytes); } catch { return fail(); }
  if (text.includes('\0') || text.includes('\r') && !text.includes('\r\n')) fail();
  const normalized = text.endsWith('\r\n')
    ? text.slice(0, -2)
    : text.endsWith('\n') ? text.slice(0, -1) : text;
  if (!normalized || normalized.includes('\r') && !normalized.split('\r\n').every(Boolean)) fail();
  const lines = normalized.split(text.includes('\r\n') ? '\r\n' : '\n');
  if (lines.length > 128 || lines.some(line => !line || line.length > 512)) fail();

  const seen = new Set<string>();
  const selected: SquirrelReleaseEntry[] = [];
  for (const line of lines) {
    const tokens = line.split(' ');
    if (tokens.length !== 3 || tokens.some(token => !token)) fail();
    const [sha1, fileName, sizeText] = tokens;
    if (!SHA1_PATTERN.test(sha1)
      || !SQUIRREL_FILE_NAME_PATTERN.test(fileName)
      || basename(fileName) !== fileName
      || fileName.includes('/')
      || fileName.includes('\\')
      || !/^[1-9]\d*$/.test(sizeText)) fail();
    const size = Number(sizeText);
    if (!Number.isSafeInteger(size) || size > SIGNED_UPDATE_DOWNLOAD_LIMITS.artifactBytes) fail();
    const foldedName = fileName.toLowerCase();
    if (seen.has(foldedName)) fail();
    seen.add(foldedName);
    if (fileName === artifact.fileName) selected.push({ sha1: sha1.toLowerCase(), fileName, size });
  }
  if (selected.length !== 1 || selected[0].size !== artifact.size) fail();
  return selected[0];
};

const verifyFeedReferencesArtifact = (
  target: string,
  version: string,
  feedBytes: Buffer,
  artifact: SignedUpdateArtifact,
): SquirrelReleaseEntry | undefined => {
  if (target.startsWith('darwin-')) {
    let feed: unknown;
    try {
      feed = JSON.parse(feedBytes.toString('utf8'));
    } catch {
      throw new Error('Signed macOS update feed is not valid JSON');
    }
    if (!isRecord(feed) || feed.url !== artifact.url || feed.name !== version) {
      throw new Error('Signed macOS update feed does not reference the bound version and artifact URL');
    }
    return undefined;
  }
  return parseSquirrelReleaseEntry(feedBytes, version, artifact);
};

export const validateMacOSUpdateApplicationLayout = async (extracted: string): Promise<string> => {
  const application = join(extracted, 'propr-desktop.app');
  let applicationStats;
  try {
    applicationStats = await lstat(application);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('macOS update ZIP is missing the canonical propr-desktop.app bundle');
    }
    throw error;
  }
  if (!applicationStats.isDirectory() || applicationStats.isSymbolicLink()) {
    throw new Error('macOS update ZIP canonical propr-desktop.app bundle must be a real directory');
  }

  const topLevel = await readdir(extracted);
  if (topLevel.length !== 1 || topLevel[0] !== 'propr-desktop.app') {
    throw new Error('macOS update ZIP has an ambiguous application layout');
  }
  return application;
};

export const verifyNativeUpdateSigner = async (
  packagePath: string,
  artifact: SignedUpdateArtifact,
  expected: SignedUpdateSigner,
): Promise<SignedUpdateSigner> => {
  const directory = await mkdtemp(join(tmpdir(), 'propr-update-check-'));
  try {
    const extracted = join(directory, 'extracted');
    if (expected.type === 'apple-team-id') {
      await execFileAsync('/usr/bin/ditto', ['-x', '-k', packagePath, extracted]);
      const application = await validateMacOSUpdateApplicationLayout(extracted);
      await execFileAsync('/usr/bin/codesign', ['--verify', '--deep', '--strict', application]);
      await execFileAsync('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=4', application]);
      const details = await execFileAsync('/usr/bin/codesign', ['-d', '--verbose=4', application]);
      const output = `${details.stdout}\n${details.stderr}`;
      const identity = /^TeamIdentifier=(.+)$/m.exec(output)?.[1]?.trim();
      if (!identity) throw new Error('macOS update has no designated Team ID');
      const requirement = await execFileAsync('/usr/bin/codesign', ['-d', '-r-', application]);
      const designatedRequirement = `${requirement.stdout}\n${requirement.stderr}`
        .split(/\r?\n/)
        .map(line => line.trim())
        .find(line => line.startsWith('designated =>'));
      if (!designatedRequirement) throw new Error('macOS update has no designated requirement');
      return { type: 'apple-team-id', identity, designatedRequirement };
    }

    const script = [
      '$ErrorActionPreference = "Stop"',
      `$package = ${JSON.stringify(packagePath)}`,
      `$extract = ${JSON.stringify(extracted)}`,
      '$zip = "$package.zip"',
      'Copy-Item -LiteralPath $package -Destination $zip',
      'Expand-Archive -LiteralPath $zip -DestinationPath $extract',
      "$executable = Get-Item -LiteralPath (Join-Path $extract 'lib/net45/propr-desktop.exe')",
      "if (!$executable -or $executable.PSIsContainer) { throw 'Windows update package canonical application is missing' }",
      '$signature = Get-AuthenticodeSignature -LiteralPath $executable.FullName',
      "if ($signature.Status -ne 'Valid' -or !$signature.SignerCertificate -or !$signature.TimeStamperCertificate) { throw 'Windows update Authenticode chain or timestamp status is invalid' }",
      '$certificateBase64 = [Convert]::ToBase64String($signature.SignerCertificate.RawData)',
      '@{ identity = $signature.SignerCertificate.Subject; certificateBase64 = $certificateBase64 } | ConvertTo-Json -Compress',
    ].join('; ');
    const { stdout } = await execFileAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script]);
    let evidence: { identity?: string; certificateBase64?: string };
    try { evidence = JSON.parse(stdout.trim()); } catch { throw new Error('Windows update signer evidence is invalid'); }
    if (!evidence.identity || !evidence.certificateBase64) {
      throw new Error('Windows update has incomplete Authenticode signer evidence');
    }
    let certificate: X509Certificate;
    try { certificate = new X509Certificate(Buffer.from(evidence.certificateBase64, 'base64')); } catch {
      throw new Error('Windows update signer certificate evidence is invalid');
    }
    return {
      type: 'authenticode-subject',
      identity: evidence.identity,
      certificateSha256: certificate.fingerprint256.replaceAll(':', '').toLowerCase(),
      spkiSha256: createHash('sha256').update(certificate.publicKey.export({ format: 'der', type: 'spki' })).digest('hex'),
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

interface UpdateCacheKey {
  origin: string;
  channel: 'stable';
  version: string;
  manifestSha256: string;
  artifactSha256: string;
  target: string;
  artifactSize: number;
  artifactFileName: string;
}

interface UpdateCacheMetadata {
  schemaVersion: 1;
  createdAt: number;
  expiresAt: number;
  key: UpdateCacheKey;
}

interface SignedUpdateOperationOptions {
  config: SignedUpdateRuntimeConfig;
  currentVersion: string;
  platform: NodeJS.Platform;
  arch: string;
  request: SignedUpdateRequest;
  cacheDirectory?: string;
  now?: () => number;
  verifyNativeSigner?: (
    packagePath: string,
    artifact: SignedUpdateArtifact,
    signer: SignedUpdateSigner,
  ) => Promise<SignedUpdateSigner>;
  /** Platform adapter that consumes only held bytes; mutable path adapters are intentionally unsupported. */
  applyHeldArtifact?: (source: HeldUpdateArtifactSource) => Promise<void>;
  /** Native-test-only deterministic barrier immediately before the broker's CreateFileW. */
  beforeWindowsArtifactOpenForTest?: (packagePath: string) => Promise<void>;
  /** Native-test-only restoration point after a mismatched handle has been closed but before rejection. */
  afterWindowsArtifactMismatchForTest?: (
    packagePath: string,
    acquired: Readonly<{ identity: WindowsFileIdentity; size: string; sha256: string }>,
  ) => Promise<void>;
}

interface PreparedSignedUpdate {
  manifest: SignedUpdateManifest;
  manifestDigest: string;
  target: string;
  feed: SignedUpdateFeed;
  feedBytes: Buffer;
  squirrelEntry?: SquirrelReleaseEntry;
}

const acquireFilesystemCacheLock = async (cacheDirectory: string): Promise<() => Promise<void>> => {
  await collectQuarantines(cacheDirectory);
  if (process.platform !== 'win32') await mkdir(cacheDirectory, { recursive: true, mode: 0o700 });
  await ensurePrivateDirectory(cacheDirectory);
  await preflightCacheNamespace(cacheDirectory);
  const lockPath = join(cacheDirectory, SIGNED_UPDATE_CACHE_POLICY.lockName);
  const ownerPath = join(lockPath, SIGNED_UPDATE_CACHE_POLICY.lockOwnerName);
  const deadline = Date.now() + SIGNED_UPDATE_DOWNLOAD_LIMITS.artifactTimeoutMs + 30_000;
  while (true) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      if (process.platform === 'win32') await protectWindowsPrivateDirectory(lockPath);
      else {
        await chmod(lockPath, 0o700);
        await inspectPrivatePath(lockPath, true);
      }
      let owner = await open(
        ownerPath,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
        0o600,
      );
      await owner.close();
      await protectPrivateFile(ownerPath);
      owner = await open(ownerPath, fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW);
      await owner.writeFile(`${JSON.stringify({ schemaVersion: 1, pid: process.pid })}\n`);
      await owner.sync();
      await owner.close();
      const windowsLock = process.platform === 'win32' ? await openWindowsLockedArtifact(ownerPath) : undefined;
      return async () => {
        await windowsLock?.close();
        await removeCachePath(lockPath);
        await syncDirectory(cacheDirectory);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let active = false;
      try {
        const heldOwner = await openPrivateRegularFile(ownerPath, 1024);
        let bytes: Buffer;
        try {
          const size = heldOwner.windowsLock
            ? BigInt(heldOwner.windowsLock.inspection.size)
            : (await heldOwner.handle!.stat({ bigint: true })).size;
          if (size <= 0n || size > 1024n) throw new Error('Verified update cache lock is unavailable');
          bytes = await readHeldFile(heldOwner, 0, Number(size));
        } finally {
          try { await heldOwner.windowsLock?.close(); } finally { await heldOwner.handle?.close(); }
        }
        const value: unknown = JSON.parse(bytes.toString('utf8'));
        if (isRecord(value) && value.schemaVersion === 1 && Number.isSafeInteger(value.pid) && Number(value.pid) > 0) {
          try { process.kill(Number(value.pid), 0); active = true; } catch { active = false; }
        }
      } catch { active = false; }
      if (!active) {
        const stalePath = join(cacheDirectory, `.stale-lock-${randomBytes(8).toString('hex')}`);
        let removed = false;
        try {
          await rename(lockPath, stalePath);
          await removeCachePath(stalePath);
          removed = true;
        } catch { /* A live owner may have won the inspection race; retry without trusting it. */ }
        if (!removed) {
          if (Date.now() >= deadline) throw new Error('Verified update cache lock is unavailable');
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        continue;
      }
      if (Date.now() >= deadline) throw new Error('Verified update cache lock is unavailable');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
};

const withCacheLock = async <T>(
  cacheDirectory: string,
  operation: (cacheLockHeld: boolean) => Promise<T>,
): Promise<T> => {
  const previous = cacheLocks.get(cacheDirectory) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  const queued = previous.then(() => current);
  cacheLocks.set(cacheDirectory, queued);
  await previous;
  let releaseFilesystemLock: (() => Promise<void>) | undefined;
  try {
    try { releaseFilesystemLock = await acquireFilesystemCacheLock(cacheDirectory); } catch { /* cache use will fail closed */ }
    return await operation(releaseFilesystemLock !== undefined);
  } finally {
    try { await releaseFilesystemLock?.(); } finally {
      release();
      if (cacheLocks.get(cacheDirectory) === queued) cacheLocks.delete(cacheDirectory);
    }
  }
};

interface PosixFileIdentity {
  platform: 'posix';
  device: string;
  inode: string;
}

type ExactFileIdentity = PosixFileIdentity | WindowsFileIdentity;

export const canonicalPosixFileIdentity = (device: bigint, inode: bigint): PosixFileIdentity => ({
  platform: 'posix',
  device: device.toString(10),
  inode: inode.toString(10),
});

export const sameExactFileIdentity = (left: ExactFileIdentity, right: ExactFileIdentity): boolean =>
  left.platform === right.platform && (left.platform === 'win32'
    ? left.volumeSerial === (right as WindowsFileIdentity).volumeSerial
      && left.fileId128 === (right as WindowsFileIdentity).fileId128
    : left.device === (right as PosixFileIdentity).device
      && left.inode === (right as PosixFileIdentity).inode);

export const posixAuthorityIsPrivate = (owner: bigint, mode: bigint, currentUid?: bigint): boolean =>
  currentUid !== undefined && owner === currentUid && (mode & 0o077n) === 0n;

const isOwnedPrivate = (stats: BigIntStats, directory = false): boolean => {
  const expectedType = directory ? stats.isDirectory() : stats.isFile();
  const currentUid = typeof process.getuid === 'function' ? BigInt(process.getuid()) : undefined;
  return expectedType && !stats.isSymbolicLink() && posixAuthorityIsPrivate(stats.uid, stats.mode, currentUid);
};

const inspectPrivatePath = async (
  path: string,
  directory = false,
): Promise<{ identity: ExactFileIdentity; size: bigint; links: bigint }> => {
  if (process.platform === 'win32') {
    const inspected = await inspectWindowsPrivatePath(path, directory);
    return { identity: inspected.identity, size: BigInt(inspected.size), links: BigInt(inspected.links) };
  }
  const stats = await lstat(path, { bigint: true });
  if (!isOwnedPrivate(stats, directory) || (!directory && stats.nlink !== 1n)) {
    throw new Error('Verified update cache authority inspection failed');
  }
  return {
    identity: canonicalPosixFileIdentity(stats.dev, stats.ino),
    size: stats.size,
    links: stats.nlink,
  };
};

const ensurePrivateDirectory = async (path: string): Promise<void> => {
  if (process.platform === 'win32') {
    await ensureWindowsPrivateDirectory(path);
    return;
  }
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  await chmod(path, 0o700);
  await inspectPrivatePath(path, true);
};

const protectPrivateFile = async (path: string): Promise<void> => {
  if (process.platform === 'win32') {
    await protectWindowsPrivateFile(path);
    return;
  }
  await chmod(path, 0o600);
  await inspectPrivatePath(path);
};

const syncDirectory = async (path: string): Promise<void> => {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform !== 'win32' || !['EINVAL', 'ENOTSUP', 'EPERM', 'EISDIR'].includes(code ?? '')) throw error;
  } finally {
    await handle?.close();
  }
};

interface NamespaceBudget {
  entries: number;
  nameBytes: number;
  bytes: number;
  readonly startedAt: number;
  readonly entryCap: number;
  readonly byteCap: number;
}

const newNamespaceBudget = (
  entryCap = SIGNED_UPDATE_CACHE_POLICY.inspectionEntryCap,
  byteCap = Number.MAX_SAFE_INTEGER,
): NamespaceBudget => ({
  entries: 0,
  nameBytes: 0,
  bytes: 0,
  startedAt: Date.now(),
  entryCap,
  byteCap,
});

const assertNamespaceBudget = (budget: NamespaceBudget, name?: string): void => {
  if (Date.now() - budget.startedAt > SIGNED_UPDATE_CACHE_POLICY.inspectionElapsedMs
    || budget.entries >= budget.entryCap) throw new Error('Verified update cache namespace inspection limit exceeded');
  if (name !== undefined) {
    const bytes = Buffer.byteLength(name);
    if (bytes <= 0 || bytes > SIGNED_UPDATE_CACHE_POLICY.inspectionNameBytes
      || budget.nameBytes + bytes > SIGNED_UPDATE_CACHE_POLICY.inspectionNameBytes) {
      throw new Error('Verified update cache namespace inspection limit exceeded');
    }
    budget.entries += 1;
    budget.nameBytes += bytes;
  }
};

const boundedDirectoryNames = async (path: string, budget = newNamespaceBudget()): Promise<string[]> => {
  const directory = await opendir(path);
  const names: string[] = [];
  try {
    while (true) {
      assertNamespaceBudget(budget);
      const entry = await directory.read();
      if (!entry) break;
      assertNamespaceBudget(budget, entry.name);
      names.push(entry.name);
    }
  } finally {
    try { await directory.close(); } catch { /* async iteration may already have closed it */ }
  }
  return names;
};

const boundedRemoveCachePath = async (
  path: string,
  budget = newNamespaceBudget(SIGNED_UPDATE_CACHE_POLICY.cleanupEntryCap),
  depth = 0,
): Promise<boolean> => {
  if (depth > SIGNED_UPDATE_CACHE_POLICY.inspectionDepth) return false;
  let stats;
  try { stats = await lstat(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    assertNamespaceBudget(budget);
    if (budget.bytes > 0 && budget.bytes + stats.size > budget.byteCap) return false;
    budget.entries += 1;
    budget.bytes += stats.size;
    await unlink(path);
    return true;
  }
  const directory = await opendir(path);
  let complete = true;
  try {
    while (true) {
      try { assertNamespaceBudget(budget); } catch { complete = false; break; }
      const entry = await directory.read();
      if (!entry) break;
      try { assertNamespaceBudget(budget, entry.name); } catch { complete = false; break; }
      if (depth === SIGNED_UPDATE_CACHE_POLICY.inspectionDepth
        || !await boundedRemoveCachePath(join(path, entry.name), budget, depth + 1)) {
        complete = false;
        break;
      }
    }
  } finally {
    try { await directory.close(); } catch { /* already closed */ }
  }
  if (!complete) return false;
  try { await rmdir(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
  }
  return true;
};

const removeCachePath = async (path: string): Promise<void> => {
  if (!await boundedRemoveCachePath(path)) {
    throw new Error('Verified update cache bounded cleanup limit exceeded');
  }
};

interface QuarantineRecord {
  slot: number;
  createdAt: number;
  names: number;
  bytes: number;
  saturated: boolean;
}

interface QuarantineState {
  schemaVersion: 1;
  cursor: number;
  records: QuarantineRecord[];
}

const quarantineRootFor = (cacheDirectory: string): string =>
  join(dirname(cacheDirectory), `.${basename(cacheDirectory)}.quarantine`);

const quarantineSlotPath = (root: string, slot: number): string => join(root, `slot-${slot}`);

const ensureQuarantineRoot = async (cacheDirectory: string): Promise<string> => {
  const root = quarantineRootFor(cacheDirectory);
  if (process.platform !== 'win32') {
    try { await mkdir(root, { mode: 0o700 }); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  } else await ensureWindowsPrivateDirectory(root);
  await inspectPrivatePath(root, true);
  return root;
};

const validQuarantineRecord = (value: unknown): value is QuarantineRecord => isRecord(value)
  && Number.isInteger(value.slot) && Number(value.slot) >= 0
  && Number(value.slot) < SIGNED_UPDATE_CACHE_POLICY.quarantineSlots
  && Number.isSafeInteger(value.createdAt) && Number(value.createdAt) >= 0
  && Number.isSafeInteger(value.names) && Number(value.names) >= 0
  && Number.isSafeInteger(value.bytes) && Number(value.bytes) >= 0
  && typeof value.saturated === 'boolean'
  && Object.keys(value).length === 5;

const readQuarantineState = async (root: string): Promise<QuarantineState> => {
  const statePath = join(root, 'collector.json');
  let value: unknown = { schemaVersion: 1, cursor: 0, records: [] };
  try {
    const inspected = await inspectPrivatePath(statePath);
    if (inspected.size <= 0n || inspected.size > BigInt(SIGNED_UPDATE_CACHE_POLICY.quarantineStateBytes)) throw new Error('invalid');
    value = JSON.parse(await readFile(statePath, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      // A missing state record is recoverable from the fixed slot namespace;
      // malformed or broad metadata is never trusted.
      try { await lstat(statePath); } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === 'ENOENT') return value as QuarantineState;
      }
      throw new Error('Verified update quarantine metadata is invalid');
    }
  }
  if (!isRecord(value) || value.schemaVersion !== 1
    || !Number.isInteger(value.cursor) || Number(value.cursor) < 0
    || Number(value.cursor) >= SIGNED_UPDATE_CACHE_POLICY.quarantineSlots
    || !Array.isArray(value.records) || value.records.length > SIGNED_UPDATE_CACHE_POLICY.quarantineSlots
    || !value.records.every(validQuarantineRecord)
    || new Set(value.records.map(record => record.slot)).size !== value.records.length
    || Object.keys(value).length !== 3) {
    throw new Error('Verified update quarantine metadata is invalid');
  }
  return value as unknown as QuarantineState;
};

const writeQuarantineState = async (root: string, state: QuarantineState): Promise<void> => {
  const statePath = join(root, 'collector.json');
  const temporary = join(root, 'collector.next');
  const bytes = Buffer.from(`${JSON.stringify(state)}\n`);
  if (bytes.length > SIGNED_UPDATE_CACHE_POLICY.quarantineStateBytes) {
    throw new Error('Verified update quarantine metadata is invalid');
  }
  await rm(temporary, { force: true });
  let handle = await open(
    temporary,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
    0o600,
  );
  await handle.close();
  await protectPrivateFile(temporary);
  handle = await open(temporary, fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, statePath);
  await syncDirectory(root);
};

const collectQuarantines = async (cacheDirectory: string): Promise<{ root: string; state: QuarantineState }> => {
  const root = await ensureQuarantineRoot(cacheDirectory);
  const state = await readQuarantineState(root);
  const records = new Map(state.records.map(record => [record.slot, record]));
  // Fixed slots avoid an attacker-controlled parent-directory walk. Missing
  // metadata is reconstructed conservatively and marks the backlog saturated.
  for (let slot = 0; slot < SIGNED_UPDATE_CACHE_POLICY.quarantineSlots; slot += 1) {
    try {
      await lstat(quarantineSlotPath(root, slot));
      if (!records.has(slot)) records.set(slot, { slot, createdAt: 0, names: 0, bytes: 0, saturated: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      records.delete(slot);
    }
  }
  const budget = newNamespaceBudget(
    SIGNED_UPDATE_CACHE_POLICY.cleanupEntryCap,
    SIGNED_UPDATE_CACHE_POLICY.cleanupByteCap,
  );
  for (let count = 0; count < SIGNED_UPDATE_CACHE_POLICY.quarantineSlots; count += 1) {
    const slot = (state.cursor + count) % SIGNED_UPDATE_CACHE_POLICY.quarantineSlots;
    const record = records.get(slot);
    if (!record) continue;
    const entriesBefore = budget.entries;
    const bytesBefore = budget.bytes;
    let complete = false;
    try { complete = await boundedRemoveCachePath(quarantineSlotPath(root, slot), budget); } catch { complete = false; }
    record.names += budget.entries - entriesBefore;
    record.bytes += budget.bytes - bytesBefore;
    record.saturated = !complete;
    if (complete) records.delete(slot);
    state.cursor = (slot + 1) % SIGNED_UPDATE_CACHE_POLICY.quarantineSlots;
    if (!complete) break;
  }
  state.records = [...records.values()].sort((left, right) => left.slot - right.slot);
  await writeQuarantineState(root, state);
  return { root, state };
};

const quarantineCacheNamespace = async (cacheDirectory: string): Promise<void> => {
  const { root, state } = await collectQuarantines(cacheDirectory);
  const now = Date.now();
  const globalNames = state.records.reduce((total, record) => total + record.names, 0);
  const globalBytes = state.records.reduce((total, record) => total + record.bytes, 0);
  if (state.records.some(record => record.saturated || now - record.createdAt > SIGNED_UPDATE_CACHE_POLICY.quarantineMaxAgeMs)
    || state.records.length >= SIGNED_UPDATE_CACHE_POLICY.quarantineSlots
    || globalNames >= SIGNED_UPDATE_CACHE_POLICY.quarantineGlobalNames
    || globalBytes >= SIGNED_UPDATE_CACHE_POLICY.quarantineGlobalBytes) {
    throw new Error('Verified update quarantine backlog exceeds the global bound');
  }
  const occupied = new Set(state.records.map(record => record.slot));
  const slot = Array.from({ length: SIGNED_UPDATE_CACHE_POLICY.quarantineSlots }, (_, index) => index)
    .find(candidate => !occupied.has(candidate));
  if (slot === undefined) throw new Error('Verified update quarantine backlog exceeds the global bound');
  const quarantine = quarantineSlotPath(root, slot);
  try {
    await rename(cacheDirectory, quarantine);
  } catch {
    throw new Error('Verified update cache namespace could not be quarantined');
  }
  try {
    await ensurePrivateDirectory(cacheDirectory);
  } catch (error) {
    try { await rename(quarantine, cacheDirectory); } catch { /* preserve quarantine if a concurrent creator won */ }
    throw error;
  }
  state.records.push({ slot, createdAt: now, names: 0, bytes: 0, saturated: false });
  state.records.sort((left, right) => left.slot - right.slot);
  await writeQuarantineState(root, state);
  // One bounded pass makes small quarantines disappear immediately. Oversized
  // trees resume from their mutated filesystem cursor on later launches.
  await collectQuarantines(cacheDirectory);
};

/** Native-test-only bounded collector probe; returns fixed non-secret progress metadata. */
export const collectUpdateCacheQuarantinesForTest = async (cacheDirectory: string): Promise<Readonly<QuarantineState>> => {
  const { state } = await collectQuarantines(cacheDirectory);
  return Object.freeze({
    schemaVersion: 1,
    cursor: state.cursor,
    records: state.records.map(record => Object.freeze({ ...record })),
  });
};

/** Native-test-only invalid-namespace transition into the fixed quarantine slots. */
export const quarantineUpdateCacheNamespaceForTest = quarantineCacheNamespace;

const preflightCacheNamespace = async (cacheDirectory: string): Promise<void> => {
  const budget = newNamespaceBudget();
  let invalid = false;
  try {
    const names = await boundedDirectoryNames(cacheDirectory, budget);
    const folded = new Set<string>();
    if (names.length > SIGNED_UPDATE_CACHE_POLICY.maxRootEntries) invalid = true;
    for (const name of names) {
      const canonical = name.toLocaleLowerCase('en-US');
      if (folded.has(canonical)) invalid = true;
      folded.add(canonical);
      if (name !== SIGNED_UPDATE_CACHE_POLICY.entryName && name !== SIGNED_UPDATE_CACHE_POLICY.lockName) {
        invalid = true;
        break;
      }
      const child = join(cacheDirectory, name);
      await inspectPrivatePath(child, true);
      const childNames = await boundedDirectoryNames(child, budget);
      const expected: Set<string> = name === SIGNED_UPDATE_CACHE_POLICY.entryName
        ? new Set([SIGNED_UPDATE_CACHE_POLICY.artifactName, SIGNED_UPDATE_CACHE_POLICY.metadataName])
        : new Set([SIGNED_UPDATE_CACHE_POLICY.lockOwnerName]);
      if (childNames.length !== expected.size) invalid = true;
      let childBytes = 0n;
      for (const childName of childNames) {
        if (!expected.delete(childName)) invalid = true;
        const inspected = await inspectPrivatePath(join(child, childName));
        childBytes += inspected.size;
      }
      if (name === SIGNED_UPDATE_CACHE_POLICY.lockName && (childBytes <= 0n || childBytes > 1024n)) invalid = true;
      if (name === SIGNED_UPDATE_CACHE_POLICY.entryName
        && childBytes > BigInt(SIGNED_UPDATE_CACHE_POLICY.namespaceBytes)) invalid = true;
      if (expected.size !== 0) invalid = true;
    }
  } catch {
    invalid = true;
  }
  if (invalid) await quarantineCacheNamespace(cacheDirectory);
};

const prepareCacheDirectory = async (cacheDirectory: string, now: number): Promise<void> => {
  await collectQuarantines(cacheDirectory);
  if (process.platform !== 'win32') await mkdir(cacheDirectory, { recursive: true, mode: 0o700 });
  await ensurePrivateDirectory(cacheDirectory);

  const names = await boundedDirectoryNames(cacheDirectory);
  const foldedNames = new Set<string>();
  let invalidateEntry = names.length > SIGNED_UPDATE_CACHE_POLICY.maxRootEntries;
  for (const name of names) {
    const folded = name.toLocaleLowerCase('en-US');
    if (foldedNames.has(folded)) invalidateEntry = true;
    foldedNames.add(folded);
    if (name === SIGNED_UPDATE_CACHE_POLICY.lockName) {
      await inspectPrivatePath(join(cacheDirectory, name), true);
      const lockNames = await boundedDirectoryNames(join(cacheDirectory, name));
      if (lockNames.length !== 1 || lockNames[0] !== SIGNED_UPDATE_CACHE_POLICY.lockOwnerName) {
        throw new Error('Verified update cache is unavailable');
      }
      const owner = await inspectPrivatePath(join(cacheDirectory, name, lockNames[0]));
      if (owner.size <= 0n || owner.size > 1024n) throw new Error('Verified update cache is unavailable');
      continue;
    }
    if (name.startsWith('.partial-') || name !== SIGNED_UPDATE_CACHE_POLICY.entryName) {
      throw new Error('Verified update cache contains unknown content');
    }
  }
  const entryPath = join(cacheDirectory, SIGNED_UPDATE_CACHE_POLICY.entryName);
  try {
    if (invalidateEntry) throw new Error('invalid');
    await inspectPrivatePath(entryPath, true);
    const entryNames = await boundedDirectoryNames(entryPath);
    if (entryNames.length !== SIGNED_UPDATE_CACHE_POLICY.maxEntryEntries) throw new Error('invalid');
    const expected = new Set<string>([SIGNED_UPDATE_CACHE_POLICY.artifactName, SIGNED_UPDATE_CACHE_POLICY.metadataName]);
    const foldedEntryNames = new Set<string>();
    let totalBytes = 0n;
    for (const name of entryNames) {
      const folded = name.toLocaleLowerCase('en-US');
      if (foldedEntryNames.has(folded) || !expected.delete(name)) throw new Error('invalid');
      foldedEntryNames.add(folded);
      const inspected = await inspectPrivatePath(join(entryPath, name));
      if (inspected.links !== 1n) throw new Error('invalid');
      totalBytes += inspected.size;
    }
    if (expected.size !== 0 || totalBytes > BigInt(SIGNED_UPDATE_CACHE_POLICY.namespaceBytes)) {
      throw new Error('invalid');
    }
    const metadata = await readCacheMetadata(entryPath);
    if (metadata.expiresAt <= now) await removeCachePath(entryPath);
  } catch {
    await removeCachePath(entryPath);
  }
};

interface HeldPrivateFile {
  handle?: FileHandle;
  identity: ExactFileIdentity;
  path: string;
  windowsLock?: WindowsLockedArtifact;
}

const openPrivateRegularFile = async (
  path: string,
  maxBytes = SIGNED_UPDATE_DOWNLOAD_LIMITS.artifactBytes,
  expectedBeforeAcquisition?: { identity: ExactFileIdentity; size: bigint; sha256?: string },
  beforeWindowsOpenForTest?: () => Promise<void>,
  afterWindowsMismatchForTest?: (
    acquired: Readonly<{ identity: WindowsFileIdentity; size: string; sha256: string }>,
  ) => Promise<void>,
): Promise<HeldPrivateFile> => {
  if (process.platform === 'win32') {
    const windowsLock = await openWindowsLockedArtifact(path, maxBytes, beforeWindowsOpenForTest);
    if (expectedBeforeAcquisition
      && (!sameExactFileIdentity(windowsLock.inspection.identity, expectedBeforeAcquisition.identity)
        || BigInt(windowsLock.inspection.size) !== expectedBeforeAcquisition.size
        || expectedBeforeAcquisition.sha256 !== undefined
          && windowsLock.inspection.sha256 !== expectedBeforeAcquisition.sha256)) {
      const acquired = Object.freeze({
        identity: windowsLock.inspection.identity,
        size: windowsLock.inspection.size,
        sha256: windowsLock.inspection.sha256,
      });
      await windowsLock.close();
      await afterWindowsMismatchForTest?.(acquired);
      throw new Error('Verified update artifact acquisition changed [update-acquire:capability-mismatch]');
    }
    return {
      identity: windowsLock.inspection.identity,
      path,
      windowsLock,
    };
  }
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const stats = await handle.stat({ bigint: true });
    const inspected = await inspectPrivatePath(path);
    const pathStats = await lstat(path, { bigint: true });
    if (stats.nlink !== 1n || pathStats.nlink !== 1n
      || pathStats.dev !== stats.dev || pathStats.ino !== stats.ino || pathStats.size !== stats.size
      || inspected.size !== stats.size || inspected.links !== 1n
      || !isOwnedPrivate(stats)) {
      throw new Error('Verified update cache entry is invalid');
    }
    return { handle, identity: inspected.identity, path };
  } catch (error) {
    await handle.close();
    throw error;
  }
};

const readHeldFile = async (held: HeldPrivateFile, offset: number, length: number): Promise<Buffer> => {
  if (held.windowsLock) return held.windowsLock.read(offset, length);
  if (!held.handle) throw new Error('Verified update artifact capability is unavailable');
  const bytes = Buffer.alloc(length);
  const { bytesRead } = await held.handle.read(bytes, 0, length, offset);
  if (bytesRead !== length) throw new Error('Verified update artifact capability is unavailable');
  return bytes;
};

const hashHeldFile = async (held: HeldPrivateFile, maxBytes: number): Promise<{ size: number; sha256: string; sha1: string }> => {
  if (held.windowsLock) {
    const verified = await held.windowsLock.verify();
    const size = Number(verified.size);
    if (!Number.isSafeInteger(size) || size <= 0 || size > maxBytes) {
      throw new Error('Verified update artifact is invalid');
    }
    return { size, sha256: verified.sha256, sha1: verified.sha1 };
  }
  if (!held.handle) throw new Error('Verified update artifact is invalid');
  const handle = held.handle;
  const stats = await handle.stat({ bigint: true });
  if (!stats.isFile() || stats.nlink !== 1n || stats.size <= 0n || stats.size > BigInt(maxBytes)) {
    throw new Error('Verified update artifact is invalid');
  }
  const sha256 = createHash('sha256');
  const sha1 = createHash('sha1');
  const size = Number(stats.size);
  const chunk = Buffer.allocUnsafe(Math.min(1024 * 1024, size));
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, size - offset), offset);
    if (bytesRead === 0) throw new Error('Verified update artifact is invalid');
    const bytes = chunk.subarray(0, bytesRead);
    sha256.update(bytes);
    sha1.update(bytes);
    offset += bytesRead;
  }
  return { size: offset, sha256: sha256.digest('hex'), sha1: sha1.digest('hex') };
};

const assertHeldArtifact = async (
  held: HeldPrivateFile,
  path: string,
  artifact: SignedUpdateArtifact,
  squirrelEntry?: SquirrelReleaseEntry,
): Promise<void> => {
  if (held.windowsLock) {
    const verified = await held.windowsLock.verify();
    if (!sameExactFileIdentity(verified.identity, held.identity)
      || verified.links !== '1'
      || BigInt(verified.size) !== BigInt(artifact.size)) {
      throw new Error('Verified update artifact is invalid');
    }
    if (Number(verified.size) !== artifact.size || verified.sha256 !== artifact.sha256) {
      throw new Error('Verified update artifact does not match signed metadata');
    }
    if (squirrelEntry && (Number(verified.size) !== squirrelEntry.size || verified.sha1 !== squirrelEntry.sha1)) {
      throw new Error('Verified update artifact does not match Squirrel metadata');
    }
    return;
  }
  if (!held.handle) throw new Error('Verified update artifact is invalid');
  const descriptor = await held.handle.stat({ bigint: true });
  const pathStats = await lstat(path, { bigint: true });
  const inspected = await inspectPrivatePath(path);
  if (descriptor.nlink !== 1n || pathStats.nlink !== 1n
    || pathStats.dev !== descriptor.dev || pathStats.ino !== descriptor.ino || pathStats.size !== descriptor.size
    || inspected.size !== descriptor.size || !sameExactFileIdentity(inspected.identity, held.identity)
    || process.platform !== 'win32' && !isOwnedPrivate(descriptor)) {
    throw new Error('Verified update artifact is invalid');
  }
  const hashes = await hashHeldFile(held, SIGNED_UPDATE_DOWNLOAD_LIMITS.artifactBytes);
  if (hashes.size !== artifact.size || hashes.sha256 !== artifact.sha256) {
    throw new Error('Verified update artifact does not match signed metadata');
  }
  // SHA-1 is only Squirrel's compatibility binding; signed SHA-256 metadata remains the trust root.
  if (squirrelEntry && (hashes.size !== squirrelEntry.size || hashes.sha1 !== squirrelEntry.sha1)) {
    throw new Error('Verified update artifact does not match Squirrel metadata');
  }
};

const assertSigner = (actual: SignedUpdateSigner, expected: SignedUpdateSigner): void => {
  if (actual.type !== expected.type
    || actual.identity !== expected.identity
    || actual.designatedRequirement !== expected.designatedRequirement
    || actual.certificateSha256 !== expected.certificateSha256
    || actual.spkiSha256 !== expected.spkiSha256) {
    throw new Error('Native update artifact signer does not match the signed build pin');
  }
};

const verifyHeldNativeSigner = async (
  source: HeldPrivateFile,
  prepared: PreparedSignedUpdate,
  verifyNativeSigner: NonNullable<SignedUpdateOperationOptions['verifyNativeSigner']>,
): Promise<SignedUpdateSigner> => {
  const directory = await mkdtemp(join(tmpdir(), 'propr-update-signer-snapshot-'));
  let snapshot: HeldPrivateFile | undefined;
  try {
    if (process.platform === 'win32') await protectWindowsPrivateDirectory(directory);
    else {
      await chmod(directory, 0o700);
      await inspectPrivatePath(directory, true);
    }
    const snapshotPath = join(directory, prepared.feed.artifact.fileName);
    let output = await open(
      snapshotPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600,
    );
    await output.close();
    await protectPrivateFile(snapshotPath);
    output = await open(snapshotPath, fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW);
    try {
      const chunk = Buffer.allocUnsafe(Math.min(1024 * 1024, prepared.feed.artifact.size));
      let offset = 0;
      while (offset < prepared.feed.artifact.size) {
        const length = Math.min(chunk.length, prepared.feed.artifact.size - offset);
        const bytes = await readHeldFile(source, offset, length);
        bytes.copy(chunk, 0);
        const bytesRead = bytes.length;
        let written = 0;
        while (written < bytesRead) {
          const result = await output.write(chunk, written, bytesRead - written, offset + written);
          if (result.bytesWritten === 0) throw new Error('Verified update signer snapshot is invalid');
          written += result.bytesWritten;
        }
        offset += bytesRead;
      }
      await output.sync();
    } finally {
      await output.close();
    }
    snapshot = await openPrivateRegularFile(snapshotPath);
    await assertHeldArtifact(snapshot, snapshotPath, prepared.feed.artifact, prepared.squirrelEntry);
    const beforeSignerDirectory = await lstat(directory, { bigint: true });
    const signer = await verifyNativeSigner(snapshotPath, prepared.feed.artifact, prepared.feed.signer);
    const afterSignerDirectory = await lstat(directory, { bigint: true });
    if (beforeSignerDirectory.dev !== afterSignerDirectory.dev
      || beforeSignerDirectory.ino !== afterSignerDirectory.ino
      || beforeSignerDirectory.ctimeNs !== afterSignerDirectory.ctimeNs
      || beforeSignerDirectory.mtimeNs !== afterSignerDirectory.mtimeNs) {
      throw new Error('Verified update signer snapshot is invalid');
    }
    await assertHeldArtifact(snapshot, snapshotPath, prepared.feed.artifact, prepared.squirrelEntry);
    return signer;
  } finally {
    try { await snapshot?.windowsLock?.close(); } finally {
      await snapshot?.handle?.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
};

const withVerifiedArtifact = async <T>(
  packagePath: string,
  prepared: PreparedSignedUpdate,
  verifyNativeSigner: NonNullable<SignedUpdateOperationOptions['verifyNativeSigner']>,
  use: (held: HeldPrivateFile) => Promise<T>,
  beforeWindowsOpenForTest?: SignedUpdateOperationOptions['beforeWindowsArtifactOpenForTest'],
  afterWindowsMismatchForTest?: SignedUpdateOperationOptions['afterWindowsArtifactMismatchForTest'],
): Promise<T> => {
  // A pathname capability is captured before the broker's first artifact open.
  // The native test barrier runs inside the broker launch protocol immediately
  // before CreateFileW; the returned full identity/size/hash must still bind A.
  const expectedBeforeAcquisition = {
    ...await inspectPrivatePath(packagePath),
    sha256: prepared.feed.artifact.sha256,
  };
  const held = await openPrivateRegularFile(
    packagePath,
    SIGNED_UPDATE_DOWNLOAD_LIMITS.artifactBytes,
    expectedBeforeAcquisition,
    beforeWindowsOpenForTest ? () => beforeWindowsOpenForTest(packagePath) : undefined,
    afterWindowsMismatchForTest
      ? acquired => afterWindowsMismatchForTest(packagePath, acquired)
      : undefined,
  );
  try {
    const entryDirectory = dirname(packagePath);
    const cacheDirectory = dirname(entryDirectory);
    const initialDirectory = await inspectPrivatePath(entryDirectory, true);
    const initialParent = await inspectPrivatePath(cacheDirectory, true);
    const initialDirectoryState = process.platform === 'win32' ? undefined : await lstat(entryDirectory, { bigint: true });
    const initialParentState = process.platform === 'win32' ? undefined : await lstat(cacheDirectory, { bigint: true });
    const assertDirectoryUnchanged = async (): Promise<void> => {
      const current = await inspectPrivatePath(entryDirectory, true);
      const currentParent = await inspectPrivatePath(cacheDirectory, true);
      const currentDirectoryState = initialDirectoryState && await lstat(entryDirectory, { bigint: true });
      const currentParentState = initialParentState && await lstat(cacheDirectory, { bigint: true });
      if (!sameExactFileIdentity(current.identity, initialDirectory.identity)
        || !sameExactFileIdentity(currentParent.identity, initialParent.identity)
        || initialDirectoryState && currentDirectoryState
          && (currentDirectoryState.ctimeNs !== initialDirectoryState.ctimeNs
            || currentDirectoryState.mtimeNs !== initialDirectoryState.mtimeNs)
        || initialParentState && currentParentState
          && (currentParentState.ctimeNs !== initialParentState.ctimeNs
            || currentParentState.mtimeNs !== initialParentState.mtimeNs)) {
        throw new Error('Verified update artifact is invalid');
      }
    };
    await assertHeldArtifact(held, packagePath, prepared.feed.artifact, prepared.squirrelEntry);
    assertSigner(
      await verifyHeldNativeSigner(held, prepared, verifyNativeSigner),
      prepared.feed.signer,
    );
    await assertDirectoryUnchanged();
    await assertHeldArtifact(held, packagePath, prepared.feed.artifact, prepared.squirrelEntry);
    const result = await use(held);
    await assertDirectoryUnchanged();
    await assertHeldArtifact(held, packagePath, prepared.feed.artifact, prepared.squirrelEntry);
    return result;
  } finally {
    try { await held.windowsLock?.close(); } finally { await held.handle?.close(); }
  }
};

const readCacheMetadata = async (entryPath: string): Promise<UpdateCacheMetadata> => {
  const path = join(entryPath, SIGNED_UPDATE_CACHE_POLICY.metadataName);
  const held = await openPrivateRegularFile(path, SIGNED_UPDATE_CACHE_POLICY.metadataBytes);
  try {
    const size = held.windowsLock
      ? BigInt(held.windowsLock.inspection.size)
      : (await held.handle!.stat({ bigint: true })).size;
    if (size <= 0n || size > BigInt(SIGNED_UPDATE_CACHE_POLICY.metadataBytes)) {
      throw new Error('Verified update cache entry is invalid');
    }
    const bytes = await readHeldFile(held, 0, Number(size));
    const value: unknown = JSON.parse(bytes.toString('utf8'));
    if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.key)
      || !Number.isSafeInteger(value.createdAt) || !Number.isSafeInteger(value.expiresAt)) {
      throw new Error('Verified update cache entry is invalid');
    }
    return value as unknown as UpdateCacheMetadata;
  } catch {
    throw new Error('Verified update cache entry is invalid');
  } finally {
    try { await held.windowsLock?.close(); } finally { await held.handle?.close(); }
  }
};

const exactCacheKey = (left: UpdateCacheKey, right: UpdateCacheKey): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const cacheKeyFor = (prepared: PreparedSignedUpdate): UpdateCacheKey => ({
  origin: new URL(prepared.manifest.manifestUrl).origin,
  channel: prepared.manifest.channel,
  version: prepared.manifest.version,
  manifestSha256: prepared.manifestDigest,
  artifactSha256: prepared.feed.artifact.sha256,
  target: prepared.target,
  artifactSize: prepared.feed.artifact.size,
  artifactFileName: prepared.feed.artifact.fileName,
});

const findCachedArtifact = async (
  cacheDirectory: string,
  key: UpdateCacheKey,
  now: number,
): Promise<string | undefined> => {
  const entryPath = join(cacheDirectory, SIGNED_UPDATE_CACHE_POLICY.entryName);
  try {
    await inspectPrivatePath(entryPath, true);
    const metadata = await readCacheMetadata(entryPath);
    if (metadata.expiresAt <= now || metadata.expiresAt - metadata.createdAt !== SIGNED_UPDATE_CACHE_POLICY.expiryMs
      || !exactCacheKey(metadata.key, key)) throw new Error('invalid');
    return join(entryPath, SIGNED_UPDATE_CACHE_POLICY.artifactName);
  } catch {
    await removeCachePath(entryPath);
    return undefined;
  }
};

const publishCachedArtifact = async (
  cacheDirectory: string,
  prepared: PreparedSignedUpdate,
  request: SignedUpdateRequest,
  verifyNativeSigner: NonNullable<SignedUpdateOperationOptions['verifyNativeSigner']>,
  now: number,
): Promise<string> => {
  const partialName = `.partial-${randomBytes(16).toString('hex')}`;
  const partialPath = join(cacheDirectory, partialName);
  const artifactPath = join(partialPath, SIGNED_UPDATE_CACHE_POLICY.artifactName);
  await ensurePrivateDirectory(partialPath);
  try {
    await downloadBoundedUpdateFile({
      request,
      url: prepared.feed.artifact.url,
      destinationPath: artifactPath,
      label: 'Native update artifact',
      maxBytes: SIGNED_UPDATE_DOWNLOAD_LIMITS.artifactBytes,
      timeoutMs: SIGNED_UPDATE_DOWNLOAD_LIMITS.artifactTimeoutMs,
      expected: prepared.feed.artifact,
    });
    await protectPrivateFile(artifactPath);
    await withVerifiedArtifact(artifactPath, prepared, verifyNativeSigner, async () => undefined);

    const metadata: UpdateCacheMetadata = {
      schemaVersion: 1,
      createdAt: now,
      expiresAt: now + SIGNED_UPDATE_CACHE_POLICY.expiryMs,
      key: cacheKeyFor(prepared),
    };
    const metadataPath = join(partialPath, SIGNED_UPDATE_CACHE_POLICY.metadataName);
    let metadataHandle = await open(
      metadataPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600,
    );
    await metadataHandle.close();
    await protectPrivateFile(metadataPath);
    metadataHandle = await open(metadataPath, fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW);
    try {
      await metadataHandle.writeFile(`${JSON.stringify(metadata)}\n`, 'utf8');
      await metadataHandle.sync();
    } finally {
      await metadataHandle.close();
    }
    await syncDirectory(partialPath);

    const entryPath = join(cacheDirectory, SIGNED_UPDATE_CACHE_POLICY.entryName);
    await removeCachePath(entryPath);
    await rename(partialPath, entryPath);
    await syncDirectory(cacheDirectory);
    return join(entryPath, SIGNED_UPDATE_CACHE_POLICY.artifactName);
  } catch (error) {
    await removeCachePath(partialPath);
    throw error;
  }
};

const prepareSignedUpdate = async ({
  config,
  currentVersion,
  platform,
  arch,
  request,
}: SignedUpdateOperationOptions): Promise<PreparedSignedUpdate | 'current' | 'unsupported'> => {
  if (platform !== 'darwin' && platform !== 'win32') return 'unsupported';
  if (!VERSION_PATTERN.test(currentVersion)) throw new Error('Current desktop version is invalid');

  const manifestUrl = parseHttpsUrl(
    config.manifestUrl,
    'Embedded update manifest URL',
    { allowQuery: false },
  );
  const [payload, signature] = await Promise.all([
    fetchBoundedUpdateBytes({
      request,
      url: manifestUrl,
      label: 'Signed update manifest',
      maxBytes: SIGNED_UPDATE_DOWNLOAD_LIMITS.manifestBytes,
      timeoutMs: SIGNED_UPDATE_DOWNLOAD_LIMITS.metadataTimeoutMs,
    }),
    fetchBoundedUpdateBytes({
      request,
      url: `${manifestUrl}.sig`,
      label: 'Signed update manifest signature',
      maxBytes: SIGNED_UPDATE_DOWNLOAD_LIMITS.signatureBytes,
      timeoutMs: SIGNED_UPDATE_DOWNLOAD_LIMITS.metadataTimeoutMs,
    }),
  ]);
  const manifest = verifySignedUpdateManifest(payload, signature.toString('ascii'), config.publicKey);
  if (manifest.manifestUrl !== manifestUrl) {
    throw new Error('Signed update manifest does not bind the embedded manifest URL');
  }
  if (compareVersions(manifest.version, currentVersion) <= 0) return 'current';

  const target = `${platform}-${arch}`;
  const feed = manifest.feeds[target];
  if (!feed) throw new Error(`Signed update manifest does not contain a feed for ${target}`);
  if (feed.target !== target || feed.version !== manifest.version) {
    throw new Error('Signed update feed target or version does not match the requested update');
  }
  if (feed.signer.identity !== config.signingIdentity) {
    throw new Error('Signed update native signer does not match the identity embedded in this build');
  }
  if (platform === 'win32') {
    if (!Array.isArray(config.windowsSignerPins)) throw new Error('Embedded Windows signer pin allowlist is invalid');
    const configuredPins = parseWindowsSignerPins(config.windowsSignerPins.join(','), 'Embedded Windows signer pin allowlist');
    const evidencePins = new Set([
      `certificate-sha256:${feed.signer.certificateSha256}`,
      `spki-sha256:${feed.signer.spkiSha256}`,
    ]);
    if (!configuredPins.some(pin => evidencePins.has(pin))) {
      throw new Error('Signed update Windows signer fingerprint is not in the embedded allowlist');
    }
  }

  const feedBytes = await fetchBoundedUpdateBytes({
    request,
    url: feed.feed.url,
    label: 'Native update feed',
    maxBytes: SIGNED_UPDATE_DOWNLOAD_LIMITS.feedBytes,
    timeoutMs: SIGNED_UPDATE_DOWNLOAD_LIMITS.metadataTimeoutMs,
    expected: feed.feed,
  });
  verifyBytes(feedBytes, feed.feed, 'Native update feed');
  const squirrelEntry = verifyFeedReferencesArtifact(target, manifest.version, feedBytes, feed.artifact);
  return {
    manifest,
    manifestDigest: createHash('sha256').update(payload).digest('hex'),
    target,
    feed,
    feedBytes,
    squirrelEntry,
  };
};

const usePreparedArtifact = async <T>(
  prepared: PreparedSignedUpdate,
  options: SignedUpdateOperationOptions,
  consume: boolean,
  use: (held: HeldPrivateFile) => Promise<T>,
): Promise<T> => {
  const verifySigner = options.verifyNativeSigner ?? verifyNativeUpdateSigner;
  let cacheDirectory = options.cacheDirectory;
  const now = (options.now ?? Date.now)();
  if (cacheDirectory) {
    try {
      await prepareCacheDirectory(cacheDirectory, now);
    } catch {
      // Cache authority is never availability: authenticate a fresh private download instead.
      cacheDirectory = undefined;
    }
  }
  if (!cacheDirectory) {
    const directory = await mkdtemp(join(tmpdir(), 'propr-update-download-'));
    try {
      if (process.platform === 'win32') await protectWindowsPrivateDirectory(directory);
      else {
        await chmod(directory, 0o700);
        await inspectPrivatePath(directory, true);
      }
      const heldDirectory = join(directory, 'held');
      await ensurePrivateDirectory(heldDirectory);
      const packagePath = join(heldDirectory, prepared.feed.artifact.fileName);
      await downloadBoundedUpdateFile({
        request: options.request,
        url: prepared.feed.artifact.url,
        destinationPath: packagePath,
        label: 'Native update artifact',
        maxBytes: SIGNED_UPDATE_DOWNLOAD_LIMITS.artifactBytes,
        timeoutMs: SIGNED_UPDATE_DOWNLOAD_LIMITS.artifactTimeoutMs,
        expected: prepared.feed.artifact,
      });
      await protectPrivateFile(packagePath);
      return await withVerifiedArtifact(
        packagePath,
        prepared,
        verifySigner,
        use,
        options.beforeWindowsArtifactOpenForTest,
        options.afterWindowsArtifactMismatchForTest,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  const entryPath = join(cacheDirectory, SIGNED_UPDATE_CACHE_POLICY.entryName);
  const key = cacheKeyFor(prepared);
  let packagePath = await findCachedArtifact(cacheDirectory, key, now);
  if (packagePath) {
    let useStarted = false;
    try {
      const result = await withVerifiedArtifact(packagePath, prepared, verifySigner, held => {
        useStarted = true;
        return use(held);
      }, options.beforeWindowsArtifactOpenForTest, options.afterWindowsArtifactMismatchForTest);
      if (consume) await removeCachePath(entryPath);
      return result;
    } catch (error) {
      await removeCachePath(entryPath);
      if (useStarted || options.beforeWindowsArtifactOpenForTest) throw error;
      packagePath = undefined;
    }
  }

  packagePath = await publishCachedArtifact(
    cacheDirectory,
    prepared,
    options.request,
    verifySigner,
    now,
  );
  try {
    return await withVerifiedArtifact(
      packagePath,
      prepared,
      verifySigner,
      use,
      options.beforeWindowsArtifactOpenForTest,
      options.afterWindowsArtifactMismatchForTest,
    );
  } finally {
    if (consume) await removeCachePath(entryPath);
  }
};

export const checkForSignedUpdates = async (
  options: SignedUpdateOperationOptions,
): Promise<'available' | 'current' | 'unsupported'> => {
  const operation = async (cacheLockHeld = true): Promise<'available' | 'current' | 'unsupported'> => {
    const effectiveOptions = cacheLockHeld ? options : { ...options, cacheDirectory: undefined };
    const prepared = await prepareSignedUpdate(effectiveOptions);
    if (prepared === 'current' || prepared === 'unsupported') return prepared;
    await usePreparedArtifact(prepared, effectiveOptions, false, async () => undefined);
    return 'available';
  };
  return options.cacheDirectory ? withCacheLock(options.cacheDirectory, operation) : operation();
};

export const applySignedUpdate = async (
  options: SignedUpdateOperationOptions & {
    installVerifiedArtifact: (artifact: VerifiedUpdateArtifact) => Promise<void>;
  },
): Promise<'applied' | 'current' | 'unsupported'> => {
  const operation = async (cacheLockHeld = true): Promise<'applied' | 'current' | 'unsupported'> => {
    const effectiveOptions = cacheLockHeld ? options : { ...options, cacheDirectory: undefined };
    const prepared = await prepareSignedUpdate(effectiveOptions);
    if (prepared === 'current' || prepared === 'unsupported') return prepared;
    if (!effectiveOptions.applyHeldArtifact) {
      throw new Error('Automatic update apply is unavailable for a held verified artifact');
    }
    await usePreparedArtifact(prepared, effectiveOptions, true, async held => {
      let active = true;
      let application: Promise<void> | undefined;
      const source: HeldUpdateArtifactSource = Object.freeze({
        artifact: prepared.feed.artifact,
        feedBytes: Buffer.from(prepared.feedBytes),
        read: async (offset: number, length: number): Promise<Buffer> => {
          if (!active || !Number.isSafeInteger(offset) || offset < 0
            || !Number.isSafeInteger(length) || length <= 0 || length > 1024 * 1024
            || offset + length > prepared.feed.artifact.size) {
            throw new Error('Verified update artifact capability is unavailable');
          }
          return readHeldFile(held, offset, length);
        },
      });
      const capability: VerifiedUpdateArtifact = Object.freeze({
        feedBytes: Buffer.from(prepared.feedBytes),
        artifact: Object.freeze({ ...prepared.feed.artifact }),
        apply: async (): Promise<void> => {
          if (!active || application) throw new Error('Verified update artifact capability is unavailable');
          application = (async () => {
            // The challenge proves that the exact broker session is live at the
            // launch barrier. Its no-share handle remains held while the platform
            // adapter consumes only source.read(), never a mutable pathname.
            await held.windowsLock?.verify();
            await effectiveOptions.applyHeldArtifact!(source);
            await held.windowsLock?.verify();
          })();
          await application;
        },
      });
      try {
        await effectiveOptions.installVerifiedArtifact(capability);
        if (!application) throw new Error('Verified update artifact capability was not consumed');
        await application;
      } finally {
        active = false;
      }
    });
    return 'applied';
  };
  return options.cacheDirectory ? withCacheLock(options.cacheDirectory, operation) : operation();
};
