import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import Redis from 'ioredis-mock';
import { spritePoolKey, spritePoolStatus } from '@propr/shared';
import { SpriteInventory } from '../packages/core/src/agents/runtime/sprites/spritesInventory.ts';
import { SpritePool } from '../packages/core/src/agents/runtime/sprites/spritesProvisioning.ts';
import { FakeSpriteOrganization } from './helpers/fakeSprites.ts';

const data = mkdtempSync(path.join(tmpdir(), 'sprite-markers-'));
after(() => rmSync(data, { recursive: true, force: true }));
let port = 8000;
function fixture() {
    const redis = new Redis({ port: port++ });
    const provider = new FakeSpriteOrganization();
    const dir = mkdtempSync(path.join(data, 'install-'));
    const open = () => SpriteInventory.open(provider, { PROPR_SPRITES_MAX: '1', DATA_DIR: dir }, redis);
    const status = async () => spritePoolStatus({ ...await redis.hgetall(spritePoolKey()), ...await redis.hgetall(spritePoolKey() + ':runners') })!;
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
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() + ttl + 100 });
    const get = provider.getSprite.bind(provider);
    provider.getSprite = async () => { throw new Error('upstream temporarily unavailable'); };
    await worker.sweep();
    assert.equal(await worker.reserve(worker.prefix + randomUUID()), false);
    assert.equal((await status()).awaitingCleanup, 1);
    provider.getSprite = get;
    t.mock.timers.tick(1);
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
        let restarted = false;
        sprite.restart = async () => { restarted = true; throw new Error('restart outcome unknown'); };
        const timeout = AbortSignal.timeout.bind(AbortSignal);
        t.mock.method(AbortSignal, 'timeout', (ms: number) => timeout(!recovers && ms === 60_000 ? 35 : ms));
        const exec = sprite.execFile.bind(sprite);
        let probes = 0;
        sprite.execFile = async (cmd, args, options) => {
            if (cmd === 'cat' && restarted && ++probes === 2 && recovers) sprite.bootId = randomUUID();
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
    const first = await SpriteInventory.open(provider, { DATA_DIR: data, PROPR_INSTANCE_ID: 'one' }, redis);
    const foreign = await provider.createSprite(first.prefix + randomUUID());
    foreign.createdAt = new Date(1);
    const second = await SpriteInventory.open(provider, { DATA_DIR: data, PROPR_INSTANCE_ID: 'two' }, redis);
    assert.notEqual(first.prefix, second.prefix);
    assert.deepEqual(provider.deleted, []);
    assert.equal(await redis.hlen(spritePoolKey('two') + ':runners'), 0);
    await first.sweep();
    assert.deepEqual(provider.deleted, [foreign.name]);
});

test('an open inventory rebuilds lost Redis state before admitting another machine', async t => {
    const { open, provider, redis, status } = fixture();
    const inventory = await open();
    const name = inventory.prefix + randomUUID();
    const next = inventory.prefix + randomUUID();
    assert.ok(await inventory.reserve(name));
    const key = spritePoolKey();
    await redis.del(key + ':runners');
    assert.equal(await inventory.reserve(next), false, 'surviving lease covers an in-flight create');
    await provider.createSprite(name);
    await redis.del(key + ':runners');
    assert.ok(await inventory.phase(name, 'inUse'));
    assert.equal((await status()).inUse, 1);
    await redis.flushdb();
    assert.equal(await inventory.reserve(next), false);
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 175_000 });
    assert.equal(await inventory.reserve(next), false);
    assert.equal((await status()).awaitingCleanup, 1);
    await redis.hdel(key, 'cap', 'orphansDeleted');
    assert.equal(await inventory.reserve(next), false);
    assert.equal((await status()).cap, 1);
    assert.equal(await redis.hget(key, 'orphansDeleted'), '0');
    await provider.deleteSprite(name);
    await inventory.sweep();
    assert.ok(await inventory.reserve(next));
    await inventory.finish(next, 'gone');
});

for (const loss of ['flush', 'runners and lease', 'lease'] as const) {
    test(`recovery after losing ${loss} fences competing creates until a fresh listing`, async t => {
        const { open, redis, provider } = fixture();
        const first = new SpritePool(provider, await open());
        t.after(() => first.close());
        const started = Promise.withResolvers<string>();
        const resume = Promise.withResolvers<void>();
        const create = provider.createSprite.bind(provider);
        provider.createSprite = async name => {
            started.resolve(name);
            await resume.promise;
            return create(name);
        };
        const checkout = first.acquire(new AbortController().signal);
        const name = await started.promise;
        const key = spritePoolKey();
        if (loss === 'flush') await redis.flushdb();
        else if (loss === 'lease') await redis.del(key + ':lease:' + name);
        else await redis.del(key + ':runners', key + ':lease:' + name);
        const second = await open();
        const next = second.prefix + randomUUID();
        assert.equal(await second.reserve(next), false);
        assert.equal(await second.reserve(next, true), false);
        const deadline = loss === 'lease' ? 'create:' + name : 'recoverAfter';
        assert.ok(Number(await redis.hget(key, deadline)) * 1000 >= Date.now() + 120_000);
        const failed = assert.rejects(checkout);
        // Cancel the original checkout before its uninterruptible request materializes.
        const closing = first.close();
        resume.resolve();
        await Promise.all([failed, closing]);
        assert.deepEqual(provider.created.map(sprite => sprite.name), [name]);
        t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 175_000 });
        await second.sweep();
        assert.equal(await second.reserve(next), false);
        assert.equal(await redis.hget(key + ':runners', name), 'orphan');
        await provider.deleteSprite(name);
        await second.sweep();
        assert.ok(await second.reserve(next));
        await second.finish(next, 'gone');
    });
}

test('a delayed holder cannot dispatch a create after its original send budget', async t => {
    const { open, provider, redis } = fixture();
    const inventory = await open();
    const pool = new SpritePool(provider, inventory);
    t.after(() => pool.close());
    let now = 0;
    t.mock.method(performance, 'now', () => now);
    const reserve = inventory.reserve.bind(inventory);
    t.mock.method(inventory, 'reserve', async (name: string) => {
        const reserved = await reserve(name);
        now += 45_000;
        assert.ok(await inventory.phase(name, 'provisioning'));
        await redis.flushdb();
        now += 10_000;
        return reserved;
    });
    await assert.rejects(pool.acquire(new AbortController().signal), /expired before create/);
    assert.deepEqual(provider.created, []);
});

test('a listing started before Redis loss cannot publish stale capacity', async () => {
    const { open, provider, redis } = fixture();
    const inventory = await open();
    const list = provider.listAllSprites.bind(provider);
    let first = true;
    provider.listAllSprites = async () => {
        const listed = await list();
        if (first) {
            first = false;
            await provider.createSprite(inventory.prefix + randomUUID());
            await redis.flushdb();
        }
        return listed;
    };
    assert.equal(await inventory.reserve(inventory.prefix + randomUUID()), false);
});

test('a legacy deployment retains its marker and reservations across migration and Redis loss', async t => {
    const { provider, redis } = fixture();
    const env = { DATA_DIR: data, PROPR_INSTANCE_ID: 'migrating', PROPR_SPRITES_MAX: '1' };
    const key = spritePoolKey(env.PROPR_INSTANCE_ID);
    const marker = '0123456789abcdef';
    const name = 'propr-' + marker + '-' + randomUUID();
    const open = () => SpriteInventory.open(provider, env, redis);
    await redis.set(key + ':deployment', marker);
    await redis.hset(key, 'cap', '1', 'orphansDeleted', '3', name, 'inUse');
    await redis.set(key + ':lease:' + name, 'legacy-owner');
    const sprite = await provider.createSprite(name);
    const before = await open();
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 175_000 });
    await before.sweep();
    assert.equal(await redis.hget(key + ':runners', name), 'inUse');
    assert.equal(await redis.hget(key, 'orphansDeleted'), '3');
    await redis.flushdb();
    const after = await open();
    assert.equal(after.prefix, before.prefix);
    assert.equal(await after.reserve(after.prefix + randomUUID()), false);
    sprite.createdAt = new Date(1);
    t.mock.timers.tick(175_000);
    await after.sweep();
    assert.deepEqual(provider.deleted, [name]);
});

test('reservation and renewal acknowledgements cannot grant authority beyond their send-time budget', async t => {
    const { open, redis } = fixture();
    const inventory = await open();
    const name = inventory.prefix + randomUUID();
    let now = 0;
    t.mock.method(performance, 'now', () => now);
    const evaluate = redis.eval.bind(redis);
    let lag = true;
    t.mock.method(redis, 'eval', async (...args: Parameters<typeof evaluate>) => {
        const result = await evaluate(...args);
        if (lag && result === 1) now += 179_000;
        return result;
    });
    await assert.rejects(inventory.reserve(name), /expired/);
    assert.equal(await redis.get(spritePoolKey() + ':lease:' + name), null);
    lag = false;
    assert.ok(await inventory.reserve(name));
    const signal = inventory.signal(name);
    lag = true;
    assert.equal(await inventory.phase(name, 'inUse'), false);
    assert.ok(signal.aborted);
    assert.ok(await redis.get(spritePoolKey() + ':lease:' + name));
});

for (const phase of ['idle', 'inUse'] as const) {
    test('a persistent ' + phase + ' phase failure discards under verified ownership', async t => {
        const { open, provider, redis } = fixture();
        const pool = new SpritePool(provider, await open());
        t.after(() => pool.close());
        const evaluate = redis.eval.bind(redis);
        let attempts = 0;
        t.mock.method(redis, 'eval', async (...args: Parameters<typeof evaluate>) => {
            if (args.at(-1) === phase) {
                await evaluate(...args); // Applied, but the acknowledgement was lost.
                attempts++;
                throw new Error('Redis disconnected');
            }
            return evaluate(...args);
        });
        const checkout = pool.acquire(new AbortController().signal);
        await assert.rejects(phase === 'idle' ? checkout.then(slot => pool.release(slot)) : checkout, /Redis disconnected/);
        assert.equal(attempts, 3);
        assert.deepEqual(provider.deleted, [provider.created[0].name]);
        assert.equal(await redis.hlen(spritePoolKey() + ':runners'), 0);
    });
}

test('lost reservation and phase replies retry the same Sprite at a cap of one', async t => {
    const { open, provider, redis } = fixture();
    const pool = new SpritePool(provider, await open());
    t.after(() => pool.close());
    const evaluate = redis.eval.bind(redis);
    const lost = new Set<string>();
    t.mock.method(redis, 'eval', async (...args: Parameters<typeof evaluate>) => {
        const result = await evaluate(...args);
        const operation = args[1] === 4 ? 'reserve' : String(args.at(-1));
        if (result === 1 && !lost.has(operation)) {
            lost.add(operation);
            throw new Error('reply lost');
        }
        return result;
    });
    const slot = await pool.acquire(AbortSignal.timeout(5000));
    await pool.release(slot);
    assert.equal(provider.created.length, 1);
    assert.deepEqual([...lost], ['reserve', 'inUse', 'idle']);
});

test('a phase replay after lease takeover leaves the new owner in control', async t => {
    const { open, redis, provider } = fixture();
    const inventory = await open();
    const pool = new SpritePool(provider, inventory);
    t.after(() => pool.close());
    const slot = await pool.acquire(new AbortController().signal);
    const evaluate = redis.eval.bind(redis);
    const lease = spritePoolKey() + ':lease:' + slot.sprite.name;
    t.mock.method(redis, 'eval', async (...args: Parameters<typeof evaluate>) => {
        const result = await evaluate(...args);
        if (result === 1 && args.at(-1) === 'idle') {
            await redis.set(lease, 'cleaner');
            throw new Error('lost reply');
        }
        return result;
    });
    await pool.release(slot);
    assert.ok(slot.lease?.aborted);
    assert.equal(await redis.get(lease), 'cleaner');
    assert.deepEqual(provider.deleted, []);
});

test('the holder timer subtracts Redis round-trip time from a successful renewal', async t => {
    const { open, redis } = fixture();
    const inventory = await open();
    const name = inventory.prefix + randomUUID();
    let now = 0;
    t.mock.timers.enable({ apis: ['setTimeout'] });
    t.mock.method(performance, 'now', () => now);
    const advance = (ms: number) => { now += ms; t.mock.timers.tick(ms); };
    assert.ok(await inventory.reserve(name));
    const signal = inventory.signal(name);
    advance(60_000);
    const evaluate = redis.eval.bind(redis);
    t.mock.method(redis, 'eval', async (...args: Parameters<typeof evaluate>) => {
        const result = await evaluate(...args);
        advance(30_000);
        return result;
    });
    assert.ok(await inventory.phase(name, 'inUse'));
    advance(139_999);
    assert.equal(signal.aborted, false);
    advance(1);
    assert.ok(signal.aborted);
});
