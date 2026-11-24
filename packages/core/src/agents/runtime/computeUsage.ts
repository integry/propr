/**
 * Compute usage of one agent run: what the sandbox itself consumed, beside
 * the LLM token cost the provider reports.
 *
 * A runtime reports it when the run settles ({@link AgentRunResult.computeUsage}).
 * Its cost is the runtime's own figure when it bills per run (`runtime`), else
 * priced from the operator's rate table in `PROPR_COMPUTE_RATES` (`rate_table`),
 * else unknown (null): a local Docker run costs nothing ProPR can know.
 */

import logger from '../../utils/logger.js';

export type ComputeCostSource = 'runtime' | 'rate_table';

export interface AgentRunComputeUsage {
    /** Runtime kind the run used (`docker`, `fly`, `sprites`, ...). */
    runtime: string;
    /** From the sandbox starting to its exit. */
    wallTimeMs: number;
    /** CPU time the sandbox consumed; null when the runtime could not measure it. */
    cpuSeconds: number | null;
    /** Highest memory charged to the sandbox; null when unmeasured. */
    peakMemoryBytes: number | null;
    /** Time-weighted average memory over the run; null when unmeasured. */
    avgMemoryBytes: number | null;
    /** Compute cost in USD; null when neither the runtime nor the rate table priced it. */
    costUsd: number | null;
    costSource: ComputeCostSource | null;
    /** How a pooled runtime (Sprites) got the run its sandbox; absent for runtimes without a runner pool. */
    runnerPool?: AgentRunRunnerPoolUsage;
}

/** Runner pool timings of one run, in milliseconds. */
export interface AgentRunRunnerPoolUsage {
    /** Queued for a free runner (every runner busy). */
    waitMs: number;
    /** A runner was created and set up for this run. */
    provisioned: boolean;
    provisionMs: number | null;
    /** The health check of the reused runner before its lease. */
    healthCheckMs: number | null;
    /** The checkpoint restore that reset the reused runner after its previous run (off this run's critical path). */
    previousRestoreMs: number | null;
    /** A restore this run waited for: the runner held another repository's warm clone. */
    restoreBeforeLeaseMs: number | null;
    /** The checkpoint the run started from. */
    baseline: 'clean' | 'warm';
}

/** JSON object keyed by runtime kind, e.g. `{"fly":{"perHourUsd":0.02},"sprites":{"perCpuSecondUsd":0.00001}}`. */
export const COMPUTE_RATES_ENV = 'PROPR_COMPUTE_RATES';

/** Rates for one runtime kind; every given rate is added up. */
export interface ComputeRate {
    /** Per hour of wall time (a provisioned machine). */
    perHourUsd?: number;
    /** Per CPU-second consumed. */
    perCpuSecondUsd?: number;
    /** Per GiB-hour of memory (average memory, or peak when no average was measured, over wall time). */
    perGiBHourUsd?: number;
}

export type ComputeRateTable = Record<string, ComputeRate>;

const RATE_KEYS = ['perHourUsd', 'perCpuSecondUsd', 'perGiBHourUsd'] as const;
const GIB = 1024 ** 3;

let warnedRates: string | undefined;

/**
 * The rate table in `PROPR_COMPUTE_RATES`. A malformed table, or a rate that is
 * not a finite non-negative number, is ignored (and logged once) rather than
 * pricing runs with a guess.
 */
export function loadComputeRateTable(environment: NodeJS.ProcessEnv = process.env): ComputeRateTable {
    const raw = environment[COMPUTE_RATES_ENV]?.trim();
    if (!raw) return {};
    const warn = (reason: string): ComputeRateTable => {
        if (warnedRates !== raw) {
            warnedRates = raw;
            logger.warn({ env: COMPUTE_RATES_ENV, reason }, 'Ignoring invalid compute rate table');
        }
        return {};
    };
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return warn('not valid JSON');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return warn('expected an object keyed by runtime');
    const table: ComputeRateTable = {};
    for (const [kind, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return warn(`rates for "${kind}" are not an object`);
        const rate: ComputeRate = {};
        for (const [key, amount] of Object.entries(value as Record<string, unknown>)) {
            if (!(RATE_KEYS as readonly string[]).includes(key)) return warn(`unknown rate "${key}" for "${kind}"`);
            if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) return warn(`rate "${key}" for "${kind}" is not a non-negative number`);
            rate[key as keyof ComputeRate] = amount;
        }
        table[kind.trim().toLowerCase()] = rate;
    }
    return table;
}

/** The run's cost under `rate`; null when a rate needs a measurement the run lacks. */
export function priceComputeUsage(usage: AgentRunComputeUsage, rate: ComputeRate): number | null {
    let cost = 0;
    const hours = usage.wallTimeMs / 3_600_000;
    if (rate.perHourUsd !== undefined) cost += rate.perHourUsd * hours;
    if (rate.perCpuSecondUsd !== undefined) {
        if (usage.cpuSeconds === null) return null;
        cost += rate.perCpuSecondUsd * usage.cpuSeconds;
    }
    if (rate.perGiBHourUsd !== undefined) {
        const memory = usage.avgMemoryBytes ?? usage.peakMemoryBytes;
        if (memory === null) return null;
        cost += rate.perGiBHourUsd * (memory / GIB) * hours;
    }
    return Math.round(cost * 1e6) / 1e6;
}

/**
 * The usage with its cost settled: a runtime-provided cost is kept, otherwise
 * the rate table for its runtime prices it, otherwise the cost stays unknown.
 */
export function withComputeCost(usage: AgentRunComputeUsage, table: ComputeRateTable = loadComputeRateTable()): AgentRunComputeUsage {
    if (usage.costUsd !== null && usage.costSource === 'runtime') return usage;
    const rate = table[usage.runtime.toLowerCase()];
    const costUsd = rate ? priceComputeUsage(usage, rate) : null;
    return { ...usage, costUsd, costSource: costUsd === null ? null : 'rate_table' };
}

/** Copies the run's compute usage onto the result built from it, when the runtime reported one. */
export function attachComputeUsage<T extends { computeUsage?: AgentRunComputeUsage }>(target: T, run: { computeUsage?: AgentRunComputeUsage }): T {
    if (run.computeUsage) target.computeUsage = run.computeUsage;
    return target;
}

const finiteOrNull = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

function normalizeRunnerPoolUsage(value: unknown): AgentRunRunnerPoolUsage | null {
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    const waitMs = finiteOrNull(record.waitMs);
    if (waitMs === null || typeof record.provisioned !== 'boolean') return null;
    return {
        waitMs,
        provisioned: record.provisioned,
        provisionMs: finiteOrNull(record.provisionMs),
        healthCheckMs: finiteOrNull(record.healthCheckMs),
        previousRestoreMs: finiteOrNull(record.previousRestoreMs),
        restoreBeforeLeaseMs: finiteOrNull(record.restoreBeforeLeaseMs),
        baseline: record.baseline === 'warm' ? 'warm' : 'clean',
    };
}

/** Reads usage back from stored JSON (history metadata, job results); null when it is not usage. */
export function normalizeComputeUsage(value: unknown): AgentRunComputeUsage | null {
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    const wallTimeMs = finiteOrNull(record.wallTimeMs);
    if (typeof record.runtime !== 'string' || wallTimeMs === null) return null;
    const costSource = record.costSource === 'runtime' || record.costSource === 'rate_table' ? record.costSource : null;
    const costUsd = finiteOrNull(record.costUsd);
    const runnerPool = normalizeRunnerPoolUsage(record.runnerPool);
    return {
        runtime: record.runtime,
        wallTimeMs,
        cpuSeconds: finiteOrNull(record.cpuSeconds),
        peakMemoryBytes: finiteOrNull(record.peakMemoryBytes),
        avgMemoryBytes: finiteOrNull(record.avgMemoryBytes),
        costUsd: costSource ? costUsd : null,
        costSource: costUsd === null ? null : costSource,
        ...(runnerPool ? { runnerPool } : {}),
    };
}

/** `1.2 GiB`, `640 MiB`. */
export function formatMemoryBytes(bytes: number): string {
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    return `${unit === 0 ? Math.round(value) : value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

/** `4m 12s`, `38s`, `1h 2m`. */
export function formatComputeDuration(ms: number): string {
    const seconds = Math.round(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** `14.2s`. */
function formatSeconds(ms: number): string {
    return `${(ms / 1000).toFixed(1)}s`;
}

/** `$0.0123` below a cent, else `$1.23`. */
export function formatComputeCost(costUsd: number): string {
    return costUsd > 0 && costUsd < 0.01 ? `$${costUsd.toFixed(4)}` : `$${costUsd.toFixed(2)}`;
}

/**
 * One line for run summaries: `docker · 4m 12s wall · 182.4 CPU-s · peak 1.2 GiB (avg 640 MiB) · $0.03 (rate table)`.
 * Unmeasured figures are left out rather than shown as zero.
 */
export function formatComputeUsage(usage: AgentRunComputeUsage): string {
    const parts = [usage.runtime, `${formatComputeDuration(usage.wallTimeMs)} wall`];
    if (usage.cpuSeconds !== null) parts.push(`${usage.cpuSeconds.toFixed(1)} CPU-s`);
    if (usage.peakMemoryBytes !== null) {
        const average = usage.avgMemoryBytes !== null ? ` (avg ${formatMemoryBytes(usage.avgMemoryBytes)})` : '';
        parts.push(`peak ${formatMemoryBytes(usage.peakMemoryBytes)}${average}`);
    } else if (usage.avgMemoryBytes !== null) {
        parts.push(`avg ${formatMemoryBytes(usage.avgMemoryBytes)}`);
    }
    if (usage.costUsd !== null) {
        parts.push(`${formatComputeCost(usage.costUsd)}${usage.costSource === 'rate_table' ? ' (rate table)' : ''}`);
    }
    const pool = usage.runnerPool;
    if (pool) {
        if (pool.waitMs >= 1000) parts.push(`queued ${formatComputeDuration(pool.waitMs)}`);
        if (pool.provisioned) parts.push(`new runner${pool.provisionMs !== null ? ` ${formatComputeDuration(pool.provisionMs)}` : ''}`);
        else parts.push(`${pool.baseline} runner`);
        if (pool.restoreBeforeLeaseMs !== null) parts.push(`restore ${formatSeconds(pool.restoreBeforeLeaseMs)} before start`);
        else if (pool.previousRestoreMs !== null) parts.push(`restored in ${formatSeconds(pool.previousRestoreMs)}`);
    }
    return parts.join(' · ');
}
