import { createPublicKey } from 'node:crypto';

export type Environment = Readonly<Record<string, string | undefined>>;

export interface TrustedUpdateBuildConfig {
  enabled: boolean;
  manifestUrl: string;
  publicKey: string;
  signingIdentity: string;
}

const RELEASE_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export const resolveDesktopVersion = (packageVersion: string, env: Environment = process.env): string => {
  const version = env.PROPR_DESKTOP_VERSION?.trim() || packageVersion;
  if (!RELEASE_VERSION_PATTERN.test(version)) {
    throw new Error(`ProPR Desktop version must be canonical stable semver (received ${JSON.stringify(version)})`);
  }
  return version;
};

const validateHttpsUrl = (value: string, label: string): string => {
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

const validateEd25519PublicKey = (value: string): string => {
  try {
    const key = createPublicKey({ key: Buffer.from(value, 'base64'), format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('wrong key type');
  } catch {
    throw new Error('PROPR_DESKTOP_UPDATE_PUBLIC_KEY must be a base64-encoded Ed25519 SPKI DER public key');
  }
  return value;
};

export const resolveTrustedUpdateBuildConfig = (
  env: Environment = process.env,
): TrustedUpdateBuildConfig => {
  if (env.PROPR_DESKTOP_ENABLE_UPDATES !== '1') {
    return { enabled: false, manifestUrl: '', publicKey: '', signingIdentity: '' };
  }
  if (env.PROPR_DESKTOP_CODE_SIGNED !== '1') {
    throw new Error('Signed updates require PROPR_DESKTOP_CODE_SIGNED=1 from the trusted signing job');
  }

  const manifestUrl = env.PROPR_DESKTOP_UPDATE_MANIFEST_URL?.trim();
  const publicKey = env.PROPR_DESKTOP_UPDATE_PUBLIC_KEY?.trim();
  const signingIdentity = env.PROPR_DESKTOP_UPDATE_SIGNING_IDENTITY?.trim();
  if (!manifestUrl || !publicKey || !signingIdentity) {
    throw new Error(
      'Signed updates require PROPR_DESKTOP_UPDATE_MANIFEST_URL, PROPR_DESKTOP_UPDATE_PUBLIC_KEY, and PROPR_DESKTOP_UPDATE_SIGNING_IDENTITY',
    );
  }

  return {
    enabled: true,
    manifestUrl: validateHttpsUrl(manifestUrl, 'PROPR_DESKTOP_UPDATE_MANIFEST_URL'),
    publicKey: validateEd25519PublicKey(publicKey),
    signingIdentity,
  };
};

interface CompleteEnvironmentGroup {
  [name: string]: string;
}

export const readCompleteEnvironmentGroup = (
  env: Environment,
  names: readonly string[],
  label: string,
): CompleteEnvironmentGroup | undefined => {
  const present = names.filter(name => Boolean(env[name]?.trim()));
  if (present.length === 0) return undefined;
  if (present.length !== names.length) {
    const missing = names.filter(name => !env[name]?.trim());
    throw new Error(`${label} configuration is incomplete; missing ${missing.join(', ')}`);
  }
  return Object.fromEntries(names.map(name => [name, env[name]!.trim()]));
};
