import type { AgentType } from '../types.js';

/**
 * What each provider CLI needs from its host credential store, and which of
 * those files it may refresh during a run.
 *
 * The credential broker copies only these entries into a per-run directory
 * (or hands them to a remote runtime as a file list) instead of exposing the
 * whole host directory. After the run only `refresh` files are written back
 * to the canonical store; anything else the CLI writes (sessions, logs,
 * caches, edited settings) stays in the disposable copy.
 */

/** `config`: the provider's config/auth directory. `data`: a separate data directory (OpenCode's XDG data). */
export type CredentialStoreKind = 'config' | 'data';

export interface CredentialManifestEntry {
    /** POSIX path relative to the store root. */
    path: string;
    type: 'file' | 'directory';
    /** The CLI rewrites this file when it refreshes a token; it is written back after the run. */
    refresh?: boolean;
}

/** A dotenv-style file whose listed variables are supplied to the run as secrets instead of as a file. */
export interface CredentialSecretEnvSource {
    path: string;
    variables: readonly string[];
}

export interface ProviderCredentialManifest {
    provider: AgentType;
    store: CredentialStoreKind;
    entries: readonly CredentialManifestEntry[];
    secretEnvFiles?: readonly CredentialSecretEnvSource[];
    /**
     * Variables that authenticate the provider without any file. When the run
     * already defines one, the refreshable token files are not materialised:
     * an API-key run never sees the OAuth login.
     */
    apiKeyEnv?: readonly string[];
}

const file = (path: string, refresh = false): CredentialManifestEntry => ({ path, type: 'file', ...(refresh ? { refresh } : {}) });
const directory = (path: string): CredentialManifestEntry => ({ path, type: 'directory' });

const MANIFESTS: readonly ProviderCredentialManifest[] = Object.freeze([
    {
        provider: 'claude', store: 'config',
        entries: [
            file('.credentials.json', true),
            file('settings.json'),
            file('CLAUDE.md'),
            directory('agents'),
            directory('commands'),
            directory('skills'),
            directory('output-styles'),
        ],
        apiKeyEnv: ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'],
    },
    {
        provider: 'codex', store: 'config',
        entries: [
            file('auth.json', true),
            file('config.toml'),
            file('AGENTS.md'),
            directory('prompts'),
            directory('rules'),
            directory('skills'),
        ],
        apiKeyEnv: ['CODEX_API_KEY'],
    },
    {
        // Task runs mount the store as a source the entrypoint copies into a
        // disposable HOME; these are exactly the files it copies and syncs back.
        provider: 'antigravity', store: 'config',
        entries: [
            file('antigravity-cli/antigravity-oauth-token', true),
            file('antigravity-cli/settings.json'),
        ],
    },
    {
        provider: 'opencode', store: 'config',
        entries: [
            file('opencode.json'),
            file('opencode.jsonc'),
            file('config.json'),
            file('tui.json'),
            file('AGENTS.md'),
            // Documented fallback without a separate data mount: logins copied
            // under the config tree (agent XDG_DATA_HOME=<config>/xdg-data).
            file('xdg-data/opencode/auth.json', true),
            file('xdg-data/opencode/account.json', true),
            ...['agent', 'agents', 'command', 'commands', 'mode', 'modes', 'plugin', 'plugins', 'tool', 'tools', 'skill', 'skills', 'themes']
                .map(directory),
        ],
    },
    {
        // OpenCode keeps provider logins in its data directory.
        provider: 'opencode', store: 'data',
        entries: [file('auth.json', true), file('account.json', true)],
    },
    {
        // Mounted read-only: Vibe never refreshes through ProPR. Its `.env`
        // API-key fallback is supplied as a secret variable, not as a file.
        provider: 'vibe', store: 'config',
        entries: [
            file('config.toml'),
            file('settings.json'),
            file('credentials.json'),
            directory('agents'),
            directory('prompts'),
        ],
        secretEnvFiles: [{ path: '.env', variables: ['MISTRAL_API_KEY'] }],
        apiKeyEnv: ['MISTRAL_API_KEY'],
    },
]);

export function providerCredentialManifest(provider: AgentType, store: CredentialStoreKind): ProviderCredentialManifest | undefined {
    return MANIFESTS.find(manifest => manifest.provider === provider && manifest.store === store);
}

export function providerCredentialManifests(): readonly ProviderCredentialManifest[] {
    return MANIFESTS;
}

/** Files the provider may refresh, i.e. what a runtime must return after the run. */
export function refreshableCredentialPaths(manifest: ProviderCredentialManifest): string[] {
    return manifest.entries.filter(entry => entry.type === 'file' && entry.refresh).map(entry => entry.path);
}
