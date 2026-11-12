/**
 * The durable repository change-event journal (`repository_events`).
 *
 * Pull request, epic queue and plan issue changes are appended here at the
 * points where they are already persisted, so a coordinator can read one
 * ordered stream instead of polling many reads and diffing them. The journal,
 * not Redis pub/sub, is the source of truth: the activity event published
 * after an append is only a hint that something changed.
 *
 * An append never throws into its caller. A failed append is logged and
 * counted, and the operation that triggered it proceeds.
 */

import type { Knex } from 'knex';
import {
    isRepositoryEventType,
    REPOSITORY_EVENT_DOMAINS,
    type RepositoryEvent,
    type RepositoryEventDomain,
} from '@propr/shared';
import type { ActivityChange, ActivityDomain } from '@propr/shared/dist/activityEvents.js';
import logger from '../utils/logger.js';
import { getEventPublisher } from '../utils/eventPublisher.js';

export interface RepositoryEventInput {
    /** `owner/repo`. */
    repository: string;
    domain: RepositoryEventDomain;
    type: string;
    /** PR number, epic execution id, or plan issue id. */
    entityId: string | number;
    prNumber?: number | null;
    issueNumber?: number | null;
    planId?: string | null;
    headSha?: string | null;
    /** Identifiers and small scalars only. */
    payload?: Record<string, unknown>;
    /** Unique per repository; a repeated key appends nothing. */
    dedupeKey?: string | null;
    occurredAt?: Date | string;
}

export type RepositoryEventAppendResult =
    | { status: 'appended'; seq: number }
    | { status: 'duplicate' }
    | { status: 'failed'; error: string };

export interface AppendRepositoryEventOptions {
    /** Defaults to publishing a bare activity event once the append is committed. */
    publish?: boolean;
    log?: Pick<typeof logger, 'warn'>;
}

/** Retention window for journal rows. */
export const REPOSITORY_EVENT_RETENTION_DAYS = 30;

/** A payload larger than this is not "small"; the append is refused rather than truncated. */
const MAX_PAYLOAD_BYTES = 4096;
/** Free-text fields that are allowed in a payload (reasons) are capped to this many characters. */
export const REPOSITORY_EVENT_REASON_MAX_CHARS = 300;

const counters = { appended: 0, duplicates: 0, failures: 0 };

/** Process-local append counters, for diagnostics and tests. */
export function getRepositoryEventJournalStats(): Readonly<typeof counters> {
    return { ...counters };
}

/** Cap a free-text reason so a payload stays a small scalar. */
export function capRepositoryEventReason(value: string | null | undefined): string | null {
    if (typeof value !== 'string' || !value.trim()) return null;
    const trimmed = value.trim();
    return trimmed.length > REPOSITORY_EVENT_REASON_MAX_CHARS
        ? `${trimmed.slice(0, REPOSITORY_EVENT_REASON_MAX_CHARS - 1)}…` : trimmed;
}

const optionalInteger = (value: unknown): number | null =>
    typeof value === 'number' && Number.isSafeInteger(value) ? value : null;

const optionalText = (value: unknown): string | null =>
    typeof value === 'string' && value.length > 0 ? value : null;

function toRow(event: RepositoryEventInput): Record<string, unknown> {
    if (typeof event.repository !== 'string' || !event.repository.includes('/')) {
        throw new TypeError('repository event repository must be owner/repo');
    }
    if (!isRepositoryEventType(event.domain, event.type)) {
        throw new TypeError(`unknown repository event ${String(event.domain)}/${String(event.type)}`);
    }
    const entityId = String(event.entityId ?? '');
    if (!entityId) throw new TypeError('repository event entityId is required');
    const payload = JSON.stringify(event.payload ?? {});
    if (Buffer.byteLength(payload) > MAX_PAYLOAD_BYTES) throw new RangeError('repository event payload is too large');
    const occurredAt = event.occurredAt === undefined ? new Date() : new Date(event.occurredAt);
    return {
        repository: event.repository,
        domain: event.domain,
        type: event.type,
        entity_id: entityId,
        pr_number: optionalInteger(event.prNumber),
        issue_number: optionalInteger(event.issueNumber),
        plan_id: optionalText(event.planId),
        head_sha: optionalText(event.headSha),
        payload,
        dedupe_key: optionalText(event.dedupeKey),
        occurred_at: (Number.isNaN(occurredAt.getTime()) ? new Date() : occurredAt).toISOString(),
    };
}

const ULTRAFIX_END_CHANGES: Record<string, ActivityChange> = {
    goal_reached: 'completed', cycles_exhausted: 'failed', failed: 'failed', stopped: 'cancelled',
};
const PULL_REQUEST_CHANGES: Record<string, ActivityChange> = {
    opened: 'created', ultrafix_started: 'started', merged: 'completed', closed: 'cancelled',
};
const EPIC_QUEUE_CHANGES: Record<string, ActivityChange> = {
    started: 'started', blocked: 'blocked', completed: 'completed',
};

/**
 * The bare activity event announcing an append, or null when the change
 * already has one: plan issue status writes publish their own `plan` event.
 */
export function repositoryEventActivity(event: RepositoryEventInput): {
    domain: ActivityDomain; change: ActivityChange; entityId: string; repository: string;
} | null {
    if (event.domain === 'pull_request') {
        const change = event.type === 'ultrafix_ended'
            ? ULTRAFIX_END_CHANGES[String(event.payload?.outcome)] ?? 'completed'
            : PULL_REQUEST_CHANGES[event.type] ?? 'progressed';
        return { domain: 'pull_request', change, entityId: String(event.entityId), repository: event.repository };
    }
    // Epic queues belong to a plan: the plan views are the ones that react.
    if (event.domain === 'epic_queue' && event.planId) {
        return { domain: 'plan', change: EPIC_QUEUE_CHANGES[event.type] ?? 'progressed', entityId: event.planId, repository: event.repository };
    }
    return null;
}

function publishAfterCommit(database: Knex, event: RepositoryEventInput): void {
    const activity = repositoryEventActivity(event);
    if (!activity) return;
    const publish = () => {
        void getEventPublisher().publishActivity(activity).catch(() => undefined);
    };
    // Announcing a change before its transaction commits would send readers to
    // a row they cannot see yet (or one a rollback removes).
    const pending = (database as Knex.Transaction).isTransaction
        ? (database as Knex.Transaction & { executionPromise?: Promise<unknown> }).executionPromise
        : undefined;
    if (pending) pending.then(publish, () => undefined);
    else publish();
}

/**
 * Append one event. Idempotent through `dedupeKey`; never throws.
 *
 * Pass the caller's transaction as `database` when the triggering change is a
 * database write, so the event commits (or rolls back) with it. A failed
 * statement does not roll back an SQLite transaction, so a failed append still
 * leaves the caller's write intact.
 */
export async function appendRepositoryEvent(
    database: Knex, event: RepositoryEventInput, options: AppendRepositoryEventOptions = {},
): Promise<RepositoryEventAppendResult> {
    try {
        const row = toRow(event);
        const inserted = await database('repository_events').insert(row)
            .onConflict(['repository', 'dedupe_key']).ignore()
            .returning('seq') as Array<{ seq: number } | number>;
        const first = inserted[0];
        const seq = typeof first === 'number' ? first : first?.seq;
        if (seq === undefined) {
            counters.duplicates++;
            return { status: 'duplicate' };
        }
        counters.appended++;
        if (options.publish !== false) publishAfterCommit(database, event);
        return { status: 'appended', seq: Number(seq) };
    } catch (error) {
        counters.failures++;
        const message = (error as Error)?.message ?? String(error);
        (options.log ?? logger).warn({ repository: event?.repository, domain: event?.domain, type: event?.type,
            entityId: event?.entityId, dedupeKey: event?.dedupeKey, error: message, failures: counters.failures },
        'Failed to append repository event; continuing without it');
        return { status: 'failed', error: message };
    }
}

interface RepositoryEventRow {
    seq: number; repository: string; domain: RepositoryEventDomain; type: string; entity_id: string;
    pr_number: number | null; issue_number: number | null; plan_id: string | null; head_sha: string | null;
    payload: string | null; occurred_at: string;
}

function fromRow(row: RepositoryEventRow): RepositoryEvent {
    let payload: Record<string, unknown> = {};
    try {
        const parsed: unknown = JSON.parse(row.payload ?? '{}');
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) payload = parsed as Record<string, unknown>;
    } catch { /* a malformed payload reads as empty */ }
    return {
        seq: Number(row.seq), repository: row.repository, domain: row.domain, type: row.type, entityId: row.entity_id,
        prNumber: row.pr_number, issueNumber: row.issue_number, planId: row.plan_id, headSha: row.head_sha,
        payload, occurredAt: row.occurred_at,
    };
}

export interface ListRepositoryEventsInput {
    repository: string;
    /** Exclusive cursor; 0 reads from the start of the retained journal. */
    afterSeq?: number;
    domains?: readonly RepositoryEventDomain[];
    entityId?: string | number;
    limit?: number;
}

const MAX_LIST_LIMIT = 500;

/** Events of one repository after a cursor, in `seq` order. */
export async function listRepositoryEvents(database: Knex, input: ListRepositoryEventsInput): Promise<RepositoryEvent[]> {
    const limit = Math.min(Math.max(Math.trunc(input.limit ?? 100), 1), MAX_LIST_LIMIT);
    const query = database('repository_events').where('repository', input.repository)
        .where('seq', '>', Math.max(0, Math.trunc(input.afterSeq ?? 0)));
    const domains = (input.domains ?? []).filter(domain => REPOSITORY_EVENT_DOMAINS.includes(domain));
    if (domains.length) query.whereIn('domain', domains);
    if (input.entityId !== undefined) query.where('entity_id', String(input.entityId));
    const rows = await query.orderBy('seq', 'asc').limit(limit).select<RepositoryEventRow[]>('*');
    return rows.map(fromRow);
}

/**
 * The cursor-expiration boundary of a repository (1 when nothing was ever
 * pruned): one past the highest `seq` retention has deleted. A cursor at or
 * above `floor - 1` has missed nothing; a cursor below it may have missed
 * pruned events, so a reader can tell an expired cursor from an empty result.
 * Retention deletes by age alone, so unexpired events below the floor are
 * still kept and readable (an older-stamped event can be appended after
 * newer ones); only the guarantee of completeness ends at the floor.
 */
export async function getRepositoryEventFloor(database: Knex, repository: string): Promise<number> {
    const row = await database('repository_event_floors').where({ repository }).first<{ floor_seq: number } | undefined>('floor_seq');
    return row ? Number(row.floor_seq) : 1;
}

export interface PruneRepositoryEventsResult {
    deleted: number;
    /** Repositories whose floor moved, with the new floor. */
    floors: Record<string, number>;
}

/**
 * Delete events older than the retention window and raise each affected
 * repository's floor past the highest deleted `seq`. Only expired rows are
 * deleted: a recent event keeps its retention even when an older-stamped event
 * was appended after it at a higher `seq`.
 */
export async function pruneRepositoryEvents(database: Knex, options: {
    olderThanDays?: number; now?: () => number;
} = {}): Promise<PruneRepositoryEventsResult> {
    const days = options.olderThanDays ?? REPOSITORY_EVENT_RETENTION_DAYS;
    const now = (options.now ?? Date.now)();
    const cutoff = new Date(now - days * 24 * 60 * 60 * 1000).toISOString();
    return database.transaction(async trx => {
        const expired = await trx('repository_events').where('occurred_at', '<', cutoff)
            .groupBy('repository').select<Array<{ repository: string; max_seq: number }>>('repository', trx.raw('MAX(seq) as max_seq'));
        const floors: Record<string, number> = {};
        if (!expired.length) return { deleted: 0, floors };
        let deleted = 0;
        for (const { repository, max_seq: maxSeq } of expired) {
            // The same age predicate as the selection, so no unexpired row goes;
            // the seq bound only keeps the floor matching what was deleted.
            deleted += await trx('repository_events').where({ repository }).where('occurred_at', '<', cutoff)
                .where('seq', '<=', maxSeq).delete();
            const floor = Number(maxSeq) + 1;
            await trx('repository_event_floors').insert({ repository, floor_seq: floor, pruned_at: new Date(now).toISOString() })
                .onConflict('repository').merge({
                    floor_seq: trx.raw('MAX(repository_event_floors.floor_seq, excluded.floor_seq)'),
                    pruned_at: trx.raw('excluded.pruned_at'),
                });
            floors[repository] = floor;
        }
        return { deleted, floors };
    });
}
