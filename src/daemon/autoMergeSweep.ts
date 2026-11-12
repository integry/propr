import {
    db, generateCorrelationId, loadDeferredUpToDateCandidates, logger, PlanIssueStatus, reevaluatePRAutoMerge, settleDeferredUpToDateCandidate,
    type AutoMergeEvaluationOutcome, type DeferredUpToDateCandidate,
} from '@propr/core';

export const AUTO_MERGE_SWEEP_INTERVAL_MS = 60_000;
/** Plan PRs untouched for longer than this are left to webhooks and humans. */
export const AUTO_MERGE_SWEEP_LOOKBACK_DAYS = 14;

export interface AutoMergeSweepCandidate {
    repository: string;
    prNumber: number;
}

/** The `require_up_to_date` retry set: candidates deferred without a guaranteed later event, plan PRs or not. */
export interface DeferredAutoMergeCandidates {
    load: () => Promise<DeferredUpToDateCandidate[]>;
    settle: (candidate: DeferredUpToDateCandidate) => Promise<void>;
}

const DEFAULT_DEFERRED: DeferredAutoMergeCandidates = {
    load: () => loadDeferredUpToDateCandidates(),
    settle: candidate => settleDeferredUpToDateCandidate(candidate),
};

/** Open plan PRs (linked, not yet merged or closed) updated recently. */
export async function loadAutoMergeSweepCandidates(now: Date = new Date()): Promise<AutoMergeSweepCandidate[]> {
    const since = new Date(now.getTime() - AUTO_MERGE_SWEEP_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
    const rows: Array<{ repository: string; pr_number: number }> = await db('plan_issues')
        .distinct('repository', 'pr_number')
        .whereNotNull('pr_number')
        .whereNotIn('status', [PlanIssueStatus.MERGED, PlanIssueStatus.CLOSED])
        .where('updated_at', '>=', since.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ''));
    return rows.map(row => ({ repository: row.repository, prNumber: Number(row.pr_number) }));
}

/**
 * Merges auto-merge plan PRs that no event will merge: a repository with no CI
 * produces no check events, and CI that finished before Ultrafix reached its goal
 * will not fire again. It also retries every PR `require_up_to_date` deferred
 * (waiting for another PR's update turn or merge, or for its own update), which
 * need not be a plan PR. Each PR goes through the same gates as a green check
 * (labels, Ultrafix state, CI, mergeability, active work, repository policy).
 * A deferred PR leaves the retry set only once a re-evaluation resolved it (it
 * merged, closed, or waits on something that produces its own event, such as a
 * failed check) and did not defer it again; an inconclusive one (unavailable CI
 * or PR reads, checks still running, unknown mergeability, active work, a
 * refused merge) or a failed one keeps it. Running checks keep it because the
 * green event they produce may meet a transient refusal no event follows.
 */
export async function sweepAutoMergeCandidates(
    loadCandidates: () => Promise<AutoMergeSweepCandidate[]> = loadAutoMergeSweepCandidates,
    reevaluate: typeof reevaluatePRAutoMerge = reevaluatePRAutoMerge,
    deferred: DeferredAutoMergeCandidates = DEFAULT_DEFERRED,
): Promise<void> {
    const candidates = new Map<string, { repository: string; prNumber: number; deferred?: DeferredUpToDateCandidate }>();
    const id = (repository: string, prNumber: number) => `${repository.toLowerCase()}#${prNumber}`;
    for (const candidate of await loadCandidates()) candidates.set(id(candidate.repository, candidate.prNumber), candidate);
    let retries: DeferredUpToDateCandidate[] = [];
    try {
        retries = await deferred.load();
    } catch (error) {
        logger.warn({ error: (error as Error).message }, 'Failed to load deferred auto-merge candidates');
    }
    for (const retry of retries) {
        const known = candidates.get(id(retry.repository, retry.prNumber));
        candidates.set(id(retry.repository, retry.prNumber), { ...(known ?? retry), deferred: retry });
    }
    for (const { repository, prNumber, deferred: retry } of candidates.values()) {
        const [owner, repo] = repository.split('/');
        if (!owner || !repo) continue;
        let outcome: AutoMergeEvaluationOutcome;
        try {
            outcome = await reevaluate(owner, repo, prNumber, { correlationId: generateCorrelationId() });
        } catch (error) {
            // A failed re-evaluation keeps a deferred PR in the retry set.
            logger.warn({ repository, prNumber, error: (error as Error).message }, 'Auto-merge sweep failed for PR');
            continue;
        }
        if (!retry) continue;
        if (outcome !== 'resolved') {
            // No event may follow an inconclusive evaluation: the next sweep tries again.
            logger.debug({ repository, prNumber, outcome }, 'Deferred auto-merge candidate stays in the retry set');
            continue;
        }
        try {
            await deferred.settle(retry);
        } catch (error) {
            logger.warn({ repository, prNumber, error: (error as Error).message }, 'Failed to settle a deferred auto-merge candidate');
        }
    }
}

export function scheduleAutoMergeSweep(
    intervalMs: number = AUTO_MERGE_SWEEP_INTERVAL_MS,
    sweep: () => Promise<void> = () => sweepAutoMergeCandidates(),
): NodeJS.Timeout {
    let running = false;
    const tick = async (): Promise<void> => {
        if (running) return;
        running = true;
        try {
            await sweep();
        } catch (error) {
            logger.warn({ error: (error as Error).message }, 'Auto-merge sweep failed');
        } finally {
            running = false;
        }
    };
    const interval = setInterval(() => { void tick(); }, intervalMs);
    interval.unref?.();
    return interval;
}
