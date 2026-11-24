import type { AgentRunResources } from './types.js';

/**
 * Operator configuration of the Fly Machines runtime. Every run is an
 * ephemeral Machine in one Fly app, created through the Machines API with a
 * scoped deploy token for that app.
 */
export const FLY_MACHINES_ENV = {
    /** Deploy token scoped to the app (`fly tokens create deploy -a <app>`); `FLY_API_TOKEN` is the fallback. */
    token: 'PROPR_FLY_API_TOKEN',
    app: 'PROPR_FLY_APP',
    /** Region code (`iad`, `ams`, ...); Fly picks one near the API caller when unset. */
    region: 'PROPR_FLY_REGION',
    /** Guest preset: `shared-cpu-<n>x` or `performance-<n>x`. */
    size: 'PROPR_FLY_MACHINE_SIZE',
    /** Memory in MB; defaults to the run's memory limit, else the preset's. */
    memoryMb: 'PROPR_FLY_MACHINE_MEMORY_MB',
    /** Pullable image the Machines run instead of the run's own image reference (e.g. `registry.fly.io/<app>:agent`). */
    image: 'PROPR_FLY_IMAGE',
    apiUrl: 'PROPR_FLY_MACHINES_API_URL',
    logsApiUrl: 'PROPR_FLY_LOGS_API_URL',
    /** `on` / `off` / `auto` (default: on when the control plane itself runs on Fly). */
    privateNetwork: 'PROPR_FLY_PRIVATE_NETWORK',
    /** Pre-pull the image in the region when the runtime starts: `1` / `true`. */
    prewarm: 'PROPR_FLY_PREWARM',
    /** How long a finished Machine waits for the worker to read its result before it exits on its own. */
    resultLingerSeconds: 'PROPR_FLY_RESULT_LINGER_SECONDS',
} as const;

export const DEFAULT_FLY_MACHINES_API_URL = 'https://api.machines.dev/v1';
export const DEFAULT_FLY_LOGS_API_URL = 'https://api.fly.io/api/v1';
export const DEFAULT_FLY_MACHINE_SIZE = 'performance-2x';
export const DEFAULT_FLY_RESULT_LINGER_SECONDS = 15 * 60;

export interface FlyMachineGuest {
    cpu_kind: 'shared' | 'performance';
    cpus: number;
    memory_mb: number;
}

export interface FlyMachinesConfig {
    token: string;
    app: string;
    region?: string;
    size: string;
    memoryMb?: number;
    image?: string;
    apiUrl: string;
    logsApiUrl: string;
    /** The control plane shares the Machines' private network (`.internal` names resolve). */
    privateNetwork: boolean;
    prewarm: boolean;
    resultLingerSeconds: number;
}

export class FlyMachinesConfigError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'FlyMachinesConfigError';
    }
}

type Environment = Record<string, string | undefined>;

const APP_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const REGION_PATTERN = /^[a-z]{3}$/;
const SIZE_PATTERN = /^(shared-cpu|performance)-(\d{1,2})x$/;

function trimmed(environment: Environment, name: string): string | undefined {
    return environment[name]?.trim() || undefined;
}

function flag(value: string | undefined): boolean {
    return value === '1' || value?.toLowerCase() === 'true' || value?.toLowerCase() === 'on';
}

function withoutTrailingSlashes(url: string): string {
    let end = url.length;
    while (end > 0 && url[end - 1] === '/') end--;
    return url.slice(0, end);
}

/**
 * Whether the control plane runs on Fly and shares the org's private
 * network: Fly sets `FLY_APP_NAME` and `FLY_PRIVATE_IP` in every Machine.
 */
export function controlPlaneOnFly(environment: Environment = process.env): boolean {
    return !!trimmed(environment, 'FLY_APP_NAME') && !!trimmed(environment, 'FLY_PRIVATE_IP');
}

/** `on`/`off` as configured, else on exactly when the control plane runs on Fly. */
export function flyPrivateNetworkEnabled(environment: Environment = process.env): boolean {
    const configured = trimmed(environment, FLY_MACHINES_ENV.privateNetwork)?.toLowerCase();
    if (!configured || configured === 'auto') return controlPlaneOnFly(environment);
    if (['on', '1', 'true'].includes(configured)) return true;
    if (['off', '0', 'false'].includes(configured)) return false;
    throw new FlyMachinesConfigError(`${FLY_MACHINES_ENV.privateNetwork} must be "on", "off" or "auto", not "${configured}"`);
}

/**
 * The ProPR MCP endpoint over the org private network when the control plane
 * runs on Fly: `http://<app>.internal:<port>/api/mcp`. Operators point
 * `PROPR_INTERNAL_API_URL` (or `PROPR_AGENT_MCP_URL`) at it so Machines reach
 * ProPR without a public endpoint.
 */
export function flyInternalMcpUrl(environment: Environment = process.env, port = environment.PORT?.trim() || '4000'): string | undefined {
    const app = trimmed(environment, 'FLY_APP_NAME');
    return app ? `http://${app}.internal:${port}/api/mcp` : undefined;
}

function wholeNumber(environment: Environment, name: string, minimum: number, unit: string): number | undefined {
    const raw = trimmed(environment, name);
    if (raw === undefined) return undefined;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < minimum) throw new FlyMachinesConfigError(`${name} must be a whole number of ${unit} (${minimum} or more), not "${raw}"`);
    return value;
}

/** Reads and validates the runtime configuration; throws a {@link FlyMachinesConfigError} naming what is missing. */
export function resolveFlyMachinesConfig(environment: Environment = process.env): FlyMachinesConfig {
    const token = trimmed(environment, FLY_MACHINES_ENV.token) ?? trimmed(environment, 'FLY_API_TOKEN');
    const app = trimmed(environment, FLY_MACHINES_ENV.app);
    const missing = [...(token ? [] : [FLY_MACHINES_ENV.token]), ...(app ? [] : [FLY_MACHINES_ENV.app])];
    if (missing.length > 0) throw new FlyMachinesConfigError(`The fly-machines agent runtime needs ${missing.join(' and ')}`);
    if (!APP_NAME_PATTERN.test(app!)) throw new FlyMachinesConfigError(`${FLY_MACHINES_ENV.app} is not a valid Fly app name: "${app}"`);
    const region = trimmed(environment, FLY_MACHINES_ENV.region)?.toLowerCase();
    if (region && !REGION_PATTERN.test(region)) throw new FlyMachinesConfigError(`${FLY_MACHINES_ENV.region} is not a Fly region code: "${region}"`);
    const size = (trimmed(environment, FLY_MACHINES_ENV.size) ?? DEFAULT_FLY_MACHINE_SIZE).toLowerCase();
    if (!SIZE_PATTERN.test(size)) throw new FlyMachinesConfigError(`${FLY_MACHINES_ENV.size} must be shared-cpu-<n>x or performance-<n>x, not "${size}"`);
    const memoryMb = wholeNumber(environment, FLY_MACHINES_ENV.memoryMb, 256, 'MB');
    const resultLingerSeconds = wholeNumber(environment, FLY_MACHINES_ENV.resultLingerSeconds, 30, 'seconds') ?? DEFAULT_FLY_RESULT_LINGER_SECONDS;
    const image = trimmed(environment, FLY_MACHINES_ENV.image);
    return {
        token: token!, app: app!, ...(region ? { region } : {}), size, ...(memoryMb !== undefined ? { memoryMb } : {}),
        ...(image ? { image } : {}),
        apiUrl: withoutTrailingSlashes(trimmed(environment, FLY_MACHINES_ENV.apiUrl) ?? DEFAULT_FLY_MACHINES_API_URL),
        logsApiUrl: withoutTrailingSlashes(trimmed(environment, FLY_MACHINES_ENV.logsApiUrl) ?? DEFAULT_FLY_LOGS_API_URL),
        privateNetwork: flyPrivateNetworkEnabled(environment),
        prewarm: flag(trimmed(environment, FLY_MACHINES_ENV.prewarm)),
        resultLingerSeconds,
    };
}

/** Docker memory limit (`6g`, `4096m`, bytes) in MB, rounded up; undefined when unparseable. */
export function dockerMemoryToMb(value: string | undefined): number | undefined {
    const match = /^(\d+)([bkmg]?)$/i.exec(value?.trim() ?? '');
    if (!match) return undefined;
    const factor = { '': 1, b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[match[2].toLowerCase() as '' | 'b' | 'k' | 'm' | 'g'];
    return Math.ceil((Number(match[1]) * factor) / 1024 ** 2);
}

/**
 * The Machine guest for a run: the configured preset's CPU kind and count,
 * and memory from the configuration, else the run's own memory limit, else
 * the preset's default. Memory is rounded up to Fly's 256 MB granularity.
 */
export function flyMachineGuest(config: Pick<FlyMachinesConfig, 'size' | 'memoryMb'>, resources?: AgentRunResources): FlyMachineGuest {
    const [, kind, count] = SIZE_PATTERN.exec(config.size)!;
    const cpus = Number(count);
    const cpuKind = kind === 'performance' ? 'performance' : 'shared';
    const presetMb = cpus * (cpuKind === 'performance' ? 2048 : 256);
    const requested = config.memoryMb ?? dockerMemoryToMb(resources?.memory) ?? presetMb;
    return { cpu_kind: cpuKind, cpus, memory_mb: Math.max(256, Math.ceil(requested / 256) * 256) };
}
