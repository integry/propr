import path from 'node:path';
import { isManagedAgentConfigPath, type AgentType } from '@propr/shared';
import { DEFAULT_CONFIG_PATHS, resolveCodexConfigPath, resolveConfigPath } from '../config/agentConfigPaths.js';
import { antigravityCredentialRoot } from './credentialRedaction.js';
import { openCodeEnvVarRejection } from '../agents/impl/openCodeEnvForwarding.js';

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
 * Codex's default through CODEX_CONFIG_PATH/HOST_CODEX_DIR, Claude's default
 * through CLAUDE_CONFIG_PATH/HOST_CLAUDE_DIR, Vibe through
 * VIBE_CONFIG_PATH, OpenCode's data directory (HOST_OPENCODE_DATA_DIR or the
 * sibling of its config directory) and other `~` paths against HOME. Launcher-only
 * HOST_* variables are therefore never required when the launch path itself is
 * resolvable; a root the launcher would refuse is refused here too.
 */
export function resolveProviderCredentialRoot(agent: CredentialRootAgent, options: { resolve?: (value: string) => string; env?: Environment } = {}): CredentialRootResolution {
    const launch = launchRoot(agent);
    if (launch) return launch;
    if (!providers.has(agent.provider)) return { reason: 'unsupported-provider' };
    const env = options.env ?? process.env;
    const provider = agent.provider as AgentType;
    const context: RootContext = {
        agent,
        env,
        configPath: agent.configPath || DEFAULT_CONFIG_PATHS[provider],
        resolve: options.resolve ?? defaultResolver(provider, env),
    };
    try {
        return (configuredRootResolvers[provider] ?? defaultConfiguredRoot)(context);
    } catch {
        // e.g. a containerized default with no host mapping: the launch refuses too.
        return { reason: 'unmapped-default-root' };
    }
}

interface RootContext {
    agent: CredentialRootAgent;
    env: Environment;
    configPath: string;
    resolve: (value: string) => string;
}

/** Launchers that compute their mount source pass it; it is authoritative. */
function launchRoot(agent: CredentialRootAgent): CredentialRootResolution | undefined {
    if (agent.authenticationRoot) return absolute(agent.authenticationRoot, 'launch');
    if (agent.provider === 'vibe' && agent.nativeRoot) return absolute(agent.nativeRoot, 'launch');
    return undefined;
}

function defaultResolver(provider: AgentType, env: Environment): (value: string) => string {
    return provider === 'codex'
        ? (value) => resolveCodexConfigPath(value, env)
        : (value) => resolveConfigPath(value, env);
}

const configuredRootResolvers: Partial<Record<AgentType, (context: RootContext) => CredentialRootResolution>> = {
    antigravity: ({ configPath, resolve, env }) => absolute(antigravityCredentialRoot(configPath, resolve, env), 'configured'),
    claude: claudeRoot,
    vibe: ({ configPath, resolve, env }) => absolute(resolve(env.VIBE_CONFIG_PATH || configPath), 'configured'),
    opencode: openCodeRoot,
};

function defaultConfiguredRoot({ configPath, resolve }: RootContext): CredentialRootResolution {
    return absolute(resolve(configPath), 'configured');
}

function claudeRoot({ configPath, resolve, env }: RootContext): CredentialRootResolution {
    // Compose mounts the host Claude home at CLAUDE_CONFIG_PATH; the worker's
    // own HOME (e.g. /root) has no .claude, so the default must not expand there.
    const mapping = env.CLAUDE_CONFIG_PATH?.trim() || env.HOST_CLAUDE_DIR?.trim();
    if (mapping && trimTrailingSlashes(configPath) === DEFAULT_CONFIG_PATHS.claude) return absolute(mapping, 'configured');
    return absolute(resolve(configPath), 'configured');
}

function openCodeRoot({ agent, configPath, resolve, env }: RootContext): CredentialRootResolution {
    // Credentials live in the data directory, never the config directory.
    if (env.HOST_OPENCODE_DATA_DIR && !isManagedAgentConfigPath(configPath)) return absolute(env.HOST_OPENCODE_DATA_DIR, 'configured');
    // Mirrors the launcher: only a forwarded XDG_DATA_HOME replaces the data
    // mount. The launcher also mounts the inferred sibling only when it exists;
    // a missing root is refused at capture as `credential-root:missing`.
    const xdgDataHome = agent.credentials?.XDG_DATA_HOME;
    if (xdgDataHome && !openCodeEnvVarRejection('XDG_DATA_HOME', xdgDataHome)) return { reason: 'no-mounted-auth-store' };
    const config = trimTrailingSlashes(resolve(configPath));
    if (!config.endsWith('/.config/opencode')) return { reason: 'no-mounted-auth-store' };
    return absolute(`${config.slice(0, -'/.config/opencode'.length)}/.local/share/opencode`, 'configured');
}

function absolute(root: string, basis: 'launch' | 'configured'): CredentialRootResolution {
    const normalized = path.normalize(root);
    if (!path.isAbsolute(normalized) || normalized.includes('\0') || normalized === path.parse(normalized).root) return { reason: 'relative-root' };
    return { root: normalized, basis };
}

/** Linear trailing-slash trim; `/\/+$/` backtracks polynomially on long slash runs. */
function trimTrailingSlashes(value: string): string {
    let end = value.length;
    while (end > 0 && value[end - 1] === '/') end--;
    return value.slice(0, end);
}
