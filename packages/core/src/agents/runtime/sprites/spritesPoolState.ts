/**
 * The shared Sprites runner pool's lease state and its transitions.
 *
 * Every worker using one Sprites organization token reads and changes the same
 * state (in Redis, see `spritesPoolStore.ts`). The functions here are pure: a
 * store applies one of them atomically to the current state and writes back
 * what it changed, so the in-memory store and the Redis store share one
 * definition of who may lease, provision or reap a runner.
 *
 * A runner record exists before its Sprite does: a worker inserts the record
 * (state `provisioning`) and only then creates the Sprite. A `propr-` Sprite of
 * this pool with no record is therefore never one a live worker is creating,
 * which makes reaping it safe.
 */

export type SpriteRunnerState =
    /** Being created and checkpointed by its lease holder. */
    | 'provisioning'
    /** At its baseline checkpoint, free to lease. */
    | 'idle'
    /** Running (or holding the result of) one run. */
    | 'leased'
    /** Its lease holder is restoring it after a run. */
    | 'resetting'
    /** A run settled and its holder has not released it yet (results may still be read). */
    | 'finished'
    /** Its holder stopped heartbeating mid-lease: the Sprite is deleted before its slot is reused. */
    | 'orphaned'
    /** A lease holder is deleting it. */
    | 'reaping'
    /** Its holder stopped heartbeating after the run settled without a release: the only copy of a result may be on it. Never reaped automatically. */
    | 'retained';

export interface SpriteRunnerRecord {
    state: SpriteRunnerState;
    leaseId?: string;
    owner?: string;
    /** The worker that last held (or provisioned) it. */
    lastOwner?: string;
    heartbeatAt: number;
    /** When it entered its current state. */
    since: number;
    /** The clean setup checkpoint. */
    checkpoint?: string;
    /** Per-repository warm clone baseline, when its idle baseline is not the clean checkpoint. */
    warm?: { repo: string; checkpoint: string };
    runs: number;
    /** Duration of the last checkpoint restore, in milliseconds. */
    lastRestoreMs?: number;
    provisionMs?: number;
}

export interface SpriteWaiter { joinedAt: number; seenAt: number }

export interface SpritePoolState {
    runners: Map<string, SpriteRunnerRecord>;
    waiting: Map<string, SpriteWaiter>;
}

const HELD: ReadonlySet<SpriteRunnerState> = new Set(['provisioning', 'leased', 'resetting', 'finished', 'reaping']);

export function emptySpritePoolState(): SpritePoolState {
    return { runners: new Map(), waiting: new Map() };
}

export function cloneSpritePoolState(state: SpritePoolState): SpritePoolState {
    return {
        runners: new Map([...state.runners].map(([name, record]) => [name, structuredClone(record)])),
        waiting: new Map([...state.waiting].map(([id, waiter]) => [id, { ...waiter }])),
    };
}

/** The state a runner whose holder stopped heartbeating is in, or its own state when it is still held or free. */
export function effectiveRunnerState(record: SpriteRunnerRecord, now: number, ttlMs: number): SpriteRunnerState {
    if (!HELD.has(record.state) || record.heartbeatAt + ttlMs >= now) return record.state;
    return record.state === 'finished' ? 'retained' : 'orphaned';
}

/** Applies lapsed heartbeats: runners of dead holders become orphaned (or retained), dead waiters leave the queue. */
export function expireSpritePool(state: SpritePoolState, now: number, ttlMs: number): void {
    for (const record of state.runners.values()) {
        const effective = effectiveRunnerState(record, now, ttlMs);
        if (effective === record.state) continue;
        record.state = effective;
        record.since = now;
        delete record.leaseId;
        delete record.owner;
    }
    for (const [id, waiter] of state.waiting) if (waiter.seenAt + ttlMs < now) state.waiting.delete(id);
}

export interface SpriteLeaseRequest {
    leaseId: string;
    owner: string;
    /** Bound on the pool's runners (PROPR_SPRITES_MAX, at most the organization limit). */
    max: number;
    /** Warm clone key of the run's repository, when warm clones are on. */
    repo?: string;
    /** Name of the Sprite to create if this request provisions. */
    newName: string;
    now: number;
    ttlMs: number;
}

export type SpriteLeaseDecision =
    | { action: 'lease'; name: string; record: SpriteRunnerRecord }
    | { action: 'provision'; name: string; record: SpriteRunnerRecord }
    | { action: 'reap'; name: string; record: SpriteRunnerRecord }
    | { action: 'wait'; position: number; runners: number };

function claim(record: SpriteRunnerRecord, state: SpriteRunnerState, holder: { leaseId: string; owner: string; now: number }) {
    const { leaseId, owner, now } = holder;
    Object.assign(record, { state, leaseId, owner, lastOwner: owner, heartbeatAt: now, since: now });
}

/**
 * One acquisition attempt. Requests are served in the order they first asked
 * (FIFO): a request leases, provisions or reaps only while fewer requests are
 * ahead of it than there are runners it could get. An idle runner warm for the
 * run's repository is preferred, then a clean one.
 */
export function acquireSpriteRunner(state: SpritePoolState, request: SpriteLeaseRequest): SpriteLeaseDecision {
    const { leaseId, owner, now, ttlMs } = request;
    expireSpritePool(state, now, ttlMs);
    const waiter = state.waiting.get(leaseId);
    if (waiter) waiter.seenAt = now;
    else state.waiting.set(leaseId, { joinedAt: now, seenAt: now });
    const runners = [...state.runners];
    const idle = runners.filter(([, record]) => record.state === 'idle');
    const orphans = runners.filter(([, record]) => record.state === 'orphaned');
    const free = Math.max(0, request.max - runners.length);
    const queue = [...state.waiting].sort(([a, x], [b, y]) => x.joinedAt - y.joinedAt || a.localeCompare(b));
    const position = queue.findIndex(([id]) => id === leaseId);
    if (position >= idle.length + orphans.length + free) return { action: 'wait', position, runners: runners.length };
    const leave = () => state.waiting.delete(leaseId);
    if (idle.length) {
        const [name, record] = idle.find(([, r]) => request.repo && r.warm?.repo === request.repo)
            ?? idle.find(([, r]) => !r.warm) ?? idle[0];
        claim(record, 'leased', request);
        leave();
        return { action: 'lease', name, record: structuredClone(record) };
    }
    if (free) {
        const record: SpriteRunnerRecord = { state: 'provisioning', leaseId, owner, lastOwner: owner, heartbeatAt: now, since: now, runs: 0 };
        state.runners.set(request.newName, record);
        leave();
        return { action: 'provision', name: request.newName, record: structuredClone(record) };
    }
    // Reaping frees a slot for this request, which stays first in line for it.
    const [name, record] = orphans[0];
    claim(record, 'reaping', request);
    return { action: 'reap', name, record: structuredClone(record) };
}

/** Keeps a holder's runners and its place in the queue alive. */
export function heartbeatSpriteLease(state: SpritePoolState, leaseId: string, now: number): void {
    for (const record of state.runners.values()) if (record.leaseId === leaseId) record.heartbeatAt = now;
    const waiter = state.waiting.get(leaseId);
    if (waiter) waiter.seenAt = now;
}

export function leaveSpriteQueue(state: SpritePoolState, leaseId: string): void {
    state.waiting.delete(leaseId);
}

/** Changes a held runner; false when the lease no longer holds it. */
/** Identifies a held runner and the time of the change. */
export interface SpriteRunnerLease { name: string; leaseId: string; now: number }

export function updateSpriteRunner(state: SpritePoolState, { name, leaseId, now }: SpriteRunnerLease, patch: Partial<SpriteRunnerRecord>): boolean {
    const record = state.runners.get(name);
    if (!record || record.leaseId !== leaseId) return false;
    Object.assign(record, patch, { heartbeatAt: now });
    if (patch.state) record.since = now;
    return true;
}

/** Swaps a held runner's record for a new Sprite name (its old Sprite is gone), keeping the slot. */
export function replaceSpriteRunner(state: SpritePoolState, { name, leaseId, now }: SpriteRunnerLease, newName: string): boolean {
    const record = state.runners.get(name);
    if (!record || record.leaseId !== leaseId) return false;
    state.runners.delete(name);
    state.runners.set(newName, { state: 'provisioning', leaseId, owner: record.owner, lastOwner: record.owner, heartbeatAt: now, since: now, runs: record.runs });
    return true;
}

export type SpriteReleaseOutcome = 'idle' | 'discard' | 'lost';

/**
 * Returns a restored runner to the pool. `discard` when the pool holds more
 * runners than its bound (the bound was lowered): the caller deletes the
 * Sprite, whose record is already gone. `lost` when the lease lapsed and the
 * runner was taken over for reaping.
 */
export function releaseSpriteRunner(state: SpritePoolState, { name, leaseId, now, max }: SpriteRunnerLease & { max: number }, patch: Partial<SpriteRunnerRecord>): SpriteReleaseOutcome {
    const record = state.runners.get(name);
    if (!record || record.leaseId !== leaseId) return 'lost';
    if (state.runners.size > max) {
        state.runners.delete(name);
        return 'discard';
    }
    Object.assign(record, patch, { state: 'idle', heartbeatAt: now, since: now });
    delete record.leaseId;
    delete record.owner;
    if (!patch.warm) delete record.warm;
    return 'idle';
}

/**
 * Removes a runner whose Sprite is gone: a held one by its lease holder, or
 * (without a lease) one that is free, orphaned or retained and was found missing.
 */
export function forgetSpriteRunner(state: SpritePoolState, name: string, leaseId?: string): boolean {
    const record = state.runners.get(name);
    if (!record) return false;
    const allowed = leaseId ? record.leaseId === leaseId : ['idle', 'orphaned', 'retained'].includes(record.state);
    if (allowed) state.runners.delete(name);
    return allowed;
}

/** Takes runners in one of `states` (and, when given, last held by `lastOwner`) for deletion by `leaseId`. */
export function claimSpriteRunners(state: SpritePoolState, request: { leaseId: string; owner: string; states: SpriteRunnerState[]; lastOwner?: string; now: number; ttlMs: number }): Array<[string, SpriteRunnerRecord]> {
    expireSpritePool(state, request.now, request.ttlMs);
    const claimed: Array<[string, SpriteRunnerRecord]> = [];
    for (const [name, record] of state.runners) {
        if (!request.states.includes(record.state)) continue;
        if (request.lastOwner && record.lastOwner !== request.lastOwner) continue;
        claim(record, 'reaping', request);
        claimed.push([name, structuredClone(record)]);
    }
    return claimed;
}

/** Puts back a runner whose deletion failed: it stays counted, orphaned, for a later reap. */
export function abandonSpriteRunner(state: SpritePoolState, name: string, leaseId: string, now: number): void {
    const record = state.runners.get(name);
    if (!record || record.leaseId !== leaseId) return;
    record.state = 'orphaned';
    record.since = now;
    delete record.leaseId;
    delete record.owner;
}
