import { createPublicKey, verify } from 'node:crypto';

export interface SignedUpdateFeed {
  url: string;
  signingIdentity: string;
}

export interface SignedUpdateManifest {
  schemaVersion: 1;
  channel: 'stable';
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

export interface DesktopAutoUpdater {
  setFeedURL(options: { url: string; serverType?: 'json' }): void;
  checkForUpdates(): void;
}

const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const parseHttpsUrl = (value: unknown, label: string): string => {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute HTTPS URL`);
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new Error(`${label} must be an HTTPS URL without credentials or a fragment`);
  }
  return url.toString();
};

export const parseSignedUpdateManifest = (payload: Buffer): SignedUpdateManifest => {
  let value: unknown;
  try {
    value = JSON.parse(payload.toString('utf8'));
  } catch {
    throw new Error('Signed update manifest is not valid JSON');
  }
  if (!isRecord(value) || value.schemaVersion !== 1 || value.channel !== 'stable') {
    throw new Error('Signed update manifest has an unsupported schema or channel');
  }
  if (typeof value.version !== 'string' || !VERSION_PATTERN.test(value.version)) {
    throw new Error('Signed update manifest version is not canonical stable semver');
  }
  if (value.tag !== `desktop-v${value.version}`) {
    throw new Error('Signed update manifest tag does not match its version');
  }
  if (typeof value.publishedAt !== 'string' || !Number.isFinite(Date.parse(value.publishedAt))) {
    throw new Error('Signed update manifest publishedAt is invalid');
  }
  if (!isRecord(value.feeds)) throw new Error('Signed update manifest feeds are missing');

  const feeds: Record<string, SignedUpdateFeed> = {};
  for (const [target, candidate] of Object.entries(value.feeds)) {
    if (!/^(darwin|win32)-(x64|arm64)$/.test(target) || !isRecord(candidate)) {
      throw new Error(`Signed update manifest feed ${target} is invalid`);
    }
    if (typeof candidate.signingIdentity !== 'string' || !candidate.signingIdentity.trim()) {
      throw new Error(`Signed update manifest feed ${target} has no signing identity`);
    }
    feeds[target] = {
      url: parseHttpsUrl(candidate.url, `Signed update manifest feed ${target}`),
      signingIdentity: candidate.signingIdentity,
    };
  }
  return { ...value, feeds } as unknown as SignedUpdateManifest;
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

export const checkForSignedUpdates = async ({
  config,
  currentVersion,
  platform,
  arch,
  fetchBytes,
  updater,
}: {
  config: SignedUpdateRuntimeConfig;
  currentVersion: string;
  platform: NodeJS.Platform;
  arch: string;
  fetchBytes: (url: string) => Promise<Buffer>;
  updater: DesktopAutoUpdater;
}): Promise<'checked' | 'current' | 'unsupported'> => {
  if (platform !== 'darwin' && platform !== 'win32') return 'unsupported';
  if (!VERSION_PATTERN.test(currentVersion)) throw new Error('Current desktop version is invalid');

  const manifestUrl = parseHttpsUrl(config.manifestUrl, 'Embedded update manifest URL');
  const [payload, signature] = await Promise.all([
    fetchBytes(manifestUrl),
    fetchBytes(`${manifestUrl}.sig`),
  ]);
  const manifest = verifySignedUpdateManifest(payload, signature.toString('ascii'), config.publicKey);
  if (compareVersions(manifest.version, currentVersion) <= 0) return 'current';

  const feed = manifest.feeds[`${platform}-${arch}`];
  if (!feed) throw new Error(`Signed update manifest does not contain a feed for ${platform}-${arch}`);
  if (feed.signingIdentity !== config.signingIdentity) {
    throw new Error('Signed update feed identity does not match the identity embedded in this build');
  }

  updater.setFeedURL({
    url: feed.url,
    ...(platform === 'darwin' ? { serverType: 'json' as const } : {}),
  });
  updater.checkForUpdates();
  return 'checked';
};
