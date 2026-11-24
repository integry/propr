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
 *   - `stop`: every targeted process runs its graceful shutdown and exits 0.
 *     The request names the participant generations registered when it was
 *     issued (`targets`: key + registration `startedAt`). A process that
 *     started later — a restart while a crashed daemon's request is still
 *     stored, or a new process during the drain — is not targeted and keeps
 *     running; a targeted process that merely reconnects still matches.
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

/** One participant generation a stop request is for; `startedAt` null when its entry was unreadable. */
export interface IdleShutdownTarget {
    key: string;
    startedAt: number | null;
}

export interface IdleShutdownIntent {
    id: string;
    phase: IdleShutdownPhase;
    issuedAt: string;
    reason: string;
    /** `stop` only: the participant generations it is for. A stop without targets stops nobody. */
    targets?: IdleShutdownTarget[];
}

function parseTargets(value: unknown): IdleShutdownTarget[] | undefined {
    if (!Array.isArray(value)) return undefined;
    return value.flatMap((entry: { key?: unknown; startedAt?: unknown } | null) => {
        if (!entry || typeof entry.key !== 'string') return [];
        const startedAt = typeof entry.startedAt === 'number' && Number.isFinite(entry.startedAt) ? entry.startedAt : null;
        return [{ key: entry.key, startedAt }];
    });
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
            ...(value.targets !== undefined ? { targets: parseTargets(value.targets) } : {}),
        };
    } catch {
        return null;
    }
}

/** The participant generations registered now in `roles`: the targets of a stop request. */
export async function listIdleShutdownTargets(
    redis: Pick<IntentRedis, 'hgetall'>,
    roles: readonly IdleParticipantRole[],
): Promise<IdleShutdownTarget[]> {
    return (await listIdleParticipants(redis))
        .filter(({ participant }) => !participant || roles.includes(participant.role))
        .map(({ key, participant }) => ({ key, startedAt: participant?.startedAt ?? null }));
}

/**
 * Whether `intent` is for the participant generation `key`/`startedAt`. A
 * quiesce is for every API process (one that starts mid-drain must quiesce
 * too); a stop only for the generations it names.
 */
export function isIdleShutdownTarget(intent: IdleShutdownIntent, key: string, startedAt: number): boolean {
    if (intent.phase !== 'stop') return true;
    return (intent.targets ?? []).some(target => target.key === key && (target.startedAt === null || target.startedAt === startedAt));
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
        // A stop is awaited only from the generations it names; a later one is not asked to stop.
        if (intent.phase === 'stop' && participant && !isIdleShutdownTarget(intent, key, participant.startedAt)) continue;
        if (intent.phase === 'stop' && !participant && !(intent.targets ?? []).some(target => target.key === key)) continue;
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
 * Settle `work` by the absolute `deadline` (epoch ms; null waits for it). The
 * work is not cancelled when the deadline wins: its result, or failure, is
 * then ignored. A failure before the deadline is rethrown.
 */
export async function beforeIdleDeadline<T>(work: Promise<T>, deadline: number | null): Promise<{ ok: true; value: T } | { ok: false }> {
    const outcome = work.then(value => ({ ok: true as const, value }), (error: unknown) => ({ ok: 'failed' as const, error }));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = deadline === null
        ? null
        : new Promise<{ ok: false }>(resolve => { timer = setTimeout(() => resolve({ ok: false }), Math.max(0, deadline - Date.now())); });
    const result = await (expired ? Promise.race([outcome, expired]) : outcome);
    clearTimeout(timer);
    if (result.ok === 'failed') throw result.error;
    return result;
}

/**
 * Wait until every registered process in `roles` has acknowledged `intent`
 * (or is confirmed stopped). While waiting the intent is re-stored and
 * re-announced, so a process that reconnects meanwhile still receives it.
 * `timeoutMs: null` waits until confirmed or `isCancelled()`.
 *
 * With a timeout, the confirmation must be read by the deadline: a read (or a
 * re-store) still outstanding then is not waited for, and a read that
 * completes after it does not count, even when it saw every acknowledgement.
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
    const deadline = options.timeoutMs === null ? null : Date.now() + options.timeoutMs;
    let progress: IdleAckProgress = { confirmed: false, pending: [] };
    const expired = (): IdleAckProgress => ({
        confirmed: false,
        pending: progress.pending.length > 0 ? progress.pending : ['(acknowledgements not read before the deadline)'],
    });
    for (;;) {
        let read: { ok: true; value: IdleAckProgress } | { ok: false };
        try {
            read = await beforeIdleDeadline(readIdleAckProgress(redis, intent, options), deadline);
        } catch {
            read = { ok: true, value: { confirmed: false, pending: progress.pending.length > 0 ? progress.pending : ['(acknowledgements unreadable)'] } };
        }
        if (!read.ok) return expired();
        // Read too late to count: the rest of the stop could no longer end in time.
        if (deadline !== null && Date.now() > deadline) return read.value.confirmed ? { confirmed: false, pending: ['(acknowledged after the deadline)'] } : read.value;
        progress = read.value;
        if (progress.confirmed || options.isCancelled?.()) return progress;
        options.onPending?.(progress.pending);
        await new Promise(resolve => setTimeout(resolve, deadline === null ? pollMs : Math.min(pollMs, Math.max(0, deadline - Date.now()))));
        if (deadline !== null && Date.now() >= deadline) return expired();
        // Cancelled during the pause (e.g. the drain was abandoned and withdrew the request): do not store it again.
        if (options.isCancelled?.()) return progress;
        await beforeIdleDeadline(issueIdleShutdownIntent(redis, intent).catch(() => undefined), deadline);
    }
}
