import crypto from 'node:crypto';
import type { AgentConfig } from '../types.js';
import { dockerAgentRuntimeInUse, FLY_MACHINES_AGENT_RUNTIME, selectedAgentRuntimeName, SPRITES_AGENT_RUNTIME } from './runtimeSelection.js';

/**
 * The configured instance runtime package list, without the Docker image
 * machinery in `agentRuntimePackages.ts`: remote runtimes (Sprites) and the
 * launch-time capability check read it here so they need no Docker daemon.
 */
export const AGENT_RUNTIME_PACKAGES_CONFIG_KEY = 'agent_runtime_packages';
const MAX_PACKAGES = 100;
const PACKAGE_SPEC = /^[a-z0-9][a-z0-9+.-]*(?::[a-z0-9][a-z0-9-]*)?(?:=[A-Za-z0-9.+:~_-]+)?$/;

export interface RuntimePackageValidation { valid: boolean; packages: string[]; errors: string[]; }

export function normalizeAgentRuntimePackageList(packages: unknown): string[] {
    if (!Array.isArray(packages)) return [];
    return [...new Set(packages
        .filter((value): value is string => typeof value === 'string')
        .map(value => {
            const trimmed = value.trim();
            const separator = trimmed.indexOf('=');
            if (separator === -1) return trimmed.toLowerCase();
            return `${trimmed.slice(0, separator).toLowerCase()}=${trimmed.slice(separator + 1)}`;
        })
        .filter(Boolean))].sort();
}

export function validateAgentRuntimePackages(packages: unknown): RuntimePackageValidation {
    if (!Array.isArray(packages)) {
        return { valid: false, packages: [], errors: ['packages must be an array of system package names'] };
    }
    const normalized = normalizeAgentRuntimePackageList(packages);
    const errors: string[] = [];
    if (normalized.length > MAX_PACKAGES) errors.push(`at most ${MAX_PACKAGES} packages may be configured`);
    for (const packageSpec of normalized) {
        if (!PACKAGE_SPEC.test(packageSpec)) errors.push(`invalid package spec: ${packageSpec}`);
    }
    return { valid: errors.length === 0, packages: normalized, errors };
}

/**
 * The package list configured in Settings (normalized and sorted). Read-only:
 * unlike `loadAgentRuntimePackageState` it never writes the state back. An
 * invalid persisted list is an error rather than an empty list, so a run is
 * never started without packages it was configured to have.
 */
export async function loadConfiguredAgentRuntimePackages(): Promise<string[]> {
    // Imported lazily: the config store opens the database.
    const { getConfig } = await import('../../config/configStore.js');
    const raw = await getConfig<unknown>(AGENT_RUNTIME_PACKAGES_CONFIG_KEY, null);
    const packages = raw && typeof raw === 'object' ? (raw as { packages?: unknown }).packages : undefined;
    if (packages === undefined || packages === null) return [];
    const validation = validateAgentRuntimePackages(packages);
    if (!validation.valid) throw new Error(`Configured agent runtime packages are invalid: ${validation.errors.join('; ')}`);
    return validation.packages;
}

/**
 * How the configured packages are applied when no enabled agent runs on Docker,
 * e.g. "Installed when Sprites are provisioned"; undefined when Docker is in use
 * (the derived image build applies them). Such a worker has no Docker daemon,
 * so Settings must not run the image build or the image-based package checks.
 */
export async function remoteAgentRuntimePackageInstall(
    configs?: ReadonlyArray<Pick<AgentConfig, 'runtime' | 'enabled'>>, environment: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
    let agents = configs;
    if (!agents) {
        const { getConfig } = await import('../../config/configStore.js');
        agents = await getConfig<AgentConfig[]>('agents', []);
    }
    if (dockerAgentRuntimeInUse(agents, environment)) return undefined;
    const enabled = agents.filter(config => config.enabled !== false);
    const runtimes = new Set((enabled.length > 0 ? enabled : [null]).map(config => selectedAgentRuntimeName(config, environment)));
    const ways = [
        ...(runtimes.has(SPRITES_AGENT_RUNTIME) ? ['when Sprites are provisioned'] : []),
        ...(runtimes.has(FLY_MACHINES_AGENT_RUNTIME) ? ['at every Fly Machine start'] : []),
    ];
    return `Installed ${ways.join(' and ')}; no Docker image is built`;
}

/** Stable digest of a normalized package list; the empty list has its own digest. */
export function agentRuntimePackagesDigest(packages: readonly string[]): string {
    return crypto.createHash('sha256').update(JSON.stringify(normalizeAgentRuntimePackageList([...packages]))).digest('hex').slice(0, 16);
}

/** Upper bound on one runtime package install (Sprite provisioning, Fly Machine start). */
export const AGENT_RUNTIME_PACKAGE_INSTALL_TIMEOUT_MS = 15 * 60_000;
const LOGGED_PACKAGE_NAMES = 5;

/**
 * Log fields identifying an installed package list: its digest and count,
 * plus the names only while the list is short enough to read in one line.
 */
export function agentRuntimePackagesLogFields(packages: readonly string[]): { packagesDigest: string; packageCount: number; packages?: string[] } {
    return { packagesDigest: agentRuntimePackagesDigest(packages), packageCount: packages.length,
        ...(packages.length <= LOGGED_PACKAGE_NAMES && { packages: [...packages] }) };
}

/**
 * argv (run as root) that installs `packages` with apt, using the same flags
 * as the derived Docker image. The specs travel as positional arguments, never
 * interpolated into the script.
 */
export function agentRuntimePackageInstallCommand(packages: readonly string[]): string[] {
    const validation = validateAgentRuntimePackages([...packages]);
    if (!validation.valid) throw new Error(`Refusing to install agent runtime packages: ${validation.errors.join('; ')}`);
    if (validation.packages.length === 0) throw new Error('Refusing to install an empty agent runtime package list');
    const script = [
        'set -eu',
        'command -v apt-get >/dev/null 2>&1 || { echo "agent runtime packages need apt-get, which this machine does not provide" >&2; exit 3; }',
        'apt-get update',
        'apt-get install -y --allow-downgrades --no-install-recommends "$@"',
        'rm -rf /var/lib/apt/lists/*',
    ].join('\n');
    return ['env', 'DEBIAN_FRONTEND=noninteractive', '/bin/bash', '-c', script, 'propr-runtime-packages', ...validation.packages];
}
