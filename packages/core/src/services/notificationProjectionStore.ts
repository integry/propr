import { createHash } from 'node:crypto';
import type { Knex } from 'knex';
import {
    normalizeISO8601Timestamp,
    type ISO8601Timestamp,
    type JsonObject,
    type NotificationSourceActivityStatus
} from '@propr/shared';
import { NotificationProjectionRecipients } from './notificationProjectionRecipients.js';

export interface DraftProjectionContext {
    draftId: string;
    repository: string;
    userId: string;
    status?: string;
    updatedAt?: ISO8601Timestamp;
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

export interface SourceActivityRow {
    activity_type: 'task' | 'indexing';
    activity_key: string;
    repository: string;
    branch: string | null;
    status: NotificationSourceActivityStatus;
    last_activity_at: string;
    completed_at: string | null;
    metadata_json: string | null;
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
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
        ? value
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
    if (typeof value !== 'string' && typeof value !== 'number' && !(value instanceof Date)) {
        return undefined;
    }
    try {
        const normalized = normalizeISO8601Timestamp(value);
        return normalized <= publishedAt ? normalized : undefined;
    } catch {
        return undefined;
    }
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

export function buildProjectionDeduplicationKey(
    source: string,
    entity: string,
    state: string,
    transitionAt: ISO8601Timestamp
): string {
    const entityHash = createHash('sha256').update(entity).digest('hex');
    return `notification:v1:${source}:${entityHash}:${state}:${transitionAt}`;
}

function indexingActivityKey(repository: string, branch: string | undefined, timestamp: string): string {
    return `indexing:${createHash('sha256')
        .update(`${repository}\0${branch ?? ''}\0${timestamp}`)
        .digest('hex')}`;
}

export class NotificationProjectionStore {
    private readonly recipients: NotificationProjectionRecipients;

    constructor(private readonly database: Knex) {
        this.recipients = new NotificationProjectionRecipients(database);
    }

    async getDraftContext(draftId: string): Promise<DraftProjectionContext | null> {
        const row = await this.database('task_drafts')
            .select('draft_id', 'repository', 'user_id', 'status', 'updated_at')
            .where({ draft_id: draftId })
            .first() as {
                draft_id: string;
                repository: string;
                user_id: string;
                status?: string;
                updated_at?: unknown;
            } | undefined;
        const updatedAt = normalizedTimestamp(row?.updated_at);
        return row
            ? {
                draftId: row.draft_id,
                repository: row.repository,
                userId: row.user_id,
                ...(typeof row.status === 'string' ? { status: row.status } : {}),
                ...(updatedAt === undefined ? {} : { updatedAt })
            }
            : null;
    }

    async getTaskContext(
        taskId: string,
        payload: { repository?: string; issueNumber?: number; metadata?: Record<string, unknown> }
    ): Promise<TaskProjectionContext | null> {
        const task = await this.database('tasks')
            .select('repository', 'issue_number', 'pr_number', 'task_type', 'initial_job_data')
            .where({ task_id: taskId })
            .first() as Record<string, unknown> | undefined;
        const history = await this.database('task_history')
            .select('metadata')
            .where({ task_id: taskId })
            .orderBy('timestamp', 'desc')
            .orderBy('history_id', 'desc')
            .first() as { metadata?: unknown } | undefined;
        const historyMetadata = parseRecordJson(history?.metadata);
        const historyPrResult = parseRecordJson(historyMetadata.prResult);
        const payloadMetadata = payload.metadata ?? {};
        const initialJobData = parseRecordJson(task?.initial_job_data);
        const repository = nonBlankString(payload.repository) ?? nonBlankString(task?.repository);
        if (!repository) return null;

        const commandMode = knownCommandMode(payloadMetadata.commandMode)
            ?? knownCommandMode(historyMetadata.commandMode);
        return {
            taskId,
            repository,
            issueNumber: positiveInteger(payload.issueNumber) ?? positiveInteger(task?.issue_number),
            prNumber: positiveInteger(payloadMetadata.prNumber)
                ?? positiveInteger(historyPrResult.prNumber)
                ?? positiveInteger(task?.pr_number)
                ?? (commandMode === 'review'
                    ? positiveInteger(payload.issueNumber) ?? positiveInteger(task?.issue_number)
                    : undefined),
            commandMode,
            prUrl: nonBlankString(payloadMetadata.prUrl) ?? nonBlankString(historyPrResult.prUrl),
            ownerUserIds: uniqueStrings([
                payloadMetadata.userId,
                payloadMetadata.user_id,
                historyMetadata.userId,
                historyMetadata.user_id,
                initialJobData.userId,
                initialJobData.user_id,
                initialJobData.requestingUserId,
                initialJobData.ownerUserId
            ])
        };
    }

    async resolveTaskTransitionTimestamp(
        taskId: string,
        state: string,
        publishedAt: ISO8601Timestamp
    ): Promise<ISO8601Timestamp> {
        if (!await this.database.schema.hasTable('task_history')) return publishedAt;
        const rows = await this.database('task_history')
            .select('timestamp')
            .where({ task_id: taskId, state })
            .orderBy('history_id', 'desc') as Array<{ timestamp: unknown }>;
        for (const row of rows) {
            const timestamp = normalizedStoredTimestamp(row.timestamp, publishedAt);
            if (timestamp !== undefined) return timestamp;
        }
        return publishedAt;
    }

    async resolveIndexingTransitionTimestamp(
        repository: string,
        branch: string | undefined,
        status: NotificationSourceActivityStatus,
        publishedAt: ISO8601Timestamp
    ): Promise<ISO8601Timestamp> {
        // Progress publications are heartbeats and must retain their own time.
        // Only terminal transitions need the durable repository transition time
        // to make publication retries deduplicate.
        if (!isTerminalActivity(status)) return publishedAt;
        if (!await this.database.schema.hasTable('repositories')) return publishedAt;
        if (!await this.database.schema.hasColumn('repositories', 'updated_at')) return publishedAt;
        const query = this.database('repositories')
            .select('updated_at')
            .where({ full_name: repository });
        if (await this.database.schema.hasColumn('repositories', 'branch')) {
            query.andWhere({ branch: branch ?? 'HEAD' });
        }
        if (await this.database.schema.hasColumn('repositories', 'indexing_status')) {
            const repositoryStatus = status === 'cancelled' ? 'idle' : status;
            query.andWhere({ indexing_status: repositoryStatus });
        }
        const row = await query.first() as { updated_at?: unknown } | undefined;
        const repositoryTransition = normalizedStoredTimestamp(row?.updated_at, publishedAt);
        if (repositoryTransition !== undefined) return repositoryTransition;

        // Once another run starts, repositories contains only that newer state.
        // Retained activity still identifies a replay of the older terminal event.
        const previous = await this.database<SourceActivityRow>('notification_source_activity')
            .select('last_activity_at')
            .where({
                activity_type: 'indexing',
                repository,
                branch: branch ?? null,
                status
            })
            .orderBy('last_activity_at', 'desc')
            .first();
        return normalizedStoredTimestamp(previous?.last_activity_at, publishedAt) ?? publishedAt;
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

    async upsertTaskActivity(input: {
        context: TaskProjectionContext;
        status: NotificationSourceActivityStatus;
        timestamp: ISO8601Timestamp;
        metadata?: JsonObject;
    }): Promise<boolean> {
        return this.upsertActivity({
            activity_type: 'task',
            activity_key: input.context.taskId,
            repository: input.context.repository,
            branch: null,
            status: input.status,
            last_activity_at: input.timestamp,
            completed_at: isTerminalActivity(input.status) ? input.timestamp : null,
            metadata_json: input.metadata === undefined ? null : JSON.stringify(input.metadata),
            created_at: input.timestamp,
            updated_at: input.timestamp
        });
    }

    async upsertIndexingActivity(input: {
        repository: string;
        branch?: string;
        status: NotificationSourceActivityStatus;
        timestamp: ISO8601Timestamp;
    }): Promise<boolean> {
        return this.database.transaction(async (transaction) => {
            const latestTransition = await transaction<SourceActivityRow>('notification_source_activity')
                .where({
                    activity_type: 'indexing',
                    repository: input.repository,
                    branch: input.branch ?? null
                })
                .orderBy('last_activity_at', 'desc')
                .first();
            if (latestTransition && latestTransition.last_activity_at >= input.timestamp) {
                return false;
            }
            const key = latestTransition && !isTerminalActivity(latestTransition.status)
                ? latestTransition.activity_key
                : indexingActivityKey(input.repository, input.branch, input.timestamp);
            return this.upsertActivity({
                activity_type: 'indexing',
                activity_key: key,
                repository: input.repository,
                branch: input.branch ?? null,
                status: input.status,
                last_activity_at: input.timestamp,
                completed_at: isTerminalActivity(input.status) ? input.timestamp : null,
                metadata_json: null,
                created_at: input.timestamp,
                updated_at: input.timestamp
            }, transaction);
        });
    }

    async getStalledActivities(cutoff: ISO8601Timestamp): Promise<SourceActivityRow[]> {
        return this.database<SourceActivityRow>('notification_source_activity')
            .select('*')
            .whereNull('completed_at')
            .whereIn('status', ['queued', 'processing'])
            .where('last_activity_at', '<=', cutoff)
            .orderBy('last_activity_at', 'asc');
    }

    async updateSystemTransition(input: {
        component: string;
        status: string;
        healthy: boolean;
        timestamp: ISO8601Timestamp;
    }): Promise<SystemTransition> {
        return this.database.transaction(async (transaction) => {
            const existing = await transaction('notification_system_health')
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
            const statusChanged = !existing || existing.status !== input.status;
            if (existing && !healthChanged && !statusChanged) {
                return {
                    component: input.component,
                    status: existing.status,
                    healthy: Boolean(existing.healthy),
                    transitionAt: normalizeISO8601Timestamp(existing.transition_at),
                    unhealthyEpisodeStarted: false
                };
            }
            const transitionAt = healthChanged
                ? input.timestamp
                : normalizeISO8601Timestamp(existing.transition_at);
            await transaction('notification_system_health')
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
                    updated_at: input.timestamp
                });
            return {
                ...input,
                transitionAt,
                unhealthyEpisodeStarted: !input.healthy && healthChanged
            };
        });
    }

    private async upsertActivity(
        row: Record<string, unknown>,
        database: Knex | Knex.Transaction = this.database
    ): Promise<boolean> {
        const updated = await database('notification_source_activity')
            .insert(row)
            .onConflict(['activity_type', 'activity_key'])
            .merge({
                repository: row.repository,
                branch: row.branch,
                status: row.status,
                last_activity_at: row.last_activity_at,
                completed_at: row.completed_at,
                metadata_json: row.metadata_json
            })
            // updated_at is advanced by notification_source_activity_touch_updated_at;
            // writing it directly is rejected because that audit field is DB-managed.
            .where('notification_source_activity.last_activity_at', '<', String(row.last_activity_at))
            .returning('activity_key') as Array<{ activity_key: string }>;
        return updated.length > 0;
    }
}

export function isTerminalActivity(status: NotificationSourceActivityStatus): boolean {
    return status === 'completed' || status === 'failed' || status === 'cancelled';
}
