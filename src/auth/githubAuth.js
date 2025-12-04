import { Octokit } from '@octokit/core'; 
import { paginateRest } from '@octokit/plugin-paginate-rest';
import { createAppAuth } from '@octokit/auth-app';
import fs from 'fs';
import path from 'path';
import 'dotenv/config';

const appId = process.env.GH_APP_ID;
const privateKeyPath = process.env.GH_PRIVATE_KEY_PATH;
const installationId = process.env.GH_INSTALLATION_ID;

let privateKey;
let appOctokit = null;

// Only initialize if all credentials are present
if (appId && privateKeyPath && installationId) {
    try {
        privateKey = fs.readFileSync(path.resolve(privateKeyPath), 'utf8');
        
        // Create Octokit with pagination plugin
        const MyOctokit = Octokit.plugin(paginateRest);
        
        appOctokit = new MyOctokit({
            authStrategy: createAppAuth,
            auth: {
                appId,
                privateKey,
                installationId,
            },
        });
    } catch (error) {
        console.error('Failed to read GitHub App private key:', error.message);
        console.error('Ensure GH_PRIVATE_KEY_PATH is set correctly in your .env file and points to a valid private key file.');
        if (process.env.NODE_ENV !== 'test') {
            process.exit(1);
        }
    }
} else if (process.env.NODE_ENV !== 'test') {
    console.error('GH_APP_ID, GH_PRIVATE_KEY_PATH, and GH_INSTALLATION_ID must be set in .env file.');
    process.exit(1);
}


/**
 * Gets an installation access token for the GitHub App.
 * @returns {Promise<string>} The installation access token.
 */
export async function getGitHubInstallationToken() {
    if (!appOctokit) {
        throw new Error('GitHub App not configured. Please set GH_APP_ID, GH_PRIVATE_KEY_PATH, and GH_INSTALLATION_ID environment variables.');
    }
    try {
        const { token } = await appOctokit.auth({ type: "installation" });
        return token;
    } catch (error) {
        console.error("Error getting GitHub installation token:", error);
        throw error;
    }
}

/**
 * Gets an Octokit instance authenticated as an installation.
 * @returns {Promise<Octokit>} Authenticated Octokit instance.
 */
export async function getAuthenticatedOctokit() {
    const token = await getGitHubInstallationToken();
    // Create Octokit with pagination plugin
    const MyOctokit = Octokit.plugin(paginateRest);
    return new MyOctokit({ auth: token });
}