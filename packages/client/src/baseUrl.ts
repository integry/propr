import { ProprClientError } from './errors.js';
import { normalizeProprApiOrigin } from '@propr/shared';

declare const normalizedApiBaseUrl: unique symbol;

/** Empty means browser same-origin; non-empty values are normalized HTTP(S) origins. */
export type ProprApiBaseUrl = string & { readonly [normalizedApiBaseUrl]: true };

export interface NormalizeApiBaseUrlOptions {
  /** Permit plain HTTP for a non-loopback host. Disabled by default. */
  allowInsecureHttp?: boolean;
}

const configurationError = (message: string): never => {
  throw new ProprClientError(message, { kind: 'configuration' });
};

/** Validate and normalize a REST/Socket.IO endpoint without retaining credentials. */
export const normalizeApiBaseUrl = (
  value?: string | null,
  options: NormalizeApiBaseUrlOptions = {}
): ProprApiBaseUrl => {
  const candidate = value?.trim() ?? '';
  if (!candidate) return '' as ProprApiBaseUrl;

  const normalized = normalizeProprApiOrigin(candidate, {
    allowInsecureHttp: options.allowInsecureHttp,
  });
  if (!normalized) {
    return configurationError('The ProPR API URL must be a canonical HTTPS origin, or a supported HTTP loopback origin.');
  }
  return normalized as ProprApiBaseUrl;
};

export const apiUrl = (baseUrl: ProprApiBaseUrl, path: string): string => {
  if (!path.startsWith('/') || path.startsWith('//')) {
    return configurationError('ProPR API request paths must start with exactly one slash.');
  }
  return baseUrl ? `${baseUrl}${path}` : path;
};
