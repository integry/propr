/** Column values of an `llm_executions` row that are normalised before they are stored. */

import { normalizeComputeUsage } from '../agents/runtime/computeUsage.js';

/** The level exactly as the agent ran it (`auto` included); blank or absent is unknown. */
export function normalizeStoredReasoningLevel(level: string | null | undefined): string | null {
    return typeof level === 'string' && level.trim() ? level.trim() : null;
}

/**
 * The execution row's compute usage columns; none for a run no runtime
 * measured, so its row keeps nulls rather than zeros.
 */
export function computeUsageColumns(value: unknown): Record<string, unknown> {
    const usage = normalizeComputeUsage(value);
    if (!usage) return {};
    return {
        compute_runtime: usage.runtime.slice(0, 32),
        compute_wall_time_ms: Math.round(usage.wallTimeMs),
        compute_cpu_seconds: usage.cpuSeconds,
        compute_peak_memory_bytes: usage.peakMemoryBytes,
        compute_avg_memory_bytes: usage.avgMemoryBytes,
        compute_cost_usd: usage.costUsd,
        compute_cost_source: usage.costSource,
    };
}
