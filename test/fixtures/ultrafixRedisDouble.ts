/**
 * In-memory Redis double for the Ultrafix recovery suites.
 *
 * It interprets the Lua scripts of the Ultrafix epoch, deferred-record,
 * state, retry-obligation and resume-claim modules, so every suite exercises
 * the same reading of each script and a script change is mirrored in one
 * place. Scripts are told apart by their `-- marker` comment where they carry
 * one, otherwise by a distinguishing call. The real-Redis suite
 * (`ultrafixRecoveryRedisIntegration.test.ts`) runs the scripts themselves
 * and stays the independent check of this reading.
 */

export type UltrafixScriptResult = number | number[];

/** Takeover-marker TTL the comment invalidation script must be given. */
const MANUAL_TAKEOVER_TTL_SECONDS = String(24 * 60 * 60);

function epochOf(store: Map<string, string>, epochKey: string): string {
    return store.get(epochKey) ?? '0';
}

/** Epoch- and comment-revision-idempotent invalidation (`invalidateUltrafixAutomaticWorkForComment`). */
function invalidateForComment(store: Map<string, string>, args: string[]): number[] {
    const [epochKey, deferredKey, stateKey, takeoverKey, ttl] = args;
    if (ttl !== MANUAL_TAKEOVER_TTL_SECONDS) throw new Error(`unexpected takeover TTL ${ttl}`);
    const existing = store.get(takeoverKey);
    if (existing) return existing.split(':').map(Number);

    const currentEpoch = Number(epochOf(store, epochKey));
    const rawState = store.get(stateKey);
    let hadAutomaticWork = store.has(deferredKey);
    if (!hadAutomaticWork && rawState) {
        try {
            const state = JSON.parse(rawState) as { active?: unknown; workEpoch?: unknown };
            const stateEpoch = typeof state.workEpoch === 'number' ? state.workEpoch : 0;
            hadAutomaticWork = state.active === true && stateEpoch === currentEpoch;
        } catch {
            hadAutomaticWork = currentEpoch === 0;
        }
    }
    const nextEpoch = currentEpoch + 1;
    store.set(epochKey, String(nextEpoch));
    store.delete(deferredKey);
    store.set(takeoverKey, `${nextEpoch}:${hadAutomaticWork ? 1 : 0}`);
    return [nextEpoch, hadAutomaticWork ? 1 : 0];
}

type ScriptHandler = (store: Map<string, string>, args: string[], script: string) => UltrafixScriptResult;

/** Ordered: the first handler whose marker the script contains runs it. */
const HANDLERS: Array<[marker: string, handler: ScriptHandler]> = [
    ['-- clear rearm retry if claim held', (store, args) => {
        const [claimKey, retryKey, epochKey, token, expectedEpoch, expectedRetry, checkRetry] = args;
        if (store.get(claimKey) !== token) return 0;
        if (expectedEpoch !== '' && epochOf(store, epochKey) !== expectedEpoch) return -1;
        if (checkRetry === '1' && (store.get(retryKey) ?? '') !== expectedRetry) return -2;
        store.delete(retryKey);
        return 1;
    }],
    ['-- save rearm retry unless claim taken', (store, args) => {
        const [claimKey, retryKey, token, value, , expectedRetry, checkRetry] = args;
        const holder = store.get(claimKey);
        if (holder !== undefined && holder !== token) return 0;
        if (checkRetry === '1' && (store.get(retryKey) ?? '') !== expectedRetry) return -2;
        store.set(retryKey, value);
        return 1;
    }],
    ['-- record failed ultrafix step', (store, args) => {
        const [epochKey, stateKey, retryKey, expectedEpoch, expectedState, value, expectedRetry, retry] = args;
        if (epochOf(store, epochKey) !== expectedEpoch) return 0;
        if (store.get(stateKey) !== expectedState) return 0;
        if ((store.get(retryKey) ?? '') !== expectedRetry) return 0;
        store.set(stateKey, value);
        store.set(retryKey, retry);
        return 1;
    }],
    ['-- commit started loop state', (store, args) => {
        const [epochKey, stateKey, retryKey, expectedEpoch, value] = args;
        if (epochOf(store, epochKey) !== expectedEpoch) return 0;
        store.set(stateKey, value);
        store.delete(retryKey);
        return 1;
    }],
    ['-- restore deferred if loop unchanged', (store, args) => {
        const [epochKey, stateKey, deferredKey, expectedEpoch, expectedState, value] = args;
        if (epochOf(store, epochKey) !== expectedEpoch) return 0;
        if (store.get(stateKey) !== expectedState) return 0;
        if (store.has(deferredKey)) return 0;
        store.set(deferredKey, value);
        return 1;
    }],
    ['-- reserve epoch and replace state', (store, args) => {
        const [epochKey, stateKey, deferredKey, expectedEpoch, expectedState, value] = args;
        if (epochOf(store, epochKey) !== expectedEpoch) return 0;
        if (store.get(stateKey) !== expectedState) return 0;
        const next = Number(expectedEpoch) + 1;
        store.set(epochKey, String(next));
        store.delete(deferredKey);
        store.set(stateKey, value);
        return next;
    }],
    // Token-checked renewal of the resume claim.
    ["redis.call('PEXPIRE'", (store, [claimKey, token]) => (store.get(claimKey) === token ? 1 : 0)],
    // Compare-and-delete: claim release, or claiming an unchanged deferred record.
    ["redis.call('DEL', KEYS[1])", (store, [key, expected]) => (store.get(key) === expected && store.delete(key) ? 1 : 0)],
    ["local existing = redis.call('GET', KEYS[4])", invalidateForComment],
    // Epoch- and snapshot-conditional state replace/clear.
    ['local current_state', (store, args, script) => {
        const [epochKey, stateKey, expectedEpoch, expectedState, value] = args;
        if (epochOf(store, epochKey) !== expectedEpoch) return 0;
        if (store.get(stateKey) !== expectedState) return 0;
        if (script.includes("redis.call('DEL', KEYS[2])")) store.delete(stateKey);
        else store.set(stateKey, value);
        return 1;
    }],
    // Plain invalidation: next epoch, deferred record dropped.
    ["redis.call('INCR'", (store, [epochKey, deferredKey]) => {
        const next = Number(epochOf(store, epochKey)) + 1;
        store.set(epochKey, String(next));
        store.delete(deferredKey);
        return next;
    }],
];

/** Epoch-conditional save or clear of one key (deferred record or state). */
function saveOrClearIfCurrent(store: Map<string, string>, args: string[], script: string): number {
    const [epochKey, targetKey, expectedEpoch, value] = args;
    if (epochOf(store, epochKey) !== expectedEpoch) return 0;
    if (script.includes("redis.call('DEL', KEYS[2])")) store.delete(targetKey);
    else store.set(targetKey, value);
    return 1;
}

/** Run one Ultrafix script against `store`, as Redis would. */
export function evalUltrafixScript(store: Map<string, string>, script: string, args: string[]): UltrafixScriptResult {
    const match = HANDLERS.find(([marker]) => script.includes(marker));
    return match ? match[1](store, args, script) : saveOrClearIfCurrent(store, args, script);
}

/** A Redis double with plain key/value commands and every Ultrafix script. */
export function createUltrafixRedis() {
    const store = new Map<string, string>();
    return {
        store,
        async get(key: string) { return store.get(key) ?? null; },
        async set(key: string, value: string, ...options: Array<string | number>) {
            if (options.includes('NX') && store.has(key)) return null;
            store.set(key, value);
            return 'OK';
        },
        async del(key: string) { return store.delete(key) ? 1 : 0; },
        async getdel(key: string) {
            const value = store.get(key) ?? null;
            store.delete(key);
            return value;
        },
        async eval(script: string, _keyCount: number, ...args: string[]): Promise<UltrafixScriptResult> {
            return evalUltrafixScript(store, script, args);
        },
        async llen(_key: string) { return 0; },
        async scan(_cursor: string, _match: string, pattern: string): Promise<[string, string[]]> {
            const prefix = pattern.replace(/\*$/, '');
            return ['0', [...store.keys()].filter(key => key.startsWith(prefix))];
        },
    };
}

export type UltrafixRedisDouble = ReturnType<typeof createUltrafixRedis>;

/** Adds the resume index set (and a scan counter) to a double. */
export function withResumeIndex<T extends UltrafixRedisDouble>(redis: T) {
    const index = new Set<string>();
    const evaluate = redis.eval.bind(redis);
    const scan = redis.scan.bind(redis);
    const scans = { count: 0 };
    return Object.assign(redis, {
        index,
        scans,
        async sadd(_key: string, member: string) { const had = index.has(member); index.add(member); return had ? 0 : 1; },
        async smembers(_key: string) { return [...index]; },
        async srem(_key: string, member: string) { return index.delete(member) ? 1 : 0; },
        async scan(...args: [string, string, string]) { scans.count++; return scan(...args); },
        async eval(script: string, keyCount: number, ...args: string[]) {
            if (script.includes('-- prune resume index entry')) {
                const [, deferredKey, retryKey, member] = args;
                if (redis.store.has(deferredKey) || redis.store.has(retryKey)) return 0;
                return index.delete(member) ? 1 : 0;
            }
            return evaluate(script, keyCount, ...args);
        },
    });
}
