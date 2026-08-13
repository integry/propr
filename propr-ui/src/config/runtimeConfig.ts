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
//   2. Previously selected hosted tunnel in sessionStorage — tab-scoped, survives
//      same-tab navigation and OAuth redirects. The stored value is only trusted
//      when the URL carries a matching flow token (?flow=<id>) and the current
//      browsing context carries the matching tab id. If a cross-site OAuth
//      redirect clears window.name, an OAuth-only continuation cookie can restore
//      that tab id once. Copied sessionStorage or copied URLs in a fresh context
//      are rejected.
//   3. Runtime config (window.__PROPR_CONFIG__.apiBaseUrl) — hosted deployments.
//   4. Build-time env (VITE_API_BASE_URL) — static single-target builds.
//   5. Empty string — same-origin (local dev via the Vite proxy).
//
// Flow-token lifecycle:
//   - On a ?tunnel= load, random flow and tab ids are generated, stored in
//     sessionStorage alongside the tunnel URL, and the flow is embedded in the
//     page URL via history.replaceState (replacing ?tunnel= with ?flow=<id>).
//   - The flowId is threaded through same-tab full-page navigations:
//     * A Router-level sync keeps ?flow= on SPA route changes.
//     * Auth redirects to /login preserve ?flow= in the URL.
//     * The login page includes ?flow= in the OAuth redirect_to so the callback
//       URL also carries it, restoring URL authority after GitHub OAuth.
//   - A new tab opened to app.propr.dev (no tunnel/flow in URL) never has URL
//     authority, even if sessionStorage was copied from an existing tab.

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
/** Paired with HOSTED_TUNNEL_API_BASE_STORAGE_KEY; must match the URL ?flow= param to be trusted. */
export const HOSTED_TUNNEL_FLOW_ID_KEY = 'propr.hostedTunnelFlowId';
/** Paired with HOSTED_TUNNEL_FLOW_ID_KEY; must match this browsing context's window.name token. */
export const HOSTED_TUNNEL_CONTEXT_ID_KEY = 'propr.hostedTunnelContextId';
export const HOSTED_TUNNEL_OAUTH_CONTINUATION_COOKIE = 'propr.hostedTunnelOAuthContinuation';

const WINDOW_NAME_CONTEXT_PREFIX = 'propr-hosted-flow-context:';
const WINDOW_NAME_CONTEXT_SEPARATOR = '|';
const OAUTH_CONTINUATION_MAX_AGE_SECONDS = 10 * 60;

let activeHostedTunnelFlowId: string | null = null;

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
    return window.sessionStorage;
  } catch {
    return undefined;
  }
};

/** Generate a random per-tab flow token. */
const generateFlowId = (): string => {
  try {
    return crypto.randomUUID();
  } catch {
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
  }
};

const generateHostedTunnelContextId = (): string => generateFlowId();

const contextIdFromWindowName = (name: string): string | null => {
  if (!name.startsWith(WINDOW_NAME_CONTEXT_PREFIX)) return null;
  const rest = name.slice(WINDOW_NAME_CONTEXT_PREFIX.length);
  const separatorIndex = rest.indexOf(WINDOW_NAME_CONTEXT_SEPARATOR);
  const contextId = (separatorIndex === -1 ? rest : rest.slice(0, separatorIndex)).trim();
  return contextId || null;
};

const currentHostedTunnelContextId = (): string | null => {
  if (typeof window === 'undefined') return null;
  try {
    return contextIdFromWindowName(window.name);
  } catch {
    return null;
  }
};

const setHostedTunnelContextId = (contextId: string): string | null => {
  if (typeof window === 'undefined') return contextId;
  try {
    const existing = window.name || '';
    const separatorIndex = existing.indexOf(WINDOW_NAME_CONTEXT_SEPARATOR);
    const preservedName = existing.startsWith(WINDOW_NAME_CONTEXT_PREFIX)
      ? (separatorIndex === -1 ? '' : existing.slice(separatorIndex + 1))
      : existing;
    window.name = `${WINDOW_NAME_CONTEXT_PREFIX}${contextId}${WINDOW_NAME_CONTEXT_SEPARATOR}${preservedName}`;
    return contextId;
  } catch {
    return null;
  }
};

const ensureHostedTunnelContextId = (): string | null => {
  const existing = currentHostedTunnelContextId();
  if (existing) return existing;
  return setHostedTunnelContextId(generateHostedTunnelContextId());
};

/** Extract the `?flow=` token from a URL search string. */
const flowIdFromSearch = (search: string): string | null =>
  new URLSearchParams(search).get('flow') || null;

const readCookie = (name: string): string | null => {
  if (typeof document === 'undefined') return null;
  try {
    const prefix = `${name}=`;
    const cookie = document.cookie
      .split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(prefix));
    return cookie ? decodeURIComponent(cookie.slice(prefix.length)) : null;
  } catch {
    return null;
  }
};

const writeCookie = (name: string, value: string, maxAgeSeconds: number): void => {
  if (typeof document === 'undefined') return;
  try {
    const secure =
      typeof window !== 'undefined' && window.location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAgeSeconds}; SameSite=Lax${secure}`;
  } catch { /* cookies can be disabled */ }
};

const clearCookie = (name: string): void => {
  writeCookie(name, '', 0);
};

type OAuthContinuationMap = Record<string, string>;

const readOAuthContinuationMap = (): OAuthContinuationMap => {
  const raw = readCookie(HOSTED_TUNNEL_OAUTH_CONTINUATION_COOKIE);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    );
  } catch {
    return {};
  }
};

const writeOAuthContinuationMap = (continuations: OAuthContinuationMap): void => {
  if (Object.keys(continuations).length === 0) {
    clearCookie(HOSTED_TUNNEL_OAUTH_CONTINUATION_COOKIE);
    return;
  }
  writeCookie(
    HOSTED_TUNNEL_OAUTH_CONTINUATION_COOKIE,
    JSON.stringify(continuations),
    OAUTH_CONTINUATION_MAX_AGE_SECONDS
  );
};

const readOAuthContinuationContextId = (
  flowId: string,
  storedContextId: string
): string | null => {
  const continuations = readOAuthContinuationMap();
  if (continuations[flowId] !== storedContextId) return null;
  delete continuations[flowId];
  writeOAuthContinuationMap(continuations);
  return setHostedTunnelContextId(storedContextId);
};

const effectiveHostedTunnelContextId = (
  flowId: string,
  storedContextId: string,
  contextId: string | null | undefined
): string | null => {
  const currentContextId = contextId === undefined ? currentHostedTunnelContextId() : contextId;
  if (currentContextId) return currentContextId;
  if (contextId !== undefined) return null;
  return readOAuthContinuationContextId(flowId, storedContextId);
};

/**
 * Store the selected hosted tunnel URL in sessionStorage together with a
 * per-tab flow token. Returns the generated flow token (to be embedded in the
 * page URL by the caller), or null if nothing was stored.
 */
export const rememberHostedTunnelApiBaseUrl = (
  hostname: string,
  apiBaseUrl: string,
  storage: HostedTunnelStorage | undefined = storageForWindow(),
  contextId: string | null = ensureHostedTunnelContextId()
): string | null => {
  if (!isHostedUiOrigin(hostname) || !storage || !contextId || !isProprProxyUrl(apiBaseUrl)) return null;
  try {
    const flowId = generateFlowId();
    storage.setItem(HOSTED_TUNNEL_API_BASE_STORAGE_KEY, apiBaseUrl.replace(/\/+$/, ''));
    storage.setItem(HOSTED_TUNNEL_FLOW_ID_KEY, flowId);
    storage.setItem(HOSTED_TUNNEL_CONTEXT_ID_KEY, contextId);
    return flowId;
  } catch {
    // sessionStorage can be disabled or full.
    return null;
  }
};

/**
 * Read the previously stored hosted tunnel URL from sessionStorage, but only
 * when the supplied `flowId` matches the stored per-tab token. A new browsing
 * context whose sessionStorage was copied from another tab (window.open(),
 * duplicate-tab) but whose URL carries no valid flow token is rejected here,
 * preventing silent cross-tab tunnel inheritance.
 */
export const readStoredHostedTunnelApiBaseUrl = (
  hostname: string,
  flowId: string | null,
  storage: HostedTunnelStorage | undefined = storageForWindow(),
  contextId?: string | null
): string | null => {
  if (!isHostedUiOrigin(hostname) || !storage) return null;
  try {
    const storedFlowId = storage.getItem(HOSTED_TUNNEL_FLOW_ID_KEY)?.trim() || null;
    const storedContextId = storage.getItem(HOSTED_TUNNEL_CONTEXT_ID_KEY)?.trim() || null;
    // Reject if storage has no flow token (never legitimately set by this tab)
    // or context token, or if the URL/current tab tokens do not match storage.
    if (!storedFlowId || storedFlowId !== flowId || !storedContextId) {
      return null;
    }
    if (effectiveHostedTunnelContextId(storedFlowId, storedContextId, contextId) !== storedContextId) {
      return null;
    }
    const stored = storage.getItem(HOSTED_TUNNEL_API_BASE_STORAGE_KEY)?.trim();
    if (stored && isProprProxyUrl(stored)) return stored.replace(/\/+$/, '');
    if (stored) storage.removeItem(HOSTED_TUNNEL_API_BASE_STORAGE_KEY);
  } catch {
    return null;
  }
  return null;
};

export const prepareHostedTunnelOAuthContinuation = (
  hostname = typeof window !== 'undefined' ? window.location.hostname : '',
  storage: HostedTunnelStorage | undefined = storageForWindow(),
  contextId: string | null = currentHostedTunnelContextId()
): void => {
  if (!isHostedUiOrigin(hostname) || !storage || !activeHostedTunnelFlowId || !contextId) return;
  try {
    const storedFlowId = storage.getItem(HOSTED_TUNNEL_FLOW_ID_KEY)?.trim() || null;
    const storedContextId = storage.getItem(HOSTED_TUNNEL_CONTEXT_ID_KEY)?.trim() || null;
    if (storedFlowId !== activeHostedTunnelFlowId || storedContextId !== contextId) return;
    writeOAuthContinuationMap({
      ...readOAuthContinuationMap(),
      [storedFlowId]: storedContextId,
    });
  } catch { /* sessionStorage can be unavailable */ }
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
  storage?: HostedTunnelStorage,
  contextId?: string | null
): string | null => {
  if (!isHostedUiOrigin(hostname)) return null;
  if (hostedTunnelQueryApiBaseUrl(hostname, search)) return null;
  if (readStoredHostedTunnelApiBaseUrl(hostname, flowIdFromSearch(search), storage, contextId)) return null;
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
  storage?: HostedTunnelStorage,
  contextId?: string | null
): HostedUiConnectionIssue | null => {
  if (!isHostedUiOrigin(hostname)) return null;
  if (hostedTunnelQueryApiBaseUrl(hostname, search)) return null;
  if (readStoredHostedTunnelApiBaseUrl(hostname, flowIdFromSearch(search), storage, contextId)) return null;

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

export const getActiveHostedTunnelFlowId = (): string | null => activeHostedTunnelFlowId;

export const pathWithActiveHostedTunnelFlow = (
  path: string,
  hostname = typeof window !== 'undefined' ? window.location.hostname : '',
  flowId = activeHostedTunnelFlowId
): string => {
  if (!isHostedUiOrigin(hostname)) return path;
  try {
    const url = new URL(path, DEFAULT_PROPR_UI_ORIGIN);
    const params = new URLSearchParams(url.search);
    params.delete('flow');
    if (flowId) params.set('flow', flowId);
    const search = params.toString();
    return `${url.pathname}${search ? `?${search}` : ''}${url.hash}`;
  } catch {
    return path;
  }
};

export const activateStoredHostedTunnelFlow = (
  hostname: string,
  search: string,
  storage?: HostedTunnelStorage,
  contextId?: string | null
): string | null => {
  const flowId = flowIdFromSearch(search);
  if (readStoredHostedTunnelApiBaseUrl(hostname, flowId, storage, contextId)) {
    activeHostedTunnelFlowId = flowId;
    return flowId;
  }
  activeHostedTunnelFlowId = null;
  return null;
};

/* eslint-disable max-params */
export const resolveApiBaseUrl = (
  hostname: string,
  search: string,
  config: ProprRuntimeConfig | undefined,
  buildTimeApiBaseUrl: string | undefined,
  storage?: HostedTunnelStorage,
  contextId?: string | null
): string => {
  const queryApiBaseUrl = hostedTunnelQueryApiBaseUrl(hostname, search);
  if (queryApiBaseUrl) {
    activeHostedTunnelFlowId = rememberHostedTunnelApiBaseUrl(hostname, queryApiBaseUrl, storage, contextId);
  }

  const flowId = flowIdFromSearch(search);
  const storedApiBaseUrl = readStoredHostedTunnelApiBaseUrl(hostname, flowId, storage, contextId);
  if (!queryApiBaseUrl && storedApiBaseUrl) activeHostedTunnelFlowId = flowId;

  return (
    queryApiBaseUrl ||
    storedApiBaseUrl ||
    config?.apiBaseUrl?.trim() ||
    buildTimeApiBaseUrl?.trim() ||
    ''
  ).replace(/\/+$/, '');
};
/* eslint-enable max-params */

if (typeof window !== 'undefined') {
  // Retire the old origin-global localStorage selection. Its value is NOT
  // migrated into sessionStorage: pulling an ambiguous global selection into
  // an unrelated new tab would violate the per-tab isolation guarantee.
  try { window.localStorage.removeItem(HOSTED_TUNNEL_API_BASE_STORAGE_KEY); } catch { /* ignore */ }

  // When a ?tunnel= deep link is present, store the validated tunnel URL in
  // sessionStorage with fresh flow/context tokens, then replace ?tunnel= in the
  // URL with ?flow=<id>. On reload/OAuth callback, re-activate the flow only if
  // the URL flow and this browsing context's window.name token both match the
  // stored selection.
  const originalSearch = window.location.search;
  const queryApiBaseUrl = hostedTunnelQueryApiBaseUrl(window.location.hostname, originalSearch);
  if (queryApiBaseUrl) {
    const flowId = rememberHostedTunnelApiBaseUrl(window.location.hostname, queryApiBaseUrl, storageForWindow());
    if (flowId) {
      activeHostedTunnelFlowId = flowId;
      try {
        const params = new URLSearchParams(originalSearch);
        params.delete('tunnel');
        params.set('flow', flowId);
        window.history.replaceState(
          null,
          '',
          window.location.pathname + '?' + params.toString() + window.location.hash
        );
      } catch { /* history API unavailable */ }
    }
  } else {
    activateStoredHostedTunnelFlow(window.location.hostname, originalSearch, storageForWindow());
  }

  const warning = runtimeConfigWarning(
    window.location.hostname,
    window.__PROPR_CONFIG__,
    originalSearch,
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
