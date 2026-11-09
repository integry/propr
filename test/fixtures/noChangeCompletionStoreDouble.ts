// Not imported from the module: importing it here would load the real Redis config before a suite mocks it.
const COMPLETION_KEY_PREFIX = 'issue:no-change-completions:';

/**
 * An in-memory stand-in for the Redis commands the no-change completion
 * obligation uses: per-issue hashes changed by its compare-and-set script,
 * plain request-generation keys, and SCAN over the completion prefix.
 * Other scripts (repository workflow admission) succeed.
 */
export function createNoChangeCompletionStoreDouble() {
    const hashes = new Map<string, Map<string, string>>();
    const strings = new Map<string, string>();
    const ttls = new Map<string, number>();
    return {
        hashes, strings, ttls,
        clear() { hashes.clear(); strings.clear(); ttls.clear(); },
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
        eval: async (script: string, keys: number, key: string, field: string, expected: string, next: string, seconds: number) => {
            if (!String(key).startsWith(COMPLETION_KEY_PREFIX)) return 1;
            if (Number(keys) === 2) {
                // Admission's drop: KEYS = hash, request key; ARGV = field, expected, admitting request.
                if (!script.includes("redis.call('GET', KEYS[2]) ~= ARGV[3]")) throw new Error('Unexpected admission script');
                const [requestKeyName, recordId, held, admitting] = [field, expected, next, String(seconds)];
                if (strings.get(requestKeyName) !== admitting) return -1;
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
