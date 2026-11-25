import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import Redis from 'ioredis-mock';
import { spritePoolKey, spritePoolStatus } from '@propr/shared';
import { SpriteInventory } from '../packages/core/src/agents/runtime/sprites/spritesInventory.ts';
import { SpritePool } from '../packages/core/src/agents/runtime/sprites/spritesProvisioning.ts';
import { FakeSpriteOrganization } from './helpers/fakeSprites.ts';

let port = 8000;
function fixture() {
    const redis = new Redis({ port: port++ });
    const provider = new FakeSpriteOrganization();
    const open = () => SpriteInventory.open(provider, { PROPR_SPRITES_MAX: '1' }, redis);
    const status = async () => spritePoolStatus(await redis.hgetall(spritePoolKey()))!;
    return { redis, provider, open, status };
}

test('two workers share one slot and the second checkout waits until the remote idle Sprite yields', { timeout: 12_000 }, async t => {
    const { open, provider, status } = fixture();
    const first = new SpritePool(provider, await open());
    const second = new SpritePool(provider, await open());
    t.after(() => Promise.all([first.close(), second.close()]));
    const signal = new AbortController().signal;
    const original = await first.acquire(signal);
    const waiting = Promise.withResolvers<void>();
    const next = second.acquire(signal, waiting.resolve);
    await waiting.promise;
    assert.equal(provider.created.length, 1);
    assert.equal((await status()).inUse, 1);
    await first.release(original);
    assert.equal((await status()).idle, 1);
    const acquired = await next;
    assert.notEqual(acquired.sprite.name, original.sprite.name);
    assert.deepEqual(provider.deleted, [original.sprite.name]);
    assert.equal((await status()).inUse, 1);
    await second.release(acquired);
});

test('expiry permits reconciliation, but only confirmed absence frees a tracked slot', async t => {
    const { open, redis, provider, status } = fixture();
    const crashed = await open();
    const name = crashed.prefix + randomUUID();
    await crashed.reserve(name);
    const worker = await open();
    const lease = spritePoolKey() + ':lease:' + name;
    const ttl = await redis.pttl(lease);
    assert.ok(ttl > 0 && ttl <= 3 * 60_000);
    let now = Date.now() + ttl + 100;
    t.mock.method(Date, 'now', () => now);
    const get = provider.getSprite.bind(provider);
    provider.getSprite = async () => { throw new Error('upstream temporarily unavailable'); };
    await worker.sweep();
    assert.equal(await worker.reserve(worker.prefix + randomUUID()), false);
    assert.equal((await status()).awaitingCleanup, 1);
    provider.getSprite = get;
    now++;
    await worker.sweep();
    assert.equal(await worker.reserve(worker.prefix + randomUUID()), true);
    assert.deepEqual(provider.deleted, []);
});

test('cleanup checks marker, age and lease and counts only confirmed deletes', async () => {
    const { open, provider, status } = fixture();
    const inventory = await open();
    const create = async (name: string, age: number) => {
        const sprite = await provider.createSprite(name);
        sprite.createdAt = new Date(Date.now() - age);
        return sprite;
    };
    const old = 31 * 60_000;
    const leased = inventory.prefix + randomUUID();
    await inventory.reserve(leased);
    await create(leased, old);
    await create('propr-ffffffffffffffff-' + randomUUID(), old);
    await create(inventory.prefix + 'foreign', old);
    await create(inventory.prefix + randomUUID(), 29 * 60_000);
    await create(inventory.prefix + randomUUID(), NaN);
    const stale = await create(inventory.prefix + randomUUID(), old);
    const remove = provider.deleteSprite.bind(provider);
    provider.deleteSprite = async () => { throw new Error('outcome unknown'); };
    const second = await open(); // startup cleanup
    assert.equal((await status()).orphansDeleted, 0);
    assert.equal((await status()).awaitingCleanup, 3);
    provider.deleteSprite = remove;
    await Promise.all([inventory.sweep(), second.sweep()]);
    assert.deepEqual(provider.deleted, [stale.name]);
    assert.equal((await status()).orphansDeleted, 1);
    assert.equal((await status()).provisioning, 1);
});

test('an orphan keeps its slot until its session list confirms inactivity under the cleaner lease', async () => {
    const { open, provider, redis, status } = fixture();
    const inventory = await open();
    const sprite = await provider.createSprite(inventory.prefix + randomUUID());
    sprite.createdAt = new Date(1);
    const lease = spritePoolKey() + ':lease:' + sprite.name;
    const idle = sprite.listSessions.bind(sprite);
    sprite.listSessions = async () => [{ id: 'running' } as Awaited<ReturnType<typeof idle>>[number]];
    await inventory.sweep();
    assert.deepEqual(provider.deleted, []);
    assert.equal(await inventory.reserve(inventory.prefix + randomUUID()), false);

    sprite.listSessions = async () => { throw Object.assign(new Error('session endpoint missing'), { statusCode: 404 }); };
    await inventory.sweep();
    assert.equal((await status()).awaitingCleanup, 1);
    assert.deepEqual(provider.deleted, []);

    sprite.listSessions = async () => {
        await redis.set(lease, 'other-cleaner');
        return [];
    };
    await inventory.sweep();
    assert.deepEqual(provider.deleted, []);
    assert.equal(await redis.get(lease), 'other-cleaner');

    await redis.del(lease);
    sprite.listSessions = idle;
    await inventory.sweep();
    await inventory.sweep();
    assert.deepEqual(provider.deleted, [sprite.name]);
    assert.equal((await status()).orphansDeleted, 1);
});

test('release cannot discard a Sprite after losing ownership during restart', async t => {
    const { open, provider, redis, status } = fixture();
    const pool = new SpritePool(provider, await open());
    t.after(() => pool.close());
    const slot = await pool.acquire(new AbortController().signal);
    provider.created[0].restart = async () => {
        await redis.set(spritePoolKey() + ':lease:' + slot.sprite.name, 'cleaner');
        throw new Error('restart failed');
    };
    await assert.rejects(pool.release(slot), /lease expired/);
    assert.equal(slot.lease?.aborted, true);
    assert.deepEqual(provider.deleted, []);
    assert.equal((await status()).inUse, 1);
});

for (const recovers of [true, false]) {
    test(`ambiguous restart ${recovers ? 'waits for exec then restores' : 'destroys after the probe deadline'}`, async t => {
        const { open, provider } = fixture();
        const pool = new SpritePool(provider, await open());
        t.after(() => pool.close());
        const slot = await pool.acquire(new AbortController().signal);
        const sprite = provider.created[0];
        sprite.restart = async () => { throw new Error('restart outcome unknown'); };
        const timeout = AbortSignal.timeout.bind(AbortSignal);
        t.mock.method(AbortSignal, 'timeout', (ms: number) => timeout(!recovers && ms === 60_000 ? 35 : ms));
        const exec = sprite.execFile.bind(sprite);
        let probes = 0;
        sprite.execFile = async (cmd, args, options) => {
            if (cmd === 'true' && (++probes === 1 || !recovers)) throw new Error('still booting');
            return exec(cmd, args, options);
        };
        await pool.release(slot);
        assert.equal(probes, recovers ? 2 : 1);
        assert.deepEqual(provider.deleted, recovers ? [] : [sprite.name]);
        assert.equal(sprite.events.includes('wipe'), recovers);
    });
}

test('confirmed external deletion frees an idle reservation even while its owner is alive', async t => {
    const { open, provider, status } = fixture();
    const first = new SpritePool(provider, await open());
    t.after(() => first.close());
    const slot = await first.acquire(new AbortController().signal);
    await first.release(slot);
    await provider.deleteSprite(slot.sprite.name);
    await open();
    assert.equal((await status()).idle, 0);
    assert.equal((await status()).orphansDeleted, 0);
    const next = await first.acquire(new AbortController().signal);
    assert.notEqual(next.sprite.name, slot.sprite.name);
    await first.release(next);
});

test('an acknowledged delete that leaves the machine visible keeps its cap slot', async t => {
    const { open, provider, status } = fixture();
    const inventory = await open();
    const pool = new SpritePool(provider, inventory);
    t.after(() => pool.close());
    const slot = await pool.acquire(new AbortController().signal);
    const remove = provider.deleteSprite.bind(provider);
    provider.deleteSprite = async () => {};
    await assert.rejects(pool.discard(slot.sprite), /still exists/);
    assert.equal((await status()).awaitingCleanup, 1);
    assert.equal(await inventory.reserve(inventory.prefix + randomUUID()), false);
    provider.deleteSprite = remove;
    await remove(slot.sprite.name);
    await inventory.sweep();
    assert.equal((await status()).awaitingCleanup, 0);
});

test('different deployments in one provider organization and Redis database have separate inventories', async () => {
    const { redis, provider } = fixture();
    const first = await SpriteInventory.open(provider, { PROPR_INSTANCE_ID: 'one' }, redis);
    const foreign = await provider.createSprite(first.prefix + randomUUID());
    foreign.createdAt = new Date(1);
    const second = await SpriteInventory.open(provider, { PROPR_INSTANCE_ID: 'two' }, redis);
    assert.notEqual(first.prefix, second.prefix);
    assert.deepEqual(provider.deleted, []);
    assert.equal(await redis.hlen(spritePoolKey('two')), 2);
    await first.sweep();
    assert.deepEqual(provider.deleted, [foreign.name]);
});
