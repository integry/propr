import { createHash, createPublicKey, verify } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';

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
}

const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const TARGET_PATTERN = /^(darwin|win32)-(x64|arm64)$/;
const execFileAsync = promisify(execFile);

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
        : {}),
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
  artifactBytes: Buffer,
  artifact: SignedUpdateArtifact,
  expected: SignedUpdateSigner,
): Promise<SignedUpdateSigner> => {
  const directory = await mkdtemp(join(tmpdir(), 'propr-update-check-'));
  try {
    const packagePath = join(directory, artifact.fileName);
    const extracted = join(directory, 'extracted');
    await writeFile(packagePath, artifactBytes, { mode: 0o600 });
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
      "$executable = Get-ChildItem -LiteralPath $extract -Recurse -Filter 'propr-desktop.exe' | Select-Object -First 1",
      "if (!$executable) { throw 'Windows update package contains no application executable' }",
      '$signature = Get-AuthenticodeSignature -LiteralPath $executable.FullName',
      "if ($signature.Status -ne 'Valid' -or !$signature.SignerCertificate) { throw 'Windows update Authenticode signature is invalid' }",
      '$signature.SignerCertificate.Subject',
    ].join('; ');
    const { stdout } = await execFileAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script]);
    const identity = stdout.trim();
    if (!identity) throw new Error('Windows update has no Authenticode signer subject');
    return { type: 'authenticode-subject', identity };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

export const checkForSignedUpdates = async ({
  config,
  currentVersion,
  platform,
  arch,
  fetchBytes,
  verifyNativeSigner = verifyNativeUpdateSigner,
}: {
  config: SignedUpdateRuntimeConfig;
  currentVersion: string;
  platform: NodeJS.Platform;
  arch: string;
  fetchBytes: (url: string) => Promise<Buffer>;
  verifyNativeSigner?: (
    bytes: Buffer,
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
    fetchBytes(manifestUrl),
    fetchBytes(`${manifestUrl}.sig`),
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

  const feedBytes = await fetchBytes(feed.feed.url);
  verifyBytes(feedBytes, feed.feed, 'Native update feed');
  verifyFeedReferencesArtifact(target, manifest.version, feedBytes, feed.artifact);
  const artifactBytes = await fetchBytes(feed.artifact.url);
  verifyBytes(artifactBytes, feed.artifact, 'Native update artifact');
  const actualSigner = await verifyNativeSigner(artifactBytes, feed.artifact, feed.signer);
  if (actualSigner.type !== feed.signer.type
    || actualSigner.identity !== feed.signer.identity
    || actualSigner.designatedRequirement !== feed.signer.designatedRequirement) {
    throw new Error('Native update artifact signer does not match the signed build pin');
  }

  // Electron autoUpdater cannot install these preverified bytes without fetching the mutable feed again.
  // Keep this channel check-only until the native installation API can consume the exact verified package.
  return 'available';
};
