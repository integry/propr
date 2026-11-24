/**
 * The daemon's drain request to the other control-plane processes (issue
 * #3770). Pub/sub alone loses the request for a process that is
 * disconnected at that moment, so the request is also kept in Redis for as
 * long as the drain runs ({@link IDLE_SHUTDOWN_INTENT_REDIS_KEY}, refreshed
 * by the daemon), and every process acknowledges it in
 * `IDLE_SHUTDOWN_ACKS_REDIS_PREFIX<id>`. A process that reconnects, or polls,
 * finds the request and acknowledges it then.
 *
 * Two phases:
 *   - `quiesce`: API processes stop admitting requests and wait for the ones
 *     in flight, so no producer can queue work while the daemon re-checks.
 *     Only API processes acknowledge it. Withdrawing the request resumes them.
 *   - `stop`: every process runs its graceful shutdown and exits 0.
 */

import { randomUUID } from 'node:crypto';
import {
    IDLE_PARTICIPANTS_REDIS_KEY,
    IDLE_SHUTDOWN_ACKS_REDIS_PREFIX,
    IDLE_SHUTDOWN_CHANNEL,
    IDLE_SHUTDOWN_INTENT_REDIS_KEY,
} from '@propr/shared';
import {
    isIdleParticipantConfirmedGone,
    listIdleParticipants,
    localProcessIdentity,
    type IdleParticipantRole,
    type LocalProcessIdentity,
} from './idleParticipants.js';

export type IdleShutdownPhase = 'quiesce' | 'stop';

export interface IdleShutdownIntent {
    id: string;
    phase: IdleShutdownPhase;
    issuedAt: string;
    reason: string;
}

/** The intent disappears this long after the daemon stops refreshing it (e.g. it crashed). */
export const IDLE_INTENT_TTL_SECONDS = 120;
const ACK_TTL_SECONDS = 60 * 60;

export function newIdleShutdownIntent(phase: IdleShutdownPhase, reason: string, id: string = randomUUID()): IdleShutdownIntent {
    return { id, phase, issuedAt: new Date().toISOString(), reason };
}

export function parseIdleShutdownIntent(raw: string | null): IdleShutdownIntent | null {
    if (!raw) return null;
    try {
        const value = JSON.parse(raw) as Partial<IdleShutdownIntent>;
        if (typeof value.id !== 'string' || (value.phase !== 'quiesce' && value.phase !== 'stop')) return null;
        return {
            id: value.id,
            phase: value.phase,
            issuedAt: typeof value.issuedAt === 'string' ? value.issuedAt : new Date(0).toISOString(),
            reason: typeof value.reason === 'string' ? value.reason : 'idle',
        };
    } catch {
        return null;
    }
}

export function idleAckField(phase: IdleShutdownPhase, participantKey: string): string {
    return `${phase}:${participantKey}`;
}

export interface IntentRedis {
    set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>;
    get(key: string): Promise<string | null>;
    del(key: string): Promise<unknown>;
    publish(channel: string, message: string): Promise<unknown>;
    hset(key: string, field: string, value: string): Promise<unknown>;
    hdel(key: string, field: string): Promise<unknown>;
    hgetall(key: string): Promise<Record<string, string>>;
    expire(key: string, seconds: number): Promise<unknown>;
}

/** Persist, then announce. Rejects when the intent cannot be stored: the drain must not go on unrecorded. */
export async function issueIdleShutdownIntent(redis: Pick<IntentRedis, 'set' | 'publish'>, intent: IdleShutdownIntent): Promise<void> {
    await redis.set(IDLE_SHUTDOWN_INTENT_REDIS_KEY, JSON.stringify(intent), 'EX', IDLE_INTENT_TTL_SECONDS);
    // Delivery is best effort: processes also poll the stored intent.
    await redis.publish(IDLE_SHUTDOWN_CHANNEL, JSON.stringify(intent)).catch(() => undefined);
}

/** Abort a drain: API processes see the intent gone (or the message) and admit requests again. */
export async function withdrawIdleShutdownIntent(redis: Pick<IntentRedis, 'get' | 'del' | 'publish'>, intentId: string): Promise<void> {
    const current = parseIdleShutdownIntent(await redis.get(IDLE_SHUTDOWN_INTENT_REDIS_KEY).catch(() => null));
    if (!current || current.id === intentId) await redis.del(IDLE_SHUTDOWN_INTENT_REDIS_KEY).catch(() => undefined);
    await redis.publish(IDLE_SHUTDOWN_CHANNEL, JSON.stringify({ id: intentId, phase: 'resume' })).catch(() => undefined);
}

/** Record that this process has acted on `intent`. */
export async function acknowledgeIdleShutdownIntent(
    redis: Pick<IntentRedis, 'hset' | 'expire'>,
    intent: IdleShutdownIntent,
    participantKey: string,
): Promise<void> {
    const key = `${IDLE_SHUTDOWN_ACKS_REDIS_PREFIX}${intent.id}`;
    await redis.hset(key, idleAckField(intent.phase, participantKey), JSON.stringify({ at: new Date().toISOString() }));
    await redis.expire(key, ACK_TTL_SECONDS).catch(() => undefined);
}

export interface IdleAckProgress {
    confirmed: boolean;
    /** Registered processes that have not acknowledged yet. */
    pending: string[];
}

/** One look at who has acknowledged. Processes confirmed stopped are dropped from the registry. */
export async function readIdleAckProgress(
    redis: Pick<IntentRedis, 'hgetall' | 'hdel'>,
    intent: IdleShutdownIntent,
    options: { roles: readonly IdleParticipantRole[]; local?: LocalProcessIdentity; isGone?: (pid: number) => boolean },
): Promise<IdleAckProgress> {
    const acks = (await redis.hgetall(`${IDLE_SHUTDOWN_ACKS_REDIS_PREFIX}${intent.id}`)) ?? {};
    const local = options.local ?? localProcessIdentity();
    const pending: string[] = [];
    for (const { key, participant } of await listIdleParticipants(redis)) {
        if (participant && !options.roles.includes(participant.role)) continue;
        if (acks[idleAckField(intent.phase, key)] !== undefined) continue;
        if (participant && isIdleParticipantConfirmedGone(participant, local, options.isGone)) {
            await redis.hdel(IDLE_PARTICIPANTS_REDIS_KEY, key).catch(() => undefined);
            continue;
        }
        pending.push(key);
    }
    return { confirmed: pending.length === 0, pending };
}

/**
 * Wait until every registered process in `roles` has acknowledged `intent`
 * (or is confirmed stopped). While waiting the intent is re-stored and
 * re-announced, so a process that reconnects meanwhile still receives it.
 * `timeoutMs: null` waits until confirmed or `isCancelled()`.
 */
export async function waitForIdleAcks(
    redis: IntentRedis,
    intent: IdleShutdownIntent,
    options: {
        roles: readonly IdleParticipantRole[];
        timeoutMs: number | null;
        pollMs?: number;
        isCancelled?: () => boolean;
        onPending?: (pending: string[]) => void;
        local?: LocalProcessIdentity;
        isGone?: (pid: number) => boolean;
    },
): Promise<IdleAckProgress> {
    const pollMs = options.pollMs ?? 1_000;
    const deadline = options.timeoutMs === null ? Number.POSITIVE_INFINITY : Date.now() + options.timeoutMs;
    let progress: IdleAckProgress = { confirmed: false, pending: [] };
    for (;;) {
        try {
            progress = await readIdleAckProgress(redis, intent, options);
        } catch {
            progress = { confirmed: false, pending: progress.pending.length > 0 ? progress.pending : ['(acknowledgements unreadable)'] };
        }
        if (progress.confirmed || options.isCancelled?.() || Date.now() >= deadline) return progress;
        options.onPending?.(progress.pending);
        await new Promise(resolve => setTimeout(resolve, pollMs));
        await issueIdleShutdownIntent(redis, intent).catch(() => undefined);
    }
}
