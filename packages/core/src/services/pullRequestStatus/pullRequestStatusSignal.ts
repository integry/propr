/**
 * Transition signal for the pull request status. Low-level code (task state
 * transitions, webhook handlers, Ultrafix state writes) only signals here; the
 * sync module registers the runner when a process enables status maintenance.
 * Kept dependency-free so any module can import it without an import cycle.
 */
import type { PullRequestStatusProvenanceRedis } from './pullRequestStatusProvenance.js';

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

/** Resolves the open pull requests of a commit, then signals each; registered with the sync runner. */
export type PullRequestStatusCommitSyncRunner = (repository: string, sha: string) => void;

let commitRunner: PullRequestStatusCommitSyncRunner | null = null;

export function setPullRequestStatusCommitSyncRunner(next: PullRequestStatusCommitSyncRunner | null): void {
    commitRunner = next;
}

/**
 * Called when a check that names a commit, not a pull request, changes (a
 * legacy commit status). Never throws and never waits; a no-op unless status
 * maintenance is enabled.
 */
export function requestPullRequestStatusSyncForCommit(repository: string | null | undefined, sha: string | null | undefined): void {
    if (!commitRunner || typeof repository !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(repository)) return;
    if (typeof sha !== 'string' || !/^[0-9a-f]{7,64}$/i.test(sha)) return;
    try {
        commitRunner(repository, sha);
    } catch {
        // A status update must never fail the event that signalled it.
    }
}

/** Finds the open pull requests into a pushed branch, then signals each; registered with the sync runner. */
export type PullRequestStatusBaseSyncRunner = (repository: string, branch: string, sha: string) => void;

let baseRunner: PullRequestStatusBaseSyncRunner | null = null;

export function setPullRequestStatusBaseSyncRunner(next: PullRequestStatusBaseSyncRunner | null): void {
    baseRunner = next;
}

/**
 * Called when a branch receives a push: every open pull request into it may
 * now conflict, without an event of its own. `sha` is the branch's new tip.
 * Never throws and never waits; a no-op unless status maintenance is enabled.
 */
export function requestPullRequestStatusSyncForBase(
    repository: string | null | undefined, branch: string | null | undefined, sha: string | null | undefined,
): void {
    if (!baseRunner || typeof repository !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(repository)) return;
    if (typeof branch !== 'string' || !/^\S+$/.test(branch)) return;
    if (typeof sha !== 'string' || !/^[0-9a-f]{7,64}$/i.test(sha)) return;
    try {
        baseRunner(repository, branch, sha);
    } catch {
        // A status update must never fail the event that signalled it.
    }
}

/** The Redis the status writes are recorded in (pullRequestStatusProvenance); registered with the sync runner. */
export type PullRequestStatusRedisProvider = () => PullRequestStatusProvenanceRedis | null;

let redisProvider: PullRequestStatusRedisProvider | null = null;

export function setPullRequestStatusRedisProvider(next: PullRequestStatusRedisProvider | null): void {
    redisProvider = next;
}

/** Null while this process does not maintain the status: then no write was recorded here to consult. */
export function pullRequestStatusRedis(): PullRequestStatusProvenanceRedis | null {
    return redisProvider?.() ?? null;
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
