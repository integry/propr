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
    return environment.PROPR_CONTAINERIZED === '1'
        || environment.PROPR_CONTAINERIZED === 'true'
        || (environment === process.env && fs.existsSync('/.dockerenv'));
}

function validateCodexCredentialMapping(value: string, source: string): string {
    const normalized = path.normalize(value.trim());
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

/**
 * Resolves a config path, expanding ~ to the home directory.
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
    if (configPath === DEFAULT_CONFIG_PATHS.codex) {
        const mapping = environment.CODEX_CONFIG_PATH?.trim()
            ? { source: 'CODEX_CONFIG_PATH', value: environment.CODEX_CONFIG_PATH }
            : environment.HOST_CODEX_DIR?.trim()
                ? { source: 'HOST_CODEX_DIR', value: environment.HOST_CODEX_DIR }
                : undefined;
        if (mapping) return validateCodexCredentialMapping(mapping.value, mapping.source);
        if (isContainerizedEnvironment(environment)) {
            throw new AgentConfigPathUnavailableError(
                'The existing ~/.codex credential path has no host mapping in this container; ' +
                'configure HOST_CODEX_DIR and restart ProPR, or use a ProPR-managed Codex login'
            );
        }
    }
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
