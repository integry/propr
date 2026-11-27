import crypto from 'node:crypto';
import type { Knex } from 'knex';
import type { AgentConfig } from '../types.js';
import { AGENT_RUNTIME_ENV, dockerAgentRuntimeInUse, FLY_MACHINES_AGENT_RUNTIME, selectedAgentRuntimeName, SPRITES_AGENT_RUNTIME } from './runtimeSelection.js';

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
 * invalid persisted list, a failed read or an unparsable stored value is an
 * error rather than an empty list, so a run is never started without packages
 * it was configured to have. Only a genuinely absent setting yields `[]`.
 */
export async function loadConfiguredAgentRuntimePackages(client?: Knex): Promise<string[]> {
    // Imported lazily: the config store opens the database. Strict: a failed read or parse throws.
    const store = await import('../../config/configStore.js');
    const raw = client ? await store.getConfigWithClient<unknown>(AGENT_RUNTIME_PACKAGES_CONFIG_KEY, null, client, true)
        : await store.getConfigStrict<unknown>(AGENT_RUNTIME_PACKAGES_CONFIG_KEY, null);
    const packages = raw && typeof raw === 'object' ? (raw as { packages?: unknown }).packages : undefined;
    if (packages === undefined || packages === null) return [];
    const validation = validateAgentRuntimePackages(packages);
    if (!validation.valid) throw new Error(`Configured agent runtime packages are invalid: ${validation.errors.join('; ')}`);
    return validation.packages;
}

/**
 * The worker's default agent runtime (its `PROPR_AGENT_RUNTIME`), published in the shared config
 * store. The API process often runs without that variable, so on its own it would validate the
 * package list against Docker on a host that has none.
 */
export const WORKER_AGENT_RUNTIME_CONFIG_KEY = 'worker_agent_runtime';

/** Reads the published worker runtime; undefined when none was published or it cannot be read. */
export type PublishedAgentRuntime = () => Promise<string | undefined>;

async function readPublishedWorkerAgentRuntime(): Promise<string | undefined> {
    const { getConfig } = await import('../../config/configStore.js');
    const value = await getConfig<{ runtime?: unknown } | null>(WORKER_AGENT_RUNTIME_CONFIG_KEY, null);
    return typeof value?.runtime === 'string' && value.runtime.trim() ? value.runtime.trim().toLowerCase() : undefined;
}

/** Worker startup: record the runtime its agents default to. With several workers, the last one to start wins. */
export async function publishWorkerAgentRuntime(environment: NodeJS.ProcessEnv = process.env): Promise<void> {
    const { saveConfig } = await import('../../config/configStore.js');
    await saveConfig(WORKER_AGENT_RUNTIME_CONFIG_KEY, { runtime: selectedAgentRuntimeName(null, environment), publishedAt: new Date().toISOString() });
}

/** This process's environment, with the worker's published default when this process selects none itself. */
async function runtimeEnvironment(environment: NodeJS.ProcessEnv, published: PublishedAgentRuntime): Promise<NodeJS.ProcessEnv> {
    if (environment[AGENT_RUNTIME_ENV]?.trim()) return environment;
    const runtime = await published().catch(() => undefined);
    return runtime ? { ...environment, [AGENT_RUNTIME_ENV]: runtime } : environment;
}

async function agentSelections(configs?: ReadonlyArray<Pick<AgentConfig, 'runtime' | 'enabled'>>) {
    if (configs) return configs;
    const { getConfig } = await import('../../config/configStore.js');
    return getConfig<AgentConfig[]>('agents', []);
}

export interface RemoteAgentRuntimeOptions {
    /** The worker's published default runtime; the worker itself passes `async () => undefined` and uses its own environment. */
    published?: PublishedAgentRuntime;
}

/** The runtimes the enabled agents (or the default, without any) select, and whether any of them is Docker-based. */
export interface AgentRuntimeUsage { runtimes: string[]; docker: boolean }

/**
 * Which runtimes are in use. The default runtime is this process's `PROPR_AGENT_RUNTIME`, or else the
 * one the worker published, so the API decides like the worker that runs the agents.
 */
export async function agentRuntimeUsage(
    configs?: ReadonlyArray<Pick<AgentConfig, 'runtime' | 'enabled'>>, environment: NodeJS.ProcessEnv = process.env,
    { published = readPublishedWorkerAgentRuntime }: RemoteAgentRuntimeOptions = {},
): Promise<AgentRuntimeUsage> {
    const agents = await agentSelections(configs);
    const effective = await runtimeEnvironment(environment, published);
    const enabled = agents.filter(config => config.enabled !== false);
    const runtimes = [...new Set((enabled.length > 0 ? enabled : [null]).map(config => selectedAgentRuntimeName(config, effective)))].sort();
    return { runtimes, docker: dockerAgentRuntimeInUse(agents, effective) };
}

/**
 * How remote runtimes apply the packages when no enabled agent runs on Docker, e.g. "Installed when
 * Sprites are provisioned; no Docker image is built"; undefined when Docker is in use (the derived image
 * build applies them). Recomputed from the runtimes in use whenever it is shown or the state changes.
 */
export function describeRemoteAgentRuntimePackageInstall(usage: AgentRuntimeUsage): string | undefined {
    if (usage.docker) return undefined;
    const ways = [
        ...(usage.runtimes.includes(SPRITES_AGENT_RUNTIME) ? ['when Sprites are provisioned'] : []),
        ...(usage.runtimes.includes(FLY_MACHINES_AGENT_RUNTIME) ? ['in a derived Fly Machine image'] : []),
    ];
    return `Installed ${ways.join(' and ')}; no Docker image is built`;
}

/**
 * How the configured packages are applied when no enabled agent runs on Docker (see
 * `describeRemoteAgentRuntimePackageInstall`). Such a worker has no Docker daemon, so Settings must not
 * run the image build or the image-based package checks.
 */
export async function remoteAgentRuntimePackageInstall(
    configs?: ReadonlyArray<Pick<AgentConfig, 'runtime' | 'enabled'>>, environment: NodeJS.ProcessEnv = process.env,
    options: RemoteAgentRuntimeOptions = {},
): Promise<string | undefined> {
    return describeRemoteAgentRuntimePackageInstall(await agentRuntimeUsage(configs, environment, options));
}

/**
 * Whether any agent, the instance default, or the worker's published default selects a remote
 * runtime. Settings uses it to fall back to name and syntax validation when Docker is unreachable.
 */
export async function remoteAgentRuntimeConfigured(
    configs?: ReadonlyArray<Pick<AgentConfig, 'runtime' | 'enabled'>>, environment: NodeJS.ProcessEnv = process.env,
    { published = readPublishedWorkerAgentRuntime }: RemoteAgentRuntimeOptions = {},
): Promise<boolean> {
    const remote = (name: string) => name === SPRITES_AGENT_RUNTIME || name === FLY_MACHINES_AGENT_RUNTIME;
    const agents = (await agentSelections(configs).catch(() => [])).filter(config => config.enabled !== false);
    const publishedRuntime = await published().catch(() => undefined);
    return agents.some(config => remote(selectedAgentRuntimeName(config, environment)))
        || remote(selectedAgentRuntimeName(null, environment))
        || (publishedRuntime !== undefined && remote(publishedRuntime));
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
 * interpolated into the script. `keepAptLists` leaves the apt lists in place:
 * a Sprite's checkpoint keeps them, so a repository's `.propr/setup.sh` can
 * `apt-get install` without its own `apt-get update`, as on a Sprite without
 * runtime packages. A Fly Machine start-time install cleans them (nothing persists).
 */
export function agentRuntimePackageInstallCommand(packages: readonly string[], { keepAptLists = false }: { keepAptLists?: boolean } = {}): string[] {
    const validation = validateAgentRuntimePackages([...packages]);
    if (!validation.valid) throw new Error(`Refusing to install agent runtime packages: ${validation.errors.join('; ')}`);
    if (validation.packages.length === 0) throw new Error('Refusing to install an empty agent runtime package list');
    const script = [
        'set -eu',
        'command -v apt-get >/dev/null 2>&1 || { echo "agent runtime packages need apt-get, which this machine does not provide" >&2; exit 3; }',
        'apt-get update',
        'apt-get install -y --allow-downgrades --no-install-recommends "$@"',
        ...(keepAptLists ? [] : ['rm -rf /var/lib/apt/lists/*']),
    ].join('\n');
    return ['env', 'DEBIAN_FRONTEND=noninteractive', '/bin/bash', '-c', script, 'propr-runtime-packages', ...validation.packages];
}
