/**
 * The ProPR App path of the Fly dashboard launch wizard (#3827): the shared
 * ProPR GitHub App through ProPR Connect, the path `propr deploy fly` takes
 * when the stack brings no App of its own (see deploy-fly.md, "GitHub relay
 * and Connect").
 *
 *   1. The user installs the shared App (github.com/apps/propr-dev).
 *   2. A GitHub user token proves who they are to the relay. `propr deploy
 *      fly` takes it from `propr login`; the wizard gets it from GitHub's
 *      device flow against the shared App (deviceFlow.ts), or, while the App
 *      does not enable device flow, from a token the user pastes. It is used
 *      for this one enrollment (installation discovery and enrollment, plus a
 *      revoke if a later step fails) and never stored, logged or rendered
 *      back; a device sign-in's token is held in memory only while the user
 *      picks between installations.
 *   3. The relay enrolls a relay token for the installation, labelled
 *      `fly:<app>@<host>` as the CLI labels it (POST /v1/relay-tokens).
 *   4. The new relay token mints one installation token to list the
 *      installed repositories, which also proves the token works.
 *   5. The result is stored like the CLI's Fly secrets: GH_AUTH_MODE=relay,
 *      the relay URL and token, GH_INSTALLATION_ID and event intake
 *      `routing_websocket`, so the instance needs no public webhook and no
 *      App of its own.
 *
 * Browser sign-in is not part of Connect here: Connect's instance login only
 * calls back to a loopback address or an active hosted tunnel, never to
 * `https://<app>.fly.dev`. The instance signs browsers in with a GitHub OAuth
 * App the user registers (storeSignInClient), as `propr deploy fly` requires
 * GH_OAUTH_CLIENT_ID and _SECRET without the tunnel flags.
 *
 * TODO(#3867): #3867 adds a `device` browser sign-in mode for relay-enrolled
 * instances on any host. Whichever of #3852 and #3867 merges second removes
 * the sign-in app step (storeSignInClient, signInAppPage, the 'signin-app'
 * step in setupSteps.ts) and signs the first administrator in with it.
 *
 * Errors never carry tokens, codes or response bodies.
 */
import { hostname } from 'node:os';
import { DEFAULT_PROPR_GH_RELAY_URL } from '@propr/shared';
import { GithubSetupError, listInstallationRepositories } from './githubSetup.js';
import { GITHUB_APP_KEY_FILE, type LaunchConfig, type LaunchConnect } from './launchConfig.js';
import type { LaunchStore } from './launchStore.js';

export const PROPR_APP_SLUG = 'propr-dev';
export const PROPR_APP_INSTALL_URL = `https://github.com/apps/${PROPR_APP_SLUG}/installations/new`;
export const GITHUB_TOKEN_SETTINGS_URL = 'https://github.com/settings/personal-access-tokens/new';
export const GITHUB_OAUTH_APP_SETTINGS_URL = 'https://github.com/settings/applications/new';
/** The API's GitHub OAuth callback; also the sign-in app's one callback URL. */
export const OAUTH_CALLBACK_PATH = '/api/auth/github/callback';
export { DEFAULT_PROPR_GH_RELAY_URL };

type Fetcher = typeof fetch;

export interface RelayInstallation {
    installationId: string;
    accountLogin: string;
    accountType: string;
}

export interface ConnectEnrollment extends LaunchConnect {
    relayUrl: string;
    relayToken: string;
    repositories: string[];
}

/** Own-App values cleared when the ProPR App path is stored, so App auth never outranks the relay. */
const OWN_APP_ENV_KEYS = ['GH_APP_ID', 'GH_WEBHOOK_SECRET', 'GH_OAUTH_CLIENT_ID', 'GH_OAUTH_CLIENT_SECRET', 'GH_INSTALLATION_ID', 'GITHUB_REPOS_TO_MONITOR', 'PROPR_ADMIN_USERS'];

/** The relay token label `propr deploy fly` uses: `fly:<app>@<host>`, within the relay's 128 characters. */
export function relayTokenLabel(app: string, host: string = hostname()): string {
    return `fly:${app}@${host}`.slice(0, 128);
}

/** A pasted GitHub token, trimmed; fine-grained (`github_pat_…`), classic or OAuth tokens. */
export function parseUserToken(value: string | null | undefined): string {
    const token = (value ?? '').trim();
    if (!/^[A-Za-z0-9_]{20,255}$/.test(token)) {
        throw new GithubSetupError('Paste a GitHub token: a fine-grained token starts with github_pat_.');
    }
    return token;
}

interface RelayCall {
    relayUrl: string;
    bearer: string;
    fetcher: Fetcher;
}

type RelayOperation = 'discovery' | 'enrollment' | 'repositories' | 'revoke' | 'wake';

function relayFailure(status: number, operation: RelayOperation): GithubSetupError {
    if (status === 401) {
        return new GithubSetupError(operation === 'repositories' || operation === 'wake'
            ? 'ProPR Connect did not accept the new relay token. Try again.'
            : 'GitHub did not accept that token. Check that it was copied whole and has not expired.', 401);
    }
    if (status === 403 && operation === 'enrollment') {
        return new GithubSetupError('Only the owner of the account the ProPR App is installed on (an organization owner, for an organization) can connect an instance to it. Sign in to GitHub as that owner and create the token there.', 403);
    }
    return new GithubSetupError(`ProPR Connect answered HTTP ${status}. Try again.`, status);
}

async function relayJson<T>(call: RelayCall, path: string, operation: RelayOperation, init: { method?: string; body?: unknown } = {}): Promise<T> {
    let response: Response;
    try {
        response = await call.fetcher(`${call.relayUrl.replace(/\/+$/, '')}${path}`, {
            method: init.method ?? 'GET',
            redirect: 'error',
            signal: AbortSignal.timeout(20_000),
            headers: {
                Accept: 'application/json',
                Authorization: `Bearer ${call.bearer}`,
                'User-Agent': 'ProPR-fly-launch',
                ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
            },
            body: init.body === undefined ? undefined : JSON.stringify(init.body),
        });
    } catch {
        throw new GithubSetupError('ProPR Connect could not be reached. Try again.');
    }
    if (!response.ok) throw relayFailure(response.status, operation);
    try {
        return await response.json() as T;
    } catch {
        throw new GithubSetupError('ProPR Connect returned an invalid answer. Try again.');
    }
}

/** The shared-App installations the relay lets this GitHub identity use (GET /v1/auth/me). */
export async function discoverInstallations(call: RelayCall): Promise<RelayInstallation[]> {
    const me = await relayJson<{ installations?: Array<{ installation_id?: unknown; account_login?: unknown; account_type?: unknown }> }>(call, '/auth/me', 'discovery');
    return (me.installations ?? [])
        .filter(entry => Number.isSafeInteger(entry.installation_id) && (entry.installation_id as number) > 0)
        .map(entry => ({
            installationId: String(entry.installation_id),
            accountLogin: typeof entry.account_login === 'string' ? entry.account_login : '',
            accountType: typeof entry.account_type === 'string' ? entry.account_type : '',
        }));
}

/** The repositories the installation was given, read with one installation token minted by the relay token. */
async function relayRepositories(call: RelayCall, installationId: string): Promise<string[]> {
    const minted = await relayJson<{ token?: string }>(call, '/installation-token', 'repositories', { method: 'POST', body: { installation_id: Number(installationId) } });
    if (!minted.token) throw new GithubSetupError('ProPR Connect did not return an installation token. Try again.');
    return listInstallationRepositories(call.fetcher, minted.token);
}

/** Best effort: a token enrolled for a step that then failed must not stay valid. */
export async function revokeRelayToken(call: RelayCall, installationId: string, tokenId: string): Promise<boolean> {
    try {
        await relayJson(call, '/relay-tokens/revoke', 'revoke', { method: 'POST', body: { installation_id: Number(installationId), token_id: tokenId } });
        return true;
    } catch {
        return false;
    }
}

export interface EnrollConnectOptions {
    userToken: string;
    /** The installation the user picked; required when the relay offers more than one. */
    installationId?: string;
    label: string;
    relayUrl?: string;
    fetcher?: Fetcher;
}

export type EnrollConnectResult =
    | { kind: 'pick'; installations: RelayInstallation[] }
    | { kind: 'enrolled'; enrollment: ConnectEnrollment; revoke: () => Promise<boolean> };

/**
 * Discover the installation (or ask to pick one), enroll a relay token and
 * list the installed repositories with it. The user token stays in this
 * call; `revoke` keeps it in a closure only for the caller's commit, which
 * may still refuse the result (another step finished meanwhile).
 */
export async function enrollConnect(options: EnrollConnectOptions): Promise<EnrollConnectResult> {
    const relayUrl = options.relayUrl ?? DEFAULT_PROPR_GH_RELAY_URL;
    const user: RelayCall = { relayUrl, bearer: options.userToken, fetcher: options.fetcher ?? fetch };
    const installations = await discoverInstallations(user);
    if (installations.length === 0) {
        throw new GithubSetupError('ProPR Connect found no ProPR App installation for this GitHub account. Install the ProPR App first (step 1), then submit the token again.');
    }
    const picked = options.installationId?.trim();
    const installation = picked
        ? installations.find(entry => entry.installationId === picked)
        : installations.length === 1 ? installations[0] : undefined;
    if (!installation) {
        if (picked) throw new GithubSetupError('That installation is not available to this GitHub account. Pick one from the list.');
        return { kind: 'pick', installations };
    }
    const enrolled = await relayJson<{ token?: string; token_id?: string; token_prefix?: string }>(user, '/relay-tokens', 'enrollment', {
        method: 'POST', body: { installation_id: Number(installation.installationId), label: options.label },
    });
    if (!enrolled.token || !enrolled.token_id) throw new GithubSetupError('ProPR Connect did not return a relay token. Try again.');
    const tokenId = enrolled.token_id;
    const revoke = () => revokeRelayToken(user, installation.installationId, tokenId);
    let repositories: string[];
    try {
        repositories = await relayRepositories({ ...user, bearer: enrolled.token }, installation.installationId);
    } catch (error) {
        await revoke();
        throw error;
    }
    return {
        kind: 'enrolled',
        revoke,
        enrollment: {
            relayUrl, relayToken: enrolled.token, repositories,
            installationId: installation.installationId, accountLogin: installation.accountLogin,
            label: options.label, tokenId, tokenPrefix: enrolled.token_prefix ?? '',
        },
    };
}

/**
 * Store the enrollment as `propr deploy fly` sets its Fly secrets for relay
 * auth. Clears an earlier own App (and its key file), its installation and
 * administrator: the two paths never mix.
 */
export function storeConnectEnrollment(store: LaunchStore, config: LaunchConfig, enrollment: ConnectEnrollment): LaunchConfig {
    store.remove(GITHUB_APP_KEY_FILE);
    const env = { ...config.env };
    for (const key of OWN_APP_ENV_KEYS) delete env[key];
    Object.assign(env, {
        GH_AUTH_MODE: 'relay',
        PROPR_GH_RELAY_URL: enrollment.relayUrl,
        PROPR_GH_RELAY_TOKEN: enrollment.relayToken,
        GH_INSTALLATION_ID: enrollment.installationId,
        GITHUB_EVENT_INTAKE_MODE: 'routing_websocket',
        PROPR_DEMO_MODE: 'false',
    });
    if (enrollment.repositories.length) env.GITHUB_REPOS_TO_MONITOR = enrollment.repositories.join(',');
    const rest: LaunchConfig = { ...config };
    delete rest.github;
    delete rest.admin;
    const { installationId, accountLogin, label, tokenId, tokenPrefix } = enrollment;
    return { ...rest, env, connect: { installationId, accountLogin, label, tokenId, tokenPrefix } };
}

/** GitHub OAuth App client ids: `Ov23…`/`Iv1.…` style, letters, digits, dots. */
export function parseSignInClient(clientId: string | null | undefined, clientSecret: string | null | undefined): { clientId: string; clientSecret: string } {
    const id = (clientId ?? '').trim();
    const secret = (clientSecret ?? '').trim();
    if (!/^[A-Za-z0-9.]{8,64}$/.test(id)) throw new GithubSetupError('Paste the OAuth App\'s Client ID.');
    if (!/^[A-Za-z0-9]{20,128}$/.test(secret)) throw new GithubSetupError('Paste a client secret generated for that OAuth App.');
    return { clientId: id, clientSecret: secret };
}

/** The sign-in app's client; a new one clears the administrator signed in with the old one. */
export function storeSignInClient(config: LaunchConfig, client: { clientId: string; clientSecret: string }): LaunchConfig {
    const env: Record<string, string> = { ...config.env, GH_OAUTH_CLIENT_ID: client.clientId, GH_OAUTH_CLIENT_SECRET: client.clientSecret };
    delete env.PROPR_ADMIN_USERS;
    const rest: LaunchConfig = { ...config, env };
    delete rest.admin;
    return rest;
}

/**
 * Register `<public URL>/wake` as this relay token's wake target (PUT
 * /v1/wake-target), so Connect pings a stopped Machine when a delivery
 * arrives and the instance asks for the cached ones when it reconnects. The
 * secret Connect returns is not kept: ProPR's /wake answers every ping.
 */
export async function registerWakeTarget(call: RelayCall, wakeUrl: string): Promise<void> {
    const result = await relayJson<{ wake_target?: { url?: string } }>(call, '/wake-target', 'wake', { method: 'PUT', body: { url: wakeUrl } });
    if (result.wake_target?.url !== wakeUrl) throw new GithubSetupError('ProPR Connect did not register the wake URL. Try again.');
}

export type { RelayCall };
