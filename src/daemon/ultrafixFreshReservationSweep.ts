import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import {
    abortFreshUltrafixTransition,
    listFreshUltrafixReservationKeys,
    loadFreshUltrafixReservation,
    parseFreshUltrafixReservationKey,
} from '../jobs/ultrafixFreshTransitionStore.js';

const DEFAULT_ORPHAN_GRACE_MS = 5 * 60 * 1000;

interface FreshReservationSweepDeps {
    getJob: (jobId: string) => Promise<unknown | null | undefined>;
    withLease: <T>(
        redis: Redis,
        identity: { owner: string; repo: string; pr: number },
        correlationId: string,
        operation: (assertOwned: () => Promise<void>) => Promise<T>,
    ) => Promise<T>;
    createLogger: () => Logger;
    generateCorrelationId: () => string;
    warn: (error: Error) => void;
    now?: () => number;
    orphanGraceMs?: number;
}

async function abortOrphanedReservation(
    redis: Redis,
    identity: { owner: string; repo: string; pr: number },
    deps: FreshReservationSweepDeps,
): Promise<boolean> {
    const reservation = await loadFreshUltrafixReservation(redis, identity);
    if (!reservation || await deps.getJob(reservation.startupJobId)) return false;
    const ageMs = (deps.now?.() ?? Date.now()) - reservation.createdAt;
    if (ageMs < (deps.orphanGraceMs ?? DEFAULT_ORPHAN_GRACE_MS)) return false;

    return deps.withLease(
        redis,
        identity,
        deps.generateCorrelationId(),
        async assertOwned => {
            await assertOwned();
            const current = await loadFreshUltrafixReservation(redis, identity);
            if (!current
                || current.commandSequence !== reservation.commandSequence
                || current.startupJobId !== reservation.startupJobId
                || await deps.getJob(current.startupJobId)) {
                return false;
            }
            return abortFreshUltrafixTransition(
                redis, identity, current.commandSequence,
            );
        },
    );
}

export async function sweepFreshUltrafixReservations(
    redis: Redis,
    deps: FreshReservationSweepDeps,
): Promise<void> {
    let keys: string[];
    try {
        keys = await listFreshUltrafixReservationKeys(redis);
    } catch (error) {
        deps.warn(error as Error);
        return;
    }
    for (const key of keys) {
        const identity = parseFreshUltrafixReservationKey(key);
        if (!identity) continue;
        try {
            if (await abortOrphanedReservation(redis, identity, deps)) {
                deps.createLogger().warn(
                    identity,
                    'Aborted orphaned fresh Ultrafix reservation with no durable startup job',
                );
            }
        } catch (error) {
            deps.warn(error as Error);
        }
    }
}

export async function scheduleFreshUltrafixReservationSweep(
    redis: Redis,
    deps: FreshReservationSweepDeps,
    intervalMs = 60_000,
): Promise<NodeJS.Timeout> {
    await sweepFreshUltrafixReservations(redis, deps);
    const interval = setInterval(() => {
        void sweepFreshUltrafixReservations(redis, deps);
    }, intervalMs);
    interval.unref();
    return interval;
}
