import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import type { SpritesClient } from '@fly/sprites';
import { spritePoolKey } from '@propr/shared';
import logger from '../../../utils/logger.js';

type Provider = Pick<SpritesClient, 'listAllSprites' | 'getSprite' | 'deleteSprite'>;
export type SpritePoolRedis = Pick<Redis, 'eval' | 'set' | 'get' | 'hsetnx' | 'hset' | 'hgetall'>;
type Phase = 'idle' | 'inUse' | 'provisioning';
// Longer than the SDK's two-minute create request. A crash during create must
// not immediately turn a transient 404 into another worker's free slot.
const leaseMs = 3 * 60_000;
const reserve = `
local speculative = ARGV[4] == '1'
if speculative and redis.call('EXISTS', KEYS[3]) == 1 then return 0 end
if redis.call('HLEN', KEYS[1]) - 2 >= tonumber(redis.call('HGET', KEYS[1], 'cap')) then
    if not speculative then redis.call('SET', KEYS[3], ARGV[2], 'PX', 10000) end
    return 0
end
redis.call('SET', KEYS[2], ARGV[2], 'PX', ARGV[3])
redis.call('HSET', KEYS[1], ARGV[1], 'provisioning')
return 1`;

// An operator can delete a checked-out or idle machine. Its name is never reused.
// Never free a live provisioning reservation on a 404: create may still be in flight.
const missing = `
local phase = redis.call('HGET', KEYS[1], ARGV[1])
if phase == 'idle' or phase == 'inUse' then
    redis.call('HDEL', KEYS[1], ARGV[1])
    redis.call('DEL', KEYS[2])
end
return 1`;

// Every mutation after reservation is fenced, including a cleaner's final acknowledgement.
const update = `
if redis.call('GET', KEYS[2]) ~= ARGV[2] then return 0 end
local action = ARGV[4]
if action == 'gone' or action == 'deleted' then
    redis.call('HDEL', KEYS[1], ARGV[1])
    redis.call('DEL', KEYS[2])
    if action == 'deleted' then redis.call('HINCRBY', KEYS[1], 'orphansDeleted', 1) end
elseif action == 'abandon' then
    redis.call('HSET', KEYS[1], ARGV[1], 'orphan')
    redis.call('DEL', KEYS[2])
else
    redis.call('PEXPIRE', KEYS[2], ARGV[3])
    if action ~= 'renew' then redis.call('HSET', KEYS[1], ARGV[1], action) end
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

export class SpriteInventory {
    private readonly owner = randomUUID();
    private readonly owned = new Map<string, { lost: AbortController; expiry: NodeJS.Timeout }>();
    private cleanup?: Promise<void>;
    private closing = false;
    private timers: NodeJS.Timeout[] = [];

    readonly prefix: string;
    private readonly key: string;
    private readonly orphanAgeMs: number;

    private constructor(
        private readonly redis: SpritePoolRedis,
        private readonly provider: Provider,
        config: { key: string; prefix: string; orphanAgeMs: number },
        private disconnect?: () => void,
    ) {
        this.key = config.key;
        this.prefix = config.prefix;
        this.orphanAgeMs = config.orphanAgeMs;
    }

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
            const markerKey = key + ':deployment';
            await redis.set(markerKey, randomUUID().replaceAll('-', '').slice(0, 16), 'NX');
            const marker = await redis.get(markerKey);
            if (!marker || !/^[0-9a-f]{16}$/.test(marker)) throw new Error('Invalid Sprite deployment marker');
            await redis.hsetnx(key, 'orphansDeleted', '0');
            await redis.hset(key, 'cap', cap);
            const inventory = new SpriteInventory(redis, provider, {
                key, prefix: `propr-${marker}-`, orphanAgeMs: age,
            }, () => owned?.disconnect());
            await inventory.sweep();
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
            const waiting = await this.redis.get(this.key + ':waiting');
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

    async reserve(name: string, speculative = false) {
        if (!await this.redis.eval(reserve, 3, this.key, this.lease(name), this.key + ':waiting', name, this.owner, leaseMs, speculative ? '1' : '0')) return false;
        const lost = new AbortController();
        const expiry = setTimeout(() => this.stopRenewing(name), leaseMs).unref();
        this.owned.set(name, { lost, expiry });
        return true;
    }

    signal(name: string) {
        return this.owned.get(name)?.lost.signal ?? AbortSignal.abort(new Error('Sprite lease expired'));
    }

    private dropLease(name: string) {
        const lease = this.owned.get(name);
        if (!lease) return;
        clearTimeout(lease.expiry);
        this.owned.delete(name);
        lease.lost.abort(new Error('Sprite lease expired'));
    }

    private lease(name: string) { return this.key + ':lease:' + name; }

    private async change(name: string, action: Phase | 'renew' | 'abandon' | 'gone' | 'deleted', owner: string = this.owner) {
        const changed = await this.redis.eval(update, 2, this.key, this.lease(name), name, owner, leaseMs, action);
        if (owner === this.owner) {
            if (changed) this.owned.get(name)?.expiry.refresh();
            else this.dropLease(name);
        }
        return !!changed;
    }

    async phase(name: string, phase: Phase) {
        try { return await this.change(name, phase); }
        catch (error) {
            // The pool cannot hand this slot to a run. Let cleanup reconcile it.
            this.dropLease(name);
            throw error;
        }
    }

    stopRenewing(name: string) {
        this.dropLease(name);
        this.disconnectWhenReleased();
    }

    async deleteOwned(name: string) {
        const lease = this.signal(name);
        lease.throwIfAborted();
        await this.change(name, 'renew');
        lease.throwIfAborted();
        await this.deleteConfirmed(name);
    }

    private async deleteConfirmed(name: string) {
        try {
            await this.provider.deleteSprite(name);
        } catch (error) {
            if (spriteGone(error)) return false;
            throw error;
        }
        try {
            await this.provider.getSprite(name);
        } catch (error) {
            if (spriteGone(error)) return true;
            throw error;
        }
        throw new Error('Sprite still exists after deletion');
    }

    async finish(name: string, action: 'gone' | 'abandon') {
        try { await this.change(name, action); }
        finally {
            this.dropLease(name);
            this.disconnectWhenReleased();
        }
    }

    sweep(): Promise<void> {
        return this.cleanup ??= this.reconcile().finally(() => { this.cleanup = undefined; });
    }

    private async reconcile() {
        const listed = await this.provider.listAllSprites(this.prefix);
        const present = new Set(listed.map(sprite => sprite.name).filter(name => this.matches(name)));
        for (const name of present) await this.redis.hsetnx(this.key, name, 'orphan');
        const tracked = await this.redis.hgetall(this.key);
        // Confirm absent slots first. A paginated listing can miss a concurrently created machine.
        for (const [name, phase] of Object.entries(tracked)) {
            if (!this.matches(name) || present.has(name)) continue;
            if (phase === 'inUse' || phase === 'idle') {
                try { await this.provider.getSprite(name); }
                catch (error) {
                    if (spriteGone(error)) await this.redis.eval(missing, 2, this.key, this.lease(name), name);
                }
            } else await this.inspect(name, false);
        }
        for (const name of present) await this.inspect(name, true);
    }

    private matches(name: string) {
        return name.startsWith(this.prefix) && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(name.slice(this.prefix.length));
    }

    private async inspect(name: string, listed: boolean) {
        const cleaner = randomUUID();
        if (!await this.redis.set(this.lease(name), cleaner, 'PX', leaseMs, 'NX')) return;
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
            if (listed && sprite.name === name && created !== undefined && Number.isFinite(created) && Date.now() - created > this.orphanAgeMs
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
