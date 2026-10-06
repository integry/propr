import { isDefaultRetryableError } from '@propr/core';
import { DEFAULT_MAX_PROVIDER_REPLACEMENTS, parseMaxProviderReplacements } from '@propr/shared';

export { DEFAULT_MAX_PROVIDER_REPLACEMENTS, MAX_PROVIDER_REPLACEMENTS_LIMIT, parseMaxProviderReplacements } from '@propr/shared';

/** Why a replacement attempt was (or would be) dispatched. */
export type ReplacementCause = 'infra_lost' | 'provider_transient';

/** Why no replacement attempt was dispatched. */
export type ReplacementSkipReason =
    | 'disabled'
    | 'cap_reached'
    | 'budget_exhausted'
    | 'user_cancelled'
    | 'issue_closed'
    | 'watchdog_stop'
    | 'cost_cap_stop'
    | 'goal_task'
    | 'unsupported_task'
    /** The claimed replacement was finalized by reconciliation before any worker ran it. */
    | 'replacement_not_started';

/** A second orphaning of the same lineage is final. */
export const MAX_INFRA_LOST_REPLACEMENTS = 1;

const SKIP_REASON_TEXT: Record<ReplacementSkipReason, string> = {
    disabled: 'automatic replacement is disabled',
    cap_reached: 'the replacement cap was reached',
    budget_exhausted: 'earlier attempts used the whole per-run cost cap',
    user_cancelled: 'the task was cancelled',
    issue_closed: 'the issue was closed',
    watchdog_stop: 'the task was stopped by the stall watchdog or its run timeout',
    cost_cap_stop: 'the task was stopped by its cost cap',
    goal_task: 'goal tasks use goal recovery instead',
    unsupported_task: 'this task type cannot be replaced automatically',
    replacement_not_started: 'the replacement attempt was ended by reconciliation before it started',
};

export function describeReplacementSkip(reason: ReplacementSkipReason): string {
    return SKIP_REASON_TEXT[reason];
}

/** A saved instance setting wins over the environment; both fall back to the default. */
export function resolveMaxProviderReplacements(
    settingValue: unknown,
    env: NodeJS.ProcessEnv = process.env,
): number {
    return parseMaxProviderReplacements(settingValue)
        ?? parseMaxProviderReplacements(env.MAX_PROVIDER_REPLACEMENTS)
        ?? DEFAULT_MAX_PROVIDER_REPLACEMENTS;
}

export function infraLostReplacementEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    return !/^(false|0|no|off)$/i.test(env.INFRA_LOST_REPLACEMENT?.trim() ?? '');
}

/** Stops that must never be undone by a replacement. */
export function stopReasonExclusion(terminalReason: unknown): ReplacementSkipReason | null {
    if (typeof terminalReason !== 'string' || !terminalReason) return null;
    if (terminalReason.startsWith('cancelled_') || terminalReason === 'user_cancelled') return 'user_cancelled';
    if (/watchdog|stall|timed_out/i.test(terminalReason)) return 'watchdog_stop';
    if (/(cost|spend|budget)_?cap|budget_exceeded|cost_limit/i.test(terminalReason)) return 'cost_cap_stop';
    return null;
}

// withRetry treats these as retryable, but they are not transient provider
// failures: 429/usage limits re-queue through their own path, and credential
// problems repeat on every attempt.
const NON_TRANSIENT_PROVIDER_PATTERNS = [
    /\b429\b/,
    /rate[ _-]?limit/i,
    /too many requests/i,
    /usage limit/i,
    /authentication failed/i,
    /invalid username or token/i,
    /credentials/i,
    /aborted by user/i,
];

function errorText(error: unknown): string {
    if (typeof error === 'string') return error;
    if (error && typeof error === 'object') {
        const record = error as { message?: unknown; error?: unknown };
        if (typeof record.message === 'string') return record.message;
        if (typeof record.error === 'string') return record.error;
    }
    return '';
}

function errorStatus(error: unknown, text: string): number | undefined {
    const status = error && typeof error === 'object' ? (error as { status?: unknown }).status : undefined;
    if (typeof status === 'number') return status;
    const match = /\b(5\d\d)\b/.exec(text);
    return match ? Number(match[1]) : undefined;
}

/**
 * A run-ending provider error that `withRetry` classifies as retryable,
 * excluding 429/usage limits (re-queued separately) and run timeouts.
 */
export function isTransientProviderError(error: unknown, terminationReason?: string | null): boolean {
    if (terminationReason) return false;
    const text = errorText(error).trim();
    const status = errorStatus(error, text);
    if (!text && status === undefined) return false;
    if (status === 429 || NON_TRANSIENT_PROVIDER_PATTERNS.some(pattern => pattern.test(text))) return false;
    const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
    return isDefaultRetryableError({
        message: text,
        ...(status === undefined ? {} : { status }),
        ...(typeof code === 'string' ? { code } : {}),
    });
}
