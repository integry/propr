import fs from 'node:fs';
import path from 'node:path';
import { getManagedAgentConfigRelativePath, type AgentType } from '@propr/shared';

/* Pure agent credential path resolution, shared by provider launchers and
 * managed diagnostics. Deliberately free of logger and database imports so the
 * diagnostics entry point never loads a native binding. */

export const DEFAULT_CONFIG_PATHS: Record<AgentType, string> = {
    claude: '~/.claude',
    codex: '~/.codex',
    antigravity: '~/.gemini',
    opencode: '~/.config/opencode',
    vibe: '~/.vibe'
};

export class AgentConfigPathUnavailableError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'AgentConfigPathUnavailableError';
    }
}

type ConfigPathEnvironment = Record<string, string | undefined>;

function isContainerizedEnvironment(environment: ConfigPathEnvironment): boolean {
    const flag = environment.PROPR_CONTAINERIZED?.trim().toLowerCase();
    if (flag === '1' || flag === 'true') return true;
    // An explicit native declaration wins over the /.dockerenv heuristic, e.g.
    // for a native backend that itself runs inside a development container.
    if (flag === '0' || flag === 'false') return false;
    return environment === process.env && fs.existsSync('/.dockerenv');
}

/**
 * Launcher-provided host mappings for each provider's exact default path, in
 * precedence order. The launcher mounts the host directory HOST:HOST and sets
 * the `*_CONFIG_PATH` variable to it; `HOST_*` is the raw launcher setting.
 * Login, health, usage and execution all resolve the default through this one
 * table so they bind the same host credential store.
 */
export const DEFAULT_CONFIG_PATH_MAPPINGS: Record<AgentType, readonly string[]> = {
    claude: ['CLAUDE_CONFIG_PATH', 'HOST_CLAUDE_DIR'],
    codex: ['CODEX_CONFIG_PATH', 'HOST_CODEX_DIR'],
    antigravity: ['ANTIGRAVITY_CONFIG_PATH', 'HOST_ANTIGRAVITY_DIR'],
    opencode: ['OPENCODE_CONFIG_PATH', 'HOST_OPENCODE_XDG_DIR'],
    vibe: ['VIBE_CONFIG_PATH', 'HOST_VIBE_DIR']
};

const PROVIDER_NAMES: Record<AgentType, string> = {
    claude: 'Claude',
    codex: 'Codex',
    antigravity: 'Antigravity',
    opencode: 'OpenCode',
    vibe: 'Vibe'
};

function validateCredentialMapping(value: string, source: string): string {
    // One canonical identity per directory, so login and execution compare equal;
    // normalize() has already collapsed repeated separators to one.
    const collapsed = path.normalize(value.trim());
    const normalized = collapsed.length > 1 && collapsed.endsWith('/') ? collapsed.slice(0, -1) : collapsed;
    if (!normalized || !path.isAbsolute(normalized) || normalized.includes(':') || /[\0\r\n]/.test(normalized)) {
        throw new AgentConfigPathUnavailableError(
            `${source} must name an absolute Linux directory mounted into this container`
        );
    }
    if (normalized === path.parse(normalized).root) {
        throw new AgentConfigPathUnavailableError(`${source} cannot be the filesystem root`);
    }
    return normalized;
}

/** The provider whose exact portable default this config path is, if any. */
export function defaultConfigPathProvider(configPath: string): AgentType | undefined {
    return (Object.keys(DEFAULT_CONFIG_PATHS) as AgentType[])
        .find(type => DEFAULT_CONFIG_PATHS[type] === configPath);
}

/**
 * Resolve a provider's exact default path through its launcher host mapping.
 *
 * Returns the validated mapping when one is configured, the backend HOME
 * expansion on a native host without a mapping, and throws in a containerized
 * backend without a mapping: there the backend's own HOME (e.g. /root) is not
 * the operator's account, so expanding against it would silently bind a
 * different (usually empty or stale) credential store.
 */
export function resolveDefaultConfigPath(
    type: AgentType,
    environment: ConfigPathEnvironment = process.env
): string {
    const source = DEFAULT_CONFIG_PATH_MAPPINGS[type].find(name => environment[name]?.trim());
    if (source) return validateCredentialMapping(environment[source]!, source);
    const defaultPath = DEFAULT_CONFIG_PATHS[type];
    if (isContainerizedEnvironment(environment)) {
        const hostVariable = DEFAULT_CONFIG_PATH_MAPPINGS[type][1];
        throw new AgentConfigPathUnavailableError(
            `The existing ${defaultPath} credential path has no host mapping in this container; ` +
            `configure ${hostVariable} and restart ProPR, or use a ProPR-managed ${PROVIDER_NAMES[type]} login`
        );
    }
    const homeDir = environment.HOME || environment.USERPROFILE || '/root';
    return path.join(homeDir, defaultPath.slice(1));
}

/**
 * Resolves a config path to the bind source visible to the Docker daemon.
 *
 * ProPR-managed paths resolve below the managed credential root. A provider's
 * exact portable default (e.g. `~/.claude`) means "this installation's existing
 * host account" and resolves through the launcher host mapping (see
 * resolveDefaultConfigPath). Explicit absolute paths are returned unchanged;
 * other `~` paths expand against HOME.
 */
export function resolveConfigPath(
    configPath: string,
    environment: ConfigPathEnvironment = process.env
): string {
    const managedRelativePath = getManagedAgentConfigRelativePath(configPath);
    if (managedRelativePath) {
        const homeDir = environment.HOME || environment.USERPROFILE || '/root';
        const managedRoot = environment.PROPR_MANAGED_CREDENTIALS_DIR
            || path.join(homeDir, '.propr', 'agent-credentials');
        return path.join(managedRoot, managedRelativePath);
    }
    const defaultProvider = defaultConfigPathProvider(configPath);
    if (defaultProvider) return resolveDefaultConfigPath(defaultProvider, environment);
    if (configPath.startsWith('~')) {
        const homeDir = environment.HOME || environment.USERPROFILE || '/root';
        return path.join(homeDir, configPath.slice(1));
    }
    return configPath;
}

/**
 * Resolve Codex's saved config path to the bind source visible to the backend.
 *
 * The portable default represents "this installation's existing host account",
 * so a containerized backend must use the launcher-provided host mapping instead
 * of expanding it against the backend user's HOME. Explicit custom and managed
 * paths retain their existing per-agent meaning and are never replaced by the
 * provider-wide mapping.
 */
export function resolveCodexConfigPath(
    configPath: string,
    environment: ConfigPathEnvironment = process.env
): string {
    const configured = configPath || DEFAULT_CONFIG_PATHS.codex;
    const managed = getManagedAgentConfigRelativePath(configured);
    if (!managed
        && configured !== DEFAULT_CONFIG_PATHS.codex
        && (configured === '~' || configured.startsWith('~/'))
        && isContainerizedEnvironment(environment)) {
        throw new AgentConfigPathUnavailableError(
            'Custom Codex credential paths must be absolute in a containerized ProPR installation; ' +
            'update this agent config path to the mounted host directory'
        );
    }
    return resolveConfigPath(configured, environment);
}

/**
 * Fail before Docker can create an empty bind source and start Codex without
 * the account the operator selected. This checks path metadata only; credential
 * files are never read or copied into diagnostics.
 */
export function assertCodexConfigPathAvailable(configPath: string): void {
    try {
        if (fs.statSync(configPath).isDirectory()) return;
    } catch {
        // Use the same bounded, actionable error for missing and inaccessible paths.
    }
    throw new AgentConfigPathUnavailableError(
        `The configured Codex credential directory is unavailable at ${configPath}; ` +
        'ensure HOST_CODEX_DIR points to an existing mounted directory and restart ProPR, ' +
        'or use a ProPR-managed Codex login'
    );
}
