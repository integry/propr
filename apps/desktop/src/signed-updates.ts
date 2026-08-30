import { createHash, createPublicKey, randomBytes, verify, X509Certificate } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  rename,
  rm,
  type FileHandle,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { parseWindowsSignerPins } from './release-config';

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

export interface SignedUpdateInstallArtifact {
  packagePath: string;
  feedBytes: Buffer;
  artifact: SignedUpdateArtifact;
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
}

interface PreparedSignedUpdate {
  manifest: SignedUpdateManifest;
  manifestDigest: string;
  target: string;
  feed: SignedUpdateFeed;
  feedBytes: Buffer;
  squirrelEntry?: SquirrelReleaseEntry;
}

const withCacheLock = async <T>(cacheDirectory: string, operation: () => Promise<T>): Promise<T> => {
  const previous = cacheLocks.get(cacheDirectory) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  const queued = previous.then(() => current);
  cacheLocks.set(cacheDirectory, queued);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (cacheLocks.get(cacheDirectory) === queued) cacheLocks.delete(cacheDirectory);
  }
};

const isOwnedPrivate = (stats: Awaited<ReturnType<typeof lstat>>, directory = false): boolean => {
  const expectedType = directory ? stats.isDirectory() : stats.isFile();
  const expectedOwner = typeof process.getuid !== 'function' || stats.uid === process.getuid();
  // libuv does not expose Windows ACLs as Unix owner/group mode bits; the cache inherits
  // the per-user Electron data-directory ACL there and is still checked for real-file identity.
  const expectedMode = process.platform === 'win32' || (Number(stats.mode) & 0o077) === 0;
  return expectedType && !stats.isSymbolicLink() && expectedOwner && expectedMode;
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

const removeCachePath = async (path: string): Promise<void> => {
  let stats;
  try { stats = await lstat(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (stats.isDirectory() && !stats.isSymbolicLink()) await rm(path, { recursive: true, force: true });
  else await rm(path, { force: true });
};

const prepareCacheDirectory = async (cacheDirectory: string, now: number): Promise<void> => {
  await mkdir(cacheDirectory, { recursive: true, mode: 0o700 });
  const stats = await lstat(cacheDirectory);
  if (!stats.isDirectory() || stats.isSymbolicLink()
    || typeof process.getuid === 'function' && stats.uid !== process.getuid()) {
    throw new Error('Verified update cache is unavailable');
  }
  await chmod(cacheDirectory, 0o700);
  if (!isOwnedPrivate(await lstat(cacheDirectory), true)) throw new Error('Verified update cache is unavailable');

  for (const name of await readdir(cacheDirectory)) {
    if (name.startsWith('.partial-')) await removeCachePath(join(cacheDirectory, name));
  }
  const entryPath = join(cacheDirectory, SIGNED_UPDATE_CACHE_POLICY.entryName);
  try {
    const entryStats = await lstat(entryPath);
    if (!isOwnedPrivate(entryStats, true)) throw new Error('invalid');
    const metadata = await readCacheMetadata(entryPath);
    if (metadata.expiresAt <= now) await removeCachePath(entryPath);
  } catch {
    await removeCachePath(entryPath);
  }
};

const openPrivateRegularFile = async (path: string): Promise<FileHandle> => {
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const stats = await handle.stat();
    const pathStats = await lstat(path);
    if (!isOwnedPrivate(stats) || stats.nlink !== 1
      || pathStats.dev !== stats.dev || pathStats.ino !== stats.ino || pathStats.size !== stats.size) {
      throw new Error('Verified update cache entry is invalid');
    }
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
};

const hashHeldFile = async (handle: FileHandle, maxBytes: number): Promise<{ size: number; sha256: string; sha1: string }> => {
  const stats = await handle.stat();
  if (!stats.isFile() || stats.nlink !== 1 || stats.size <= 0 || stats.size > maxBytes) {
    throw new Error('Verified update artifact is invalid');
  }
  const sha256 = createHash('sha256');
  const sha1 = createHash('sha1');
  const chunk = Buffer.allocUnsafe(Math.min(1024 * 1024, stats.size));
  let offset = 0;
  while (offset < stats.size) {
    const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, stats.size - offset), offset);
    if (bytesRead === 0) throw new Error('Verified update artifact is invalid');
    const bytes = chunk.subarray(0, bytesRead);
    sha256.update(bytes);
    sha1.update(bytes);
    offset += bytesRead;
  }
  return { size: offset, sha256: sha256.digest('hex'), sha1: sha1.digest('hex') };
};

const assertHeldArtifact = async (
  handle: FileHandle,
  path: string,
  artifact: SignedUpdateArtifact,
  squirrelEntry?: SquirrelReleaseEntry,
): Promise<void> => {
  const descriptor = await handle.stat();
  const pathStats = await lstat(path);
  if (!isOwnedPrivate(descriptor) || descriptor.nlink !== 1
    || pathStats.dev !== descriptor.dev || pathStats.ino !== descriptor.ino || pathStats.size !== descriptor.size) {
    throw new Error('Verified update artifact is invalid');
  }
  const hashes = await hashHeldFile(handle, SIGNED_UPDATE_DOWNLOAD_LIMITS.artifactBytes);
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

const withVerifiedArtifact = async <T>(
  packagePath: string,
  prepared: PreparedSignedUpdate,
  verifyNativeSigner: NonNullable<SignedUpdateOperationOptions['verifyNativeSigner']>,
  use: (packagePath: string) => Promise<T>,
): Promise<T> => {
  const handle = await openPrivateRegularFile(packagePath);
  try {
    const entryDirectory = dirname(packagePath);
    const cacheDirectory = dirname(entryDirectory);
    const initialDirectory = await lstat(entryDirectory, { bigint: true });
    const initialParent = await lstat(cacheDirectory, { bigint: true });
    const assertDirectoryUnchanged = async (): Promise<void> => {
      const current = await lstat(entryDirectory, { bigint: true });
      const currentParent = await lstat(cacheDirectory, { bigint: true });
      if (current.dev !== initialDirectory.dev || current.ino !== initialDirectory.ino
        || current.ctimeNs !== initialDirectory.ctimeNs || current.mtimeNs !== initialDirectory.mtimeNs
        || currentParent.dev !== initialParent.dev || currentParent.ino !== initialParent.ino
        || currentParent.ctimeNs !== initialParent.ctimeNs || currentParent.mtimeNs !== initialParent.mtimeNs) {
        throw new Error('Verified update artifact is invalid');
      }
    };
    await assertHeldArtifact(handle, packagePath, prepared.feed.artifact, prepared.squirrelEntry);
    assertSigner(
      await verifyNativeSigner(packagePath, prepared.feed.artifact, prepared.feed.signer),
      prepared.feed.signer,
    );
    await assertDirectoryUnchanged();
    await assertHeldArtifact(handle, packagePath, prepared.feed.artifact, prepared.squirrelEntry);
    const result = await use(packagePath);
    await assertDirectoryUnchanged();
    await assertHeldArtifact(handle, packagePath, prepared.feed.artifact, prepared.squirrelEntry);
    return result;
  } finally {
    await handle.close();
  }
};

const readCacheMetadata = async (entryPath: string): Promise<UpdateCacheMetadata> => {
  const path = join(entryPath, SIGNED_UPDATE_CACHE_POLICY.metadataName);
  const handle = await openPrivateRegularFile(path);
  try {
    const stats = await handle.stat();
    if (stats.size <= 0 || stats.size > SIGNED_UPDATE_CACHE_POLICY.metadataBytes) {
      throw new Error('Verified update cache entry is invalid');
    }
    const bytes = Buffer.alloc(stats.size);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== bytes.length) throw new Error('Verified update cache entry is invalid');
    const value: unknown = JSON.parse(bytes.toString('utf8'));
    if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.key)
      || !Number.isSafeInteger(value.createdAt) || !Number.isSafeInteger(value.expiresAt)) {
      throw new Error('Verified update cache entry is invalid');
    }
    return value as unknown as UpdateCacheMetadata;
  } catch {
    throw new Error('Verified update cache entry is invalid');
  } finally {
    await handle.close();
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
    const entryStats = await lstat(entryPath);
    if (!isOwnedPrivate(entryStats, true)) throw new Error('invalid');
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
  await mkdir(partialPath, { mode: 0o700 });
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
    await chmod(artifactPath, 0o600);
    await withVerifiedArtifact(artifactPath, prepared, verifyNativeSigner, async () => undefined);

    const metadata: UpdateCacheMetadata = {
      schemaVersion: 1,
      createdAt: now,
      expiresAt: now + SIGNED_UPDATE_CACHE_POLICY.expiryMs,
      key: cacheKeyFor(prepared),
    };
    const metadataPath = join(partialPath, SIGNED_UPDATE_CACHE_POLICY.metadataName);
    const metadataHandle = await open(
      metadataPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600,
    );
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
  use: (packagePath: string) => Promise<T>,
): Promise<T> => {
  const verifySigner = options.verifyNativeSigner ?? verifyNativeUpdateSigner;
  if (!options.cacheDirectory) {
    const directory = await mkdtemp(join(tmpdir(), 'propr-update-download-'));
    try {
      const heldDirectory = join(directory, 'held');
      await mkdir(heldDirectory, { mode: 0o700 });
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
      await chmod(packagePath, 0o600);
      return await withVerifiedArtifact(packagePath, prepared, verifySigner, use);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  const cacheDirectory = options.cacheDirectory;
  const now = (options.now ?? Date.now)();
  await prepareCacheDirectory(cacheDirectory, now);
  const entryPath = join(cacheDirectory, SIGNED_UPDATE_CACHE_POLICY.entryName);
  const key = cacheKeyFor(prepared);
  let packagePath = await findCachedArtifact(cacheDirectory, key, now);
  if (packagePath) {
    let useStarted = false;
    try {
      const result = await withVerifiedArtifact(packagePath, prepared, verifySigner, path => {
        useStarted = true;
        return use(path);
      });
      if (consume) await removeCachePath(entryPath);
      return result;
    } catch (error) {
      await removeCachePath(entryPath);
      if (useStarted) throw error;
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
    return await withVerifiedArtifact(packagePath, prepared, verifySigner, use);
  } finally {
    if (consume) await removeCachePath(entryPath);
  }
};

export const checkForSignedUpdates = async (
  options: SignedUpdateOperationOptions,
): Promise<'available' | 'current' | 'unsupported'> => {
  const operation = async (): Promise<'available' | 'current' | 'unsupported'> => {
    if (options.cacheDirectory) {
      await prepareCacheDirectory(options.cacheDirectory, (options.now ?? Date.now)());
    }
    const prepared = await prepareSignedUpdate(options);
    if (prepared === 'current' || prepared === 'unsupported') return prepared;
    await usePreparedArtifact(prepared, options, false, async () => undefined);
    return 'available';
  };
  return options.cacheDirectory ? withCacheLock(options.cacheDirectory, operation) : operation();
};

export const applySignedUpdate = async (
  options: SignedUpdateOperationOptions & {
    installVerifiedArtifact: (artifact: SignedUpdateInstallArtifact) => Promise<void>;
  },
): Promise<'applied' | 'current' | 'unsupported'> => {
  const operation = async (): Promise<'applied' | 'current' | 'unsupported'> => {
    if (options.cacheDirectory) {
      await prepareCacheDirectory(options.cacheDirectory, (options.now ?? Date.now)());
    }
    const prepared = await prepareSignedUpdate(options);
    if (prepared === 'current' || prepared === 'unsupported') return prepared;
    await usePreparedArtifact(prepared, options, true, packagePath => options.installVerifiedArtifact({
      packagePath,
      feedBytes: prepared.feedBytes,
      artifact: prepared.feed.artifact,
    }));
    return 'applied';
  };
  return options.cacheDirectory ? withCacheLock(options.cacheDirectory, operation) : operation();
};
