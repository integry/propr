import type { Knex } from 'knex';
import type { PullRequestEvent } from '@octokit/webhooks-types';
import { db } from '../db/connection.js';
import { appendRepositoryEvent } from '../services/repositoryEventJournal.js';

/**
 * Journal a pull request being opened or receiving a new head. Both are keyed
 * so webhook redelivery appends nothing: a pull request opens once, and each
 * head commit is new once. Never throws.
 */
export async function journalPullRequestWebhook(payload: PullRequestEvent, database: Knex = db): Promise<void> {
    if (payload.action !== 'opened' && payload.action !== 'synchronize') return;
    const repository = payload.repository.full_name;
    const prNumber = payload.pull_request.number;
    const headSha = payload.pull_request.head?.sha ?? null;
    const base = { repository, domain: 'pull_request' as const, entityId: prNumber, prNumber, headSha };
    if (payload.action === 'opened') {
        await appendRepositoryEvent(database, { ...base, type: 'opened', dedupeKey: `pr:${prNumber}:opened`,
            occurredAt: payload.pull_request.created_at ?? undefined,
            payload: { baseRef: payload.pull_request.base?.ref ?? null, draft: payload.pull_request.draft === true } });
        return;
    }
    if (!headSha) return;
    await appendRepositoryEvent(database, { ...base, type: 'head_changed', dedupeKey: `pr:${prNumber}:head:${headSha}`,
        payload: { previousHeadSha: typeof payload.before === 'string' ? payload.before : null } });
}
