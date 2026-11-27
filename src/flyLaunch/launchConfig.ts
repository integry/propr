/**
 * What the first-visit setup wizard of a Fly dashboard launch (#3827) saves,
 * and how it reaches the process environment on every boot.
 *
 * The wizard stores plain env values (GitHub App ids, OAuth client, webhook
 * secret, runtime tokens, the first administrator) in `config.json` and the
 * App private key in `github-app.pem`, both mode 0600 on the volume. On boot
 * they fill only the variables the environment leaves unset: a Fly secret or
 * a fly.toml [env] value always wins, so an operator can override any of them
 * with `fly secrets set` (or the dashboard's Secrets page) at any time.
 */
import { flyMcpInstanceId, flyPublicUrl, parseTruthyEnvValue } from '@propr/shared';
import type { LaunchStore } from './launchStore.js';

export const LAUNCH_CONFIG_FILE = 'config.json';
export const GITHUB_APP_KEY_FILE = 'github-app.pem';

export type LaunchRuntime = 'sprites' | 'fly-machines' | 'none';

export interface LaunchGithubApp {
    appId: number;
    slug: string;
    ownerLogin: string;
    htmlUrl: string;
}

export interface LaunchConfig {
    version: 1;
    /** Plain env values, applied where the environment has none. */
    env: Record<string, string>;
    github?: LaunchGithubApp;
    admin?: { login: string; id: number };
    runtime?: LaunchRuntime;
    completedAt?: string;
}

const present = (value: string | undefined): value is string => typeof value === 'string' && value.trim() !== '';

export function readLaunchConfig(store: LaunchStore): LaunchConfig {
    const stored = store.readJson<Partial<LaunchConfig>>(LAUNCH_CONFIG_FILE);
    return { version: 1, ...stored, env: { ...(stored?.env ?? {}) } };
}

export function writeLaunchConfig(store: LaunchStore, config: LaunchConfig): void {
    store.writeJson(LAUNCH_CONFIG_FILE, config);
}

/**
 * Whether the instance is configured without the wizard: GitHub credentials
 * (an own App or a ProPR Connect relay token) or demo mode come from the
 * environment. Checked on the environment as Fly started the process, before
 * any stored value is applied.
 */
export function configuredOutsideWizard(env: NodeJS.ProcessEnv): boolean {
    return present(env.GH_APP_ID) || present(env.PROPR_GH_RELAY_TOKEN) || parseTruthyEnvValue(env.PROPR_DEMO_MODE);
}

/** The wizard runs until it is completed, unless the environment configures the instance itself. */
export function setupRequired(config: LaunchConfig, startEnv: NodeJS.ProcessEnv): boolean {
    return !config.completedAt && !configuredOutsideWizard(startEnv);
}

/** The instance's public origin: API_PUBLIC_URL when set, else https://<FLY_APP_NAME>.fly.dev. */
export function launchPublicUrl(env: NodeJS.ProcessEnv): string {
    const explicit = env.API_PUBLIC_URL?.trim();
    if (explicit) return explicit.replace(/\/+$/, '');
    const app = env.FLY_APP_NAME?.trim();
    if (!app) throw new Error('FLY_APP_NAME is not set: the Fly launch entry derives the public URL from it (or set API_PUBLIC_URL)');
    return flyPublicUrl(app);
}

/**
 * Env `propr deploy fly` derives from the app name (buildAppEnv), derived here
 * from FLY_APP_NAME for a launch whose fly.toml cannot name the app.
 * `mcp` follows flyLaunchEnablesMcp, decided before these defaults are set.
 */
export function launchDerivedEnv(env: NodeJS.ProcessEnv, options: { mcp: boolean }): Record<string, string> {
    const publicUrl = launchPublicUrl(env);
    const app = env.FLY_APP_NAME?.trim() || new URL(publicUrl).hostname.split('.')[0];
    const derived: Record<string, string> = {
        API_PUBLIC_URL: publicUrl,
        FRONTEND_URL: publicUrl,
        GH_OAUTH_CALLBACK_URL: `${publicUrl}/api/auth/github/callback`,
        PROPR_INSTANCE_ID: app,
    };
    if (options.mcp) {
        derived.MCP_ENABLED = 'true';
        derived.MCP_PUBLIC_ORIGIN = new URL(publicUrl).origin;
        derived.MCP_INSTANCE_ID = flyMcpInstanceId(app);
    }
    return derived;
}

export interface AppliedLaunchEnv {
    /** Stored names applied to the environment. */
    applied: string[];
    /** Stored names the environment already set (a Fly secret wins). */
    overridden: string[];
}

/** Fill unset variables from the stored config, the stored App key and the derived env. Values are never reported. */
export function applyLaunchEnv(
    env: NodeJS.ProcessEnv,
    store: LaunchStore,
    config: LaunchConfig,
    options: { mcp: boolean; keyExists: (path: string) => boolean },
): AppliedLaunchEnv {
    const result: AppliedLaunchEnv = { applied: [], overridden: [] };
    const fill = (name: string, value: string, stored: boolean): void => {
        if (present(env[name])) {
            if (stored) result.overridden.push(name);
            return;
        }
        env[name] = value;
        if (stored) result.applied.push(name);
    };
    for (const [name, value] of Object.entries(config.env)) if (present(value)) fill(name, value, true);
    const keyPath = store.path(GITHUB_APP_KEY_FILE);
    if (options.keyExists(keyPath)) fill('GH_PRIVATE_KEY_PATH', keyPath, true);
    for (const [name, value] of Object.entries(launchDerivedEnv(env, options))) fill(name, value, false);
    // The wizard's runtime choice (or Sprites, the CLI default) when no operator setting picks one.
    fill('PROPR_AGENT_RUNTIME', 'sprites', false);
    if (env.PROPR_AGENT_RUNTIME === 'sprites') fill('SPRITES_CLIENT_SIGNALS', '0', false);
    return result;
}
