/**
 * Operator-facing projection of the routing resume-resync record. Published with
 * the routing status snapshot; carries no tokens, payloads or relay fields.
 */

import type { ResumeResyncRecord, ResumeResyncState } from './routingResumeResyncStore.js';

/** Failed repositories listed in status, bounded so the snapshot stays small. */
const MAX_FAILED_REPOSITORIES = 10;

export interface RoutingResumeResyncStatus {
    /** `idle` when no suspension gap was ever recorded for this installation. */
    state: ResumeResyncState | 'idle';
    installationId: number;
    routingGeneration: number | null;
    resumeGeneration: number | null;
    gapStartedAt: string | null;
    gapEndedAt: string | null;
    startedAt: string | null;
    completedAt: string | null;
    acknowledgedAt: string | null;
    attempts: number;
    lastAttemptAt: string | null;
    nextRetryAt: string | null;
    lastError: string | null;
    /** Whether an attempt is running in this process right now. */
    running: boolean;
    repositories: { total: number; reconciled: number; inaccessible: number; failed: number; pending: number };
    failedRepositories: Array<{ repository: string; error: string | null }>;
    /** True while Routing holds (caches) normal routed intake for this installation. */
    intakeWaiting: boolean;
    completionId: string | null;
    lastCompletionSentAt: string | null;
    lastRejection: { reason: string; frameType: string; at: string } | null;
}

export interface ResumeResyncStatusContext {
    installationId: number;
    running: boolean;
    lastRejection: RoutingResumeResyncStatus['lastRejection'];
    lastCompletionSentAt: string | null;
}

function countRepositories(record: ResumeResyncRecord): RoutingResumeResyncStatus['repositories'] {
    const statuses = Object.values(record.repositories).map(entry => entry.status);
    const count = (status: string) => statuses.filter(value => value === status).length;
    return {
        total: statuses.length,
        reconciled: count('reconciled'),
        inaccessible: count('inaccessible'),
        failed: count('failed'),
        pending: count('pending'),
    };
}

function idleStatus(ctx: ResumeResyncStatusContext): RoutingResumeResyncStatus {
    return {
        state: 'idle', installationId: ctx.installationId, routingGeneration: null, resumeGeneration: null,
        gapStartedAt: null, gapEndedAt: null, startedAt: null, completedAt: null, acknowledgedAt: null,
        attempts: 0, lastAttemptAt: null, nextRetryAt: null, lastError: null, running: ctx.running,
        repositories: { total: 0, reconciled: 0, inaccessible: 0, failed: 0, pending: 0 },
        failedRepositories: [], intakeWaiting: false, completionId: null,
        lastCompletionSentAt: ctx.lastCompletionSentAt, lastRejection: ctx.lastRejection,
    };
}

export function buildResumeResyncStatus(record: ResumeResyncRecord | null, ctx: ResumeResyncStatusContext): RoutingResumeResyncStatus {
    if (!record) return idleStatus(ctx);
    return {
        state: record.state,
        installationId: ctx.installationId,
        routingGeneration: record.routingGeneration,
        resumeGeneration: record.resumeGeneration,
        gapStartedAt: record.gapStartedAt,
        gapEndedAt: record.gapEndedAt,
        startedAt: record.startedAt,
        completedAt: record.completion ? record.completion.completedAt : null,
        acknowledgedAt: record.acknowledgedAt,
        attempts: record.attempts,
        lastAttemptAt: record.lastAttemptAt,
        nextRetryAt: record.nextRetryAt,
        lastError: record.lastError,
        running: ctx.running,
        repositories: countRepositories(record),
        failedRepositories: Object.entries(record.repositories)
            .filter(([, entry]) => entry.status === 'failed')
            .slice(0, MAX_FAILED_REPOSITORIES)
            .map(([repository, entry]) => ({ repository, error: entry.lastError })),
        intakeWaiting: record.state !== 'acknowledged',
        completionId: record.completion ? record.completion.completionId : null,
        lastCompletionSentAt: ctx.lastCompletionSentAt,
        lastRejection: ctx.lastRejection,
    };
}
