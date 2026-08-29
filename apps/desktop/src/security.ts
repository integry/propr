import {
  isProprConnectReservedHostAttempt,
  MAX_PROPR_API_BASE_URL_LENGTH,
  parseProprConnectEndpoint,
} from '@propr/shared';
import { DESKTOP_PROTOCOL } from './shared/contract';

// WHATWG URL.hostname retains brackets around IPv6 literals.
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost']);
const DEEP_LINK_ACTIONS = new Set(['connect', 'open']);

const parseUrl = (value: string): URL | null => {
  try {
    return new URL(value);
  } catch {
    return null;
  }
};

const hasCredentials = (url: URL): boolean => Boolean(url.username || url.password);

export const normalizeApiBaseUrl = (value: string): string | null => {
  if (value.length > MAX_PROPR_API_BASE_URL_LENGTH) return null;
  const candidate = value.trim();
  const url = parseUrl(candidate);
  if (!url || hasCredentials(url) || url.hash || url.search) return null;
  if (url.protocol === 'http:' && !LOOPBACK_HOSTS.has(url.hostname)) return null;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.pathname.replace(/\//g, '') !== '') return null;
  if (isProprConnectReservedHostAttempt(value) && !parseProprConnectEndpoint(value)) return null;
  return url.origin;
};

export const isSafeExternalUrl = (value: string): boolean => {
  const url = parseUrl(value);
  if (!url || hasCredentials(url)) return false;
  return url.protocol === 'https:'
    || (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname));
};

export const validatedDevServerUrl = (value: string | undefined): URL | null => {
  if (!value) return null;
  const url = parseUrl(value);
  if (!url || url.protocol !== 'http:' || !LOOPBACK_HOSTS.has(url.hostname) || hasCredentials(url)) return null;
  if (url.pathname !== '/' || url.search || url.hash) return null;
  return url;
};

export const isTrustedRendererUrl = (
  candidate: string,
  devServerUrl: string | undefined,
  packagedRendererUrl: string,
): boolean => {
  const candidateUrl = parseUrl(candidate);
  if (!candidateUrl) return false;
  const devUrl = validatedDevServerUrl(devServerUrl);
  if (devUrl) return candidateUrl.origin === devUrl.origin;
  const packagedUrl = parseUrl(packagedRendererUrl);
  if (!packagedUrl || hasCredentials(candidateUrl) || candidateUrl.search) return false;
  return candidateUrl.protocol === packagedUrl.protocol
    && candidateUrl.host === packagedUrl.host
    && candidateUrl.pathname === packagedUrl.pathname;
};

export const normalizeDeepLink = (value: string): string | null => {
  if (value.length > 2_048) return null;
  const url = parseUrl(value);
  if (!url || url.protocol !== `${DESKTOP_PROTOCOL}:` || hasCredentials(url)) return null;
  if (!DEEP_LINK_ACTIONS.has(url.hostname) || url.port || url.hash) return null;
  return url.href;
};

export const deepLinkFromArguments = (argv: readonly string[]): string | null => {
  for (const argument of argv) {
    const normalized = normalizeDeepLink(argument);
    if (normalized) return normalized;
  }
  return null;
};

export const rendererContentSecurityPolicy = (development = false): string => [
  "default-src 'self'",
  `script-src 'self'${development ? " 'unsafe-inline'" : ''}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' https: http://127.0.0.1:* http://[::1]:* http://localhost:* ws://127.0.0.1:* ws://[::1]:* ws://localhost:* wss:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'",
].join('; ');

export const applyDevelopmentRendererCsp = (html: string): string => {
  const packagedPolicy = rendererContentSecurityPolicy();
  if (!html.includes(packagedPolicy)) {
    throw new Error('renderer.html is missing the packaged content security policy');
  }
  return html.replace(packagedPolicy, rendererContentSecurityPolicy(true));
};
