/**
 * Where the Fly dashboard launch wizard (#3827) stands, derived only from
 * what is stored on the volume, so every step resumes after a restart.
 */
import type { LaunchConfig } from './launchConfig.js';
import type { GithubPath, SetupStep } from './setupPages.js';

/** Which GitHub path the stored config is on; the ProPR App path until an own App is created. */
export function githubPath(config: LaunchConfig): GithubPath {
    return config.github ? 'own-app' : 'connect';
}

/** Which step the stored config is at. */
export function currentSetupStep(config: LaunchConfig, keyExists: boolean): Exclude<SetupStep, 'claim'> {
    if (config.connect) {
        if (!config.env.PROPR_GH_RELAY_TOKEN || !config.env.GH_INSTALLATION_ID) return 'github';
        if (!config.env.GH_OAUTH_CLIENT_ID || !config.env.GH_OAUTH_CLIENT_SECRET) return 'signin-app';
    } else {
        if (!config.github || !config.env.GH_APP_ID || !keyExists) return 'github';
        if (!config.env.GH_INSTALLATION_ID) return 'install';
    }
    if (!config.env.PROPR_ADMIN_USERS) return 'admin';
    if (!config.runtime) return 'runtime';
    return 'finish';
}
