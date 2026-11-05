import { db, generateCorrelationId, logger, PlanIssueStatus, reevaluatePRAutoMerge } from '@propr/core';

export const AUTO_MERGE_SWEEP_INTERVAL_MS = 60_000;
/** Plan PRs untouched for longer than this are left to webhooks and humans. */
export const AUTO_MERGE_SWEEP_LOOKBACK_DAYS = 14;

export interface AutoMergeSweepCandidate {
    repository: string;
    prNumber: number;
}

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
 * will not fire again. Each PR goes through the same gates as a green check
 * (labels, Ultrafix state, CI, mergeability, active work, repository policy).
 */
export async function sweepAutoMergeCandidates(
    loadCandidates: () => Promise<AutoMergeSweepCandidate[]> = loadAutoMergeSweepCandidates,
    reevaluate: typeof reevaluatePRAutoMerge = reevaluatePRAutoMerge,
): Promise<void> {
    for (const { repository, prNumber } of await loadCandidates()) {
        const [owner, repo] = repository.split('/');
        if (!owner || !repo) continue;
        try {
            await reevaluate(owner, repo, prNumber, { correlationId: generateCorrelationId() });
        } catch (error) {
            logger.warn({ repository, prNumber, error: (error as Error).message }, 'Auto-merge sweep failed for PR');
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
