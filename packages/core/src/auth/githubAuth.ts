import { Octokit } from '@octokit/core';
import { paginateRest } from '@octokit/plugin-paginate-rest';
import { createAppAuth } from '@octokit/auth-app';
import fs from 'fs';
import path from 'path';
import 'dotenv/config';
import { parseTruthyEnvValue } from '@propr/shared';
import { createRelayAuth } from './relayAuth.js';

interface InstallationAuth {
    token: string;
    type: string;
}

const appId = process.env.GH_APP_ID;
const privateKeyPath = process.env.GH_PRIVATE_KEY_PATH;
const installationId = process.env.GH_INSTALLATION_ID;
const demoMode = parseTruthyEnvValue(process.env.PROPR_DEMO_MODE);

// GitHub auth is configured one of three ways (precedence matches `propr check`):
//   demo  — no GitHub access
//   relay — fetch installation tokens from a vendor relay (shared-app path)
//   app   — mint installation tokens locally from the App private key (own-app)
// An explicit GH_AUTH_MODE overrides the inference below.
const relayUrl = process.env.PROPR_GH_RELAY_URL;
const relayToken = process.env.PROPR_GH_RELAY_TOKEN;

type AuthMode = 'demo' | 'relay' | 'app' | 'none';

function resolveAuthMode(): AuthMode {
    if (demoMode) return 'demo';
    const explicit = (process.env.GH_AUTH_MODE || '').trim().toLowerCase();
    if (explicit === 'demo') return 'demo';
    if (explicit === 'relay') return 'relay';
    if (explicit === 'app') return 'app';
    if (relayUrl) return 'relay';
    if (appId && privateKeyPath && installationId) return 'app';
    return 'none';
}

function validateRelayUrl(url: string): string | null {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return `PROPR_GH_RELAY_URL ("${url}") is not a valid URL.`;
    }
    const isLocalhost = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '::1';
    if (parsed.protocol !== 'https:' && !isLocalhost) {
        return 'PROPR_GH_RELAY_URL must use https:// (http is only allowed for localhost).';
    }
    return null;
}

const authMode = resolveAuthMode();

let privateKey: string | undefined;
const PaginatedOctokit = Octokit.plugin(paginateRest);
let appOctokit: InstanceType<typeof PaginatedOctokit> | null = null;

function fatalConfigError(message: string): void {
    console.error(message);
    if (process.env.NODE_ENV !== 'test') {
        process.exit(1);
    }
}

if (authMode === 'relay') {
    const urlError = relayUrl ? validateRelayUrl(relayUrl) : 'PROPR_GH_RELAY_URL must be set for relay mode.';
    if (urlError) {
        fatalConfigError(`ERROR: ${urlError}`);
    } else if (!relayToken) {
        fatalConfigError('ERROR: PROPR_GH_RELAY_TOKEN must be set for relay mode (the durable credential issued for your installation).');
    } else {
        // No network call here — the token is fetched lazily on first use.
        appOctokit = new PaginatedOctokit({
            authStrategy: createRelayAuth,
            auth: { relayUrl, relayToken, installationId },
        });
    }
} else if (authMode === 'app') {
    try {
        privateKey = fs.readFileSync(path.resolve(privateKeyPath as string), 'utf8');

        appOctokit = new PaginatedOctokit({
            authStrategy: createAppAuth,
            auth: {
                appId,
                privateKey,
                installationId,
            },
        });
    } catch (error) {
        console.error('Failed to read GitHub App private key:', (error as Error).message);
        console.error('Ensure GH_PRIVATE_KEY_PATH is set correctly in your .env file and points to a valid private key file.');
        if (process.env.NODE_ENV !== 'test') {
            process.exit(1);
        }
    }
} else if (authMode === 'none' && process.env.NODE_ENV !== 'test') {
    console.error('GitHub auth is not configured. Set one of:');
    console.error('  - GH_APP_ID + GH_INSTALLATION_ID + GH_PRIVATE_KEY_PATH (own GitHub App), or');
    console.error('  - PROPR_GH_RELAY_URL + PROPR_GH_RELAY_TOKEN (shared-app token relay), or');
    console.error('  - PROPR_DEMO_MODE=true (no GitHub access).');
    process.exit(1);
}

export async function getGitHubInstallationToken(): Promise<string> {
    if (!appOctokit) {
        throw new Error('GitHub auth not configured. Set GH_APP_ID + GH_PRIVATE_KEY_PATH + GH_INSTALLATION_ID (own app), or PROPR_GH_RELAY_URL + PROPR_GH_RELAY_TOKEN (token relay).');
    }
    try {
        const auth = await appOctokit.auth({ type: "installation" }) as InstallationAuth;
        return auth.token;
    } catch (error) {
        console.error("Error getting GitHub installation token:", error);
        throw error;
    }
}

export type PaginatedOctokitInstance = InstanceType<typeof PaginatedOctokit>;

export async function getAuthenticatedOctokit(): Promise<PaginatedOctokitInstance> {
    if (!appOctokit) {
        throw new Error('GitHub auth not configured. Set GH_APP_ID + GH_PRIVATE_KEY_PATH + GH_INSTALLATION_ID (own app), or PROPR_GH_RELAY_URL + PROPR_GH_RELAY_TOKEN (token relay).');
    }
    return appOctokit as PaginatedOctokitInstance;
}
