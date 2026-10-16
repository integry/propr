/**
 * Durable state for the Routing installation resume-resync contract. One record
 * per installation survives daemon restarts so duplicate control frames resume
 * the same work, completed repository families are not rerun, and a lost
 * `resync_complete` response is retried with the identical completion identity.
 */

import type { Knex } from 'knex';
import type { ResumeGenerationIdentity, ResyncCompletion } from './routingResumeResyncProtocol.js';

export type ResumeResyncState =
    /** Suspended (or not yet unsuspended): GitHub is unreachable, nothing to reconcile yet. */
    | 'pending'
    /** Unsuspended: reconciliation is running or due to run. */
    | 'reconciling'
    /** An attempt left repositories unreconciled; a bounded retry is scheduled. */
    | 'partial'
    /** The retry budget is exhausted; a fresh `resync_required` or restart resumes it. */
    | 'failed'
    /** Every repository converged; `resync_complete` is awaiting Routing's acceptance. */
    | 'completed'
    /** Routing accepted the completion; normal routed intake resumed. */
    | 'acknowledged';

export type RepositoryResyncStatus = 'pending' | 'reconciled' | 'inaccessible' | 'failed';

export interface RepositoryResyncProgress {
    status: RepositoryResyncStatus;
    /** Families already reconciled for this repository in this generation. */
    completedFamilies: string[];
    attempts: number;
    lastError: string | null;
    updatedAt: string | null;
}

export interface ResumeResyncRecord extends ResumeGenerationIdentity {
    state: ResumeResyncState;
    gapStartedAt: string;
    /** Unknown until `resync_required` reports the unsuspension. */
    gapEndedAt: string | null;
    attempts: number;
    startedAt: string | null;
    lastAttemptAt: string | null;
    nextRetryAt: string | null;
    lastError: string | null;
    repositories: Record<string, RepositoryResyncProgress>;
    /** Installation-level families already reconciled in this generation. */
    installationFamilies: string[];
    /** Attempts that ended partial since the last success or resume trigger. */
    consecutiveFailures: number;
    completion: ResyncCompletion | null;
    acknowledgedAt: string | null;
    updatedAt: string;
}

export interface ResumeResyncStore {
    load(installationId: number): Promise<ResumeResyncRecord | null>;
    save(record: ResumeResyncRecord): Promise<void>;
}

const TABLE = 'routing_resume_resyncs';

interface ResumeResyncRow {
    installation_id: number | string;
    routing_generation: number | string;
    resume_generation: number | string;
    state: string;
    gap_started_at: string;
    gap_ended_at: string | null;
    attempts: number;
    started_at: string | null;
    last_attempt_at: string | null;
    next_retry_at: string | null;
    last_error: string | null;
    progress_json: string;
    completion_json: string | null;
    acknowledged_at: string | null;
    updated_at: string;
}

const STATES: readonly ResumeResyncState[] = ['pending', 'reconciling', 'partial', 'failed', 'completed', 'acknowledged'];

function toRow(record: ResumeResyncRecord): ResumeResyncRow {
    return {
        installation_id: record.installationId,
        routing_generation: record.routingGeneration,
        resume_generation: record.resumeGeneration,
        state: record.state,
        gap_started_at: record.gapStartedAt,
        gap_ended_at: record.gapEndedAt,
        attempts: record.attempts,
        started_at: record.startedAt,
        last_attempt_at: record.lastAttemptAt,
        next_retry_at: record.nextRetryAt,
        last_error: record.lastError,
        progress_json: JSON.stringify({
            repositories: record.repositories,
            installationFamilies: record.installationFamilies,
            consecutiveFailures: record.consecutiveFailures,
        }),
        completion_json: record.completion ? JSON.stringify(record.completion) : null,
        acknowledged_at: record.acknowledgedAt,
        updated_at: record.updatedAt,
    };
}

function fromRow(row: ResumeResyncRow): ResumeResyncRecord {
    const state = row.state as ResumeResyncState;
    // A corrupt row must not be guessed into a state that could acknowledge.
    if (!STATES.includes(state)) throw new Error(`Unrecognized persisted resume-resync state "${row.state}"`);
    const progress = JSON.parse(row.progress_json) as Pick<ResumeResyncRecord, 'repositories' | 'installationFamilies' | 'consecutiveFailures'>;
    if (typeof progress !== 'object' || progress === null || typeof progress.repositories !== 'object' || progress.repositories === null) {
        throw new Error('Unrecognized persisted resume-resync progress');
    }
    return {
        installationId: Number(row.installation_id),
        routingGeneration: Number(row.routing_generation),
        resumeGeneration: Number(row.resume_generation),
        state,
        gapStartedAt: row.gap_started_at,
        gapEndedAt: row.gap_ended_at,
        attempts: Number(row.attempts),
        startedAt: row.started_at,
        lastAttemptAt: row.last_attempt_at,
        nextRetryAt: row.next_retry_at,
        lastError: row.last_error,
        repositories: progress.repositories,
        installationFamilies: Array.isArray(progress.installationFamilies) ? progress.installationFamilies : [],
        consecutiveFailures: Number.isSafeInteger(progress.consecutiveFailures) ? progress.consecutiveFailures : 0,
        completion: row.completion_json ? JSON.parse(row.completion_json) as ResyncCompletion : null,
        acknowledgedAt: row.acknowledged_at,
        updatedAt: row.updated_at,
    };
}

/** SQLite-backed store; `getDb` defaults to the shared connection, resolved lazily. */
export function createKnexResumeResyncStore(getDb?: () => Knex | Promise<Knex>): ResumeResyncStore {
    const resolveDb = getDb ?? (async () => (await import('../db/connection.js')).db);
    return {
        async load(installationId) {
            const db = await resolveDb();
            const row = await db<ResumeResyncRow>(TABLE).where({ installation_id: installationId }).first();
            return row ? fromRow(row as ResumeResyncRow) : null;
        },
        async save(record) {
            const db = await resolveDb();
            await db(TABLE).insert(toRow(record)).onConflict('installation_id').merge();
        },
    };
}

/** Process-local store for tests and embedders without a database. */
export class InMemoryResumeResyncStore implements ResumeResyncStore {
    private readonly records = new Map<number, string>();
    saves = 0;

    async load(installationId: number): Promise<ResumeResyncRecord | null> {
        const raw = this.records.get(installationId);
        return raw ? JSON.parse(raw) as ResumeResyncRecord : null;
    }

    async save(record: ResumeResyncRecord): Promise<void> {
        this.saves += 1;
        // Serialize so callers cannot mutate persisted state by reference.
        this.records.set(record.installationId, JSON.stringify(record));
    }
}
