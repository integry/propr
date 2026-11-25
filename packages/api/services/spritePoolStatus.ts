import type { RedisClientType } from 'redis';
import { spritePoolKey, spritePoolStatus } from '@propr/shared';

// Report a crashed worker's machines as awaiting cleanup as soon as its lease expires,
// even if the next provider sweep is several minutes away.
const snapshot = `
local inventory = redis.call('HGETALL', KEYS[1])
for i = 1, #inventory, 2 do
    if string.sub(inventory[i], 1, 6) == 'propr-' and
        redis.call('EXISTS', KEYS[1] .. ':lease:' .. inventory[i]) == 0 then
        inventory[i+1] = 'orphan'
    end
end
return inventory`;

export async function readSpritePoolStatus(redis: Pick<RedisClientType, 'eval'>) {
    const fields = await redis.eval(snapshot, { keys: [spritePoolKey(process.env.PROPR_INSTANCE_ID)] }) as string[];
    const inventory: Record<string, string> = {};
    for (let i = 0; i < fields.length; i += 2) inventory[fields[i]] = fields[i + 1];
    return spritePoolStatus(inventory);
}
