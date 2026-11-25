import path from 'node:path';
import { readFileSync } from 'node:fs';
import { createInstanceId } from '../../../idle/idleParticipants.js';
import { withRetry } from '../../../utils/retryHandler.js';
import { createHash, randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import type { SpritesClient } from '@fly/sprites';
import { spritePoolKey } from '@propr/shared';
import logger from '../../../utils/logger.js';

type Provider = Pick<SpritesClient, 'listAllSprites' | 'getSprite' | 'deleteSprite'>;
export type SpritePoolRedis = Pick<Redis, 'eval' | 'set' | 'get' | 'hsetnx' | 'hget' | 'hset' | 'hgetall'>;
type Phase = 'idle' | 'inUse' | 'provisioning';
// Longer than the SDK's two-minute create request. A crash during create must
// not immediately turn a transient 404 into another worker's free slot.
const leaseMs = 3 * 60_000;
const localLeaseMs = leaseMs - 10_000;
// A delayed reservation acknowledgement can still dispatch a create until its original
// local deadline. Then allow the SDK's full two-minute request before listing.
const createRequestMs = 120_000;
const dispatchMs = localLeaseMs - createRequestMs;
// Redis TIME is truncated to seconds, so round the fence past the final millisecond.
const recoverySeconds = Math.ceil(localLeaseMs / 1000) + 1;
const redisSeconds = "tonumber(redis.call('TIME')[1])";
const sizeMatches = "tonumber(redis.call('HGET', meta, 'size')) == redis.call('HLEN', runners)";
const beginSnapshot = `
local meta, runners = KEYS[1], KEYS[2]
local marker = redis.call('GET', KEYS[3])
if marker and marker ~= ARGV[3] then return redis.error_reply('Conflicting Sprite marker') end
redis.call('SETNX', KEYS[3], ARGV[3])
local generation = redis.call('HGET', meta, 'generation')
if generation and (redis.call('HEXISTS', meta, 'firstInstall') == 1 or ${sizeMatches}) then return {generation, ${redisSeconds}} end
local now = ${redisSeconds}
local untilTime = tonumber(redis.call('HGET', meta, 'recoverAfter'))
if not untilTime or not generation then
    redis.call('HSET', meta, 'generation', ARGV[1], 'recoverAfter', now + tonumber(ARGV[2]))
    redis.call('HDEL', meta, 'size')
    return false
end
if now < untilTime then return false end
return {generation, now}`;
const publish = `
local meta, runners = KEYS[1], KEYS[2]
if redis.call('HGET', meta, 'generation') ~= ARGV[1] then
    -- A busy healthy pool can still inspect individual machines under their leases.
    if ${sizeMatches} then return -1 end
    return 0
end
if redis.call('HDEL', meta, 'firstInstall') == 1 then
    if ARGV[4] == '1' then
        redis.call('HSET', meta, 'recoverAfter', ${redisSeconds} + ${recoverySeconds})
        return 0
    end
else
    local fence = tonumber(redis.call('HGET', meta, 'recoverAfter'))
    if fence then
        if tonumber(ARGV[2]) < fence then return 0 end
    elseif not (${sizeMatches}) then return 0 end
end
for i = 5, #ARGV do redis.call('HSETNX', runners, ARGV[i], 'orphan') end
-- Preserve legacy phases. The create fields index outstanding reservations
-- even if the runners hash alone was evicted.
for _, field in ipairs(redis.call('HKEYS', meta)) do
    if string.sub(field, 1, 6) == 'propr-' then
        redis.call('HSET', runners, field, redis.call('HGET', meta, field))
        redis.call('HDEL', meta, field)
    elseif string.sub(field, 1, 7) == 'create:' then
        redis.call('HSETNX', runners, string.sub(field, 8), 'provisioning')
    end
end
redis.call('HSET', meta, 'size', redis.call('HLEN', runners))
redis.call('HDEL', meta, 'recoverAfter')
redis.call('HSETNX', meta, 'orphansDeleted', '0')
redis.call('HSETNX', meta, 'cap', ARGV[3])
return 1`;

const reserve = `
local meta, runners, lease, waiting = KEYS[1], KEYS[2], KEYS[3], KEYS[4]
local size = tonumber(redis.call('HGET', meta, 'size'))
local cap = tonumber(redis.call('HGET', meta, 'cap'))
if not size or not cap then return -1 end
if size ~= redis.call('HLEN', runners) then return 0 end
if redis.call('GET', lease) == ARGV[2] then
    redis.call('PEXPIRE', lease, ARGV[3])
    redis.call('HSET', meta, 'create:' .. ARGV[1], ${redisSeconds} + ${recoverySeconds})
    redis.call('HSET', runners, ARGV[1], 'provisioning')
    return 1
end
local speculative = ARGV[4] == '1'
if speculative and redis.call('EXISTS', waiting) == 1 then return 0 end
if size >= cap then
    if not speculative then redis.call('SET', waiting, ARGV[2], 'PX', 10000) end
    return 0
end
if redis.call('HEXISTS', runners, ARGV[1]) == 1 or not redis.call('SET', lease, ARGV[2], 'PX', ARGV[3], 'NX') then return 0 end
redis.call('HSET', runners, ARGV[1], 'provisioning')
redis.call('HSET', meta, 'generation', ARGV[1], 'create:' .. ARGV[1], ${redisSeconds} + ${recoverySeconds}, 'size', redis.call('HLEN', runners))
return 1`;

// An operator can delete a checked-out or idle machine. Its name is never reused.
// Never free a live provisioning reservation on a 404: create may still be in flight.
const removeRunner = `if redis.call('HDEL', KEYS[1], ARGV[1]) == 1 then
        redis.call('HSET', KEYS[3], 'generation', ARGV[1] .. ':gone')
        if redis.call('HEXISTS', KEYS[3], 'size') == 1 then redis.call('HINCRBY', KEYS[3], 'size', -1) end
    end
    redis.call('HDEL', KEYS[3], 'create:' .. ARGV[1])`;
const missing = `
local phase = redis.call('HGET', KEYS[1], ARGV[1])
if phase == 'idle' or phase == 'inUse' then
    ${removeRunner}
    redis.call('DEL', KEYS[2])
end
return 1`;

// Every mutation after reservation is fenced, including a cleaner's final acknowledgement.
const update = `
if redis.call('GET', KEYS[2]) ~= ARGV[2] then return 0 end
local action = ARGV[4]
if action == 'gone' or action == 'deleted' then
    ${removeRunner}
    redis.call('DEL', KEYS[2])
    if action == 'deleted' then redis.call('HINCRBY', KEYS[3], 'orphansDeleted', 1) end
elseif action == 'abandon' then
    if redis.call('HEXISTS', KEYS[1], ARGV[1]) == 1 then redis.call('HSET', KEYS[1], ARGV[1], 'orphan') end
    redis.call('DEL', KEYS[2])
else
    if action ~= 'renew' then
        if redis.call('HEXISTS', KEYS[1], ARGV[1]) == 0 then redis.call('HDEL', KEYS[3], 'size') end
        if action ~= 'provisioning' then redis.call('HDEL', KEYS[3], 'create:' .. ARGV[1]) end
        redis.call('HSET', KEYS[1], ARGV[1], action)
    end
    redis.call('PEXPIRE', KEYS[2], ARGV[3])
end
return 1`;

function positive(value: string | undefined, fallback: number, name: string) {
    const number = Number(value ?? fallback);
    if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`Invalid ${name}`);
    return number;
}

export function spriteGone(error: unknown) {
    return (error as { statusCode?: number })?.statusCode === 404;
}

async function deploymentMarker(redis: SpritePoolRedis, env: NodeJS.ProcessEnv, key: string) {
    const digest = createHash('sha256').update(key).digest('hex').slice(0, 16);
    const dir = env.DATA_DIR || path.join(process.cwd(), 'data');
    const file = path.join(dir, 'sprites-deployment-' + digest);
    // A delayed opener may initialize only the generation it observed before reading the file.
    await redis.hsetnx(key, 'generation', randomUUID());
    const observed = await redis.hget(key, 'generation');
    let saved: string | undefined;
    try { saved = readFileSync(file, 'utf8').trim(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const candidate = saved ?? (env.PROPR_INSTANCE_ID?.trim() ? digest : randomUUID().replaceAll('-', '').slice(0, 16));
    if (!/^[0-9a-f]{16}$/.test(candidate)) throw new Error('Invalid persisted Sprite deployment marker');
    const markerKey = key + ':deployment';
    const marker = await redis.eval(`
        if redis.call('SET', KEYS[2], ARGV[1], 'NX') and ARGV[2] == redis.call('HGET', KEYS[1], 'generation')
            and redis.call('HLEN', KEYS[1]) == 1 then
            redis.call('HSET', KEYS[1], 'firstInstall', 1)
        end
        return redis.call('GET', KEYS[2])
    `, 2, key, markerKey, candidate, saved ? '' : observed ?? '');
    if (typeof marker !== 'string' || !/^[0-9a-f]{16}$/.test(marker) || (saved && saved !== marker)) throw new Error('Invalid or conflicting Sprite deployment marker');
    if (saved) return saved;
    if (createInstanceId(file, marker, 0o600) !== marker) throw new Error('Could not persist Sprite deployment marker');
    return marker;
}

class SpriteLeaseExpired extends Error {
    constructor(message = 'Sprite lease expired') { super(message); }
}
const retryOptions = { baseDelay: 100, maxDelay: 1000, shouldRetry: (error: unknown) =>
    !(error instanceof SpriteLeaseExpired || ['AbortError', 'TimeoutError'].includes((error as Error)?.name)) };

export class SpriteInventory {
    private readonly owner = randomUUID();
    private readonly owned = new Map<string, { lost: AbortController; expiry?: NodeJS.Timeout; deadline: number; createDeadline: number }>();
    private cleanup?: Promise<void>;
    private closing = false;
    private timers: NodeJS.Timeout[] = [];

    private constructor(
        private readonly redis: SpritePoolRedis,
        private readonly provider: Provider,
        private readonly config: { key: string; prefix: string; marker: string; queueMinutes: number; orphanAgeMs: number; cap: number },
        private disconnect?: () => void,
    ) {}

    get prefix() { return this.config.prefix; }

    get cap() { return this.config.cap; }
    get queueMinutes() { return this.config.queueMinutes; }

    static async open(provider: Provider, env: NodeJS.ProcessEnv, store?: SpritePoolRedis) {
        const cap = positive(env.PROPR_SPRITES_MAX, 2, 'PROPR_SPRITES_MAX');
        const queueMinutes = positive(env.PROPR_SPRITES_QUEUE_TIMEOUT, 10, 'PROPR_SPRITES_QUEUE_TIMEOUT');
        const age = positive(env.PROPR_SPRITES_ORPHAN_AGE, 30, 'PROPR_SPRITES_ORPHAN_AGE') * 60_000;
        let owned: Redis | undefined;
        if (!store) {
            const { buildRedisRuntimeConfig } = await import('../../../webhook/checkRunHelpers.js');
            const { url, options } = buildRedisRuntimeConfig(env);
            const bounded = { ...options, maxRetriesPerRequest: 1, commandTimeout: 5000 };
            owned = url ? new Redis(url, bounded) : new Redis(bounded);
        }
        const redis = store ?? owned!;
        try {
            // Stable across worker restarts and token rotation, unique even for two installs in one Fly org.
            const key = spritePoolKey(env.PROPR_INSTANCE_ID);
            const marker = await deploymentMarker(redis, env, key);
            const config = { key, cap, marker, queueMinutes, prefix: `propr-${marker}-`, orphanAgeMs: age };
            const inventory = new SpriteInventory(redis, provider, config, () => owned?.disconnect());
            await redis.hset(key, 'cap', cap);
            void inventory.sweep().catch(err => logger.warn({ err }, 'Sprite pool startup sweep failed'));
            return inventory;
        } catch (error) {
            owned?.disconnect();
            throw error;
        }
    }

    start(yieldIdle: () => Promise<void>) {
        const every = (ms: number, fn: () => Promise<void>) => {
            let running = false;
            this.timers.push(setInterval(() => {
                if (running) return;
                running = true;
                void fn().catch(() => logger.warn('Sprite pool maintenance failed')).finally(() => { running = false; });
            }, ms).unref());
        };
        every(5000, async () => {
            await Promise.all([...this.owned.keys()].map(name => this.change(name, 'renew')));
        });
        every(5000, async () => {
            if (this.closing) return;
            const waiting = await this.redis.get(this.config.key + ':waiting');
            if (waiting && waiting !== this.owner) await yieldIdle();
        });
        every(5 * 60_000, async () => { if (!this.closing) await this.sweep(); });
    }

    async close() {
        this.closing = true;
        try { await this.cleanup; }
        finally { this.disconnectWhenReleased(); }
    }

    private disconnectWhenReleased() {
        if (!this.closing || this.owned.size || this.cleanup) return;
        for (const timer of this.timers) clearInterval(timer);
        this.disconnect?.();
        this.disconnect = undefined;
    }

    private get runners() { return this.config.key + ':runners'; }

    private admission(name: string, speculative: boolean) {
        return this.redis.eval(reserve, 4, this.config.key, this.runners, this.lease(name), this.config.key + ':waiting',
            name, this.owner, leaseMs, speculative ? '1' : '0');
    }

    private async snapshot() {
        const { key, cap, marker } = this.config;
        const start = await this.redis.eval(beginSnapshot, 3, key, this.runners, key + ':deployment', randomUUID(), recoverySeconds, marker);
        if (!Array.isArray(start)) return;
        const [generation, listedAt] = start as [string, number];
        const listed = await this.provider.listAllSprites(this.prefix);
        const present = new Set(listed.map(sprite => sprite.name).filter(name => this.matches(name)));
        const hasPrefix = listed.some(sprite => sprite.name.startsWith(this.prefix));
        const result = await this.redis.eval(publish, 2, key, this.runners, generation, listedAt, cap, hasPrefix ? 1 : 0, ...present);
        if (result !== 0) return { listedAt, present };
    }

    async reserve(name: string, speculative = false) {
        try {
            return await withRetry(async () => {
                let sent = performance.now();
                let result = await this.admission(name, speculative);
                if (result === -1) {
                    const snapshot = await this.snapshot();
                    if (!snapshot) return false;
                    sent = performance.now();
                    result = await this.admission(name, speculative);
                }
                if (result !== 1) return false;
                this.owned.set(name, { lost: new AbortController(), deadline: 0, createDeadline: sent + dispatchMs });
                if (!this.arm(name, sent)) {
                    await this.change(name, 'gone'); // No create can have started.
                    throw new SpriteLeaseExpired('Sprite reservation expired before acknowledgement');
                }
                return true;
            }, retryOptions, 'reserve Sprite');
        } catch (error) {
            // A lost response may have reserved this name, but no create was sent.
            await this.change(name, 'gone').catch(() => {});
            throw error;
        }
    }

    private arm(name: string, sent: number) {
        const lease = this.owned.get(name);
        if (!lease) return false;
        const deadline = Math.max(lease.deadline, sent + localLeaseMs);
        const now = performance.now();
        if (deadline <= now || (lease.deadline && lease.deadline <= now)) {
            this.stopRenewing(name);
            return false;
        }
        if (deadline > lease.deadline) {
            clearTimeout(lease.expiry);
            lease.deadline = deadline;
            lease.expiry = setTimeout(() => this.stopRenewing(name), deadline - now).unref();
        }
        return true;
    }

    checkCreate(name: string) {
        this.signal(name).throwIfAborted();
        const lease = this.owned.get(name);
        if (!lease || performance.now() >= lease.createDeadline) throw new Error('Sprite reservation expired before create');
    }

    signal(name: string) {
        const lease = this.owned.get(name);
        if (lease && performance.now() >= lease.deadline) this.stopRenewing(name);
        return this.owned.get(name)?.lost.signal ?? AbortSignal.abort(new SpriteLeaseExpired());
    }

    private dropLease(name: string) {
        const lease = this.owned.get(name);
        if (!lease) return;
        clearTimeout(lease.expiry);
        this.owned.delete(name);
        lease.lost.abort(new SpriteLeaseExpired());
    }

    private lease(name: string) { return this.config.key + ':lease:' + name; }

    private async change(name: string, action: Phase | 'renew' | 'abandon' | 'gone' | 'deleted', owner: string = this.owner) {
        const extendsLease = action === 'renew' || action === 'inUse' || action === 'idle' || action === 'provisioning';
        if (extendsLease && owner === this.owner && this.signal(name).aborted) return false;
        const sent = performance.now();
        const changed = await this.redis.eval(update, 3, this.runners, this.lease(name), this.config.key, name, owner, leaseMs, action);
        if (owner === this.owner && !changed) this.dropLease(name);
        if (!changed || !extendsLease) return !!changed;
        return owner === this.owner ? this.arm(name, sent) : performance.now() < sent + localLeaseMs;
    }

    async phase(name: string, phase: Phase) {
        return withRetry(() => this.change(name, phase), retryOptions, 'update Sprite phase');
    }

    stopRenewing(name: string) {
        this.dropLease(name);
        this.disconnectWhenReleased();
    }

    async deleteOwned(name: string, timeout: AbortSignal) {
        const lease = AbortSignal.any([this.signal(name), timeout]);
        await withRetry(async () => { lease.throwIfAborted(); return this.change(name, 'renew'); }, retryOptions, 'renew Sprite lease');
        lease.throwIfAborted();
        await this.deleteConfirmed(name);
    }

    private async deleteConfirmed(name: string) {
        let deleted = false;
        try {
            await this.provider.deleteSprite(name);
            deleted = true;
            await this.provider.getSprite(name);
        } catch (error) {
            if (spriteGone(error)) return deleted;
            throw error;
        }
        throw new Error('Sprite still exists after deletion');
    }

    async finish(name: string, action: 'gone' | 'abandon') {
        try { await withRetry(() => this.change(name, action), retryOptions, 'finish Sprite lease'); }
        finally { this.stopRenewing(name); }
    }

    sweep(): Promise<void> {
        return this.cleanup ??= this.reconcile().finally(() => { this.cleanup = undefined; });
    }

    private async reconcile() {
        const listing = await withRetry(() => this.snapshot(), retryOptions, 'list Sprite inventory');
        if (!listing) return;
        const tracked = await this.redis.hgetall(this.runners);
        // Confirm absent slots first. A paginated listing can miss a concurrently created machine.
        for (const [name, phase] of Object.entries(tracked)) {
            if (!this.matches(name) || listing.present.has(name)) continue;
            if (phase === 'inUse' || phase === 'idle') {
                try { await this.provider.getSprite(name); }
                catch (error) {
                    if (spriteGone(error)) await this.redis.eval(missing, 3, this.runners, this.lease(name), this.config.key, name);
                }
            } else await this.inspect(name, listing.listedAt);
        }
        for (const name of listing.present) await this.inspect(name);
    }

    private matches(name: string) {
        return name.startsWith(this.prefix) && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(name.slice(this.prefix.length));
    }

    private async inspect(name: string, absentAt?: number) {
        const cleaner = randomUUID();
        // Only a listing begun after the outstanding create window can establish absence.
        if (!await this.redis.eval(`
            local untilTime = redis.call('HGET', KEYS[1], 'create:' .. ARGV[1])
            if ARGV[4] ~= '' and untilTime and tonumber(untilTime) > tonumber(ARGV[4]) then return false end
            return redis.call('SET', KEYS[2], ARGV[2], 'PX', ARGV[3], 'NX')
        `, 2, this.config.key, this.lease(name), name, cleaner, leaseMs, absentAt ?? '')) return;
        try {
            let sprite;
            try {
                sprite = await this.provider.getSprite(name);
            } catch (error) {
                if (!spriteGone(error)) throw error;
                await this.change(name, 'gone', cleaner);
                return;
            }
            const created = sprite.createdAt?.getTime();
            if (absentAt === undefined && sprite.name === name && created !== undefined && Number.isFinite(created) && Date.now() - created > this.config.orphanAgeMs
                && (await sprite.listSessions()).length === 0
                && await this.change(name, 'renew', cleaner)) {
                const deleted = await this.deleteConfirmed(name);
                await this.change(name, deleted ? 'deleted' : 'gone', cleaner);
                return;
            }
        } catch {
            logger.warn({ sprite: name }, 'Could not verify or delete orphan Sprite');
        }
        await this.change(name, 'abandon', cleaner);
    }
}
