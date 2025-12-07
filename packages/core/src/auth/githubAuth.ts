import { Octokit } from '@octokit/core';
import { paginateRest } from '@octokit/plugin-paginate-rest';
import { createAppAuth } from '@octokit/auth-app';
import fs from 'fs';
import path from 'path';
import 'dotenv/config';

interface InstallationAuth {
    token: string;
    type: string;
}

const appId = process.env.GH_APP_ID;
const privateKeyPath = process.env.GH_PRIVATE_KEY_PATH;
const installationId = process.env.GH_INSTALLATION_ID;

let privateKey: string | undefined;
const PaginatedOctokit = Octokit.plugin(paginateRest);
let appOctokit: InstanceType<typeof PaginatedOctokit> | null = null;

if (appId && privateKeyPath && installationId) {
    try {
        privateKey = fs.readFileSync(path.resolve(privateKeyPath), 'utf8');

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
} else if (process.env.NODE_ENV !== 'test') {
    console.error('GH_APP_ID, GH_PRIVATE_KEY_PATH, and GH_INSTALLATION_ID must be set in .env file.');
    process.exit(1);
}

export async function getGitHubInstallationToken(): Promise<string> {
    if (!appOctokit) {
        throw new Error('GitHub App not configured. Please set GH_APP_ID, GH_PRIVATE_KEY_PATH, and GH_INSTALLATION_ID environment variables.');
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
        throw new Error('GitHub App not configured. Please set GH_APP_ID, GH_PRIVATE_KEY_PATH, and GH_INSTALLATION_ID environment variables.');
    }
    return appOctokit as PaginatedOctokitInstance;
}
