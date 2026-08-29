import { createHash, createPublicKey, verify, X509Certificate } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
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
} as const;

const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const TARGET_PATTERN = /^(darwin|win32)-(x64|arm64)$/;
const execFileAsync = promisify(execFile);

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
    file = await open(options.destinationPath, 'wx', 0o600);
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
    await file.close();
    file = undefined;
  } catch (error) {
    await file?.close().catch(() => undefined);
    await rm(options.destinationPath, { force: true });
    throw error;
  }
};

const verifyFeedReferencesArtifact = (
  target: string,
  version: string,
  feedBytes: Buffer,
  artifact: SignedUpdateArtifact,
): void => {
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
    return;
  }

  const referenced = feedBytes.toString('utf8').split(/\r?\n/).some(line => {
    const match = /^[a-fA-F0-9]{40}\s+(\S+)\s+(\d+)$/.exec(line.trim());
    return match?.[1] === artifact.fileName && Number(match[2]) === artifact.size;
  });
  if (!referenced) throw new Error('Signed Windows update feed does not reference the bound package bytes');
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
      const { stdout: appPath } = await execFileAsync('/usr/bin/find', [extracted, '-type', 'd', '-name', '*.app', '-print', '-quit']);
      const application = appPath.trim();
      if (!application) throw new Error('macOS update ZIP contains no application bundle');
      await execFileAsync('/usr/bin/codesign', ['--verify', '--deep', '--strict', application]);
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

export const checkForSignedUpdates = async ({
  config,
  currentVersion,
  platform,
  arch,
  request,
  verifyNativeSigner = verifyNativeUpdateSigner,
}: {
  config: SignedUpdateRuntimeConfig;
  currentVersion: string;
  platform: NodeJS.Platform;
  arch: string;
  request: SignedUpdateRequest;
  verifyNativeSigner?: (
    packagePath: string,
    artifact: SignedUpdateArtifact,
    signer: SignedUpdateSigner,
  ) => Promise<SignedUpdateSigner>;
}): Promise<'available' | 'current' | 'unsupported'> => {
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
  verifyFeedReferencesArtifact(target, manifest.version, feedBytes, feed.artifact);
  const directory = await mkdtemp(join(tmpdir(), 'propr-update-download-'));
  try {
    const packagePath = join(directory, feed.artifact.fileName);
    await downloadBoundedUpdateFile({
      request,
      url: feed.artifact.url,
      destinationPath: packagePath,
      label: 'Native update artifact',
      maxBytes: SIGNED_UPDATE_DOWNLOAD_LIMITS.artifactBytes,
      timeoutMs: SIGNED_UPDATE_DOWNLOAD_LIMITS.artifactTimeoutMs,
      expected: feed.artifact,
    });
    const actualSigner = await verifyNativeSigner(packagePath, feed.artifact, feed.signer);
    if (actualSigner.type !== feed.signer.type
      || actualSigner.identity !== feed.signer.identity
      || actualSigner.designatedRequirement !== feed.signer.designatedRequirement
      || actualSigner.certificateSha256 !== feed.signer.certificateSha256
      || actualSigner.spkiSha256 !== feed.signer.spkiSha256) {
      throw new Error('Native update artifact signer does not match the signed build pin');
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }

  // Electron autoUpdater cannot install these preverified bytes without fetching the mutable feed again.
  // Keep this channel check-only until the native installation API can consume the exact verified package.
  return 'available';
};
