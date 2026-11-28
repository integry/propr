import { getAuthenticatedOctokit, logger } from '@propr/core';
import type { WebhookRecoveryResult } from '@propr/shared';

interface Delivery {
    id: number;
    guid: string;
    delivered_at: string;
    status_code: number | null;
    status: string;
}

interface DeliveryPage {
    deliveries: Delivery[];
    next: string | null;
    exhausted: boolean;
}

interface HookApi {
    list(cursor?: string): Promise<DeliveryPage>;
    redeliver(id: number): Promise<boolean>; // true when the rate limit is exhausted
}

const exhausted = (headers: Record<string, unknown>) => headers['x-ratelimit-remaining'] === '0';
const requestOptions = () => ({ signal: AbortSignal.timeout(15_000) });

// The existing App-auth Octokit signs /app/hook routes with an App JWT.
const github: HookApi = {
    async list(cursor) {
        const client = await getAuthenticatedOctokit();
        const { data, headers } = await client.request('GET /app/hook/deliveries', { per_page: 100, cursor, request: requestOptions() });
        const nextUrl = headers.link?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
        return { deliveries: data, next: nextUrl ? new URL(nextUrl).searchParams.get('cursor') : null, exhausted: exhausted(headers) };
    },
    async redeliver(delivery_id) {
        const client = await getAuthenticatedOctokit();
        const { headers } = await client.request('POST /app/hook/deliveries/{delivery_id}/attempts', { delivery_id, request: requestOptions() });
        return exhausted(headers);
    },
};

const MAX_REDELIVERIES = 200;

async function listFailedDeliveries(since: number, api: HookApi, result: WebhookRecoveryResult): Promise<number[]> {
    const seen = new Set<string>();
    const candidates: number[] = [];
    let cursor: string | undefined;
    // Finish listing before requesting attempts, so our POSTs cannot shift the pages.
    for (;;) {
        const page = await api.list(cursor);
        let reachedBoundary = false;
        for (const delivery of page.deliveries) {
            const delivered = Date.parse(delivery.delivered_at);
            if (!Number.isFinite(delivered)) continue;
            if (delivered < since) {
                reachedBoundary = true;
                break;
            }
            result.scanned++;
            const failed = delivery.status_code === 0 || (delivery.status_code ?? 0) >= 400 || delivery.status !== 'OK';
            if (failed) result.failed++;
            if (failed && !seen.has(delivery.guid) && candidates.length < MAX_REDELIVERIES) candidates.push(delivery.id);
            seen.add(delivery.guid);
        }
        if (page.exhausted) throw new Error('GitHub API rate limit exhausted');
        if (reachedBoundary || !page.next) break;
        if (page.next === cursor) throw new Error('GitHub returned a repeated delivery cursor');
        cursor = page.next;
    }
    return candidates;
}

export async function recoverDirectWebhooks(
    stoppedAt: string,
    api: HookApi = github,
    pause: () => Promise<void> = () => new Promise(resolve => setTimeout(resolve, 1000)),
): Promise<WebhookRecoveryResult> {
    const since = Date.parse(stoppedAt) - 120_000;
    const result: WebhookRecoveryResult = { scanned: 0, failed: 0, redelivered: 0, skipped: 0 };
    try {
        if (!Number.isFinite(since)) throw new Error('Invalid idle stop timestamp');
        const candidates = await listFailedDeliveries(since, api, result);
        for (const id of candidates) {
            if (result.redelivered) await pause();
            const limitReached = await api.redeliver(id);
            result.redelivered++;
            if (limitReached && result.redelivered < candidates.length) throw new Error('GitHub API rate limit exhausted');
        }
    } catch (error) {
        result.error = (error as Error).message;
    }
    result.skipped = result.failed - result.redelivered;
    logger.info({ ...result, stoppedAt }, 'GitHub App webhook redelivery after idle wake');
    return result;
}
