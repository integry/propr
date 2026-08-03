import type { Knex } from 'knex';
import type { TaskProjectionContext } from './notificationProjectionStore.js';

type ProjectionDatabase = Knex | Knex.Transaction;
const CACHE_TTL_MS = 60_000;
// Leave ample room for the repository and expiry bindings under SQLite's
// commonly configured placeholder limits.
const ENTITLEMENT_LOOKUP_CHUNK_SIZE = 200;

function nonBlankString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function uniqueStrings(values: readonly unknown[]): string[] {
    return [...new Set(values.flatMap((value) => {
        const stringValue = nonBlankString(value);
        return stringValue === undefined ? [] : [stringValue];
    }))];
}

interface CachedValue<T> {
    expiresAt: number;
    value: T;
}

export class NotificationProjectionRecipients {
    private readonly schemaCapabilities = new Map<string, Promise<boolean>>();
    private knownRecipientsCache?: CachedValue<string[]>;

    constructor(
        private readonly database: Knex,
        private readonly now: () => string | number | Date = () => new Date()
    ) {}

    async getTaskRecipients(context: TaskProjectionContext): Promise<string[]> {
        const candidates: unknown[] = [...(context.ownerUserIds ?? [])];
        if (await this.hasTable('plan_issues') && await this.hasTable('task_drafts')) {
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
            candidates.push(...rows.map((row) => row.user_id));
        }
        candidates.push(...await this.getRepositoryCandidateRecipients(context.repository));
        return this.filterCurrentlyEntitled(context.repository, uniqueStrings(candidates));
    }

    async getRepositoryRecipients(repository: string): Promise<string[]> {
        const candidates = await this.getRepositoryCandidateRecipients(repository);
        return this.filterCurrentlyEntitled(repository, candidates);
    }

    async filterCurrentlyEntitled(
        repository: string,
        candidates: readonly string[],
        database: ProjectionDatabase = this.database
    ): Promise<string[]> {
        const userIds = uniqueStrings(candidates);
        if (userIds.length === 0
            || !await this.hasTable('notification_repository_entitlements', database)) {
            return [];
        }
        const entitled: string[] = [];
        const expiresAfter = new Date(this.now()).toISOString();
        for (let offset = 0; offset < userIds.length; offset += ENTITLEMENT_LOOKUP_CHUNK_SIZE) {
            const rows = await database('notification_repository_entitlements')
                .select('user_id')
                .where({ repository })
                .whereIn('user_id', userIds.slice(offset, offset + ENTITLEMENT_LOOKUP_CHUNK_SIZE))
                .where('expires_at', '>', expiresAfter) as Array<{ user_id: string }>;
            entitled.push(...rows.map((row) => row.user_id));
        }
        return uniqueStrings(entitled);
    }

    async getKnownRecipients(): Promise<string[]> {
        const nowMs = new Date(this.now()).getTime();
        if (this.knownRecipientsCache && this.knownRecipientsCache.expiresAt > nowMs) {
            return [...this.knownRecipientsCache.value];
        }
        const tables = [
            ['task_drafts', 'user_id'],
            ['notification_preferences', 'user_id'],
            ['notification_preference_settings', 'user_id'],
            ['repo_todos', 'user_id'],
            ['push_subscriptions', 'user_id'],
            ['notification_user_states', 'user_id']
        ] as const;
        const scans = tables.map(async ([table, column]) => {
            if (!await this.hasTable(table)) return [];
            const rows = await this.database(table).distinct(column) as Array<Record<string, unknown>>;
            return rows.map((row) => row[column]);
        });
        const entitlementScan = this.hasTable('notification_repository_entitlements').then(async (present) => {
            if (!present) return [];
            const rows = await this.database('notification_repository_entitlements')
                .distinct('user_id')
                .where('expires_at', '>', new Date(this.now()).toISOString()) as Array<{ user_id: string }>;
            return rows.map((row) => row.user_id);
        });
        const recipients = uniqueStrings((await Promise.all([...scans, entitlementScan])).flat());
        this.knownRecipientsCache = { value: recipients, expiresAt: nowMs + CACHE_TTL_MS };
        return [...recipients];
    }

    private async getRepositoryCandidateRecipients(repository: string): Promise<string[]> {
        if (!await this.hasTable('notification_repository_subscriptions')) return [];
        const rows = await this.database('notification_repository_subscriptions')
            .select('user_id')
            .where({ repository, hidden: false }) as Array<{ user_id: string }>;
        // Drafts and repository todos are historical ownership evidence, not an
        // implicit repository-wide subscription. Task ownership is resolved by
        // getTaskRecipients() against the specific task/issue/PR instead.
        return uniqueStrings(rows.map((row) => row.user_id));
    }

    private async hasTable(
        table: string,
        database: ProjectionDatabase = this.database
    ): Promise<boolean> {
        let capability = this.schemaCapabilities.get(table);
        if (!capability) {
            // Use the caller's transaction for the first check when one is
            // already open, then reuse the stable positive capability across
            // later projections instead of querying SQLite for every event.
            // Knex returns a re-executable thenable here, so adopt it into a
            // native Promise before caching; otherwise a later await could try
            // to run the schema query on an already-completed transaction.
            capability = Promise.resolve().then(() => database.schema.hasTable(table));
            this.schemaCapabilities.set(table, capability);
        }
        try {
            const present = await capability;
            // A negative result can become stale when migrations finish during
            // process startup. Cache stable positive capabilities, but retry a
            // missing table on the next projection.
            if (!present && this.schemaCapabilities.get(table) === capability) {
                this.schemaCapabilities.delete(table);
            }
            return present;
        } catch (error) {
            if (this.schemaCapabilities.get(table) === capability) {
                this.schemaCapabilities.delete(table);
            }
            throw error;
        }
    }
}
