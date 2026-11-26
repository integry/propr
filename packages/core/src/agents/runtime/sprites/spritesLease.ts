import logger from '../../../utils/logger.js';
import type { SpritePoolRedis } from './spritesInventory.js';

/** The run's Sprite lease is lost: another holder has it, or it was not confirmed in time. */
export class SpriteLeaseExpired extends Error {
    constructor(message = 'Sprite lease expired') { super(message); }
}

/** This worker ended the lease itself (deleted, abandoned or never created the Sprite); not an expiry. */
export class SpriteLeaseReleased extends SpriteLeaseExpired {
    constructor(name: string) { super(`Sprite lease released for ${name}`); }
}

/** A lease this worker holds; times are performance.now() values. */
export type OwnedSpriteLease = { lost: AbortController; expiry?: NodeJS.Timeout; deadline: number; createDeadline: number;
    /** When the reservation was sent, and when Redis last confirmed the lease. */
    reservedAt: number; renewedAt?: number };

/** Who holds a lease key now, and its remaining TTL; `holder` is null once the key is gone. */
export type SpriteLeaseHolder = { holder: string | null; ttlMs: number | null };

// The holder and remaining TTL of a lease key, read for diagnostics only.
const leaseState = "return {redis.call('GET', KEYS[1]) or '', redis.call('PTTL', KEYS[1])}";

export async function readSpriteLeaseHolder(redis: SpritePoolRedis, key: string): Promise<SpriteLeaseHolder> {
    const [holder, ttl] = await redis.eval(leaseState, 1, key) as [string, number];
    return { holder: holder || null, ttlMs: holder ? Number(ttl) : null };
}

/** This worker's side of a lost lease, as of the moment it was lost (times from performance.now()). */
export type SpriteLeaseLoss = { sprite: string; owner: string; cause: string; now: number; reservedAt: number; renewedAt?: number; deadline: number };

/** The error a lost lease fails its run with; it names the holder and expiry when they are known. */
export function spriteLeaseExpiredError(loss: SpriteLeaseLoss, holder?: SpriteLeaseHolder) {
    const held = holder && (holder.holder ? `the Redis lease is held by ${holder.holder} (expires in ${holder.ttlMs} ms)` : 'the Redis lease key is gone');
    return new SpriteLeaseExpired(`Sprite lease expired for ${loss.sprite}: ${loss.cause}${held ? `; ${held}` : ''}`);
}

/**
 * Logs a lost lease with who holds the key now and when it expires, so a lost lease can be told
 * apart from a cleaner, a restart or a stalled worker from the logs alone.
 */
export function logSpriteLeaseExpiry(loss: SpriteLeaseLoss, holder: SpriteLeaseHolder | Promise<SpriteLeaseHolder>) {
    const { sprite, owner, cause, now, reservedAt, renewedAt, deadline } = loss;
    const detail = { sprite, owner, cause, heldForMs: Math.round(now - reservedAt),
        lastRenewedMsAgo: renewedAt === undefined ? null : Math.round(now - renewedAt), localDeadlineInMs: Math.round(deadline - now) };
    const report = (state?: SpriteLeaseHolder) => logger.warn({ ...detail, ...state }, 'Sprite lease expired');
    void Promise.resolve(holder).then(report, () => report());
}
