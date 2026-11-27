/**
 * GitHub side of the Fly dashboard launch wizard (#3827): create the GitHub
 * App with the manifest flow, verify its installation, and sign the first
 * administrator in.
 *
 * The manifest is the one `propr github-app create` registers
 * (buildGithubAppManifest), with the callback, webhook, redirect and setup
 * URLs on the instance's `https://<app>.fly.dev` origin. The conversion's
 * credentials are stored on the volume (launchConfig.ts); a Fly secret with
 * the same name still wins on boot.
 *
 * Errors never carry response bodies, codes or tokens.
 */
import { createSign } from 'node:crypto';
import { buildGithubAppManifest } from '@propr/shared';
import { GITHUB_APP_KEY_FILE, type LaunchConfig } from './launchConfig.js';
import type { LaunchStore } from './launchStore.js';

export const SETUP_PATHS = {
    created: '/setup/github/created',
    installed: '/setup/github/installed',
    admin: '/setup/github/admin',
} as const;

export interface ManifestCredentials {
    id: number;
    slug: string;
    html_url?: string;
    owner?: { login?: string } | null;
    pem: string;
    webhook_secret: string | null;
    client_id: string;
    client_secret: string;
}

export class GithubSetupError extends Error {
    constructor(message: string, readonly status?: number) { super(message); }
}

type Fetcher = typeof fetch;

async function githubJson<T>(fetcher: Fetcher, url: string, init: RequestInit & { token?: string; jwt?: string } = {}): Promise<T> {
    const { token, jwt, ...rest } = init;
    let response: Response;
    try {
        response = await fetcher(url, {
            ...rest,
            redirect: 'error',
            signal: AbortSignal.timeout(20_000),
            headers: {
                Accept: 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
                'User-Agent': 'ProPR-fly-launch',
                ...(jwt ? { Authorization: `Bearer ${jwt}` } : token ? { Authorization: `token ${token}` } : {}),
                ...(rest.body ? { 'Content-Type': 'application/json' } : {}),
                ...(rest.headers as Record<string, string> | undefined),
            },
        });
    } catch {
        throw new GithubSetupError(`GitHub could not be reached (${new URL(url).pathname.split('/').slice(0, 3).join('/')}). Try again.`);
    }
    if (!response.ok) {
        throw new GithubSetupError(`GitHub answered HTTP ${response.status}.`, response.status);
    }
    return response.json() as Promise<T>;
}

/** The App manifest, with every URL on the instance's public origin. */
export function launchGithubAppManifest(publicUrl: string, name?: string) {
    const base = publicUrl.replace(/\/+$/, '');
    const manifest = buildGithubAppManifest({
        publicUrl: base,
        ...(name?.trim() ? { name: name.trim() } : {}),
        redirectUrl: `${base}${SETUP_PATHS.created}`,
        setupUrl: `${base}${SETUP_PATHS.installed}`,
    });
    // The wizard signs the first administrator in before the API runs.
    return { ...manifest, callback_urls: [...manifest.callback_urls, `${base}${SETUP_PATHS.admin}`] };
}

/** Where the manifest form posts: the personal account, or an organization the user administers. */
export function githubAppRegistrationUrl(org: string | undefined, state: string): string {
    const login = org?.trim();
    if (login && !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,38})$/.test(login)) throw new GithubSetupError('Use a GitHub organization login, or leave it empty for your personal account.');
    return `https://github.com/${login ? `organizations/${encodeURIComponent(login)}/` : ''}settings/apps/new?state=${encodeURIComponent(state)}`;
}

export function githubAppInstallUrl(slug: string, state: string): string {
    return `https://github.com/apps/${encodeURIComponent(slug)}/installations/new?state=${encodeURIComponent(state)}`;
}

export function githubOAuthAuthorizeUrl(clientId: string, publicUrl: string, state: string): string {
    const query = new URLSearchParams({ client_id: clientId, redirect_uri: `${publicUrl.replace(/\/+$/, '')}${SETUP_PATHS.admin}`, state, allow_signup: 'false' });
    return `https://github.com/login/oauth/authorize?${query}`;
}

export async function convertManifestCode(code: string, fetcher: Fetcher = fetch): Promise<ManifestCredentials> {
    if (!/^[a-zA-Z0-9_-]{1,200}$/.test(code)) throw new GithubSetupError('GitHub returned an invalid App creation code.');
    const credentials = await githubJson<ManifestCredentials>(fetcher, `https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, { method: 'POST' });
    if (!credentials?.id || !credentials.slug || !credentials.pem || !credentials.client_id || !credentials.client_secret) {
        throw new GithubSetupError('GitHub did not return the App credentials.');
    }
    if (!credentials.webhook_secret) throw new GithubSetupError('GitHub did not return a webhook secret for the App.');
    return credentials;
}

/**
 * Store the manifest-flow credentials: the key as `github-app.pem` (0600),
 * the rest as env values the boot applies (direct webhook intake, App auth).
 * Clears any installation and administrator of an earlier App.
 */
export function storeManifestCredentials(store: LaunchStore, config: LaunchConfig, credentials: ManifestCredentials): LaunchConfig {
    store.writeText(GITHUB_APP_KEY_FILE, credentials.pem.endsWith('\n') ? credentials.pem : `${credentials.pem}\n`);
    const env = { ...config.env };
    for (const key of ['GH_INSTALLATION_ID', 'GITHUB_REPOS_TO_MONITOR', 'PROPR_ADMIN_USERS']) delete env[key];
    Object.assign(env, {
        GH_APP_ID: String(credentials.id),
        GH_WEBHOOK_SECRET: credentials.webhook_secret!,
        GH_OAUTH_CLIENT_ID: credentials.client_id,
        GH_OAUTH_CLIENT_SECRET: credentials.client_secret,
        GH_AUTH_MODE: 'app',
        GITHUB_EVENT_INTAKE_MODE: 'direct_webhook',
        PROPR_DEMO_MODE: 'false',
    });
    const rest: LaunchConfig = { ...config };
    delete rest.admin;
    return {
        ...rest,
        env,
        github: {
            appId: credentials.id,
            slug: credentials.slug,
            ownerLogin: credentials.owner?.login ?? '',
            htmlUrl: credentials.html_url ?? `https://github.com/apps/${credentials.slug}`,
        },
    };
}

export function githubAppJwt(appId: string | number, pem: string, now = Date.now()): string {
    const seconds = Math.floor(now / 1000);
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const payload = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iat: seconds - 60, exp: seconds + 540, iss: String(appId) })}`;
    try {
        return `${payload}.${createSign('RSA-SHA256').update(payload).sign(pem, 'base64url')}`;
    } catch {
        throw new GithubSetupError('The stored GitHub App private key cannot sign a JWT.');
    }
}

/** Check the installation belongs to this App and list the repositories it was given. */
export async function verifyInstallation(appId: number, pem: string, installationId: string, fetcher: Fetcher = fetch): Promise<{ repositories: string[] }> {
    if (!/^\d{1,20}$/.test(installationId)) throw new GithubSetupError('GitHub returned an invalid installation id.');
    const jwt = githubAppJwt(appId, pem);
    const installation = await githubJson<{ id: number; app_id: number }>(fetcher, `https://api.github.com/app/installations/${installationId}`, { jwt });
    if (installation.app_id !== appId) throw new GithubSetupError('That installation belongs to a different GitHub App.');
    const { token } = await githubJson<{ token: string }>(fetcher, `https://api.github.com/app/installations/${installationId}/access_tokens`, { method: 'POST', jwt });
    const repositories: string[] = [];
    for (let page = 1; page <= 10; page++) {
        const list = await githubJson<{ repositories: Array<{ full_name: string }> }>(fetcher, `https://api.github.com/installation/repositories?per_page=100&page=${page}`, { token });
        repositories.push(...list.repositories.map(repository => repository.full_name));
        if (list.repositories.length < 100) break;
    }
    return { repositories };
}

/** Exchange the OAuth code for a user token and read who signed in. The token is discarded. */
export async function signInAdministrator(
    credentials: { clientId: string; clientSecret: string },
    code: string,
    publicUrl: string,
    fetcher: Fetcher = fetch,
): Promise<{ login: string; id: number }> {
    if (!/^[a-zA-Z0-9_-]{1,200}$/.test(code)) throw new GithubSetupError('GitHub returned an invalid sign-in code.');
    const exchange = await githubJson<{ access_token?: string }>(fetcher, 'https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { Accept: 'application/json' },
        body: JSON.stringify({
            client_id: credentials.clientId,
            client_secret: credentials.clientSecret,
            code,
            redirect_uri: `${publicUrl.replace(/\/+$/, '')}${SETUP_PATHS.admin}`,
        }),
    });
    if (!exchange.access_token) throw new GithubSetupError('GitHub did not complete the sign-in. Try again.');
    const user = await githubJson<{ login?: string; id?: number }>(fetcher, 'https://api.github.com/user', { token: exchange.access_token });
    if (!user.login || !user.id) throw new GithubSetupError('GitHub did not say who signed in.');
    return { login: user.login, id: user.id };
}
