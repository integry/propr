import type { Knex } from 'knex';
import type { TaskProjectionContext } from './notificationProjectionStore.js';

function nonBlankString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function uniqueStrings(values: readonly unknown[]): string[] {
    return [...new Set(values.flatMap((value) => {
        const stringValue = nonBlankString(value);
        return stringValue === undefined ? [] : [stringValue];
    }))];
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

export class NotificationProjectionRecipients {
    constructor(private readonly database: Knex) {}

    async getTaskRecipients(context: TaskProjectionContext): Promise<string[]> {
        const recipients: unknown[] = [...(context.ownerUserIds ?? [])];
        if (
            await this.database.schema.hasTable('plan_issues')
            && await this.database.schema.hasTable('task_drafts')
        ) {
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
            recipients.push(...rows.map((row) => row.user_id));
        }
        recipients.push(...await this.getRepositoryRecipients(context.repository));
        return uniqueStrings(recipients);
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
        // Category/channel preferences only filter an already eligible recipient;
        // they are installation-wide and must never establish repository access.
        recipients.push(...await this.getRepositoryPreferenceRecipients(repository));
        return uniqueStrings(recipients);
    }

    async getKnownRecipients(): Promise<string[]> {
        const recipients: unknown[] = [];
        const tables = [
            ['task_drafts', 'user_id'],
            ['notification_preferences', 'user_id'],
            ['notification_preference_settings', 'user_id'],
            ['repo_todos', 'user_id'],
            ['push_subscriptions', 'user_id'],
            ['notification_user_states', 'user_id']
        ] as const;
        for (const [table, column] of tables) {
            if (!await this.database.schema.hasTable(table)) continue;
            const rows = await this.database(table).distinct(column) as Array<Record<string, unknown>>;
            recipients.push(...rows.map((row) => row[column]));
        }
        if (await this.database.schema.hasTable('system_configs')) {
            const rows = await this.database('system_configs')
                .select('key')
                .whereLike('key', 'user_repo_prefs_%') as Array<{ key: string }>;
            recipients.push(...rows
                .filter((row) => row.key.startsWith('user_repo_prefs_'))
                .map((row) => row.key.slice('user_repo_prefs_'.length)));
        }
        return uniqueStrings(recipients);
    }

    private async getRepositoryPreferenceRecipients(repository: string): Promise<string[]> {
        if (!await this.database.schema.hasTable('system_configs')) return [];
        const rows = await this.database('system_configs')
            .select('key', 'value')
            .whereLike('key', 'user_repo_prefs_%') as Array<{ key: string; value: unknown }>;
        return uniqueStrings(rows.flatMap((row) => {
            if (!row.key.startsWith('user_repo_prefs_')) return [];
            const repositoryPreference = parseRecordJson(row.value)[repository];
            if (
                typeof repositoryPreference !== 'object'
                || repositoryPreference === null
                || Array.isArray(repositoryPreference)
                || (repositoryPreference as Record<string, unknown>).hidden === true
            ) return [];
            return [row.key.slice('user_repo_prefs_'.length)];
        }));
    }
}
