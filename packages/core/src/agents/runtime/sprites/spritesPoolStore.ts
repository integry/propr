/**
 * Where the shared Sprites runner pool state lives. Redis in a deployment, so
 * every worker using one Sprites organization shares one bounded pool; memory
 * for a single process (tests, standalone callers).
 *
 * A store applies one pure transition from `spritesPoolState.ts` atomically.
 * The Redis store does it optimistically: WATCH the pool's keys, read, apply
 * the transition in JavaScript, and write only what changed in MULTI/EXEC,
 * retrying when another worker changed the pool in between.
 */
import { Redis } from 'ioredis';
import logger from '../../../utils/logger.js';
import { cloneSpritePoolState, emptySpritePoolState, type SpritePoolState, type SpriteRunnerRecord, type SpriteWaiter } from './spritesPoolState.js';

/** What the workers of a pool last said its bounds are (for status readers that do not share their environment). */
export interface SpritePoolPublishedConfig {
    max: number;
    orgLimit: number;
    warmClones: boolean;
    updatedAt: number;
}

export interface SpritePoolStore {
    transact<T>(scope: string, operation: (state: SpritePoolState) => T): Promise<T>;
    read(scope: string): Promise<SpritePoolState>;
    publishConfig(scope: string, config: SpritePoolPublishedConfig): Promise<void>;
    readConfig(scope: string): Promise<SpritePoolPublishedConfig | null>;
    scopes(): Promise<string[]>;
    close?(): Promise<void>;
}

export const SPRITES_POOL_SCOPES_KEY = 'propr:sprites-pool:scopes';

export function spritesPoolKeys(scope: string) {
    const base = `propr:sprites-pool:{${scope}}`;
    return { runners: `${base}:runners`, waiting: `${base}:waiting`, config: `${base}:config` };
}

export class MemorySpritePoolStore implements SpritePoolStore {
    private readonly states = new Map<string, SpritePoolState>();
    private readonly configs = new Map<string, SpritePoolPublishedConfig>();
    async transact<T>(scope: string, operation: (state: SpritePoolState) => T): Promise<T> {
        const state = this.states.get(scope) ?? emptySpritePoolState();
        this.states.set(scope, state);
        return operation(state);
    }
    async read(scope: string) { return cloneSpritePoolState(this.states.get(scope) ?? emptySpritePoolState()); }
    async publishConfig(scope: string, config: SpritePoolPublishedConfig) { this.configs.set(scope, config); }
    async readConfig(scope: string) { return this.configs.get(scope) ?? null; }
    async scopes() { return [...new Set([...this.states.keys(), ...this.configs.keys()])]; }
}

function parse<T>(raw: string | undefined): T | undefined {
    if (raw === undefined) return undefined;
    try {
        const value = JSON.parse(raw);
        return value && typeof value === 'object' ? value as T : undefined;
    } catch { return undefined; }
}

/** Decodes the stored hashes. An unreadable runner record still counts: as orphaned, so it is reaped rather than ignored. */
export function decodeSpritePoolState(runners: Record<string, string>, waiting: Record<string, string>): SpritePoolState {
    const state = emptySpritePoolState();
    for (const [name, raw] of Object.entries(runners)) {
        const record = parse<SpriteRunnerRecord>(raw);
        state.runners.set(name, record && typeof record.state === 'string' && Number.isFinite(record.heartbeatAt)
            ? record : { state: 'orphaned', heartbeatAt: 0, since: 0, runs: 0 });
    }
    for (const [id, raw] of Object.entries(waiting)) {
        const waiter = parse<SpriteWaiter>(raw);
        if (!waiter || !Number.isFinite(waiter.joinedAt) || !Number.isFinite(waiter.seenAt)) continue;
        // A waiter written without an arrival number (an older worker) sorts by its timestamp and ID.
        state.waiting.set(id, { ...waiter, seq: Number.isFinite(waiter.seq) ? waiter.seq : 0 });
    }
    return state;
}

/** The fields to write and delete to turn `before` into `after`. */
function diff<T>(before: Map<string, T>, after: Map<string, T>) {
    const set: string[] = [];
    for (const [key, value] of after) {
        const encoded = JSON.stringify(value);
        if (!before.has(key) || JSON.stringify(before.get(key)) !== encoded) set.push(key, encoded);
    }
    const removed = [...before.keys()].filter(key => !after.has(key));
    return { set, removed };
}

const MAX_ATTEMPTS = 50;

export class RedisSpritePoolStore implements SpritePoolStore {
    private static readonly queues = new WeakMap<Redis, Promise<unknown>>();
    private readonly owned: boolean;
    private readonly client: Redis;

    constructor(client?: Redis) {
        this.owned = !client;
        this.client = client ?? new Redis({
            host: process.env.REDIS_HOST || 'redis', port: Number(process.env.REDIS_PORT || 6379),
            connectTimeout: 5000, commandTimeout: 5000, maxRetriesPerRequest: 1, lazyConnect: true,
        });
        if (this.owned) this.client.on('error', error => logger.error({ error: error.message }, 'Sprites pool Redis unavailable'));
    }

    /** WATCH is per connection: one transaction at a time on this client. */
    private serialized<T>(operation: () => Promise<T>): Promise<T> {
        const previous = RedisSpritePoolStore.queues.get(this.client) ?? Promise.resolve();
        const run = previous.then(operation);
        RedisSpritePoolStore.queues.set(this.client, run.catch(() => {}));
        return run;
    }

    private async load(scope: string): Promise<SpritePoolState> {
        const keys = spritesPoolKeys(scope);
        const [runners, waiting] = await Promise.all([this.client.hgetall(keys.runners), this.client.hgetall(keys.waiting)]);
        return decodeSpritePoolState(runners, waiting);
    }

    transact<T>(scope: string, operation: (state: SpritePoolState) => T): Promise<T> {
        const keys = spritesPoolKeys(scope);
        return this.serialized(async () => {
            for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
                await this.client.watch(keys.runners, keys.waiting);
                let committed = false;
                try {
                    const before = await this.load(scope);
                    const after = cloneSpritePoolState(before);
                    const result = operation(after);
                    const runners = diff(before.runners, after.runners);
                    const waiting = diff(before.waiting, after.waiting);
                    const multi = this.client.multi();
                    if (runners.set.length) multi.hset(keys.runners, ...runners.set);
                    if (runners.removed.length) multi.hdel(keys.runners, ...runners.removed);
                    if (waiting.set.length) multi.hset(keys.waiting, ...waiting.set);
                    if (waiting.removed.length) multi.hdel(keys.waiting, ...waiting.removed);
                    multi.sadd(SPRITES_POOL_SCOPES_KEY, scope);
                    const reply = await multi.exec();
                    committed = true;
                    if (reply) return result;
                } finally {
                    if (!committed) await this.client.unwatch().catch(() => {});
                }
            }
            throw new Error('Sprites pool state is too contended to update');
        });
    }

    read(scope: string) { return this.load(scope); }

    async publishConfig(scope: string, config: SpritePoolPublishedConfig) {
        await this.serialized(() => this.client.multi().set(spritesPoolKeys(scope).config, JSON.stringify(config)).sadd(SPRITES_POOL_SCOPES_KEY, scope).exec());
    }

    async readConfig(scope: string) {
        return parse<SpritePoolPublishedConfig>(await this.client.get(spritesPoolKeys(scope).config) ?? undefined) ?? null;
    }

    scopes() { return this.client.smembers(SPRITES_POOL_SCOPES_KEY); }

    async close() { if (this.owned) this.client.disconnect(); }
}
