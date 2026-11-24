/**
 * The Sprites runner pool shared by every worker that uses one Sprites
 * organization token: its settings, its identity in Redis, and the status
 * report (`/api/status`, the admission report, `propr admission`,
 * `propr remote-status` and the Web UI's system status).
 *
 * The pool itself (provisioning, leasing, restoring and reaping runners) is
 * `SpritePool` in `sprites/spritesRunnerPool.ts`; its lease state is in
 * `sprites/spritesPoolState.ts`.
 */
import { createHash } from 'node:crypto';
import { effectiveRunnerState, type SpritePoolState, type SpriteRunnerState } from './sprites/spritesPoolState.js';
import {
    RedisSpritePoolStore, SPRITES_POOL_SCOPES_KEY, decodeSpritePoolState, spritesPoolKeys, type SpritePoolPublishedConfig, type SpritePoolStore,
} from './sprites/spritesPoolStore.js';

export { MemorySpritePoolStore, RedisSpritePoolStore, type SpritePoolStore } from './sprites/spritesPoolStore.js';

export const SPRITES_MAX_ENV = 'PROPR_SPRITES_MAX';
export const SPRITES_ORG_LIMIT_ENV = 'PROPR_SPRITES_ORG_LIMIT';
export const SPRITES_WARM_CLONES_ENV = 'PROPR_SPRITES_WARM_CLONES';
export const DEFAULT_SPRITES_MAX = 2;
/** Sprites a Free-plan organization may hold at once. */
export const DEFAULT_SPRITES_ORG_LIMIT = 3;
/** A holder that has not heartbeated for this long is presumed dead. */
export const SPRITES_LEASE_TTL_MS = 60_000;

export interface SpritesPoolConfig {
    /** Runners the pool holds at most: PROPR_SPRITES_MAX, never above the organization limit. */
    max: number;
    orgLimit: number;
    /** Keep a per-repository warm clone checkpoint (PROPR_SPRITES_WARM_CLONES=on). */
    warmClones: boolean;
    /** True when PROPR_SPRITES_MAX asked for more than the organization limit allows. */
    clamped: boolean;
}

function positiveInteger(environment: NodeJS.ProcessEnv, name: string, fallback: number): number {
    const raw = environment[name]?.trim();
    if (!raw) return fallback;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid ${name}: expected a positive integer`);
    return value;
}

export function resolveSpritesPoolConfig(environment: NodeJS.ProcessEnv = process.env): SpritesPoolConfig {
    const requested = positiveInteger(environment, SPRITES_MAX_ENV, DEFAULT_SPRITES_MAX);
    const orgLimit = positiveInteger(environment, SPRITES_ORG_LIMIT_ENV, DEFAULT_SPRITES_ORG_LIMIT);
    const warm = environment[SPRITES_WARM_CLONES_ENV]?.trim().toLowerCase() || 'off';
    if (!['on', 'off', 'true', 'false', '1', '0'].includes(warm)) throw new Error(`Invalid ${SPRITES_WARM_CLONES_ENV}: expected on or off`);
    return { max: Math.min(requested, orgLimit), orgLimit, warmClones: ['on', 'true', '1'].includes(warm), clamped: requested > orgLimit };
}

/** The pool's key in Redis: derived from the organization token, never the token itself. */
export function spritesPoolScope(token: string): string {
    return createHash('sha256').update(`propr-sprites-pool:${token}`).digest('hex').slice(0, 24);
}

/** Label every runner of the pool carries, so a worker can tell its pool's Sprites from others in the organization. */
export const SPRITES_POOL_LABEL = 'propr-pool';
export function spritesPoolLabel(scope: string): string {
    return `propr-pool-${scope.slice(0, 16)}`;
}

/** Warm clone key of a repository remote. */
export function spritesWarmCloneKey(remote: string): string {
    return createHash('sha256').update(remote.trim()).digest('hex').slice(0, 24);
}

export type SpritesRunnerCounts = Record<SpriteRunnerState, number>;

export interface SpritesPoolStatus {
    /** A short, non-secret identifier of the organization's pool. */
    id: string;
    /** What its workers last published; null before any worker used it with this version. */
    max: number | null;
    orgLimit: number | null;
    warmClones: boolean | null;
    configuredAt: string | null;
    runners: { total: number; busy: number } & SpritesRunnerCounts;
    /** Runs queued for a runner. */
    waiting: number;
    /** Idle runners holding a warm clone checkpoint. */
    warm: number;
    restore: { lastMs: number | null; averageMs: number | null; samples: number };
    /** Runners that need attention: orphaned Sprites wait to be reaped, retained ones to be recovered by hand. */
    attention: string[];
}

export interface SpritesPoolStatusReport {
    pools: SpritesPoolStatus[];
    unavailable?: string;
}

const STATES: SpriteRunnerState[] = ['provisioning', 'idle', 'leased', 'resetting', 'finished', 'orphaned', 'reaping', 'retained'];

export function summarizeSpritesPool(scope: string, state: SpritePoolState, config: SpritePoolPublishedConfig | null, now = Date.now()): SpritesPoolStatus {
    const counts = Object.fromEntries(STATES.map(name => [name, 0])) as SpritesRunnerCounts;
    const restores: Array<{ at: number; ms: number }> = [];
    let warm = 0;
    for (const record of state.runners.values()) {
        const effective = effectiveRunnerState(record, now, SPRITES_LEASE_TTL_MS);
        counts[effective] += 1;
        if (effective === 'idle' && record.warm) warm += 1;
        if (typeof record.lastRestoreMs === 'number') restores.push({ at: record.since, ms: record.lastRestoreMs });
    }
    const waiting = [...state.waiting.values()].filter(waiter => waiter.seenAt + SPRITES_LEASE_TTL_MS >= now).length;
    restores.sort((a, b) => b.at - a.at);
    const attention: string[] = [];
    if (counts.orphaned) attention.push(`${counts.orphaned} runner(s) of a stopped worker will be deleted before their slot is reused.`);
    if (counts.retained) attention.push(`${counts.retained} runner(s) kept a result no worker released; recover it and delete the Sprite (see the agent runtime docs).`);
    const total = state.runners.size;
    return {
        id: scope.slice(0, 12),
        max: config?.max ?? null,
        orgLimit: config?.orgLimit ?? null,
        warmClones: config?.warmClones ?? null,
        configuredAt: config ? new Date(config.updatedAt).toISOString() : null,
        runners: { total, busy: total - counts.idle, ...counts },
        waiting,
        warm,
        restore: {
            lastMs: restores[0]?.ms ?? null,
            averageMs: restores.length ? Math.round(restores.reduce((sum, item) => sum + item.ms, 0) / restores.length) : null,
            samples: restores.length,
        },
        attention,
    };
}

type StatusStore = Pick<SpritePoolStore, 'read' | 'readConfig' | 'scopes' | 'close'>;

/** The three reads the status report needs, over any Redis client (the API passes its own). */
export interface SpritesPoolStatusRedis {
    hgetall(key: string): Promise<Record<string, string>>;
    get(key: string): Promise<string | null>;
    smembers(key: string): Promise<string[]>;
}

export function spritesPoolStatusStore(redis: SpritesPoolStatusRedis): StatusStore {
    return {
        scopes: () => redis.smembers(SPRITES_POOL_SCOPES_KEY),
        read: async scope => {
            const keys = spritesPoolKeys(scope);
            const [runners, waiting] = await Promise.all([redis.hgetall(keys.runners), redis.hgetall(keys.waiting)]);
            return decodeSpritePoolState(runners ?? {}, waiting ?? {});
        },
        readConfig: async scope => {
            try {
                const value = JSON.parse(await redis.get(spritesPoolKeys(scope).config) ?? 'null');
                return value && typeof value === 'object' ? value as SpritePoolPublishedConfig : null;
            } catch { return null; }
        },
    };
}

/** Every Sprites pool recorded in Redis; an empty list when Sprites never ran here. */
export async function readSpritesPoolStatus(options: { store?: StatusStore; now?: number } = {}): Promise<SpritesPoolStatusReport> {
    const store = options.store ?? new RedisSpritePoolStore();
    try {
        const scopes = (await store.scopes()).sort();
        const pools = await Promise.all(scopes.map(async scope => {
            const [state, config] = await Promise.all([store.read(scope), store.readConfig(scope)]);
            return summarizeSpritesPool(scope, state, config, options.now);
        }));
        return { pools };
    } catch {
        return { pools: [], unavailable: 'The Sprites runner pool state could not be read from Redis' };
    } finally {
        if (!options.store) await store.close?.();
    }
}
