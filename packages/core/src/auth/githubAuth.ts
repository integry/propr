import { Octokit } from '@octokit/core';
import { paginateRest } from '@octokit/plugin-paginate-rest';
import { createAppAuth } from '@octokit/auth-app';
import fs from 'fs';
import path from 'path';
import 'dotenv/config';
import {
    parseTruthyEnvValue,
    resolveGithubAuthMode,
    resolveGithubEventIntakeMode,
    validateIntakeModePrerequisites,
    validateRelayUrl,
} from '@propr/shared';
import type { GithubAuthMode } from '@propr/shared';
import { createRelayAuth } from './relayAuth.js';

interface InstallationAuth {
    token: string;
    type: string;
}

const appId = process.env.GH_APP_ID;
const privateKeyPath = process.env.GH_PRIVATE_KEY_PATH;
const installationId = process.env.GH_INSTALLATION_ID;
const demoMode = parseTruthyEnvValue(process.env.PROPR_DEMO_MODE);

// The mode inference lives in @propr/shared (resolveGithubAuthMode) so the CLI's
// `propr check` reports exactly what the backend will do at boot.
const relayUrl = process.env.PROPR_GH_RELAY_URL;
const relayToken = process.env.PROPR_GH_RELAY_TOKEN;

function resolveAuthMode(): GithubAuthMode {
    const { mode, warnings } = resolveGithubAuthMode({
        demoMode,
        ghAuthMode: process.env.GH_AUTH_MODE,
        relayUrl,
        relayToken,
        appId,
        privateKeyPath,
        installationId,
    });
    for (const warning of warnings) console.warn(`WARNING: ${warning}`);
    return mode;
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
    const missingAppVars = [
        !appId && 'GH_APP_ID',
        !privateKeyPath && 'GH_PRIVATE_KEY_PATH',
        !installationId && 'GH_INSTALLATION_ID',
    ].filter(Boolean) as string[];
    if (missingAppVars.length > 0) {
        fatalConfigError(`ERROR: App auth mode requires ${missingAppVars.join(', ')} to be set.`);
    } else {
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
    }
} else if (authMode === 'none' && process.env.NODE_ENV !== 'test') {
    console.error('GitHub auth is not configured. Set one of:');
    console.error('  - GH_APP_ID + GH_INSTALLATION_ID + GH_PRIVATE_KEY_PATH (own GitHub App), or');
    console.error('  - PROPR_GH_RELAY_URL + PROPR_GH_RELAY_TOKEN (shared-app token relay), or');
    console.error('  - PROPR_DEMO_MODE=true (no GitHub access).');
    process.exit(1);
}

// Mode-specific GitHub intake prerequisites. Auth resolution above proves the
// stack can talk to GitHub; this proves the *resolved intake mode*
// (routing_websocket, polling, or direct_webhook) has the extra config it needs
// — a routing URL, a webhook secret, etc. — so the daemon/worker/api never boot
// half-configured. It uses the same shared helper `propr check` reports against,
// so the CLI preview and the boot path can never drift.
function validateIntakeModePrerequisitesAtBoot(): void {
    // An unconfigured stack ('none') is already handled above (production exits,
    // tests stay quiet); intake prerequisites only add signal once auth is usable.
    if (authMode === 'none') {
        return;
    }

    let intakeMode;
    try {
        const resolved = resolveGithubEventIntakeMode({
            eventIntakeMode: process.env.GITHUB_EVENT_INTAKE_MODE,
            enableGithubWebhooks: process.env.ENABLE_GITHUB_WEBHOOKS,
        });
        intakeMode = resolved.mode;
        for (const warning of resolved.warnings) console.warn(`WARNING: ${warning}`);
    } catch (error) {
        fatalConfigError(`ERROR: ${(error as Error).message}`);
        return;
    }

    const { errors, warnings } = validateIntakeModePrerequisites({
        intakeMode,
        authMode,
        routingUrl: process.env.PROPR_ROUTING_URL,
        relayUrl,
        relayToken,
        webhookSecret: process.env.GH_WEBHOOK_SECRET,
    });
    for (const warning of warnings) console.warn(`WARNING: ${warning}`);
    for (const error of errors) fatalConfigError(`ERROR: ${error}`);
}

validateIntakeModePrerequisitesAtBoot();

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
