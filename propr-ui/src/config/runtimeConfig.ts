// Runtime configuration for the UI.
//
// The hosted UI is a single static bundle that serves many local stacks, so the
// API / Socket.IO base URL cannot be baked in at build time — each instance
// must talk to its own per-instance proxy (e.g. https://t-abc123.propr.dev).
// The base URL is therefore exposed on `window.__PROPR_CONFIG__` by the static
// `public/config.js`, which the hosting environment rewrites at container start
// from the `PROPR_UI_PUBLIC_API_URL` env var (see docker-entrypoint.sh).
//
// Resolution order for the API base URL:
//   1. Hosted-UI `?tunnel=` query param — Connect's per-installation deep link.
//   2. Previously selected hosted tunnel in localStorage — survives login redirects.
//   3. Runtime config (window.__PROPR_CONFIG__.apiBaseUrl) — hosted deployments.
//   4. Build-time env (VITE_API_BASE_URL) — static single-target builds.
//   5. Empty string — same-origin (local dev via the Vite proxy).

import { DEFAULT_PROPR_UI_ORIGIN, isProprProxyUrl, proprInstanceProxyUrl } from '@propr/shared';

export interface ProprRuntimeConfig {
  /** Base URL for REST and Socket.IO. Empty string means same-origin. */
  apiBaseUrl?: string;
}

export interface HostedUiConnectionIssue {
  title: string;
  message: string;
}

declare global {
  interface Window {
    __PROPR_CONFIG__?: ProprRuntimeConfig;
  }
}

const runtimeConfig: ProprRuntimeConfig =
  (typeof window !== 'undefined' && window.__PROPR_CONFIG__) || {};

export const HOSTED_TUNNEL_API_BASE_STORAGE_KEY = 'propr.hostedTunnelApiBaseUrl';

/**
 * Hostname of the managed hosted UI (e.g. `app.propr.dev`), derived from the
 * shared origin constant so there is a single source of truth.
 */
const HOSTED_UI_HOSTNAME = new URL(DEFAULT_PROPR_UI_ORIGIN).hostname;

/**
 * Whether the page is being served from the managed hosted UI origin
 * (`app.propr.dev`) — the single static bundle that serves many per-instance
 * proxies and is versioned independently from the API. Used to scope hosted-only
 * behavior (the runtime-config warning, the compatibility gate). A self-hosted
 * production deployment on its own domain (e.g. `https://propr.example.com`)
 * ships the UI and API together and is NOT a hosted-UI origin, so it is exempt
 * from both — only the actual hosted UI is gated. Exported for unit testing.
 */
export const isHostedUiOrigin = (hostname: string): boolean =>
  hostname === HOSTED_UI_HOSTNAME;

/**
 * Whether a string is an absolute http(s) URL — used to sanity-check a
 * runtime-injected API base before it is used to build request URLs. Returns
 * false for relative paths, scheme-less hosts, and malformed input. Exported for
 * unit testing.
 */
export const isValidHttpUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
};

/**
 * Resolve the Connect deep-link API base from `?tunnel=`. Connect opens the
 * hosted UI as `https://app.propr.dev?tunnel=t-<id>.propr.dev` after a
 * tunnel passes health checks. Accept only hosted ProPR proxy targets and only
 * on the managed hosted UI origin so arbitrary self-hosted pages cannot smuggle
 * a cross-origin API base through the query string.
 */
export const hostedTunnelQueryApiBaseUrl = (
  hostname: string,
  search: string
): string | null => {
  if (!isHostedUiOrigin(hostname)) return null;

  const raw = new URLSearchParams(search).get('tunnel')?.trim();
  if (!raw) return null;

  if (isProprProxyUrl(raw)) return raw.replace(/\/+$/, '');

  const instanceUrl = proprInstanceProxyUrl(raw);
  if (instanceUrl) return instanceUrl;

  try {
    const url = new URL(`https://${raw}`);
    if (/[^/]/.test(url.pathname) || url.search || url.hash) return null;
    const normalized = `https://${url.hostname}`;
    return isProprProxyUrl(normalized) ? normalized : null;
  } catch {
    return null;
  }
};

type HostedTunnelStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const storageForWindow = (): HostedTunnelStorage | undefined => {
  if (typeof window === 'undefined') return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
};

export const readStoredHostedTunnelApiBaseUrl = (
  hostname: string,
  storage: HostedTunnelStorage | undefined = storageForWindow()
): string | null => {
  if (!isHostedUiOrigin(hostname) || !storage) return null;
  try {
    const stored = storage.getItem(HOSTED_TUNNEL_API_BASE_STORAGE_KEY)?.trim();
    if (isProprProxyUrl(stored)) return stored.replace(/\/+$/, '');
    if (stored) storage.removeItem(HOSTED_TUNNEL_API_BASE_STORAGE_KEY);
  } catch {
    return null;
  }
  return null;
};

export const rememberHostedTunnelApiBaseUrl = (
  hostname: string,
  apiBaseUrl: string,
  storage: HostedTunnelStorage | undefined = storageForWindow()
): void => {
  if (!isHostedUiOrigin(hostname) || !storage || !isProprProxyUrl(apiBaseUrl)) return;
  try {
    storage.setItem(HOSTED_TUNNEL_API_BASE_STORAGE_KEY, apiBaseUrl.replace(/\/+$/, ''));
  } catch {
    // localStorage can be disabled or full. The query-param path still works for
    // the current page load; persistence is only needed across full redirects.
  }
};

/**
 * On the hosted UI origin the bundle expects `config.js` to have run first and
 * populated window.__PROPR_CONFIG__ with a per-instance apiBaseUrl. If it is
 * missing — or loaded but with an empty apiBaseUrl (the more likely
 * misconfiguration: PROPR_UI_PUBLIC_API_URL was unset at container start) — the
 * hosted app cannot know which per-instance proxy to call. Returns a warning
 * message to surface in that case, or null when nothing looks wrong. Only the
 * hosted UI origin is checked: localhost and self-hosted same-origin deployments
 * are exempt. Exported for unit testing.
 */
export const runtimeConfigWarning = (
  hostname: string,
  config: ProprRuntimeConfig | undefined,
  search = '',
  storage?: HostedTunnelStorage
): string | null => {
  if (!isHostedUiOrigin(hostname)) return null;
  if (hostedTunnelQueryApiBaseUrl(hostname, search)) return null;
  if (readStoredHostedTunnelApiBaseUrl(hostname, storage)) return null;
  if (!config) {
    return (
      '[propr] window.__PROPR_CONFIG__ is not set — config.js did not load. ' +
      'The hosted UI needs a selected tunnel before it can reach a per-instance proxy.'
    );
  }
  const apiBaseUrl = config.apiBaseUrl?.trim();
  if (!apiBaseUrl) {
    return (
      '[propr] window.__PROPR_CONFIG__.apiBaseUrl is empty — config.js loaded but ' +
      'PROPR_UI_PUBLIC_API_URL was not set at container start. ' +
      'The hosted UI needs a selected tunnel before it can reach a per-instance proxy.'
    );
  }
  // The launcher validates PROPR_UI_PUBLIC_API_URL before injecting it, but a
  // hand-served config.js or vendor-hosted injection can still provide a
  // malformed value. The base is used as `${apiBaseUrl}/api/...`, so anything
  // that is not an absolute http(s) URL (a path, a host with no scheme, junk)
  // produces broken requests — warn so hosted misconfiguration is diagnosable.
  if (!isValidHttpUrl(apiBaseUrl)) {
    return (
      `[propr] window.__PROPR_CONFIG__.apiBaseUrl is not a valid http(s) URL: "${apiBaseUrl}". ` +
      'Expected an absolute per-instance proxy URL like https://t-abc123.propr.dev. ' +
      'API calls built from this base will fail.'
    );
  }
  // Hosted UI tunnel mode is explicitly limited to per-instance proxy hosts:
  // propr-routing only forwards /api/* and /socket.io/* on
  // https://t-<id>.propr.dev. A well-formed http(s) URL pointing anywhere
  // else (e.g. https://custom.example.com) parses fine but requests will not be
  // routed to the local stack, so warn rather than letting it fail silently at
  // request time. This is a warning, not a hard block — a future hosting setup
  // could legitimately front a different proxy domain.
  if (!isProprProxyUrl(apiBaseUrl)) {
    return (
      `[propr] window.__PROPR_CONFIG__.apiBaseUrl is not a hosted ProPR proxy URL: "${apiBaseUrl}". ` +
      'Hosted UI tunnel mode only routes https://t-<id>.propr.dev, so API calls built ' +
      'from this base may not reach the local stack.'
    );
  }
  return null;
};

export const hostedUiConnectionIssue = (
  hostname: string,
  config: ProprRuntimeConfig | undefined,
  search = '',
  storage?: HostedTunnelStorage
): HostedUiConnectionIssue | null => {
  if (!isHostedUiOrigin(hostname)) return null;
  if (hostedTunnelQueryApiBaseUrl(hostname, search)) return null;
  if (readStoredHostedTunnelApiBaseUrl(hostname, storage)) return null;

  const apiBaseUrl = config?.apiBaseUrl?.trim();
  if (!apiBaseUrl) {
    return {
      title: 'Connect a ProPR stack',
      message:
        'This hosted UI needs a selected local stack before it can make API calls. Open ProPR Connect and choose a tunnel, or use the hosted UI link shown after tunnel setup.',
    };
  }
  if (!isValidHttpUrl(apiBaseUrl)) {
    return {
      title: 'Invalid hosted UI configuration',
      message:
        `The configured API URL is not a valid http(s) URL: "${apiBaseUrl}". ` +
        'Restart the stack after setting a hosted proxy URL such as https://t-abc123.propr.dev.',
    };
  }
  if (!isProprProxyUrl(apiBaseUrl)) {
    return {
      title: 'Invalid hosted UI tunnel',
      message:
        `The configured API URL is not a hosted ProPR proxy URL: "${apiBaseUrl}". ` +
        'Hosted UI tunnel mode requires a bare https://t-<id>.propr.dev URL.',
    };
  }
  return null;
};

export const resolveApiBaseUrl = (
  hostname: string,
  search: string,
  config: ProprRuntimeConfig | undefined,
  buildTimeApiBaseUrl: string | undefined,
  storage?: HostedTunnelStorage
): string => {
  const queryApiBaseUrl = hostedTunnelQueryApiBaseUrl(hostname, search);
  if (queryApiBaseUrl) {
    rememberHostedTunnelApiBaseUrl(hostname, queryApiBaseUrl, storage);
  }

  return (
    queryApiBaseUrl ||
    readStoredHostedTunnelApiBaseUrl(hostname, storage) ||
    config?.apiBaseUrl?.trim() ||
    buildTimeApiBaseUrl?.trim() ||
    ''
  ).replace(/\/+$/, '');
};

if (typeof window !== 'undefined') {
  const warning = runtimeConfigWarning(
    window.location.hostname,
    window.__PROPR_CONFIG__,
    window.location.search,
    storageForWindow()
  );
  if (warning) console.warn(warning);
}

/**
 * Resolve the base URL used for both REST API calls and the Socket.IO
 * connection so they always target the same origin. Returns an empty string
 * for same-origin requests.
 *
 * Trailing slashes are stripped here, once, so the many callers that build
 * paths as `${API_BASE_URL}/api/...` never produce a double slash (e.g.
 * `https://t-abc.propr.dev//api/compatibility`). The orchestrator already
 * normalizes the values it injects, but a hand-served `public/config.js`,
 * `VITE_API_BASE_URL`, or manually set apiBaseUrl can still carry one.
 */
export const getApiBaseUrl = (): string =>
  resolveApiBaseUrl(
    typeof window !== 'undefined' ? window.location.hostname : '',
    typeof window !== 'undefined' ? window.location.search : '',
    runtimeConfig,
    import.meta.env.VITE_API_BASE_URL,
    storageForWindow()
  );
