import {
  canonicalProprHttpUrlOrigin,
  isProprConnectReservedHostAttempt,
  isProprLoopbackHostname,
  MAX_PROPR_API_BASE_URL_LENGTH,
  parseProprConnectEndpoint,
} from '@propr/shared';
import { ProprClientError } from './errors.js';

declare const normalizedApiBaseUrl: unique symbol;

/** Empty means browser same-origin; non-empty values are normalized HTTP(S) origins. */
export type ProprApiBaseUrl = string & { readonly [normalizedApiBaseUrl]: true };

export interface NormalizeApiBaseUrlOptions {
  /** Permit plain HTTP for a non-loopback host. Disabled by default. */
  allowInsecureHttp?: boolean;
}

export type ProprApiEndpointKind = 'same-origin' | 'loopback' | 'remote' | 'propr-connect';

export interface ProprApiEndpointClassification {
  baseUrl: ProprApiBaseUrl;
  kind: ProprApiEndpointKind;
  /** Present only after exact ProPR Connect hostname verification. */
  connectInstanceId?: string;
}

const configurationError = (message: string): never => {
  throw new ProprClientError(message, { kind: 'configuration', code: 'INVALID_API_BASE_URL' });
};

const invalidApiBaseUrl = (): never =>
  configurationError('The configured ProPR API URL is invalid.');

/** Validate and normalize a REST/Socket.IO endpoint without retaining credentials. */
export const normalizeApiBaseUrl = (
  value?: string | null,
  options: NormalizeApiBaseUrlOptions = {}
): ProprApiBaseUrl => {
  if (typeof value === 'string' && value.length > MAX_PROPR_API_BASE_URL_LENGTH) {
    return invalidApiBaseUrl();
  }
  const candidate = value?.trim() ?? '';
  if (!candidate) return '' as ProprApiBaseUrl;

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return invalidApiBaseUrl();
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return invalidApiBaseUrl();
  }
  if (parsed.username || parsed.password) {
    return invalidApiBaseUrl();
  }
  if (parsed.search || parsed.hash) {
    return invalidApiBaseUrl();
  }
  if (parsed.pathname.replace(/\//g, '') !== '') {
    return invalidApiBaseUrl();
  }
  if (isProprConnectReservedHostAttempt(value) && !parseProprConnectEndpoint(value)) {
    return invalidApiBaseUrl();
  }

  const normalized = canonicalProprHttpUrlOrigin(candidate, {
    allowInsecureHttp: options.allowInsecureHttp,
  });
  if (!normalized) {
    return invalidApiBaseUrl();
  }
  return normalized as ProprApiBaseUrl;
};

/** Normalize an API origin and identify only the exact ProPR Connect shape. */
export const classifyApiBaseUrl = (
  value?: string | null,
  options: NormalizeApiBaseUrlOptions = {}
): ProprApiEndpointClassification => {
  const baseUrl = normalizeApiBaseUrl(value, options);
  if (!baseUrl) return { baseUrl, kind: 'same-origin' };

  // Classify the original spelling, not the normalized origin. Otherwise an
  // encoded or Unicode authority could acquire the trusted Connect label only
  // after WHATWG URL canonicalization.
  const connect = parseProprConnectEndpoint(value);
  if (connect) {
    return { baseUrl, kind: 'propr-connect', connectInstanceId: connect.instanceId };
  }
  return {
    baseUrl,
    kind: isProprLoopbackHostname(new URL(baseUrl).hostname) ? 'loopback' : 'remote',
  };
};

export const apiUrl = (baseUrl: ProprApiBaseUrl, path: string): string => {
  if (!path.startsWith('/') || path.startsWith('//')) {
    return configurationError('ProPR API request paths must start with exactly one slash.');
  }
  return baseUrl ? `${baseUrl}${path}` : path;
};
