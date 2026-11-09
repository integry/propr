// Not imported from the module: importing it here would load the real Redis config before a suite mocks it.
const COMPLETION_KEY_PREFIX = 'issue:no-change-completions:';
const REQUEST_KEY_PREFIX = 'issue:no-change-request:';
const ORDER_KEY_PREFIX = 'issue:no-change-request-order:';
const SEQUENCE_FIELD = '#sequence';

/**
 * An in-memory stand-in for the Redis commands the no-change completion
 * obligation uses: per-issue hashes changed by its compare-and-set script,
 * request-generation keys taken by its ordered admission script, per-issue
 * request-order hashes, and SCAN over the completion prefix.
 * Other scripts (repository workflow admission) succeed.
 */
export function createNoChangeCompletionStoreDouble() {
    const hashes = new Map<string, Map<string, string>>();
    const strings = new Map<string, string>();
    const ttls = new Map<string, number>();
    /** Each issue's request order: request ID to ordinal, plus the counter. */
    const orders = new Map<string, Map<string, string>>();
    return {
        hashes, strings, ttls, orders,
        clear() { hashes.clear(); strings.clear(); ttls.clear(); orders.clear(); },
        /** Every retained completion, across issues. */
        records(): Array<Record<string, unknown>> {
            return [...hashes.values()].flatMap(fields => [...fields.values()].map(raw => JSON.parse(raw) as Record<string, unknown>));
        },
        get: async (key: string) => strings.get(key) ?? null,
        set: async (key: string, value: string, mode?: string, seconds?: number) => {
            strings.set(key, value);
            if (mode === 'EX') ttls.set(key, Number(seconds)); else ttls.delete(key);
            return 'OK';
        },
        hgetall: async (key: string) => Object.fromEntries(hashes.get(key) ?? []),
        eval: async (script: string, keys: number, ...args: Array<string | number>) => {
            const [key, field, expected, next, seconds, extra] = args.map(String);
            /** The request's ordinal in an issue's order hash, assigned on first sight. */
            const ordinalOf = (orderKey: string, request: string) => {
                const order = orders.get(orderKey) ?? new Map<string, string>();
                if (!order.has(request)) {
                    const sequence = Number(order.get(SEQUENCE_FIELD) ?? 0) + 1;
                    order.set(SEQUENCE_FIELD, String(sequence));
                    order.set(request, String(sequence));
                }
                orders.set(orderKey, order);
                return Number(order.get(request));
            };
            if (key.startsWith(ORDER_KEY_PREFIX) && Number(keys) === 1) {
                // Registration: KEYS = order; ARGV = request, TTL.
                if (!script.includes('HINCRBY')) throw new Error('Unexpected registration script');
                return ordinalOf(key, field);
            }
            if (key.startsWith(REQUEST_KEY_PREFIX) && Number(keys) === 2) {
                // Admission: KEYS = generation, order; ARGV = request, TTL.
                if (!script.includes("redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])")) throw new Error('Unexpected admission script');
                const [orderKey, request, ttl] = [field, expected, next];
                const ordinal = ordinalOf(orderKey, request);
                const holder = strings.get(key);
                const newest = holder === undefined ? undefined : orders.get(orderKey)?.get(holder);
                if (holder !== undefined && holder !== request && newest !== undefined && Number(newest) > ordinal) return 0;
                strings.set(key, request);
                ttls.set(key, Number(ttl));
                return 1;
            }
            if (!key.startsWith(COMPLETION_KEY_PREFIX)) return 1;
            if (Number(keys) === 3) {
                // Admission's drop: KEYS = hash, generation, order; ARGV = field, expected, admitting request, record's request.
                if (!script.includes("redis.call('GET', KEYS[2]) ~= ARGV[3]")) throw new Error('Unexpected admission drop script');
                const [requestKeyName, orderKey, recordId, held, admitting, recorded] = [field, expected, next, seconds, extra, String(args[6])];
                if (strings.get(requestKeyName) !== admitting) return -1;
                const order = orders.get(orderKey);
                const [admittingOrdinal, recordedOrdinal] = [order?.get(admitting), order?.get(recorded)];
                if (admittingOrdinal !== undefined && recordedOrdinal !== undefined && Number(recordedOrdinal) > Number(admittingOrdinal)) return 0;
                const fields = hashes.get(key);
                if ((fields?.get(recordId) ?? '') !== held) return 0;
                fields!.delete(recordId);
                if (!fields!.size) { hashes.delete(key); ttls.delete(key); }
                return 1;
            }
            if (!script.includes("redis.call('HGET', KEYS[1], ARGV[1])")) throw new Error('Unexpected completion script');
            const fields = hashes.get(key) ?? new Map<string, string>();
            if ((fields.get(field) ?? '') !== expected) return 0;
            if (next === '') fields.delete(field); else { fields.set(field, next); ttls.set(key, Number(seconds)); }
            if (fields.size) hashes.set(key, fields); else { hashes.delete(key); ttls.delete(key); }
            return 1;
        },
        scan: async (_cursor: string, _match: string, pattern: string) => {
            const prefix = pattern.replace(/\*$/u, '');
            return ['0', [...hashes.keys()].filter(key => key.startsWith(prefix))] as [string, string[]];
        },
    };
}
