/* eslint-disable max-lines -- projection ordering and checkpoint writes share transactional invariants */
import { createHash } from 'node:crypto';
import type { Knex } from 'knex';
import {
    normalizeISO8601Timestamp,
    type ISO8601Timestamp,
    type JsonObject,
    type NotificationSourceActivityStatus
} from '@propr/shared';
import { NotificationProjectionRecipients } from './notificationProjectionRecipients.js';

type ProjectionDatabase = Knex | Knex.Transaction;

export interface DraftProjectionContext {
    draftId: string;
    repository: string;
    userId: string;
    status?: string;
    reviewTransitionAt?: ISO8601Timestamp;
}

export interface TaskProjectionContext {
    taskId: string;
    repository: string;
    issueNumber?: number;
    prNumber?: number;
    commandMode?: string;
    prUrl?: string;
    ownerUserIds?: string[];
}

export interface TaskTransitionIdentity {
    timestamp: ISO8601Timestamp;
    sequence?: number;
}

export interface IndexingTransitionIdentity {
    timestamp: ISO8601Timestamp;
    runId?: string;
}

export type ActivityProjectionDecision = 'applied' | 'current' | 'stale';

export interface SourceActivityRow {
    activity_type: 'task' | 'indexing';
    activity_key: string;
    repository: string;
    branch: string | null;
    status: NotificationSourceActivityStatus;
    last_activity_at: string;
    completed_at: string | null;
    metadata_json: string | null;
    process_heartbeat_at: string | null;
    stalled_notified_at: string | null;
}

export interface StalledActivityCursor {
    lastActivityAt: string;
    activityType: SourceActivityRow['activity_type'];
    activityKey: string;
}

export interface SystemTransition {
    component: string;
    status: string;
    healthy: boolean;
    transitionAt: ISO8601Timestamp;
    unhealthyEpisodeStarted: boolean;
}

function parseRecordJson(value: unknown): Record<string, unknown> {
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        return value as Record<string, unknown>;
    }
    if (typeof value !== 'string') return {};
    try {
        const parsed: unknown = JSON.parse(value);
        return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : {};
    } catch {
        return {};
    }
}

function positiveInteger(value: unknown): number | undefined {
    const numeric = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
    return typeof numeric === 'number' && Number.isSafeInteger(numeric) && numeric > 0
        ? numeric
        : undefined;
}

function nonBlankString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function knownCommandMode(value: unknown): string | undefined {
    const mode = nonBlankString(value);
    return mode && ['default', 'review', 'fix', 'switch', 'use', 'ultrafix'].includes(mode)
        ? mode
        : undefined;
}

function commandModeFromRecord(value: Record<string, unknown>): string | undefined {
    const commandMeta = parseRecordJson(value.commandMeta);
    return knownCommandMode(value.commandMode) ?? knownCommandMode(commandMeta.mode);
}

function uniqueStrings(values: readonly unknown[]): string[] {
    return [...new Set(values.flatMap((value) => {
        const stringValue = nonBlankString(value);
        return stringValue === undefined ? [] : [stringValue];
    }))];
}

function normalizedStoredTimestamp(
    value: unknown,
    publishedAt: ISO8601Timestamp
): ISO8601Timestamp | undefined {
    const normalized = normalizedTimestamp(value);
    return normalized !== undefined && normalized <= publishedAt ? normalized : undefined;
}

function normalizedTimestamp(value: unknown): ISO8601Timestamp | undefined {
    if (typeof value !== 'string' && typeof value !== 'number' && !(value instanceof Date)) {
        return undefined;
    }
    try {
        return normalizeISO8601Timestamp(value);
    } catch {
        return undefined;
    }
}

function activitySequence(row: Pick<SourceActivityRow, 'metadata_json'>): number | undefined {
    return positiveInteger(parseRecordJson(row.metadata_json).sourceSequence);
}

function activityTransitionTimestamp(row: SourceActivityRow): ISO8601Timestamp {
    return normalizedTimestamp(parseRecordJson(row.metadata_json).transitionAt)
        ?? normalizeISO8601Timestamp(row.last_activity_at);
}

// eslint-disable-next-line max-params -- each field is part of the persisted deduplication-key schema
export function buildProjectionDeduplicationKey(
    source: string,
    entity: string,
    state: string,
    transitionAt: ISO8601Timestamp,
    transitionIdentity?: string | number
): string {
    const entityHash = createHash('sha256').update(entity).digest('hex');
    const identitySuffix = transitionIdentity === undefined
        ? ''
        : `:${createHash('sha256').update(String(transitionIdentity)).digest('hex').slice(0, 24)}`;
    return `notification:v1:${source}:${entityHash}:${state}:${transitionAt}${identitySuffix}`;
}

function indexingActivityKey(
    repository: string,
    branch: string | undefined,
    transition: IndexingTransitionIdentity
): string {
    return `indexing:${createHash('sha256')
        .update(`${repository}\0${branch ?? ''}\0${transition.runId ?? transition.timestamp}`)
        .digest('hex')}`;
}

export class NotificationProjectionStore {
    private readonly recipients: NotificationProjectionRecipients;

    constructor(
        private readonly database: Knex,
        now: () => string | number | Date = () => new Date()
    ) {
        this.recipients = new NotificationProjectionRecipients(database, now);
    }

    async getDraftContext(draftId: string): Promise<DraftProjectionContext | null> {
        const row = await this.database('task_drafts')
            .select('draft_id', 'repository', 'user_id', 'status', 'review_transition_at')
            .where({ draft_id: draftId })
            .first() as {
                draft_id: string;
                repository: string;
                user_id: string;
                status?: string;
                review_transition_at?: unknown;
            } | undefined;
        const reviewTransitionAt = normalizedTimestamp(row?.review_transition_at);
        return row
            ? {
                draftId: row.draft_id,
                repository: row.repository,
                userId: row.user_id,
                ...(typeof row.status === 'string' ? { status: row.status } : {}),
                ...(reviewTransitionAt === undefined ? {} : { reviewTransitionAt })
            }
            : null;
    }

    // eslint-disable-next-line complexity -- context precedence intentionally reconciles several durable sources
    async getTaskContext(
        taskId: string,
        payload: { repository?: string; issueNumber?: number; metadata?: Record<string, unknown> }
    ): Promise<TaskProjectionContext | null> {
        const task = await this.database('tasks')
            .select('repository', 'issue_number', 'pr_number', 'task_type', 'initial_job_data')
            .where({ task_id: taskId })
            .first() as Record<string, unknown> | undefined;
        const historyRows = await this.database('task_history')
            .select('metadata')
            .where({ task_id: taskId })
            .andWhere((query) => query
                .where('metadata', 'like', '%"commandMode"%')
                .orWhere('metadata', 'like', '%"commandMeta"%')
                .orWhere('metadata', 'like', '%"prResult"%')
                .orWhere('metadata', 'like', '%"pr"%')
                .orWhere('metadata', 'like', '%"prNumber"%')
                .orWhere('metadata', 'like', '%"prUrl"%')
                .orWhere('metadata', 'like', '%"userId"%')
                .orWhere('metadata', 'like', '%"user_id"%'))
            .orderBy('history_id', 'desc')
            .limit(32) as Array<{ metadata?: unknown }>;
        const historyMetadata = historyRows.map((row) => parseRecordJson(row.metadata));
        const payloadMetadata = payload.metadata ?? {};
        const initialJobData = parseRecordJson(task?.initial_job_data);
        const repository = nonBlankString(task?.repository) ?? nonBlankString(payload.repository);
        if (!repository) return null;

        // Classification is durable-first. Replayed publications often omit mode,
        // and the newest history row may be an unrelated metadata heartbeat.
        const taskType = nonBlankString(task?.task_type);
        const commandMode = commandModeFromRecord(initialJobData)
            ?? historyMetadata.map(commandModeFromRecord).find((mode) => mode !== undefined)
            ?? (taskType === 'review' || taskType === 'pr-review' ? 'review' : undefined)
            ?? commandModeFromRecord(payloadMetadata);
        const historyPrResults = historyMetadata.flatMap((metadata) => [
            parseRecordJson(metadata.prResult),
            parseRecordJson(metadata.pr)
        ]);
        const historyPrNumber = historyPrResults
            .map((result) => positiveInteger(result.prNumber) ?? positiveInteger(result.number))
            .find((value) => value !== undefined);
        const historyPrUrl = historyPrResults
            .map((result) => nonBlankString(result.prUrl) ?? nonBlankString(result.url))
            .find((value) => value !== undefined);
        const issueNumber = positiveInteger(task?.issue_number) ?? positiveInteger(payload.issueNumber);

        return {
            taskId,
            repository,
            issueNumber,
            prNumber: positiveInteger(payloadMetadata.prNumber)
                ?? positiveInteger(initialJobData.prNumber)
                ?? positiveInteger(initialJobData.pullRequestNumber)
                ?? historyPrNumber
                ?? positiveInteger(task?.pr_number)
                ?? (commandMode === 'review' ? issueNumber : undefined),
            commandMode,
            prUrl: nonBlankString(payloadMetadata.prUrl)
                ?? nonBlankString(initialJobData.prUrl)
                ?? historyPrUrl,
            ownerUserIds: uniqueStrings([
                payloadMetadata.userId,
                payloadMetadata.user_id,
                ...historyMetadata.flatMap((metadata) => [metadata.userId, metadata.user_id]),
                initialJobData.userId,
                initialJobData.user_id,
                initialJobData.requestingUserId,
                initialJobData.ownerUserId
            ])
        };
    }

    // eslint-disable-next-line max-params -- transition identity inputs mirror the published event and durable row
    async resolveTaskTransition(
        taskId: string,
        state: string,
        publishedAt: ISO8601Timestamp,
        preferredTimestamp?: ISO8601Timestamp,
        preferredSequence?: number
    ): Promise<TaskTransitionIdentity> {
        if (!await this.database.schema.hasTable('task_history')) {
            return {
                timestamp: preferredTimestamp ?? publishedAt,
                ...(preferredSequence === undefined ? {} : { sequence: preferredSequence })
            };
        }
        const query = this.database('task_history')
            .select('history_id', 'timestamp')
            .where({ task_id: taskId, state });
        if (preferredSequence !== undefined) query.andWhere({ history_id: preferredSequence });
        else if (preferredTimestamp !== undefined) query.andWhere({ timestamp: preferredTimestamp });
        const rows = await query.orderBy('history_id', 'desc').limit(1) as Array<{
            history_id: unknown;
            timestamp: unknown;
        }>;
        const candidates = rows.flatMap((row) => {
            const timestamp = normalizedStoredTimestamp(row.timestamp, publishedAt);
            const sequence = positiveInteger(row.history_id);
            return timestamp === undefined ? [] : [{ timestamp, sequence }];
        });
        const matched = preferredSequence === undefined
            ? candidates.find((candidate) => preferredTimestamp === undefined || candidate.timestamp === preferredTimestamp)
            : candidates.find((candidate) => candidate.sequence === preferredSequence
                && (preferredTimestamp === undefined || candidate.timestamp === preferredTimestamp));
        const resolved = matched ?? (preferredTimestamp === undefined && preferredSequence === undefined
            ? candidates[0]
            : undefined);
        if (resolved) {
            return {
                timestamp: preferredTimestamp ?? resolved.timestamp,
                ...(resolved.sequence === undefined ? {} : { sequence: resolved.sequence })
            };
        }
        return {
            timestamp: preferredTimestamp ?? publishedAt,
            ...(preferredSequence === undefined ? {} : { sequence: preferredSequence })
        };
    }

    // eslint-disable-next-line max-params, complexity -- reconciliation preserves durable run ordering across schema versions
    async resolveIndexingTransition(
        repository: string,
        branch: string | undefined,
        status: NotificationSourceActivityStatus,
        publishedAt: ISO8601Timestamp,
        preferredTimestamp?: ISO8601Timestamp,
        preferredRunId?: string
    ): Promise<IndexingTransitionIdentity> {
        const explicitRunId = nonBlankString(preferredRunId);
        if (!await this.database.schema.hasTable('repositories')) {
            return {
                timestamp: preferredTimestamp ?? publishedAt,
                ...(explicitRunId === undefined ? {} : { runId: explicitRunId })
            };
        }
        const hasTransitionAt = await this.database.schema.hasColumn('repositories', 'indexing_transition_at');
        const hasRunId = await this.database.schema.hasColumn('repositories', 'indexing_run_id');
        const query = this.database('repositories')
            .select([
                'indexing_status',
                ...(hasTransitionAt ? ['indexing_transition_at'] : []),
                ...(hasRunId ? ['indexing_run_id'] : [])
            ])
            .where({ full_name: repository });
        if (await this.database.schema.hasColumn('repositories', 'branch')) {
            query.andWhere({ branch: branch ?? 'HEAD' });
        }
        const row = await query.first() as Record<string, unknown> | undefined;
        const durableRunId = nonBlankString(row?.indexing_run_id);
        const durableTimestamp = normalizedStoredTimestamp(row?.indexing_transition_at, publishedAt);
        const repositoryStatus = status === 'cancelled' ? 'idle' : status;
        const matchesDurableTransition = row?.indexing_status === repositoryStatus
            && (explicitRunId === undefined || durableRunId === explicitRunId);
        if (matchesDurableTransition && (durableTimestamp !== undefined || durableRunId !== undefined)) {
            return {
                timestamp: preferredTimestamp ?? durableTimestamp ?? publishedAt,
                ...(explicitRunId ?? durableRunId ? { runId: (explicitRunId ?? durableRunId)! } : {})
            };
        }

        // A retry after a newer run began can still recover its previous durable
        // activity identity. This never consults generic repositories.updated_at.
        if (isTerminalActivity(status)) {
            const previousRows = await this.database<SourceActivityRow>('notification_source_activity')
                .select('last_activity_at', 'metadata_json')
                .where({
                    activity_type: 'indexing',
                    repository,
                    branch: branch ?? null,
                    status
                })
                .orderBy('last_activity_at', 'desc');
            const previous = previousRows.find((candidate) => explicitRunId === undefined
                || nonBlankString(parseRecordJson(candidate.metadata_json).runId) === explicitRunId);
            const previousMetadata = parseRecordJson(previous?.metadata_json);
            const previousTimestamp = normalizedStoredTimestamp(
                previousMetadata.transitionAt ?? previous?.last_activity_at,
                publishedAt
            );
            const previousRunId = nonBlankString(previousMetadata.runId);
            if (previousTimestamp !== undefined) {
                return {
                    timestamp: preferredTimestamp ?? previousTimestamp,
                    ...(explicitRunId ?? previousRunId ? { runId: (explicitRunId ?? previousRunId)! } : {})
                };
            }
        }

        return {
            timestamp: preferredTimestamp ?? (isTerminalActivity(status)
                && (explicitRunId === undefined || explicitRunId === durableRunId)
                ? durableTimestamp ?? publishedAt
                : publishedAt),
            ...(explicitRunId ?? (!isTerminalActivity(status) ? durableRunId : undefined)
                ? { runId: (explicitRunId ?? durableRunId)! }
                : {})
        };
    }

    async getTaskRecipients(context: TaskProjectionContext): Promise<string[]> {
        return this.recipients.getTaskRecipients(context);
    }

    async getRepositoryRecipients(repository: string): Promise<string[]> {
        return this.recipients.getRepositoryRecipients(repository);
    }

    async getKnownRecipients(): Promise<string[]> {
        return this.recipients.getKnownRecipients();
    }

    async filterCurrentlyEntitled(
        repository: string,
        candidates: readonly string[],
        database: ProjectionDatabase = this.database
    ): Promise<string[]> {
        return this.recipients.filterCurrentlyEntitled(repository, candidates, database);
    }

    // eslint-disable-next-line complexity -- all ordering decisions must remain inside the atomic checkpoint write
    async upsertTaskActivity(input: {
        context: TaskProjectionContext;
        status: NotificationSourceActivityStatus;
        transition: TaskTransitionIdentity;
        metadata?: JsonObject;
    }, database: ProjectionDatabase = this.database): Promise<ActivityProjectionDecision> {
        const existing = await database<SourceActivityRow>('notification_source_activity')
            .where({ activity_type: 'task', activity_key: input.context.taskId })
            .first();
        const existingSequence = existing ? activitySequence(existing) : undefined;
        const timestampComparison = existing
            ? input.transition.timestamp.localeCompare(activityTransitionTimestamp(existing))
            : 1;
        const sequenceComparison = input.transition.sequence !== undefined && existingSequence !== undefined
            ? input.transition.sequence - existingSequence
            : input.transition.sequence !== undefined && existingSequence === undefined ? 1 : 0;
        if (existing && (timestampComparison < 0 || (timestampComparison === 0 && sequenceComparison < 0))) {
            return 'stale';
        }
        const sameTransition = existing
            && timestampComparison === 0
            && sequenceComparison === 0;
        if (sameTransition && existing.status !== input.status) {
            // A durable history sequence should disambiguate equal-millisecond state
            // changes. Without one, do not guess which conflicting publication won.
            return 'stale';
        }

        const metadata = {
            ...(input.metadata ?? {}),
            ...(input.transition.sequence === undefined ? {} : { sourceSequence: input.transition.sequence })
        };
        const lastActivityAt = existing && existing.last_activity_at > input.transition.timestamp
            ? existing.last_activity_at
            : input.transition.timestamp;
        const row = {
            activity_type: 'task',
            activity_key: input.context.taskId,
            repository: input.context.repository,
            branch: null,
            status: input.status,
            last_activity_at: lastActivityAt,
            completed_at: isTerminalActivity(input.status) ? lastActivityAt : null,
            metadata_json: JSON.stringify(metadata),
            process_heartbeat_at: lastActivityAt,
            stalled_notified_at: null,
            created_at: input.transition.timestamp,
            updated_at: lastActivityAt
        };
        if (!existing) {
            await database('notification_source_activity').insert(row);
            return 'applied';
        }
        if (sameTransition) {
            if (existing.metadata_json !== row.metadata_json || existing.repository !== row.repository) {
                await database('notification_source_activity')
                    .where({ activity_type: 'task', activity_key: input.context.taskId })
                    .update({ repository: row.repository, metadata_json: row.metadata_json });
            }
            return 'current';
        }
        await database('notification_source_activity')
            .where({ activity_type: 'task', activity_key: input.context.taskId })
            .update({
                repository: row.repository,
                status: row.status,
                last_activity_at: row.last_activity_at,
                completed_at: row.completed_at,
                metadata_json: row.metadata_json,
                process_heartbeat_at: row.process_heartbeat_at,
                stalled_notified_at: null
            });
        return 'applied';
    }

    async touchTaskActivity(
        taskId: string,
        timestamp: ISO8601Timestamp,
        activityKind: 'progress' | 'process_liveness' = 'progress',
        database: ProjectionDatabase = this.database
    ): Promise<boolean> {
        const query = database('notification_source_activity')
            .where({ activity_type: 'task', activity_key: taskId })
            .whereNull('completed_at')
            .whereIn('status', ['queued', 'processing']);
        const updated = activityKind === 'process_liveness'
            ? await query.where((builder) => builder
                .whereNull('process_heartbeat_at')
                .orWhere('process_heartbeat_at', '<', timestamp))
                .update({ process_heartbeat_at: timestamp }) as number
            : await query.where('last_activity_at', '<', timestamp).update({
                last_activity_at: timestamp,
                process_heartbeat_at: timestamp,
                stalled_notified_at: null
            }) as number;
        return updated > 0;
    }

    // eslint-disable-next-line complexity -- run identity and terminal-state guards form one atomic checkpoint write
    async upsertIndexingActivity(input: {
        repository: string;
        branch?: string;
        status: NotificationSourceActivityStatus;
        observedAt: ISO8601Timestamp;
        transition: IndexingTransitionIdentity;
    }, database: ProjectionDatabase = this.database): Promise<ActivityProjectionDecision> {
        let key = indexingActivityKey(input.repository, input.branch, input.transition);
        if (input.transition.runId === undefined && !isTerminalActivity(input.status)) {
            const latest = await database<SourceActivityRow>('notification_source_activity')
                .where({
                    activity_type: 'indexing',
                    repository: input.repository,
                    branch: input.branch ?? null
                })
                .orderBy('last_activity_at', 'desc')
                .first();
            if (latest && !isTerminalActivity(latest.status)) key = latest.activity_key;
        }
        const existing = await database<SourceActivityRow>('notification_source_activity')
            .where({ activity_type: 'indexing', activity_key: key })
            .first();
        const existingTransitionAt = existing
            ? normalizedTimestamp(parseRecordJson(existing.metadata_json).transitionAt)
                ?? normalizeISO8601Timestamp(existing.last_activity_at)
            : undefined;
        if (existingTransitionAt && input.transition.timestamp < existingTransitionAt) {
            return 'stale';
        }
        const incomingIsTerminal = isTerminalActivity(input.status);
        if (existing && isTerminalActivity(existing.status)) {
            const existingMetadata = parseRecordJson(existing.metadata_json);
            const sameTerminalTransition = existing.status === input.status
                && existingMetadata.transitionAt === input.transition.timestamp
                && nonBlankString(existingMetadata.runId) === input.transition.runId;
            return sameTerminalTransition ? 'current' : 'stale';
        }
        if (existing && existing.last_activity_at > input.observedAt && !incomingIsTerminal) {
            return 'stale';
        }
        const metadata = JSON.stringify({
            transitionAt: input.transition.timestamp,
            ...(input.transition.runId === undefined ? {} : { runId: input.transition.runId })
        });
        const lastActivityAt = existing && existing.last_activity_at > input.observedAt
            ? existing.last_activity_at
            : input.observedAt;
        const sameTransition = existing
            && existing.last_activity_at === lastActivityAt
            && existing.status === input.status
            && existing.metadata_json === metadata;
        const row = {
            activity_type: 'indexing',
            activity_key: key,
            repository: input.repository,
            branch: input.branch ?? null,
            status: input.status,
            last_activity_at: lastActivityAt,
            completed_at: incomingIsTerminal ? lastActivityAt : null,
            metadata_json: metadata,
            process_heartbeat_at: lastActivityAt,
            stalled_notified_at: null,
            created_at: input.transition.timestamp,
            updated_at: lastActivityAt
        };
        if (!existing) {
            await database('notification_source_activity').insert(row);
            return 'applied';
        }
        if (sameTransition) return 'current';
        await database('notification_source_activity')
            .where({ activity_type: 'indexing', activity_key: key })
            .update({
                status: row.status,
                last_activity_at: row.last_activity_at,
                completed_at: row.completed_at,
                metadata_json: row.metadata_json,
                process_heartbeat_at: row.process_heartbeat_at,
                stalled_notified_at: null
            });
        return 'applied';
    }

    async getStalledActivities(
        cutoff: ISO8601Timestamp,
        cursor: StalledActivityCursor | undefined,
        limit: number
    ): Promise<SourceActivityRow[]> {
        const query = this.database<SourceActivityRow>('notification_source_activity')
            .select('*')
            .whereNull('completed_at')
            .whereNull('stalled_notified_at')
            .whereIn('status', ['queued', 'processing'])
            .where('last_activity_at', '<=', cutoff);
        if (cursor) {
            query.andWhere((afterCursor) => afterCursor
                .where('last_activity_at', '>', cursor.lastActivityAt)
                .orWhere((sameTimestamp) => sameTimestamp
                    .where('last_activity_at', '=', cursor.lastActivityAt)
                    .andWhere((afterIdentity) => afterIdentity
                        .where('activity_type', '>', cursor.activityType)
                        .orWhere((sameType) => sameType
                            .where('activity_type', '=', cursor.activityType)
                            .where('activity_key', '>', cursor.activityKey)))));
        }
        return query
            .orderBy('last_activity_at', 'asc')
            .orderBy('activity_type', 'asc')
            .orderBy('activity_key', 'asc')
            .limit(limit);
    }

    async claimStalledActivity(
        activity: SourceActivityRow,
        detectedAt: ISO8601Timestamp,
        database: ProjectionDatabase = this.database
    ): Promise<boolean> {
        const updated = await database('notification_source_activity')
            .where({
                activity_type: activity.activity_type,
                activity_key: activity.activity_key,
                status: activity.status,
                last_activity_at: activity.last_activity_at
            })
            .whereNull('completed_at')
            .whereNull('stalled_notified_at')
            .update({ stalled_notified_at: detectedAt }) as number;
        return updated === 1;
    }

    async updateSystemTransition(input: {
        component: string;
        status: string;
        healthy: boolean;
        timestamp: ISO8601Timestamp;
    }, database: ProjectionDatabase = this.database): Promise<SystemTransition> {
        const existing = await database('notification_system_health')
            .where({ component: input.component })
            .first() as {
                status: string;
                healthy: number | boolean;
                transition_at: string;
                updated_at: string;
            } | undefined;
        if (existing && existing.updated_at >= input.timestamp) {
            return {
                component: input.component,
                status: existing.status,
                healthy: Boolean(existing.healthy),
                transitionAt: normalizeISO8601Timestamp(existing.transition_at),
                unhealthyEpisodeStarted: false
            };
        }
        const healthChanged = !existing || Boolean(existing.healthy) !== input.healthy;
        const transitionAt = healthChanged
            ? input.timestamp
            : normalizeISO8601Timestamp(existing.transition_at);
        await database('notification_system_health')
            .insert({
                component: input.component,
                status: input.status,
                healthy: input.healthy,
                transition_at: transitionAt,
                updated_at: input.timestamp
            })
            .onConflict('component')
            .merge({
                status: input.status,
                healthy: input.healthy,
                ...(healthChanged ? { transition_at: transitionAt } : {}),
                // This is an observation high-water mark, not just a transition time.
                updated_at: input.timestamp
            });
        return {
            ...input,
            transitionAt,
            unhealthyEpisodeStarted: !input.healthy && healthChanged
        };
    }

    /**
     * Advance ordering for an unclassified observation without opening or closing
     * an outage episode. The schema stores the last confirmed health separately
     * from the raw status; a first unknown observation therefore starts from the
     * conservative non-outage baseline.
     */
    async updateUnknownSystemObservation(input: {
        component: string;
        status: string;
        timestamp: ISO8601Timestamp;
    }, database: ProjectionDatabase = this.database): Promise<void> {
        const existing = await database('notification_system_health')
            .select('updated_at')
            .where({ component: input.component })
            .first() as { updated_at?: string } | undefined;
        if (existing?.updated_at && existing.updated_at >= input.timestamp) return;
        if (existing) {
            await database('notification_system_health')
                .where({ component: input.component })
                .update({ status: input.status, updated_at: input.timestamp });
            return;
        }
        await database('notification_system_health').insert({
            component: input.component,
            status: input.status,
            healthy: true,
            transition_at: input.timestamp,
            updated_at: input.timestamp
        });
    }
}

export function isTerminalActivity(status: NotificationSourceActivityStatus): boolean {
    return status === 'completed' || status === 'failed' || status === 'cancelled';
}
