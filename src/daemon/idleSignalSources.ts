import type { Redis } from 'ioredis';
import type { Knex } from 'knex';
import {
    collectActivitySignals,
    collectDatabaseSignals,
    collectParticipantSignals,
    collectQueueSignals,
    idleActivity,
    idleParticipantKey,
    isIdleParticipantInThisProcess,
    type IdleActivityTracker,
    type IdleParticipant,
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
    /** The daemon runs in the composed (all-in-one) process, which closes every component together. */
    composed: boolean;
    connectInFlight: () => number;
    /** Null without Connect intake. */
    connectIdleWakeSupport?: () => IdleWakeSupport | null;
    /** Why nothing would wake the stopped instance for scheduled work; null when Connect or an external wake would. */
    scheduledWakeMissing?: () => string | null;
    /** Why this process could not stop its host (a Fly Machine without a stop token); null when it can. */
    hostStopProblem?: () => string | null;
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

/**
 * API activity: the record every API process publishes (open Web UI sessions,
 * requests in flight, the last request, one turned away while quiesced
 * included), and this process's own tracker. Composed, the API runs here, and
 * a request it just turned away counts at once, before its record reaches
 * Redis. The idle drain reads these again after it quiesced the API, right
 * before it asks every process to stop and once they have acknowledged.
 */
export function createDaemonActivitySources(deps: Pick<DaemonIdleSourceDeps, 'redis' | 'now'> & { local?: IdleActivityTracker }): Record<string, IdleSignalSource> {
    const now = deps.now ?? Date.now;
    const local = deps.local ?? idleActivity;
    return {
        'API activity': () => collectActivitySignals(deps.redis, { now: now() }),
        'API requests in this process': async () => {
            const { lastRequestAt } = local.snapshot();
            return lastRequestAt > 0 ? { lastActivityAt: lastRequestAt } : {};
        },
    };
}

/**
 * Idle shutdown stops only the composed process. Its participants exit with
 * it, so a stop that is called off (exit 1) restarts every one of them; a
 * process outside it exits 0 on its own and would stay stopped. So a
 * standalone daemon, and any live registration made outside this process,
 * blocks.
 */
export function separateProcessSignals(composed: boolean, participants: IdleParticipant[]): string[] {
    if (!composed) return ['the daemon runs as its own process: idle shutdown needs the single-process control plane (propr all-in-one)'];
    return participants
        .filter(participant => !isIdleParticipantInThisProcess(idleParticipantKey(participant.role, participant.id), participant.startedAt))
        .map(participant => `${idleParticipantKey(participant.role, participant.id)} runs outside the all-in-one process`);
}

/** Every signal the daemon's idle detector reads, by name (the name shows up when one cannot be read). */
export function createDaemonIdleSources(deps: DaemonIdleSourceDeps): Record<string, IdleSignalSource> {
    const now = deps.now ?? Date.now;
    const work = createDaemonWorkSources(deps);
    return {
        'BullMQ queues': work['BullMQ queues'],
        // Every registered API/worker process must be observed: a stale entry is unavailable, not idle.
        'process registrations': async () => {
            const { unavailable, participants } = await collectParticipantSignals(deps.redis, { now: now() });
            return { unavailable, separateProcesses: separateProcessSignals(deps.composed, participants) };
        },
        ...createDaemonActivitySources(deps),
        'database work': work['database work'],
        'Ultrafix loops': work['Ultrafix loops'],
        'Connect deliveries': async () => ({ connectDeliveries: deps.connectInFlight() }),
        // Retried after a reconnect: the relay may have gained idle wake support.
        'Connect idle wake': async () => (deps.connectIdleWakeSupport?.() === 'rejected'
            ? { unavailable: ['Connect idle wake support (the relay did not acknowledge the wake hint)'] }
            : {}),
        // A due time written to the wake hint file wakes nothing by itself: without Connect intake (or an external
        // scheduler the operator configured), scheduled work keeps the instance up however far off it is.
        'scheduled wake': async () => ({ scheduledWakeMissing: deps.scheduledWakeMissing?.() ?? null }),
        // An exit that cannot stop the host would leave it started and unreachable: worse than staying up.
        'host stop': async () => {
            const problem = deps.hostStopProblem?.() ?? null;
            return problem ? { unavailable: [problem] } : {};
        },
        // Polling intake always blocks: its timer keeps its own cadence (set at startup, not at
        // this observation), so a deadline derived from `now()` would drift past the real next poll.
        'polling': async () => (deps.intakeMode === 'polling' ? { pollingIntake: true } : {}),
    };
}
