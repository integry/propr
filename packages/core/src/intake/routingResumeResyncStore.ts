/**
 * Durable state for the Routing installation resume-resync contract. One record
 * per installation survives daemon restarts so duplicate control frames resume
 * the same work, completed repository families are not rerun, and a lost
 * `resync_complete` response is retried with the identical completion identity.
 */

import type { Knex } from 'knex';
import type { ResumeGenerationIdentity, ResyncCompletion } from './routingResumeResyncProtocol.js';
import { decodeResumeResyncRow, encodeResumeResyncRecord, type ResumeResyncRow } from './routingResumeResyncCodec.js';

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

/** Authoritative current installation access, proved by the `repository_access` family. */
export type RepositoryAccess = 'accessible' | 'inaccessible';

export interface RepositoryResyncProgress {
    status: RepositoryResyncStatus;
    /** Families already reconciled for this repository in this generation. */
    completedFamilies: string[];
    /**
     * GitHub-dependent families classified inapplicable, with `access` or
     * `configured` as their evidence. Never contains a local family.
     */
    inapplicableFamilies: string[];
    /** Null until `repository_access` proves it in this generation. */
    access: RepositoryAccess | null;
    /** False for a repository referenced only by durable local work or earlier progress. */
    configured: boolean;
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

/** SQLite-backed store; `getDb` defaults to the shared connection, resolved lazily. */
export function createKnexResumeResyncStore(getDb?: () => Knex | Promise<Knex>): ResumeResyncStore {
    const resolveDb = getDb ?? (async () => (await import('../db/connection.js')).db);
    return {
        async load(installationId) {
            const db = await resolveDb();
            const row = await db<ResumeResyncRow>(TABLE).where({ installation_id: installationId }).first();
            return row ? decodeResumeResyncRow(row as ResumeResyncRow) : null;
        },
        async save(record) {
            const db = await resolveDb();
            await db(TABLE).insert(encodeResumeResyncRecord(record)).onConflict('installation_id').merge();
        },
    };
}

/**
 * Process-local store for tests and embedders without a database. Records go
 * through the same row codec, so it fails closed exactly like the SQLite store.
 */
export class InMemoryResumeResyncStore implements ResumeResyncStore {
    private readonly rows = new Map<number, ResumeResyncRow>();
    saves = 0;

    async load(installationId: number): Promise<ResumeResyncRecord | null> {
        const row = this.rows.get(installationId);
        return row ? decodeResumeResyncRow({ ...row }) : null;
    }

    async save(record: ResumeResyncRecord): Promise<void> {
        this.saves += 1;
        // Serialized, so callers cannot mutate persisted state by reference.
        this.rows.set(record.installationId, encodeResumeResyncRecord(record));
    }

    /** Overwrite raw persisted columns (tests simulating corruption). */
    corrupt(installationId: number, columns: Partial<Record<keyof ResumeResyncRow, unknown>>): void {
        const row = this.rows.get(installationId);
        if (row) this.rows.set(installationId, { ...row, ...columns } as ResumeResyncRow);
    }
}
