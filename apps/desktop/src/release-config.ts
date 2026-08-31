import { createPublicKey } from 'node:crypto';

export type Environment = Readonly<Record<string, string | undefined>>;

export interface TrustedUpdateBuildConfig {
  enabled: boolean;
  manifestUrl: string;
  publicKey: string;
  signingIdentity: string;
  windowsSignerPins: readonly string[];
}

const RELEASE_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const WINDOWS_SIGNER_PIN_PATTERN = /^(?:certificate|spki)-sha256:[a-f0-9]{64}$/;
const MAX_WINDOWS_SIGNER_PINS = 16;

export const parseWindowsSignerPins = (
  value: string | undefined,
  label = 'PROPR_DESKTOP_WINDOWS_SIGNER_PINS',
): readonly string[] => {
  if (!value) throw new Error(`${label} is required`);
  const pins = value.split(',');
  if (pins.length > MAX_WINDOWS_SIGNER_PINS
    || pins.some(pin => !WINDOWS_SIGNER_PIN_PATTERN.test(pin))
    || new Set(pins).size !== pins.length
    || pins.join(',') !== [...pins].sort().join(',')) {
    throw new Error(
      `${label} must be a sorted, unique comma-separated allowlist of canonical certificate-sha256 or spki-sha256 fingerprints`,
    );
  }
  return pins;
};

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
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) {
    throw new Error(`${label} must be an HTTPS URL without credentials, a fragment, or a query`);
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
  platform: NodeJS.Platform = process.platform,
): TrustedUpdateBuildConfig => {
  // Windows self-update is deliberately outside the first-release MVP. This
  // check precedes every update environment validation so even a fully (or
  // partially) configured Windows build embeds no update endpoint or key.
  if (platform === 'win32') {
    return { enabled: false, manifestUrl: '', publicKey: '', signingIdentity: '', windowsSignerPins: [] };
  }
  if (env.PROPR_DESKTOP_ENABLE_UPDATES !== '1') {
    return { enabled: false, manifestUrl: '', publicKey: '', signingIdentity: '', windowsSignerPins: [] };
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
    windowsSignerPins: [],
  };
};

interface CompleteEnvironmentGroup {
  [name: string]: string;
}

interface CompleteEnvironmentGroupOptions<Name extends string> {
  opaqueNames?: readonly Name[];
}

export const readCompleteEnvironmentGroup = <const Name extends string>(
  env: Environment,
  names: readonly Name[],
  label: string,
  { opaqueNames = [] }: CompleteEnvironmentGroupOptions<Name> = {},
): Record<Name, string> | undefined => {
  const present = names.filter(name => Boolean(env[name]?.trim()));
  if (present.length === 0) return undefined;
  if (present.length !== names.length) {
    const missing = names.filter(name => !env[name]?.trim());
    throw new Error(`${label} configuration is incomplete; missing ${missing.join(', ')}`);
  }
  const opaque = new Set(opaqueNames);
  return Object.fromEntries(
    names.map(name => [name, opaque.has(name) ? env[name]! : env[name]!.trim()]),
  ) as Record<Name, string>;
};

export const requireProductionReleaseConfiguration = ({
  platform,
  updateConfig,
  macSigning,
  macNotarization,
  windowsSigning,
  windowsSignerPins = [],
}: {
  platform: NodeJS.Platform;
  updateConfig: TrustedUpdateBuildConfig;
  macSigning?: CompleteEnvironmentGroup;
  macNotarization?: CompleteEnvironmentGroup;
  windowsSigning?: CompleteEnvironmentGroup;
  windowsSignerPins?: readonly string[];
}): void => {
  if (platform === 'darwin' && (!macSigning || !macNotarization || !updateConfig.enabled)) {
    throw new Error('Production macOS releases require signing, notarization, and signed updates');
  }
  if (platform === 'win32' && !windowsSigning) {
    throw new Error('Production Windows releases require Authenticode signing; Windows self-update is unsupported');
  }
  if (platform === 'win32' && windowsSignerPins.length === 0) {
    throw new Error('Production Windows releases require an Authenticode certificate or SPKI SHA-256 artifact signer pin');
  }
};
