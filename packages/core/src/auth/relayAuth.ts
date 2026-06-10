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
}

export interface RelayAuthInterface {
  (): Promise<RelayInstallationAuthentication>;
  hook(
    request: RequestInterface,
    route: Route | EndpointOptions,
    parameters?: RequestParameters,
  ): Promise<OctokitResponse<unknown>>;
}

interface RelayTokenResponse {
  token?: string;
  expires_at?: string;
}

// Refresh slightly before the token actually expires, mirroring createAppAuth.
const REFRESH_MARGIN_MS = 60_000;
// Fallback lifetime if the relay omits expires_at (GitHub installation tokens
// last 1 hour).
const DEFAULT_TOKEN_TTL_MS = 60 * 60 * 1000;

export function createRelayAuth(strategyOptions: RelayAuthStrategyOptions): RelayAuthInterface {
  const { relayUrl, relayToken, installationId } = strategyOptions;
  const endpoint = `${relayUrl.replace(/\/+$/, '')}/installation-token`;
  const cache: { token: string | null; expiresAt: number } = { token: null, expiresAt: 0 };
  let pendingFetch: Promise<string> | null = null;

  async function fetchToken(): Promise<string> {
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${relayToken}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(installationId ? { installationId } : {}),
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
      throw new Error(`GitHub token relay returned HTTP ${response.status} for ${endpoint}.`);
    }

    const data = (await response.json()) as RelayTokenResponse;
    if (!data?.token) {
      throw new Error('GitHub token relay response did not include a token.');
    }

    cache.token = data.token;
    const parsed = data.expires_at ? new Date(data.expires_at).getTime() : NaN;
    cache.expiresAt = Number.isNaN(parsed) ? Date.now() + DEFAULT_TOKEN_TTL_MS : parsed;
    return data.token;
  }

  async function getToken(): Promise<string> {
    if (cache.token && Date.now() < cache.expiresAt - REFRESH_MARGIN_MS) {
      return cache.token;
    }
    if (pendingFetch) return pendingFetch;
    pendingFetch = fetchToken().finally(() => { pendingFetch = null; });
    return pendingFetch;
  }

  const auth = (async (): Promise<RelayInstallationAuthentication> => {
    const token = await getToken();
    return { type: 'token', tokenType: 'installation', token };
  }) as RelayAuthInterface;

  auth.hook = async (request, route, parameters) => {
    const token = await getToken();
    const endpointOptions = request.endpoint.merge(route as Route, parameters);
    endpointOptions.headers.authorization = `token ${token}`;
    try {
      return await request(endpointOptions as EndpointOptions);
    } catch (error) {
      if ((error as { status?: number }).status === 401) {
        // Invalidate and retry once with a fresh token (edge-of-expiry race).
        cache.token = null;
        cache.expiresAt = 0;
        const freshToken = await getToken();
        endpointOptions.headers.authorization = `token ${freshToken}`;
        return await request(endpointOptions as EndpointOptions);
      }
      throw error;
    }
  };

  return auth;
}
