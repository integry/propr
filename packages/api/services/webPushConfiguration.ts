import { createECDH, timingSafeEqual } from 'node:crypto';

export interface WebPushServerConfiguration {
  enabled?: boolean;
  subject?: string;
  publicKey?: string;
  privateKey?: string;
}

export type WebPushConfigurationIssue =
  | 'disabled'
  | 'missing'
  | 'invalid_subject'
  | 'malformed'
  | 'mismatched'
  | 'storage_invalid'
  | 'storage_unavailable';

export type ValidatedWebPushConfiguration =
  | { configured: false; issue: WebPushConfigurationIssue }
  | {
    configured: true;
    issue: null;
    subject: string;
    publicKey: string;
    privateKey: string;
  };

const ENABLED_VALUES = new Set(['1', 'true', 'yes', 'on']);
const DISABLED_VALUES = new Set(['0', 'false', 'no', 'off']);

function configuredEnablement(value: string | undefined): boolean {
  if (value === undefined || value.trim() === '') return true;
  const normalized = value.trim().toLowerCase();
  if (ENABLED_VALUES.has(normalized)) return true;
  if (DISABLED_VALUES.has(normalized)) return false;
  return false;
}

export function webPushConfigurationFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): WebPushServerConfiguration {
  return {
    enabled: configuredEnablement(environment.WEB_PUSH_ENABLED),
    subject: environment.WEB_PUSH_VAPID_SUBJECT,
    publicKey: environment.WEB_PUSH_VAPID_PUBLIC_KEY,
    privateKey: environment.WEB_PUSH_VAPID_PRIVATE_KEY,
  };
}

function decodeVapidKey(value: unknown, expectedBytes: number): Buffer | null {
  const expectedLength = Math.ceil(expectedBytes * 8 / 6);
  if (
    typeof value !== 'string'
    || value.length !== expectedLength
    || value !== value.trim()
    || !/^[A-Za-z0-9_-]+$/.test(value)
  ) return null;

  const decoded = Buffer.from(value, 'base64url');
  return decoded.length === expectedBytes && decoded.toString('base64url') === value
    ? decoded
    : null;
}

export function validVapidSubject(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) return false;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:') {
      return url.hostname.length > 0 && url.username === '' && url.password === '';
    }
    return url.protocol === 'mailto:'
      && url.pathname.length > 0
      && url.pathname.includes('@')
      && url.search === ''
      && url.hash === '';
  } catch {
    return false;
  }
}

/** Validate the complete process-static configuration without exposing key material. */
export function validateWebPushConfiguration(
  configuration: WebPushServerConfiguration,
): ValidatedWebPushConfiguration {
  if (configuration.enabled === false) return { configured: false, issue: 'disabled' };
  if (!configuration.subject || !configuration.publicKey || !configuration.privateKey) {
    return { configured: false, issue: 'missing' };
  }
  if (!validVapidSubject(configuration.subject)) {
    return { configured: false, issue: 'invalid_subject' };
  }

  const publicKey = decodeVapidKey(configuration.publicKey, 65);
  const privateKey = decodeVapidKey(configuration.privateKey, 32);
  if (!publicKey || publicKey[0] !== 0x04 || !privateKey) {
    return { configured: false, issue: 'malformed' };
  }

  try {
    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(privateKey);
    if (!timingSafeEqual(publicKey, ecdh.getPublicKey(undefined, 'uncompressed'))) {
      return { configured: false, issue: 'mismatched' };
    }
  } catch {
    return { configured: false, issue: 'malformed' };
  }

  return {
    configured: true,
    issue: null,
    subject: configuration.subject,
    publicKey: publicKey.toString('base64url'),
    privateKey: privateKey.toString('base64url'),
  };
}

export const WEB_PUSH_CONFIGURATION_WARNINGS: Readonly<
  Record<Exclude<WebPushConfigurationIssue, 'disabled'>, string>
> = {
  missing: 'VAPID key configuration is missing or incomplete; set both WEB_PUSH_VAPID_PUBLIC_KEY and WEB_PUSH_VAPID_PRIVATE_KEY, or remove both for automatic setup',
  invalid_subject: 'VAPID subject is malformed; set WEB_PUSH_VAPID_SUBJECT to an HTTPS contact URL or mailto address',
  malformed: 'VAPID public/private keys are malformed; correct both environment keys or remove both for automatic setup',
  mismatched: 'VAPID public/private keys do not match; configure both keys from the same pair',
  storage_invalid: 'Stored Web Push identity is invalid or has unsafe permissions; restore web-push/vapid.json from backup with directory mode 700 and file mode 600. No keys were replaced',
  storage_unavailable: 'Web Push identity storage is unavailable; check the mounted instance database data directory, ownership, free space and write permissions, then restart. No transient key is advertised',
};
