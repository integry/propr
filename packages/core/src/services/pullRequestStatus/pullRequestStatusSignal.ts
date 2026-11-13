/**
 * Transition signal for the pull request status. Low-level code (task state
 * transitions, webhook handlers, Ultrafix state writes) only signals here; the
 * sync module registers the runner when a process enables status maintenance.
 * Kept dependency-free so any module can import it without an import cycle.
 */
export type PullRequestStatusSyncRunner = (repository: string, prNumber: number) => void;

let runner: PullRequestStatusSyncRunner | null = null;

export function setPullRequestStatusSyncRunner(next: PullRequestStatusSyncRunner | null): void {
    runner = next;
}

/**
 * Called on every transition that may change a pull request's status. Never
 * throws and never waits; a no-op unless status maintenance is enabled.
 */
export function requestPullRequestStatusSync(repository: string | null | undefined, prNumber: number | null | undefined): void {
    if (!runner || typeof repository !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(repository)) return;
    if (typeof prNumber !== 'number' || !Number.isSafeInteger(prNumber) || prNumber <= 0) return;
    try {
        runner(repository, prNumber);
    } catch {
        // A status update must never fail the transition that signalled it.
    }
}

const PULL_REQUEST_TASK_TYPES = new Set(['pr-comment', 'review', 'merge_conflict']);

/** The pull request a task works on or produced, when known. */
export function pullRequestNumberOfTask(
    issueRef: { number?: unknown; type?: unknown; pullRequestNumber?: unknown; prNumber?: unknown } | null | undefined,
    prResult?: { prNumber?: unknown } | null,
): number | null {
    const candidates = [
        prResult?.prNumber,
        issueRef?.pullRequestNumber,
        issueRef?.prNumber,
        typeof issueRef?.type === 'string' && PULL_REQUEST_TASK_TYPES.has(issueRef.type) ? issueRef.number : undefined,
    ];
    for (const candidate of candidates) {
        if (typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate > 0) return candidate;
    }
    return null;
}
