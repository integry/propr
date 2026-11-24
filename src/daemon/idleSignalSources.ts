import type { Redis } from 'ioredis';
import type { Knex } from 'knex';
import {
    collectActivitySignals,
    collectDatabaseSignals,
    collectQueueSignals,
    type IdleSignalSource,
    type IdleSignals,
} from '@propr/core';
import type { ScheduledItem } from '@propr/shared';
import { listIndexedUltrafixResumeCandidates, type UltrafixPrRef } from '../jobs/ultrafixResumeIndex.js';
import {
    listDeferredContinuationKeys,
    listRearmRetryKeys,
    loadDeferredContinuation,
    loadRearmRetry,
    parseDeferredKey,
    parseRearmRetryKey,
} from '../jobs/ultrafixDeferredContinuationStore.js';

/**
 * Ultrafix loops: a deferred continuation (waiting for CI, or holding a
 * claimed step) is active work; a retry obligation is scheduled work due at
 * its `notBefore`.
 */
export async function collectUltrafixSignals(redis: Redis, now: number): Promise<Partial<IdleSignals>> {
    let refs: UltrafixPrRef[] | null = await listIndexedUltrafixResumeCandidates(redis);
    if (refs === null) {
        const keys = [
            ...(await listDeferredContinuationKeys(redis)).map(parseDeferredKey),
            ...(await listRearmRetryKeys(redis)).map(parseRearmRetryKey),
        ];
        refs = keys.filter((ref): ref is UltrafixPrRef => ref !== null);
    }
    let ultrafixLoops = 0;
    const scheduled: ScheduledItem[] = [];
    for (const { owner, repo, pr } of refs) {
        if (await loadDeferredContinuation(redis, owner, repo, pr)) {
            ultrafixLoops += 1;
            continue;
        }
        const retry = await loadRearmRetry(redis, owner, repo, pr);
        if (!retry) continue;
        const notBefore = retry.notBefore ? Date.parse(retry.notBefore) : Number.NaN;
        scheduled.push({
            kind: 'ultrafix_retry',
            dueAt: Number.isFinite(notBefore) ? notBefore : now,
            detail: `Ultrafix retry for ${owner}/${repo}#${pr}`,
        });
    }
    return { ultrafixLoops, scheduled };
}

export interface DaemonIdleSourceDeps {
    redis: Redis;
    database: Knex;
    intakeMode: string;
    pollingIntervalMs: number;
    connectInFlight: () => number;
    now?: () => number;
}

/** Every signal the daemon's idle detector reads, by name (the name shows up when one cannot be read). */
export function createDaemonIdleSources(deps: DaemonIdleSourceDeps): Record<string, IdleSignalSource> {
    const now = deps.now ?? Date.now;
    return {
        'BullMQ queues': () => collectQueueSignals(deps.redis),
        'API activity': () => collectActivitySignals(deps.redis),
        'database work': () => collectDatabaseSignals(deps.database),
        'Ultrafix loops': () => collectUltrafixSignals(deps.redis, now()),
        'Connect deliveries': async () => ({ connectDeliveries: deps.connectInFlight() }),
        // Polling is scheduled work: the next poll is always one interval away.
        'polling': async () => (deps.intakeMode === 'polling'
            ? { scheduled: [{ kind: 'polling' as const, dueAt: now() + deps.pollingIntervalMs, detail: 'GitHub polling' }] }
            : {}),
    };
}
