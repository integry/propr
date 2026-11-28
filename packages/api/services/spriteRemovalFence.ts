import { randomUUID } from 'node:crypto';
import { spritePoolKey } from '@propr/shared';

/**
 * Takes Sprites out of the agent pool before Settings deletes them (issue #3827 follow-up).
 *
 * The pool (packages/core sprites/spritesInventory.ts) records every mutation of a
 * Sprite under its lease `<pool key>:lease:<name>`: an idle Sprite stays leased to
 * the worker holding it, and checking it out for a run (idle → inUse) succeeds only
 * while that worker still owns the lease. Reserving a Sprite for removal replaces
 * the lease with the remover's token in the same script that checks no Sprite is
 * busy, so a checkout racing the removal fails its lease check and the run
 * provisions a new Sprite instead. A Sprite already in use or being provisioned
 * refuses the whole reservation.
 *
 * Names are never reused, so a revoked worker lease never comes back. A reservation
 * left behind by a crash expires; the pool's sweep then reconciles the Sprite.
 */

export interface SpriteRemovalReservation {
  token: string;
}

export interface SpriteRemovalFence {
  /** Reserves every name, or none: `{ busy }` counts the names a run is using or provisioning. */
  reserve(names: string[]): Promise<SpriteRemovalReservation | { busy: number }>;
  /** Drops deleted Sprites from the pool and hands failed ones to the sweep as orphans. */
  release(reservation: SpriteRemovalReservation, deleted: string[], failed: string[]): Promise<void>;
}

/** node-redis `eval`. */
export interface SpriteRemovalRedis {
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
}

// Longer than one SDK delete request (two minutes) with every name deleted in parallel.
export const SPRITE_REMOVAL_LEASE_MS = 10 * 60_000;

const reserveScript = `
local runners, meta = KEYS[1], KEYS[2]
local busy = 0
for i = 3, #ARGV do
    local phase = redis.call('HGET', runners, ARGV[i])
    if phase == 'inUse' or phase == 'provisioning' or redis.call('HEXISTS', meta, 'create:' .. ARGV[i]) == 1 then busy = busy + 1 end
end
if busy > 0 then return busy end
for i = 3, #ARGV do
    redis.call('SET', meta .. ':lease:' .. ARGV[i], ARGV[1], 'PX', ARGV[2])
    -- Only a tracked Sprite changes phase: adding one would change the pool's size.
    if redis.call('HEXISTS', runners, ARGV[i]) == 1 then redis.call('HSET', runners, ARGV[i], 'removing') end
end
return 0`;

// As the pool's own fenced 'gone' and 'abandon' updates, under the removal token.
const releaseScript = `
local runners, meta, token = KEYS[1], KEYS[2], ARGV[1]
local deleted = tonumber(ARGV[2])
for i = 3, #ARGV do
    local name, lease = ARGV[i], meta .. ':lease:' .. ARGV[i]
    if redis.call('GET', lease) == token then
        if i < 3 + deleted then
            if redis.call('HDEL', runners, name) == 1 then
                redis.call('HSET', meta, 'generation', name .. ':gone')
                if redis.call('HEXISTS', meta, 'size') == 1 then redis.call('HINCRBY', meta, 'size', -1) end
            end
            redis.call('HDEL', meta, 'create:' .. name)
        elseif redis.call('HEXISTS', runners, name) == 1 then
            redis.call('HSET', runners, name, 'orphan')
        end
        redis.call('DEL', lease)
    end
end
return 1`;

export function createRedisSpriteRemovalFence(redis: SpriteRemovalRedis, env: NodeJS.ProcessEnv = process.env): SpriteRemovalFence {
  const keys = () => {
    const key = spritePoolKey(env.PROPR_INSTANCE_ID);
    return [key + ':runners', key];
  };
  return {
    async reserve(names) {
      const token = randomUUID();
      const busy = Number(await redis.eval(reserveScript, { keys: keys(), arguments: [token, String(SPRITE_REMOVAL_LEASE_MS), ...names] }));
      if (!Number.isSafeInteger(busy) || busy < 0) throw new Error('Unexpected Sprite reservation reply');
      return busy ? { busy } : { token };
    },
    async release(reservation, deleted, failed) {
      await redis.eval(releaseScript, { keys: keys(), arguments: [reservation.token, String(deleted.length), ...deleted, ...failed] });
    },
  };
}
