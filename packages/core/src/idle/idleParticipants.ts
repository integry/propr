/**
 * The processes idle shutdown must hear from (issue #3770). Every API and
 * worker process registers in {@link IDLE_PARTICIPANTS_REDIS_KEY}, refreshes
 * its entry while it runs and removes it on a clean stop. The daemon then
 * knows which observations it expects: an entry without a fresh heartbeat is
 * unavailable evidence, not idleness, until the process is confirmed stopped
 * (it removed itself, or the daemon can see on the same host that its pid is
 * gone).
 */

import { readFileSync, readlinkSync } from 'node:fs';
import { hostname } from 'node:os';
import { IDLE_PARTICIPANTS_REDIS_KEY } from '@propr/shared';

export type IdleParticipantRole = 'api' | 'worker' | 'indexing_worker';

export interface IdleParticipant {
    role: IdleParticipantRole;
    id: string;
    host: string;
    pid: number;
    /** `/proc/self/ns/pid` and the kernel boot id; a pid check is only valid when both match. */
    pidNamespace: string | null;
    bootId: string | null;
    startedAt: number;
    seenAt: number;
}

/** Refresh interval of a participant's entry. */
export const IDLE_PARTICIPANT_HEARTBEAT_MS = 15_000;
/** An entry (or API activity record) older than this is not a current observation. */
export const IDLE_PARTICIPANT_STALE_MS = 3 * IDLE_PARTICIPANT_HEARTBEAT_MS;

export interface ParticipantRedis {
    hset(key: string, field: string, value: string): Promise<unknown>;
    hdel(key: string, field: string): Promise<unknown>;
    hgetall(key: string): Promise<Record<string, string>>;
}

export function idleParticipantKey(role: string, id: string): string {
    return `${role}:${id}`;
}

function readQuietly(read: () => string): string | null {
    try {
        return read().trim() || null;
    } catch {
        return null;
    }
}

export interface LocalProcessIdentity {
    host: string;
    pidNamespace: string | null;
    bootId: string | null;
}

export function localProcessIdentity(): LocalProcessIdentity {
    return {
        host: hostname(),
        pidNamespace: readQuietly(() => readlinkSync('/proc/self/ns/pid')),
        bootId: readQuietly(() => readFileSync('/proc/sys/kernel/random/boot_id', 'utf8')),
    };
}

const ROLES: readonly IdleParticipantRole[] = ['api', 'worker', 'indexing_worker'];

export function parseIdleParticipant(raw: string | undefined): IdleParticipant | null {
    if (!raw) return null;
    try {
        const value = JSON.parse(raw) as Partial<IdleParticipant>;
        const finite = (field: unknown): field is number => typeof field === 'number' && Number.isFinite(field);
        if (!ROLES.includes(value.role as IdleParticipantRole) || typeof value.id !== 'string' || typeof value.host !== 'string') return null;
        if (!finite(value.pid) || !finite(value.startedAt) || !finite(value.seenAt)) return null;
        return {
            role: value.role as IdleParticipantRole,
            id: value.id,
            host: value.host,
            pid: value.pid,
            pidNamespace: typeof value.pidNamespace === 'string' ? value.pidNamespace : null,
            bootId: typeof value.bootId === 'string' ? value.bootId : null,
            startedAt: value.startedAt,
            seenAt: value.seenAt,
        };
    } catch {
        return null;
    }
}

export interface IdleParticipantEntry {
    /** Hash field, `<role>:<id>`. */
    key: string;
    /** Null when the entry cannot be parsed; it still counts as expected. */
    participant: IdleParticipant | null;
}

export async function listIdleParticipants(redis: Pick<ParticipantRedis, 'hgetall'>): Promise<IdleParticipantEntry[]> {
    const raw = (await redis.hgetall(IDLE_PARTICIPANTS_REDIS_KEY)) ?? {};
    return Object.entries(raw).map(([key, value]) => ({ key, participant: parseIdleParticipant(value) }));
}

function pidIsGone(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return false;
    } catch (error) {
        // EPERM means the pid exists but belongs to someone else: not gone.
        return (error as NodeJS.ErrnoException).code === 'ESRCH';
    }
}

/**
 * Whether the daemon can confirm the process has stopped. Only on the same
 * host, kernel boot and pid namespace is a pid lookup meaningful; elsewhere
 * a missing heartbeat stays unconfirmed. A reused pid reads as alive, which
 * errs on the side of staying awake.
 */
export function isIdleParticipantConfirmedGone(
    participant: IdleParticipant,
    local: LocalProcessIdentity = localProcessIdentity(),
    isGone: (pid: number) => boolean = pidIsGone,
): boolean {
    if (participant.host !== local.host) return false;
    if (!participant.pidNamespace || participant.pidNamespace !== local.pidNamespace) return false;
    if (!participant.bootId || participant.bootId !== local.bootId) return false;
    return isGone(participant.pid);
}

export function isIdleParticipantFresh(participant: IdleParticipant, now: number): boolean {
    return now - participant.seenAt <= IDLE_PARTICIPANT_STALE_MS;
}

export interface IdleParticipantRegistration {
    key: string;
    participant: IdleParticipant;
    /** Remove the entry: this process is confirmed stopped. */
    stop: () => Promise<void>;
}

/** Register this process and keep its entry fresh until `stop`. */
export function registerIdleParticipant(
    redis: Pick<ParticipantRedis, 'hset' | 'hdel'>,
    options: { role: IdleParticipantRole; id: string; intervalMs?: number; now?: () => number },
): IdleParticipantRegistration {
    const now = options.now ?? Date.now;
    const local = localProcessIdentity();
    const participant: IdleParticipant = {
        role: options.role,
        id: options.id,
        host: local.host,
        pid: process.pid,
        pidNamespace: local.pidNamespace,
        bootId: local.bootId,
        startedAt: now(),
        seenAt: now(),
    };
    const key = idleParticipantKey(options.role, options.id);
    let stopped = false;
    const refresh = () => {
        if (stopped) return Promise.resolve();
        participant.seenAt = now();
        // A failed refresh leaves the entry stale, which the daemon reads as "not idle".
        return redis.hset(IDLE_PARTICIPANTS_REDIS_KEY, key, JSON.stringify(participant)).then(() => undefined, () => undefined);
    };
    void refresh();
    const timer = setInterval(() => { void refresh(); }, options.intervalMs ?? IDLE_PARTICIPANT_HEARTBEAT_MS);
    timer.unref?.();
    return {
        key,
        participant,
        stop: async () => {
            stopped = true;
            clearInterval(timer);
            await redis.hdel(IDLE_PARTICIPANTS_REDIS_KEY, key).catch(() => undefined);
        },
    };
}

/**
 * The registry as idle evidence: every entry must be parseable and fresh.
 * Entries the daemon confirms stopped are removed. Returns what cannot be
 * observed, plus the live entries for callers that need them.
 */
export async function collectParticipantSignals(
    redis: ParticipantRedis,
    options: { now: number; local?: LocalProcessIdentity; isGone?: (pid: number) => boolean },
): Promise<{ unavailable: string[]; participants: IdleParticipant[] }> {
    const unavailable: string[] = [];
    const participants: IdleParticipant[] = [];
    const local = options.local ?? localProcessIdentity();
    for (const { key, participant } of await listIdleParticipants(redis)) {
        if (!participant) {
            unavailable.push(`the registration of ${key} (malformed)`);
            continue;
        }
        if (isIdleParticipantFresh(participant, options.now)) {
            participants.push(participant);
            continue;
        }
        if (isIdleParticipantConfirmedGone(participant, local, options.isGone)) {
            await redis.hdel(IDLE_PARTICIPANTS_REDIS_KEY, key).catch(() => undefined);
            continue;
        }
        unavailable.push(`${key} (no heartbeat for ${Math.round((options.now - participant.seenAt) / 1000)}s)`);
    }
    return { unavailable, participants };
}
