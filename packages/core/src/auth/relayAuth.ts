import type {
  EndpointOptions,
  OctokitResponse,
  RequestInterface,
  RequestParameters,
  Route,
} from '@octokit/types';

/**
 * Custom Octokit auth strategy for the GitHub token relay (auth path 2).
 *
 * Instead of minting installation tokens locally from the App private key
 * (createAppAuth), this strategy fetches short-lived installation access tokens
 * from a vendor-run relay endpoint authenticated by a durable per-stack relay
 * credential. The vendor holds the shared App's private key; the self-hosted
 * stack holds only the relay token.
 *
 * It mirrors createAppAuth's *installation* behavior so every existing call site
 * (`getAuthenticatedOctokit()`, `octokit.auth({ type: 'installation' })`) keeps
 * working unchanged. Tokens are cached in-memory until shortly before expiry.
 */

export interface RelayAuthStrategyOptions {
  relayUrl: string;
  relayToken: string;
  installationId?: string;
}

export interface RelayInstallationAuthentication {
  type: 'token';
  tokenType: 'installation';
  token: string;
  permissions?: Record<string, string>;
  repositoryIds?: number[];
}

export interface RelayAuthOptions {
  refresh?: boolean;
  type?: string;
  permissions?: Record<string, string>;
  repositoryIds?: number[];
}

export interface RelayAuthInterface {
  (options?: RelayAuthOptions): Promise<RelayInstallationAuthentication>;
  hook(
    request: RequestInterface,
    route: Route | EndpointOptions,
    parameters?: RequestParameters,
  ): Promise<OctokitResponse<unknown>>;
}

interface RelayTokenResponse {
  token?: string;
  expires_at?: string;
  permissions?: Record<string, string>;
  repositories?: Array<{ id: number }>;
}

// Refresh slightly before the token actually expires, mirroring createAppAuth.
const REFRESH_MARGIN_MS = 60_000;
// Fallback lifetime if the relay omits expires_at (GitHub installation tokens
// last 1 hour).
const DEFAULT_TOKEN_TTL_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;

function assertRelayTokenScope(data: RelayTokenResponse, options: RelayAuthOptions): void {
    // Old relays may ignore unknown request fields. Never treat their full token
    // as scoped: require the mint response to attest to the requested limits.
    if (options.permissions && (!data.permissions
        || Object.entries(data.permissions).some(([key, value]) => options.permissions![key] !== value)
        || Object.keys(options.permissions).some(key => data.permissions![key] !== options.permissions![key]))) {
      throw new Error('GitHub token relay did not honor scoped permissions; update the relay before launching agents.');
    }
    if (options.repositoryIds && (!data.repositories
        || data.repositories.length !== options.repositoryIds.length
        || data.repositories.some(repo => !options.repositoryIds!.includes(repo.id)))) {
      throw new Error('GitHub token relay did not honor the context repository restriction.');
    }
}

export function createRelayAuth(strategyOptions: RelayAuthStrategyOptions): RelayAuthInterface {
  const { relayUrl, relayToken, installationId } = strategyOptions;
  const endpoint = `${relayUrl.replace(/\/+$/, '')}/installation-token`;
  type CacheEntry = { auth?: RelayInstallationAuthentication; expiresAt: number; pending?: Promise<RelayInstallationAuthentication> };
  const caches = new Map<string, CacheEntry>();

  async function fetchToken(options: RelayAuthOptions, cache: CacheEntry): Promise<RelayInstallationAuthentication> {
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${relayToken}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({
          ...(installationId ? { installation_id: installationId } : {}),
          ...(options.permissions ? { permissions: options.permissions } : {}),
          ...(options.repositoryIds ? { repository_ids: options.repositoryIds } : {}),
        }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (error) {
      throw new Error(`GitHub token relay unreachable at ${relayUrl}: ${(error as Error).message}`);
    }

    if (response.status === 401 || response.status === 403) {
      throw new Error(
        `GitHub token relay rejected the relay credential (HTTP ${response.status}). Check PROPR_GH_RELAY_TOKEN.`,
      );
    }
    if (!response.ok) {
      throw Object.assign(new Error(`GitHub token relay returned HTTP ${response.status} for ${endpoint}.`), { status: response.status });
    }

    let data: RelayTokenResponse;
    try {
      data = (await response.json()) as RelayTokenResponse;
    } catch {
      throw new Error(`GitHub token relay returned non-JSON response from ${endpoint}.`);
    }
    if (!data?.token) {
      throw new Error('GitHub token relay response did not include a token.');
    }

    assertRelayTokenScope(data, options);
    cache.auth = { type: 'token', tokenType: 'installation', token: data.token,
      ...(data.permissions ? { permissions: data.permissions } : {}),
      ...(data.repositories ? { repositoryIds: data.repositories.map(repo => repo.id) } : {}),
    };
    const parsed = data.expires_at ? new Date(data.expires_at).getTime() : NaN;
    cache.expiresAt = Number.isNaN(parsed) ? Date.now() + DEFAULT_TOKEN_TTL_MS : parsed;
    return cache.auth;
  }

  function cacheFor(options: RelayAuthOptions): CacheEntry {
    const key = JSON.stringify([
      Object.entries(options.permissions ?? {}).sort(([a], [b]) => a.localeCompare(b)),
      options.repositoryIds ? [...options.repositoryIds].sort((a, b) => a - b) : null,
    ]);
    let cache = caches.get(key);
    if (!cache) { cache = { expiresAt: 0 }; caches.set(key, cache); }
    return cache;
  }

  async function getToken(options: RelayAuthOptions = {}): Promise<RelayInstallationAuthentication> {
    // Explicit container launches need a newly minted token even when another
    // request for the same scope is cached or in flight. Keep that mint isolated
    // so a slower old request cannot overwrite newer shared cache state.
    if (options.refresh) return fetchToken(options, { expiresAt: 0 });
    const cache = cacheFor(options);
    if (cache.auth && Date.now() < cache.expiresAt - REFRESH_MARGIN_MS) return cache.auth;
    if (cache.pending) return cache.pending;
    cache.pending = fetchToken(options, cache).finally(() => { cache.pending = undefined; });
    return cache.pending;
  }

  const auth = (async (options?: RelayAuthOptions): Promise<RelayInstallationAuthentication> => {
    // The relay only issues installation tokens. Fail loudly if a call site ever
    // requests a different auth type (e.g. an app JWT) instead of silently
    // handing back an installation token.
    if (options?.type !== undefined && options.type !== 'installation') {
      throw new Error(
        `The GitHub token relay auth strategy only supports auth({ type: "installation" }); got type "${options.type}".`,
      );
    }
    return getToken(options);
  }) as RelayAuthInterface;

  auth.hook = async (request, route, parameters) => {
    const { token } = await getToken();
    const endpointOptions = request.endpoint.merge(route as Route, parameters);
    endpointOptions.headers.authorization = `token ${token}`;
    try {
      return await request(endpointOptions as EndpointOptions);
    } catch (error) {
      if ((error as { status?: number }).status === 401) {
        // Invalidate and retry once with a fresh token (edge-of-expiry race).
        const cache = cacheFor({});
        cache.auth = undefined;
        cache.expiresAt = 0;
        const { token: freshToken } = await getToken();
        endpointOptions.headers.authorization = `token ${freshToken}`;
        return await request(endpointOptions as EndpointOptions);
      }
      throw error;
    }
  };

  return auth;
}
