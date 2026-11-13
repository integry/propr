import type { Knex } from 'knex';
import type { PullRequestEvent } from '@octokit/webhooks-types';
import { db } from '../db/connection.js';
import { appendRepositoryEvent } from '../services/repositoryEventJournal.js';

/**
 * Journal a pull request being opened or receiving a new head. A pull request
 * opens once, so `opened` is keyed by the pull request alone. A head change is
 * keyed by the webhook delivery that reported it: GitHub redelivers with the
 * same `X-GitHub-Delivery` id, while a force-push back to an earlier commit is
 * a new delivery, so it is journaled even though that commit was seen before.
 * Without a delivery id the head change is appended unkeyed, since neither the
 * commit nor the before/after pair identifies one occurrence. Never throws.
 */
export async function journalPullRequestWebhook(payload: PullRequestEvent, options: {
    deliveryId?: string | null; database?: Knex;
} = {}): Promise<void> {
    if (payload.action !== 'opened' && payload.action !== 'synchronize') return;
    const database = options.database ?? db;
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
    const deliveryId = typeof options.deliveryId === 'string' && options.deliveryId ? options.deliveryId : null;
    await appendRepositoryEvent(database, { ...base, type: 'head_changed',
        dedupeKey: deliveryId ? `pr:${prNumber}:head_changed:delivery:${deliveryId}` : null,
        payload: { previousHeadSha: typeof payload.before === 'string' ? payload.before : null } });
}
