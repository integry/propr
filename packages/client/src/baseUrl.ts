import { ProprClientError } from './errors.js';

declare const normalizedApiBaseUrl: unique symbol;

/** Empty means browser same-origin; non-empty values are normalized HTTP(S) origins. */
export type ProprApiBaseUrl = string & { readonly [normalizedApiBaseUrl]: true };

export interface NormalizeApiBaseUrlOptions {
  /** Permit plain HTTP for a non-loopback host. Disabled by default. */
  allowInsecureHttp?: boolean;
}

const isLoopbackHostname = (hostname: string): boolean => {
  const normalized = hostname.toLowerCase().replace(/\.$/, '');
  if (normalized === 'localhost' || normalized.endsWith('.localhost') || normalized === '[::1]') return true;
  const parts = normalized.split('.');
  return parts.length === 4
    && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
    && Number(parts[0]) === 127;
};

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

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return configurationError('The ProPR API URL must be an absolute HTTP(S) URL.');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return configurationError('The ProPR API URL must use HTTP or HTTPS.');
  }
  if (parsed.username || parsed.password) {
    return configurationError('The ProPR API URL must not contain embedded credentials.');
  }
  if (parsed.search || parsed.hash) {
    return configurationError('The ProPR API URL must not contain a query string or fragment.');
  }
  if (parsed.pathname.replace(/\//g, '') !== '') {
    return configurationError('The ProPR API URL must be an origin without a path.');
  }
  if (
    parsed.protocol === 'http:'
    && !isLoopbackHostname(parsed.hostname)
    && options.allowInsecureHttp !== true
  ) {
    return configurationError('Plain HTTP is only allowed for loopback ProPR API URLs.');
  }

  return parsed.origin as ProprApiBaseUrl;
};

export const apiUrl = (baseUrl: ProprApiBaseUrl, path: string): string => {
  if (!path.startsWith('/') || path.startsWith('//')) {
    return configurationError('ProPR API request paths must start with exactly one slash.');
  }
  return baseUrl ? `${baseUrl}${path}` : path;
};
