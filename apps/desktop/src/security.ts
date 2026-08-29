import { DESKTOP_PROTOCOL } from './shared/contract';

// WHATWG URL.hostname retains brackets around IPv6 literals.
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost']);
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

export const normalizeApiBaseUrl = (value: string): string | null => {
  const url = parseUrl(value.trim());
  if (!url || hasCredentials(url) || url.hash || url.search) return null;
  if (url.protocol === 'http:' && !LOOPBACK_HOSTS.has(url.hostname)) return null;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.pathname.replace(/\//g, '') !== '') return null;
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
  if (value.length > 2_048 || /[\u0000-\u001F\u007F]/.test(value)) return null;
  const url = parseUrl(value);
  if (!url || url.protocol !== `${DESKTOP_PROTOCOL}:` || hasCredentials(url)) return null;
  if (!DEEP_LINK_ACTIONS.has(url.hostname) || url.port || url.hash) return null;
  if (url.hostname === 'open' && !dashboardPathFromDeepLink(value)) return null;
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
