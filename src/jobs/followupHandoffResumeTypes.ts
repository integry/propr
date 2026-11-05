import type { UnprocessedComment } from '@propr/core';
import type { FollowupHandoffGitOps } from './followupHandoffGitOps.js';
import type { FollowupHandoffRecord, FollowupHandoffStoreDeps } from './followupHandoffStore.js';

/** Collaborator contracts and outcomes of follow-up handoff resumption. */

export interface LoggerLike {
    info(context: Record<string, unknown>, message: string): void;
    warn(context: Record<string, unknown>, message: string): void;
    error(context: Record<string, unknown>, message: string): void;
}

export interface IssueComment { id: number; body?: string; html_url?: string }

export interface HandoffOctokit {
    request(route: string, params?: Record<string, unknown>): Promise<{ data: unknown }>;
    paginate(route: string, params?: Record<string, unknown>): Promise<unknown[]>;
    auth(options: { type: 'installation' }): Promise<unknown>;
}

export interface HandoffStateManager {
    getTaskState(taskId: string): Promise<{ state: string } | null>;
    /** Resolves to the resulting state; a concurrent cancellation is returned unapplied. */
    updateTaskState(taskId: string, state: string, metadata?: Record<string, unknown>): Promise<{ state?: string } | null | void>;
    updateHistoryMetadata(taskId: string, historyState: string, metadata?: Record<string, unknown>): Promise<unknown>;
}

export interface HandoffTaskStates {
    COMPLETED: string;
    FAILED: string;
    CANCELLED: string;
}

export interface ResumeFollowupHandoffParams {
    record: FollowupHandoffRecord;
    octokit: HandoffOctokit;
    git: FollowupHandoffGitOps;
    stateManager: HandoffStateManager;
    restoreComments(record: FollowupHandoffRecord, comments: UnprocessedComment[]): Promise<void>;
    store: FollowupHandoffStoreDeps;
    log: LoggerLike;
    taskStates: HandoffTaskStates;
    /** Successor task adopting this handoff, when a new follow-up triggered the recovery. */
    recoveredBy?: string;
    /** Reports a lost PR processing lease; once true no further external mutation runs. */
    isOwnershipLost?: () => boolean;
    /**
     * Guarantees another attempt for claimed comments a no-change recovery
     * returned to the pending list. Standalone recovery passes enqueue a
     * pending-comment follow-up job here; in-line predecessor adoption omits
     * it because the adopting job's own cleanup queues that follow-up.
     */
    scheduleRestoredComments?(record: FollowupHandoffRecord): Promise<void>;
    /**
     * Removes the claimed comments from the pending list again whenever a
     * cancelled handoff is held (an earlier pass may have restored them), so
     * they cannot trigger automatic execution without an operator decision.
     * Idempotent: comments that are not pending are left alone.
     */
    withdrawRestoredComments?(record: FollowupHandoffRecord, comments: UnprocessedComment[]): Promise<void>;
}

export type ResumeOutcome =
    | { outcome: 'published'; commitHash: string | null }
    /** Interrupted before producing changes; the claimed comments were returned to the queue. */
    | { outcome: 'no_changes' }
    /**
     * A no-change completion or failure was delivered — by the normal path, or
     * by this recovery for a recorded successful agent run — and recorded
     * without republishing or requeueing.
     */
    | { outcome: 'settled' }
    | { outcome: 'awaiting_operator'; reason: string }
    /** A failed attempt whose queued retry takes it over; recovery leaves it untouched. */
    | { outcome: 'retry_pending' }
    | { outcome: 'cleanup_pending' }
    | { outcome: 'ownership_lost' }
    | { outcome: 'superseded' };

export function splitHandoffRepository(repository: string): { owner: string; repo: string } {
    const [owner, repo] = repository.split('/');
    return { owner, repo };
}
