import { mkdir, readFile, link, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { calculateDelay } from '../../../utils/retryHandler.js';
import { createHash, randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import type { SpritesClient } from '@fly/sprites';
import { spritePoolKey } from '@propr/shared';
import logger from '../../../utils/logger.js';

type Provider = Pick<SpritesClient, 'listAllSprites' | 'getSprite' | 'deleteSprite'>;
export type SpritePoolRedis = Pick<Redis, 'eval' | 'set' | 'get' | 'scan' | 'hsetnx' | 'hget' | 'hset' | 'hgetall'>;
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
local generation = redis.call('HGET', meta, 'generation')
if generation and ${sizeMatches} then return {generation, ${redisSeconds}} end
local now = ${redisSeconds}
local untilTime = tonumber(redis.call('HGET', meta, 'recoverAfter'))
if not untilTime or not generation then
    redis.call('HSET', meta, 'generation', ARGV[1], 'recoverAfter', now + tonumber(ARGV[2]))
    redis.call('HDEL', meta, 'size')
    return false
end
if now < untilTime then return false end
return {generation, now}`;
const reserve = `
local meta, runners, lease, waiting = KEYS[1], KEYS[2], KEYS[3], KEYS[4]
if ARGV[6] ~= '' then
    if redis.call('HGET', meta, 'generation') ~= ARGV[6] then return -1 end
    local recoverAfter = tonumber(redis.call('HGET', meta, 'recoverAfter'))
    if recoverAfter then
        if tonumber(ARGV[7]) < recoverAfter then return -1 end
    elseif not (${sizeMatches}) then return -1 end
    -- Publish a complete listing in one operation. Include surviving reservations
    -- (create can be in flight) and migrate phase fields from the original hash.
    for i = 8, #ARGV do redis.call('HSETNX', runners, ARGV[i], 'orphan') end
    local old = redis.call('HKEYS', meta)
    for _, name in ipairs(old) do
        if string.sub(name, 1, 6) == 'propr-' then
            redis.call('HSET', runners, name, redis.call('HGET', meta, name))
            redis.call('HDEL', meta, name)
        elseif string.sub(name, 1, 7) == 'create:' and redis.call('HEXISTS', runners, string.sub(name, 8)) == 0 then
            redis.call('HDEL', meta, name)
        end
    end
    redis.call('HSET', meta, 'size', redis.call('HLEN', runners))
    redis.call('HDEL', meta, 'recoverAfter')
elseif not (${sizeMatches}) or redis.call('EXISTS', runners) == 0 or not redis.call('HGET', meta, 'cap') then
    return -1
end
redis.call('HSETNX', meta, 'orphansDeleted', '0')
redis.call('HSETNX', meta, 'cap', ARGV[5])
if ARGV[1] == '' then return 0 end
if redis.call('GET', lease) == ARGV[2] then
    redis.call('PEXPIRE', lease, ARGV[3])
    redis.call('HSET', meta, 'create:' .. ARGV[1], ${redisSeconds} + ${recoverySeconds})
    redis.call('HSET', runners, ARGV[1], 'provisioning')
    return 1
end
local speculative = ARGV[4] == '1'
if speculative and redis.call('EXISTS', waiting) == 1 then return 0 end
if redis.call('HLEN', runners) >= tonumber(redis.call('HGET', meta, 'cap')) then
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
    // Bind first-install initialization to the Redis generation observed before publishing
    // the durable marker. A delayed opener cannot bless a replacement inventory.
    await redis.hsetnx(key, 'generation', randomUUID());
    const generation = await redis.hget(key, 'generation');
    let saved: string | undefined;
    try { saved = await readFile(file, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const candidate = saved ?? (env.PROPR_INSTANCE_ID?.trim() ? digest : randomUUID().replaceAll('-', '').slice(0, 16));
    if (!/^[0-9a-f]{16}$/.test(candidate)) throw new Error('Invalid persisted Sprite deployment marker');
    const markerKey = key + ':deployment';
    const marker = await redis.eval(`
        if redis.call('SET', KEYS[2], ARGV[1], 'NX') and redis.call('HGET', KEYS[1], 'generation') == ARGV[2]
            and not redis.call('HGET', KEYS[1], 'recoverAfter') then
            redis.call('HSETNX', KEYS[1], 'size', '0')
        end
        return redis.call('GET', KEYS[2])
    `, 2, key, markerKey, candidate, saved ? '' : generation ?? '');
    if (typeof marker !== 'string' || !/^[0-9a-f]{16}$/.test(marker) || (saved && saved !== marker)) throw new Error('Invalid or conflicting Sprite deployment marker');
    if (saved) return saved;
    await mkdir(dir, { recursive: true });
    const temp = file + '.' + randomUUID();
    await writeFile(temp, marker, { flag: 'wx', mode: 0o600 });
    try { await link(temp, file); } // Publish complete contents once across concurrent workers.
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    finally { await unlink(temp); }
    if (await readFile(file, 'utf8') !== marker) throw new Error('Conflicting persisted Sprite deployment marker');
    return marker;
}

async function retry<T>(operation: () => Promise<T>) {
    const config = { maxAttempts: 3, baseDelay: 100, maxDelay: 1000, exponentialBase: 2, jitter: true, retryableErrors: [] };
    for (let attempt = 0; ; attempt++) {
        try { return await operation(); }
        catch (error) {
            if (attempt + 1 >= config.maxAttempts) throw error;
            await delay(calculateDelay(attempt, config));
        }
    }
}

export class SpriteInventory {
    private readonly owner = randomUUID();
    private readonly owned = new Map<string, { lost: AbortController; expiry?: NodeJS.Timeout; deadline: number; createDeadline: number }>();
    private cleanup?: Promise<void>;
    private closing = false;
    private timers: NodeJS.Timeout[] = [];

    private constructor(
        private readonly redis: SpritePoolRedis,
        private readonly provider: Provider,
        private readonly config: { key: string; prefix: string; orphanAgeMs: number; cap: number },
        private disconnect?: () => void,
    ) {}

    get prefix() { return this.config.prefix; }

    static async open(provider: Provider, env: NodeJS.ProcessEnv, store?: SpritePoolRedis) {
        const cap = positive(env.PROPR_SPRITES_MAX, 2, 'PROPR_SPRITES_MAX');
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
            const config = { key, cap, prefix: `propr-${marker}-`, orphanAgeMs: age };
            const inventory = new SpriteInventory(redis, provider, config, () => owned?.disconnect());
            await inventory.sweep();
            await redis.hset(key, 'cap', cap);
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
        await this.cleanup;
        this.disconnectWhenReleased();
    }

    private disconnectWhenReleased() {
        if (!this.closing || this.owned.size || this.cleanup) return;
        for (const timer of this.timers) clearInterval(timer);
        this.disconnect?.();
        this.disconnect = undefined;
    }

    private get runners() { return this.config.key + ':runners'; }

    private admission(name: string, speculative: boolean, snapshot?: { generation: string; listedAt: number; names: string[] }) {
        return this.redis.eval(reserve, 4, this.config.key, this.runners, this.lease(name), this.config.key + ':waiting',
            name, this.owner, leaseMs, speculative ? '1' : '0', this.config.cap, snapshot?.generation ?? '', snapshot?.listedAt ?? 0, ...(snapshot?.names ?? []));
    }

    private async snapshot() {
        const start = await this.redis.eval(beginSnapshot, 2, this.config.key, this.runners, randomUUID(), recoverySeconds);
        if (!Array.isArray(start)) return;
        const [generation, listedAt] = start as [string, number];
        const listed = await this.provider.listAllSprites(this.prefix);
        const present = new Set(listed.map(sprite => sprite.name).filter(name => this.matches(name)));
        const names = new Set(present);
        let cursor = '0';
        const prefix = this.lease('');
        do {
            const page = await this.redis.scan(cursor, 'MATCH', prefix + this.prefix + '*');
            cursor = page[0];
            for (const key of page[1]) {
                const name = key.slice(prefix.length);
                if (this.matches(name)) names.add(name);
            }
        } while (cursor !== '0');
        return { generation, listedAt, present, names: [...names] };
    }

    async reserve(name: string, speculative = false) {
        try {
            return await retry(async () => {
                let sent = performance.now();
                let result = await this.admission(name, speculative);
                if (result === -1) {
                    const snapshot = await this.snapshot();
                    if (!snapshot) return false;
                    sent = performance.now();
                    result = await this.admission(name, speculative, snapshot);
                    if (result === -1) throw new Error('Sprite inventory changed during recovery');
                }
                if (result !== 1) return false;
                this.owned.set(name, { lost: new AbortController(), deadline: 0, createDeadline: sent + dispatchMs });
                if (!this.arm(name, sent)) {
                    await this.change(name, 'gone'); // No create can have started.
                    throw new Error('Sprite reservation expired before acknowledgement');
                }
                return true;
            });
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
        return this.owned.get(name)?.lost.signal ?? AbortSignal.abort(new Error('Sprite lease expired'));
    }

    private dropLease(name: string) {
        const lease = this.owned.get(name);
        if (!lease) return;
        clearTimeout(lease.expiry);
        this.owned.delete(name);
        lease.lost.abort(new Error('Sprite lease expired'));
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
        return retry(() => this.change(name, phase));
    }

    stopRenewing(name: string) {
        this.dropLease(name);
        this.disconnectWhenReleased();
    }

    async deleteOwned(name: string, timeout: AbortSignal) {
        const lease = AbortSignal.any([this.signal(name), timeout]);
        await retry(async () => { lease.throwIfAborted(); return this.change(name, 'renew'); });
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
        try { await retry(() => this.change(name, action)); }
        finally { this.stopRenewing(name); }
    }

    sweep(): Promise<void> {
        return this.cleanup ??= this.reconcile().finally(() => { this.cleanup = undefined; });
    }

    private async reconcile() {
        const listing = await retry(async () => {
            const snapshot = await this.snapshot();
            if (!snapshot) return;
            if (await this.admission('', false, snapshot) === -1) throw new Error('Sprite inventory changed during sweep');
            return snapshot;
        });
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
