import logger from '../utils/logger.js';

import { MAX_RUN_COST_CAP_USD, RUN_COST_CAP_SOURCE_LABELS, formatUsd, type RunCostCapSource } from '@propr/shared';

export { MAX_RUN_COST_CAP_USD, RUN_COST_CAP_SOURCE_LABELS, formatUsd, type RunCostCapSource };

export interface RunCostCap {
    capUsd: number;
    source: RunCostCapSource;
}

export interface RunCostCapInputs {
    /** `maxCostUsd` on the task submission, MCP `create_task` or CLI `--max-cost`. */
    override?: unknown;
    /** `limits.max_cost_usd` from `.propr/workflow.yml`. */
    workflow?: unknown;
    /** Instance `default_max_cost_usd`. */
    instanceDefault?: unknown;
}

const DECIMAL_AMOUNT = /^\s*\d+(?:\.\d+)?\s*$/;

/**
 * Reads one configured cap in USD. Unset values (`undefined`, `null`, empty
 * string) and 0 mean "no cap at this level". A malformed or negative value is
 * a mistake, never a $0 cap: it is logged and treated as unset, so a typo can
 * never cancel every run. Valid amounts are clamped to {@link MAX_RUN_COST_CAP_USD}.
 */
export function parseCostCapUsd(value: unknown, field: string): number | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value === 'string' && !value.trim()) return undefined;
    const amount = typeof value === 'number'
        ? value
        : typeof value === 'string' && DECIMAL_AMOUNT.test(value) ? Number(value) : Number.NaN;
    if (!Number.isFinite(amount) || amount < 0) {
        logger.warn({ field, value }, 'Ignoring malformed spend cap; it is treated as no cap');
        return undefined;
    }
    if (amount === 0) return undefined;
    return Math.min(amount, MAX_RUN_COST_CAP_USD);
}

/**
 * Resolves the cap that applies to one run. The highest-precedence level with
 * a valid positive amount wins; levels that are unset, zero or malformed are
 * skipped. Returns null when no level sets a cap.
 */
export function resolveRunCostCap(inputs: RunCostCapInputs): RunCostCap | null {
    const levels: Array<[RunCostCapSource, unknown, string]> = [
        ['override', inputs.override, 'maxCostUsd'],
        ['workflow', inputs.workflow, 'limits.max_cost_usd'],
        ['instance_default', inputs.instanceDefault, 'default_max_cost_usd'],
    ];
    for (const [source, value, field] of levels) {
        const capUsd = parseCostCapUsd(value, field);
        if (capUsd !== undefined) return { capUsd, source };
    }
    return null;
}

/**
 * What a run may still spend. Retries share their task's budget: an attempt
 * started after earlier attempts spent part of the cap only gets the rest.
 */
export function remainingRunBudget(capUsd: number, spentUsd: number): number {
    const spent = Number.isFinite(spentUsd) && spentUsd > 0 ? spentUsd : 0;
    return Math.max(0, capUsd - spent);
}

/** Stderr line the Docker executor appends when it stops a run at its cap; termination parsing keys on it. */
export function runCostCapStopMessage(cap: RunCostCap, spentUsd: number): string {
    return `Agent execution stopped: run spend cap of ${formatUsd(cap.capUsd)} exceeded (estimated spend ${formatUsd(spentUsd)}, cap from ${RUN_COST_CAP_SOURCE_LABELS[cap.source]})`;
}

export const RUN_COST_CAP_STOP_PATTERN = /(?:^|\n)agent execution stopped: run spend cap of \$/i;

/** Raised by executions that cannot return partial output when their run is stopped at its cap. */
export class RunCostCapExceededError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'RunCostCapExceededError';
    }
}
