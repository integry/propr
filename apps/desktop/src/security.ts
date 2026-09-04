import {
  canonicalProprHttpUrlOrigin,
  isProprConnectReservedHostAttempt,
  MAX_PROPR_API_BASE_URL_LENGTH,
  parseProprConnectEndpoint,
} from '@propr/shared';
import { DESKTOP_PROTOCOL } from './shared/contract';
import {
  isProprLoopbackHostname,
} from '@propr/shared';

const DEEP_LINK_ACTIONS = new Set(['connect', 'open']);
const DESKTOP_DASHBOARD_ORIGIN = 'https://desktop.propr.invalid';
const RESERVED_DASHBOARD_PARAMETERS = new Set([
  'flow',
  'logged_out',
  'oauth_complete',
  'redirect_to',
  'tunnel',
]);

const parseUrl = (value: string): URL | null => {
  try {
    return new URL(value);
  } catch {
    return null;
  }
};

const hasCredentials = (url: URL): boolean => Boolean(url.username || url.password);

const isSafeDashboardPathForm = (value: string): boolean => {
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return false;
  if (/[\u0000-\u001F\u007F\\]/.test(value)) return false;
  const pathname = value.split(/[?#]/, 1)[0];
  return !pathname.split('/').some(segment => segment === '.' || segment === '..');
};

const isSafeDecodedPathScope = (value: string): boolean => {
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return false;
  if (/[\u0000-\u001F\u007F\\]/.test(value)) return false;
  return !value.split('/').some(segment => segment === '.' || segment === '..');
};

const isAllowedDashboardUrl = (url: URL): boolean => {
  if (url.origin !== DESKTOP_DASHBOARD_ORIGIN) return false;
  const route = url.pathname.toLowerCase().replace(/\/+$/, '') || '/';
  if (route === '/login' || route.startsWith('/login/') || route === '/desktop/pairing') return false;
  return ![...url.searchParams.keys()].some(key => RESERVED_DASHBOARD_PARAMETERS.has(key.toLowerCase()));
};

const fullyDecodeDashboardPath = (value: string): URL | null => {
  let decoded = value;
  // Keep the original path scope while decoding so encoded delimiters cannot hide traversal in a later layer.
  let decodedPathScope = value.split(/[?#]/, 1)[0];
  for (let remaining = value.length + 1; remaining > 0; remaining -= 1) {
    if (!isSafeDashboardPathForm(decoded) || !isSafeDecodedPathScope(decodedPathScope)) return null;
    let url: URL;
    try {
      url = new URL(decoded, DESKTOP_DASHBOARD_ORIGIN);
    } catch {
      return null;
    }
    if (!isAllowedDashboardUrl(url)) return null;
    if (!decoded.includes('%')) return url;
    if (/%(?![\da-f]{2})/i.test(decoded)) return null;
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) return url;
      decoded = next;
      decodedPathScope = decodeURIComponent(decodedPathScope);
    } catch {
      return null;
    }
  }
  return null;
};

export const normalizeDesktopDashboardPath = (value: string): string | null => {
  if (!value || value.length > 2_048) return null;
  const url = fullyDecodeDashboardPath(value);
  if (!url) return null;
  return `${url.pathname}${url.search}${url.hash}`;
};

export const dashboardPathFromDeepLink = (value: string): string | null => {
  if (value.length > 2_048 || /[\u0000-\u001F\u007F]/.test(value)) return null;
  const url = parseUrl(value);
  if (
    !url
    || url.protocol !== `${DESKTOP_PROTOCOL}:`
    || url.hostname !== 'open'
    || hasCredentials(url)
    || url.port
    || url.hash
    || (url.pathname !== '' && url.pathname !== '/')
  ) return null;
  const entries = [...url.searchParams.entries()];
  if (entries.length !== 1 || entries[0][0] !== 'path') return null;
  return normalizeDesktopDashboardPath(entries[0][1]);
};

export const connectApiBaseUrlFromDeepLink = (value: string): string | null => {
  if (value.length > 2_048 || /[\u0000-\u001F\u007F]/.test(value)) return null;
  const url = parseUrl(value);
  if (
    !url
    || url.protocol !== `${DESKTOP_PROTOCOL}:`
    || url.hostname !== 'connect'
    || hasCredentials(url)
    || url.port
    || url.hash
    || (url.pathname !== '' && url.pathname !== '/')
  ) return null;
  const entries = [...url.searchParams.entries()];
  if (entries.length !== 1 || entries[0][0] !== 'api') return null;
  return normalizeApiBaseUrl(entries[0][1]);
};

export const normalizeApiBaseUrl = (value: string): string | null => {
  if (value.length > MAX_PROPR_API_BASE_URL_LENGTH) return null;
  const candidate = value.trim();
  const url = parseUrl(candidate);
  if (!url || hasCredentials(url) || url.hash || url.search) return null;
  if (url.pathname.replace(/\//g, '') !== '') return null;
  if (isProprConnectReservedHostAttempt(value) && !parseProprConnectEndpoint(value)) return null;
  return canonicalProprHttpUrlOrigin(candidate);
};

export const isSafeExternalUrl = (value: string): boolean => {
  const url = parseUrl(value);
  if (!url || hasCredentials(url)) return false;
  return canonicalProprHttpUrlOrigin(value) === url.origin;
};

export const validatedDevServerUrl = (value: string | undefined): URL | null => {
  if (!value) return null;
  const url = parseUrl(value);
  if (!url || url.protocol !== 'http:' || !isProprLoopbackHostname(url.hostname) || hasCredentials(url)) return null;
  if (url.pathname !== '/' || url.search || url.hash) return null;
  if (canonicalProprHttpUrlOrigin(value) !== url.origin) return null;
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
  if (devUrl) {
    return !hasCredentials(candidateUrl)
      && canonicalProprHttpUrlOrigin(candidate) === candidateUrl.origin
      && candidateUrl.origin === devUrl.origin;
  }
  const packagedUrl = parseUrl(packagedRendererUrl);
  if (!packagedUrl || hasCredentials(candidateUrl) || candidateUrl.search) return false;
  return candidateUrl.protocol === packagedUrl.protocol
    && candidateUrl.host === packagedUrl.host
    && candidateUrl.pathname === packagedUrl.pathname;
};

export const normalizeDeepLink = (value: string): string | null => {
  if (value.length > 2_048 || /[\u0000-\u001F\u007F]/.test(value)) return null;
  const url = parseUrl(value);
  if (!url || url.protocol !== `${DESKTOP_PROTOCOL}:` || hasCredentials(url)) return null;
  if (!DEEP_LINK_ACTIONS.has(url.hostname) || url.port || url.hash) return null;
  const dashboardPath = url.hostname === 'open' ? dashboardPathFromDeepLink(value) : null;
  if (url.hostname === 'open' && dashboardPath === null) return null;
  const connectApiBaseUrl = url.hostname === 'connect' ? connectApiBaseUrlFromDeepLink(value) : null;
  if (url.hostname === 'connect' && connectApiBaseUrl === null) return null;

  const canonicalCandidate = url.href;
  if (canonicalCandidate.length > 2_048 || /[\u0000-\u001F\u007F]/.test(canonicalCandidate)) return null;
  if (
    url.hostname === 'open'
    && dashboardPathFromDeepLink(canonicalCandidate) !== dashboardPath
  ) return null;
  if (
    url.hostname === 'connect'
    && connectApiBaseUrlFromDeepLink(canonicalCandidate) !== connectApiBaseUrl
  ) return null;
  return canonicalCandidate;
};

export const deepLinkFromArguments = (argv: readonly string[]): string | null => {
  for (const argument of argv) {
    const normalized = normalizeDeepLink(argument);
    if (normalized) return normalized;
  }
  return null;
};

const rendererConnectSources = (
  development: boolean,
  apiBaseUrls: readonly string[],
): string => {
  const sources = new Set(["'self'", 'https:', 'wss:']);
  if (development) {
    sources.add('http:');
    sources.add('ws:');
  } else {
    for (const candidate of apiBaseUrls) {
      const origin = normalizeApiBaseUrl(candidate);
      if (!origin || !origin.startsWith('http://')) continue;
      sources.add(origin);
      sources.add(`ws://${origin.slice('http://'.length)}`);
    }
  }
  return [...sources].join(' ');
};

export const rendererContentSecurityPolicy = (
  development = false,
  apiBaseUrls: readonly string[] = [],
): string => [
  "default-src 'self'",
  `script-src 'self'${development ? " 'unsafe-inline'" : ''}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  // HTTPS/WSS support remote instances and ProPR Connect. Cleartext sources
  // are exact, main-validated active profile origins because CSP has no IPv4
  // CIDR syntax with which to express the normalizer's complete 127/8 range.
  `connect-src ${rendererConnectSources(development, apiBaseUrls)}`,
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'",
].join('; ');

interface ReloadableRenderer {
  isDestroyed(): boolean;
  reload(): void;
}

export const createLatestRendererReloader = (
  getCurrentRenderer: () => ReloadableRenderer | null,
  schedule: (callback: () => void) => void = callback => { setTimeout(callback, 0); },
): (() => void) => {
  let generation = 0;
  return () => {
    const scheduledGeneration = ++generation;
    schedule(() => {
      if (generation !== scheduledGeneration) return;
      const renderer = getCurrentRenderer();
      if (renderer && !renderer.isDestroyed()) renderer.reload();
    });
  };
};

export const applyDevelopmentRendererCsp = (html: string): string => {
  const packagedPolicy = rendererContentSecurityPolicy();
  if (!html.includes(packagedPolicy)) {
    throw new Error('renderer.html is missing the packaged content security policy');
  }
  return html.replace(packagedPolicy, rendererContentSecurityPolicy(true));
};
