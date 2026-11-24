import type { Redis } from 'ioredis';
import type { Knex } from 'knex';
import {
    collectActivitySignals,
    collectDatabaseSignals,
    collectParticipantSignals,
    collectQueueSignals,
    type IdleSignalSource,
    type IdleSignals,
    type IdleWakeSupport,
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
    connectInFlight: () => number;
    /** Null without Connect intake. */
    connectIdleWakeSupport?: () => IdleWakeSupport | null;
    now?: () => number;
}

/**
 * The signals that show work to run (queued or running jobs, runs, goals,
 * handoffs, Ultrafix loops, and what is scheduled): what an idle stop must not
 * strand. They do not depend on the API and worker processes being up.
 */
export function createDaemonWorkSources(deps: Pick<DaemonIdleSourceDeps, 'redis' | 'database' | 'now'>): Record<string, IdleSignalSource> {
    const now = deps.now ?? Date.now;
    return {
        'BullMQ queues': () => collectQueueSignals(deps.redis),
        'database work': () => collectDatabaseSignals(deps.database),
        'Ultrafix loops': () => collectUltrafixSignals(deps.redis, now()),
    };
}

/** Every signal the daemon's idle detector reads, by name (the name shows up when one cannot be read). */
export function createDaemonIdleSources(deps: DaemonIdleSourceDeps): Record<string, IdleSignalSource> {
    const now = deps.now ?? Date.now;
    const work = createDaemonWorkSources(deps);
    return {
        'BullMQ queues': work['BullMQ queues'],
        // Every registered API/worker process must be observed: a stale entry is unavailable, not idle.
        'process registrations': async () => ({ unavailable: (await collectParticipantSignals(deps.redis, { now: now() })).unavailable }),
        'API activity': () => collectActivitySignals(deps.redis, { now: now() }),
        'database work': work['database work'],
        'Ultrafix loops': work['Ultrafix loops'],
        'Connect deliveries': async () => ({ connectDeliveries: deps.connectInFlight() }),
        // Retried after a reconnect: the relay may have gained idle wake support.
        'Connect idle wake': async () => (deps.connectIdleWakeSupport?.() === 'rejected'
            ? { unavailable: ['Connect idle wake support (the relay did not acknowledge the wake hint)'] }
            : {}),
        // Polling intake always blocks: its timer keeps its own cadence (set at startup, not at
        // this observation), so a deadline derived from `now()` would drift past the real next poll.
        'polling': async () => (deps.intakeMode === 'polling' ? { pollingIntake: true } : {}),
    };
}
