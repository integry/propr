import type { GitHubUser } from './authTypes.js';

export const DEFAULT_PROPR_CONNECT_ORIGIN = 'https://connect.propr.dev';
const CONNECT_REDEEM_TIMEOUT_MS = 20_000;
const GITHUB_USER_URL = 'https://api.github.com/user';

export type BrowserAuthMode = 'connect' | 'github' | 'disabled';

export function resolveBrowserAuthMode(
    env: NodeJS.ProcessEnv = process.env,
): BrowserAuthMode {
    const explicit = env.PROPR_WEB_AUTH_MODE?.trim().toLowerCase();
    if (explicit === 'connect' || explicit === 'github' || explicit === 'disabled') return explicit;

    // Relay enrollment identifies this stack to ProPR Connect. Managed tunnels
    // retain their existing Connect-first behavior. Off-tunnel, an explicitly
    // configured OAuth App still wins for backward compatibility; otherwise
    // Connect supports an exact loopback callback for the zero-config path.
    const hasRelay = Boolean(env.PROPR_GH_RELAY_URL?.trim() && env.PROPR_GH_RELAY_TOKEN?.trim());
    const tunnelEnabled = env.PROPR_UI_TUNNEL_ENABLED?.trim().toLowerCase() === 'true';
    if (hasRelay && tunnelEnabled) return 'connect';

    if (isConfiguredValue(env.GH_OAUTH_CLIENT_ID) && isConfiguredValue(env.GH_OAUTH_CLIENT_SECRET)) {
        return 'github';
    }
    if (hasRelay) return 'connect';
    return 'disabled';
}

export function buildConnectAuthorizationUrl(options: {
    connectOrigin?: string;
    callbackUrl: string;
    state: string;
    installationId?: string;
}): string {
    const origin = new URL(options.connectOrigin || DEFAULT_PROPR_CONNECT_ORIGIN);
    if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash) {
        throw new Error('PROPR_CONNECT_URL must be a bare HTTPS origin');
    }
    const url = new URL('/instance-login', origin);
    url.searchParams.set('callback_url', options.callbackUrl);
    url.searchParams.set('state', options.state);
    if (options.installationId?.trim()) {
        url.searchParams.set('installation_id', options.installationId.trim());
    }
    return url.toString();
}

export async function redeemConnectAuthorizationCode(options: {
    code: string;
    relayUrl: string;
    relayToken: string;
    fetchImpl?: typeof fetch;
}): Promise<GitHubUser> {
    const fetchImpl = options.fetchImpl ?? fetch;
    const relayBase = options.relayUrl.trim().replace(/\/+$/, '');
    const endpoint = new URL(`${relayBase}/auth/instance-grants/redeem`);
    if (endpoint.protocol !== 'https:' && endpoint.hostname !== 'localhost' && endpoint.hostname !== '127.0.0.1') {
        throw new Error('PROPR_GH_RELAY_URL must use HTTPS');
    }

    const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
            accept: 'application/json',
            authorization: `Bearer ${options.relayToken}`,
            'content-type': 'application/json',
        },
        body: JSON.stringify({ code: options.code }),
        signal: AbortSignal.timeout(CONNECT_REDEEM_TIMEOUT_MS),
    });
    if (!response.ok) {
        throw new Error(`ProPR Connect rejected the instance login code (HTTP ${response.status})`);
    }

    const body = await response.json() as unknown;
    if (!isRedeemedIdentity(body)) {
        throw new Error('ProPR Connect returned an invalid instance login response');
    }

    const githubResponse = await fetchImpl(GITHUB_USER_URL, {
        headers: {
            accept: 'application/vnd.github+json',
            authorization: `Bearer ${body.access_token}`,
            'user-agent': 'ProPR',
        },
        signal: AbortSignal.timeout(CONNECT_REDEEM_TIMEOUT_MS),
    });
    if (!githubResponse.ok) {
        throw new Error(`GitHub rejected the Connect access token (HTTP ${githubResponse.status})`);
    }
    const githubIdentity = await githubResponse.json() as unknown;
    if (!isGitHubIdentity(githubIdentity)) {
        throw new Error('GitHub returned an invalid user response for the Connect access token');
    }

    return {
        id: String(githubIdentity.id),
        login: githubIdentity.login,
        username: githubIdentity.login,
        displayName: githubIdentity.login,
        email: null,
        avatarUrl: body.avatar_url,
        accessToken: body.access_token,
    };
}

function isGitHubIdentity(value: unknown): value is { id: number; login: string } {
    if (typeof value !== 'object' || value === null) return false;
    const candidate = value as Record<string, unknown>;
    return (
        typeof candidate.id === 'number' &&
        Number.isSafeInteger(candidate.id) &&
        candidate.id > 0 &&
        isGitHubLogin(candidate.login)
    );
}

function isGitHubLogin(value: unknown): value is string {
    return typeof value === 'string' && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(value);
}

function isConfiguredValue(value: string | undefined): boolean {
    const normalized = value?.trim().toLowerCase();
    return Boolean(normalized && !normalized.startsWith('your_') && normalized !== 'changeme');
}

function isRedeemedIdentity(value: unknown): value is {
    username: string;
    avatar_url: string | null;
    access_token: string;
} {
    if (typeof value !== 'object' || value === null) return false;
    const candidate = value as Record<string, unknown>;
    return (
        isGitHubLogin(candidate.username) &&
        (candidate.avatar_url === null || typeof candidate.avatar_url === 'string') &&
        typeof candidate.access_token === 'string' &&
        candidate.access_token.length > 0
    );
}
