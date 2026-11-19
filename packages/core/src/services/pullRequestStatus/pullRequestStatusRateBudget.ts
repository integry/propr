import logger from '../../utils/logger.js';
import type { PullRequestStatusGitHub } from './pullRequestStatusFacts.js';

/**
 * The GitHub App installation's remaining REST budget, as the responses of a
 * status update report it (`x-ratelimit-remaining`, `x-ratelimit-reset`).
 * Status edits caused by check progress alone are the bulk of ProPR's edits
 * during a CI run and the only ones nobody waits on, so while the budget is
 * below LOW_BUDGET_THRESHOLD they are skipped: the budget goes to work that
 * must not be lost (opening pull requests, summaries, review comments,
 * labels) and to status changes a person waits on, which are still written.
 *
 * The budget is read from the update's own requests (it reads the pull
 * request just before deciding), so every process sees the current value
 * without sharing it.
 */
export const DEFAULT_LOW_BUDGET_THRESHOLD = 500;
let lowBudgetThreshold = DEFAULT_LOW_BUDGET_THRESHOLD;

/** How long a skipped edit waits before the update reads again, at least and at most. */
const MIN_RETRY_MS = 60_000;
const MAX_RETRY_MS = 10 * 60_000;

/** Test hook: changes the threshold below which check-progress edits are skipped; null restores it. */
export function setPullRequestStatusLowBudgetThresholdForTests(threshold: number | null): void {
    lowBudgetThreshold = threshold ?? DEFAULT_LOW_BUDGET_THRESHOLD;
}

export interface RateBudget {
    remaining: number;
    /** Epoch milliseconds the budget is restored, when GitHub said. */
    resetAt: number | null;
}

function header(headers: unknown, name: string): number | null {
    if (!headers || typeof headers !== 'object') return null;
    const raw = (headers as Record<string, unknown>)[name];
    if (raw === undefined || raw === null || raw === '') return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
}

/** The budget a GitHub response reports, or null when it reports none. */
export function rateBudgetOfResponse(response: unknown): RateBudget | null {
    const headers = (response as { headers?: unknown } | null | undefined)?.headers;
    const remaining = header(headers, 'x-ratelimit-remaining');
    if (remaining === null) return null;
    const reset = header(headers, 'x-ratelimit-reset');
    return { remaining, resetAt: reset === null ? null : reset * 1000 };
}

/**
 * Wraps the GitHub client of one status update so the budget its latest
 * response reported can be read back. Failed requests report nothing here.
 */
export function observeRateBudget(github: PullRequestStatusGitHub): { github: PullRequestStatusGitHub; latest: () => RateBudget | null } {
    let latest: RateBudget | null = null;
    return {
        github: {
            request: async (route, parameters) => {
                const response = await github.request(route, parameters);
                latest = rateBudgetOfResponse(response) ?? latest;
                return response;
            },
        },
        latest: () => latest,
    };
}

/** Whether the budget is too low for an edit of check progress alone. Unknown budgets are not low. */
export function isLowRateBudget(budget: RateBudget | null | undefined): budget is RateBudget {
    return !!budget && budget.remaining < lowBudgetThreshold;
}

/** How long after `now` a skipped edit reads again: once the budget resets, within bounds. */
export function lowBudgetRetryMs(budget: RateBudget, now: number): number {
    const untilReset = budget.resetAt === null ? MIN_RETRY_MS : budget.resetAt - now + 1_000;
    return Math.min(Math.max(untilReset, MIN_RETRY_MS), MAX_RETRY_MS);
}

/** The log line of each skipped edit; never a pull request comment. */
export function logSkippedForRateBudget(target: { repository: string; prNumber: number }, budget: RateBudget, retryInMs: number): void {
    logger.warn({
        ...target, remaining: budget.remaining, threshold: lowBudgetThreshold,
        resetAt: budget.resetAt === null ? null : new Date(budget.resetAt).toISOString(), retryInMs,
    }, 'Skipped a check-progress pull request status edit: the GitHub App installation rate limit is low');
}
