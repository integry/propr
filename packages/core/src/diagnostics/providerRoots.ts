import path from 'node:path';
import { isManagedAgentConfigPath, type AgentType } from '@propr/shared';
import { DEFAULT_CONFIG_PATHS, resolveCodexConfigPath, resolveConfigPath } from '../config/agentConfigPaths.js';
import { antigravityCredentialRoot } from './credentialRedaction.js';

export interface CredentialRootAgent {
    provider: string;
    configPath?: string;
    credentials?: Record<string, string>;
    nativeRoot?: string;
    authenticationRoot?: string;
}
/** Explicit, operator-visible refusals. None of them reads a credential. */
export type CredentialRootRefusal =
    | 'unsupported-provider'
    | 'unmapped-default-root'
    | 'relative-root'
    | 'no-mounted-auth-store';
export type CredentialRootResolution =
    | { root: string; basis: 'launch' | 'configured'; reason?: undefined }
    | { root?: undefined; reason: CredentialRootRefusal };
type Environment = Record<string, string | undefined>;

const providers = new Set<string>(['codex', 'claude', 'antigravity', 'opencode', 'vibe']);

/**
 * The credential directory a provider container actually mounts, resolved by
 * the same rules as its launcher, for hosted, native and Compose installs:
 * managed accounts below PROPR_MANAGED_CREDENTIALS_DIR (or ~/.propr/agent-credentials),
 * Codex's default through CODEX_CONFIG_PATH/HOST_CODEX_DIR, Vibe through
 * VIBE_CONFIG_PATH, OpenCode's data directory (HOST_OPENCODE_DATA_DIR or the
 * sibling of its config directory) and other `~` paths against HOME. Launcher-only
 * HOST_* variables are therefore never required when the launch path itself is
 * resolvable; a root the launcher would refuse is refused here too.
 */
export function resolveProviderCredentialRoot(agent: CredentialRootAgent, options: { resolve?: (value: string) => string; env?: Environment } = {}): CredentialRootResolution {
    // Launchers that compute their mount source pass it; it is authoritative.
    if (agent.authenticationRoot) return absolute(agent.authenticationRoot, 'launch');
    if (agent.provider === 'vibe' && agent.nativeRoot) return absolute(agent.nativeRoot, 'launch');
    if (!providers.has(agent.provider)) return { reason: 'unsupported-provider' };
    const env = options.env ?? process.env;
    const provider = agent.provider as AgentType;
    const configPath = agent.configPath || DEFAULT_CONFIG_PATHS[provider];
    const resolve = options.resolve ?? ((value: string) => provider === 'codex' ? resolveCodexConfigPath(value, env) : resolveConfigPath(value, env));
    try {
        switch (provider) {
            case 'antigravity': return absolute(antigravityCredentialRoot(configPath, resolve, env), 'configured');
            case 'vibe': return absolute(resolve(env.VIBE_CONFIG_PATH || configPath), 'configured');
            case 'opencode': {
                // Credentials live in the data directory, never the config directory.
                const managed = isManagedAgentConfigPath(configPath);
                if (env.HOST_OPENCODE_DATA_DIR && !managed) return absolute(env.HOST_OPENCODE_DATA_DIR, 'configured');
                if (agent.credentials?.XDG_DATA_HOME) return { reason: 'no-mounted-auth-store' };
                const config = resolve(configPath).replace(/\/+$/, '');
                if (!config.endsWith('/.config/opencode')) return { reason: 'no-mounted-auth-store' };
                return absolute(`${config.slice(0, -'/.config/opencode'.length)}/.local/share/opencode`, 'configured');
            }
            default: return absolute(resolve(configPath), 'configured');
        }
    } catch {
        // e.g. a containerized default with no host mapping: the launch refuses too.
        return { reason: 'unmapped-default-root' };
    }
}

function absolute(root: string, basis: 'launch' | 'configured'): CredentialRootResolution {
    const normalized = path.normalize(root);
    if (!path.isAbsolute(normalized) || normalized.includes('\0') || normalized === path.parse(normalized).root) return { reason: 'relative-root' };
    return { root: normalized, basis };
}
