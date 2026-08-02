import { createHash } from 'node:crypto';
import type { Knex } from 'knex';
import {
    normalizeISO8601Timestamp,
    type ISO8601Timestamp,
    type JsonObject,
    type NotificationSourceActivityStatus
} from '@propr/shared';

export interface DraftProjectionContext {
    draftId: string;
    repository: string;
    userId: string;
}

export interface TaskProjectionContext {
    taskId: string;
    repository: string;
    issueNumber?: number;
    prNumber?: number;
    commandMode?: string;
    prUrl?: string;
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
    constructor(private readonly database: Knex) {}

    async getDraftContext(draftId: string): Promise<DraftProjectionContext | null> {
        const row = await this.database('task_drafts')
            .select('draft_id', 'repository', 'user_id')
            .where({ draft_id: draftId })
            .first() as { draft_id: string; repository: string; user_id: string } | undefined;
        return row
            ? { draftId: row.draft_id, repository: row.repository, userId: row.user_id }
            : null;
    }

    async getTaskContext(
        taskId: string,
        payload: { repository?: string; issueNumber?: number; metadata?: Record<string, unknown> }
    ): Promise<TaskProjectionContext | null> {
        const task = await this.database('tasks')
            .select('repository', 'issue_number', 'pr_number', 'task_type')
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
            prUrl: nonBlankString(payloadMetadata.prUrl) ?? nonBlankString(historyPrResult.prUrl)
        };
    }

    async getTaskRecipients(context: TaskProjectionContext): Promise<string[]> {
        if (!await this.database.schema.hasTable('plan_issues')) return [];
        const rows = await this.database('plan_issues as issue')
            .join('task_drafts as draft', 'draft.draft_id', 'issue.draft_id')
            .distinct('draft.user_id')
            .where((query) => {
                query.where('issue.task_id', context.taskId);
                if (context.issueNumber !== undefined) {
                    query.orWhere((issueQuery) => issueQuery
                        .where('issue.repository', context.repository)
                        .where('issue.issue_number', context.issueNumber!));
                }
                if (context.prNumber !== undefined) {
                    query.orWhere((issueQuery) => issueQuery
                        .where('issue.repository', context.repository)
                        .where('issue.pr_number', context.prNumber!));
                }
            }) as Array<{ user_id: string }>;
        return uniqueStrings(rows.map((row) => row.user_id));
    }

    async getRepositoryRecipients(repository: string): Promise<string[]> {
        const recipients: unknown[] = [];
        if (await this.database.schema.hasTable('task_drafts')) {
            const rows = await this.database('task_drafts')
                .distinct('user_id')
                .where({ repository }) as Array<{ user_id: string }>;
            recipients.push(...rows.map((row) => row.user_id));
        }
        if (await this.database.schema.hasTable('repo_todos')) {
            const rows = await this.database('repo_todos')
                .distinct('user_id')
                .where({ repository }) as Array<{ user_id: string }>;
            recipients.push(...rows.map((row) => row.user_id));
        }
        return uniqueStrings(recipients);
    }

    async getKnownRecipients(): Promise<string[]> {
        const recipients: unknown[] = [];
        const tables = [
            ['task_drafts', 'user_id'],
            ['notification_preferences', 'user_id'],
            ['notification_preference_settings', 'user_id'],
            ['repo_todos', 'user_id']
        ] as const;
        for (const [table, column] of tables) {
            if (!await this.database.schema.hasTable(table)) continue;
            const rows = await this.database(table).distinct(column) as Array<Record<string, unknown>>;
            recipients.push(...rows.map((row) => row[column]));
        }
        return uniqueStrings(recipients);
    }

    async upsertTaskActivity(input: {
        context: TaskProjectionContext;
        status: NotificationSourceActivityStatus;
        timestamp: ISO8601Timestamp;
        metadata?: JsonObject;
    }): Promise<void> {
        await this.upsertActivity({
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
    }): Promise<void> {
        const active = await this.database<SourceActivityRow>('notification_source_activity')
            .where({
                activity_type: 'indexing',
                repository: input.repository,
                branch: input.branch ?? null
            })
            .whereNull('completed_at')
            .where('last_activity_at', '<=', input.timestamp)
            .orderBy('last_activity_at', 'desc')
            .first();
        const repeatedTransition = active ? undefined : await this.database<SourceActivityRow>(
            'notification_source_activity'
        )
            .where({
                activity_type: 'indexing',
                repository: input.repository,
                branch: input.branch ?? null,
                status: input.status,
                last_activity_at: input.timestamp
            })
            .first();
        const latestTransition = active || repeatedTransition ? undefined
            : await this.database<SourceActivityRow>('notification_source_activity')
                .where({
                    activity_type: 'indexing',
                    repository: input.repository,
                    branch: input.branch ?? null
                })
                .orderBy('last_activity_at', 'desc')
                .first();
        const key = active?.activity_key
            ?? repeatedTransition?.activity_key
            ?? (latestTransition && latestTransition.last_activity_at >= input.timestamp
                ? latestTransition.activity_key
                : undefined)
            ?? indexingActivityKey(input.repository, input.branch, input.timestamp);
        await this.upsertActivity({
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
            if (existing && existing.updated_at > input.timestamp) {
                return {
                    component: input.component,
                    status: existing.status,
                    healthy: Boolean(existing.healthy),
                    transitionAt: normalizeISO8601Timestamp(existing.transition_at)
                };
            }
            const changed = !existing
                || existing.status !== input.status
                || Boolean(existing.healthy) !== input.healthy;
            const transitionAt = changed
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
                    ...(changed ? { transition_at: transitionAt } : {}),
                    updated_at: input.timestamp
                });
            return { ...input, transitionAt };
        });
    }

    private async upsertActivity(row: Record<string, unknown>): Promise<void> {
        await this.database('notification_source_activity')
            .insert(row)
            .onConflict(['activity_type', 'activity_key'])
            .merge([
                'repository',
                'branch',
                'status',
                'last_activity_at',
                'completed_at',
                'metadata_json'
            ]);
    }
}

export function isTerminalActivity(status: NotificationSourceActivityStatus): boolean {
    return status === 'completed' || status === 'failed' || status === 'cancelled';
}
