import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import type { Request, Response } from 'express';
import Redis from 'ioredis-mock';
import { spritePoolKey, spritePoolStatus } from '@propr/shared';
import { SpriteInventory } from '../packages/core/src/agents/runtime/sprites/spritesInventory.ts';
import { SpritePool } from '../packages/core/src/agents/runtime/sprites/spritesProvisioning.ts';
import { createInstanceSpritesRoutes } from '../packages/api/routes/instanceSpritesRoutes.ts';
import type { SpritesProvider } from '../packages/api/services/instanceSprites.ts';
import { readSpritePoolStatus } from '../packages/api/services/spritePoolStatus.ts';
import { FakeSpriteOrganization } from './helpers/fakeSprites.ts';

/**
 * Settings → Agent runtime → Remove Sprites against the real worker pool: the
 * removal's busy count is a snapshot, so an idle Sprite allocated to an agent
 * run after it must never be deleted under that run.
 */

const data = mkdtempSync(path.join(tmpdir(), 'sprite-removal-'));
after(() => rmSync(data, { recursive: true, force: true }));
let port = 8600;

async function fixture() {
    const redis = new Redis({ port: port++ });
    const organization = new FakeSpriteOrganization();
    const env = { PROPR_SPRITES_MAX: '2', DATA_DIR: mkdtempSync(path.join(data, 'install-')), SPRITES_TOKEN: 'tok' };
    const inventory = await SpriteInventory.open(organization, env, redis);
    await inventory.sweep();
    const pool = new SpritePool(organization, inventory);
    // The API's node-redis client, over the same store the worker's ioredis uses.
    const apiRedis = {
        get: (key: string) => redis.get(key),
        eval: (script: string, options: { keys: string[]; arguments?: string[] }) => redis.eval(script, options.keys.length, ...options.keys, ...options.arguments ?? []),
    };
    const status = async () => spritePoolStatus({ ...await redis.hgetall(spritePoolKey()), ...await redis.hgetall(spritePoolKey() + ':runners') })!;
    return { redis, organization, env, inventory, pool, apiRedis, status };
}

/** The Sprites API as the route sees it: the fake organization, listing only this prefix. */
function sprites(organization: FakeSpriteOrganization): SpritesProvider {
    return {
        listAllSprites: async prefix => (await organization.listAllSprites()).filter(sprite => sprite.name.startsWith(prefix ?? '')),
        deleteSprite: name => organization.deleteSprite(name),
    };
}

async function call(handler: (req: Request, res: Response) => Promise<void>, body: unknown) {
    let status = 200;
    let json: Record<string, unknown> = {};
    const res = {
        status(code: number) { status = code; return this; },
        json(value: Record<string, unknown>) { json = value; return this; },
    } as unknown as Response;
    await handler({ body } as Request, res);
    return { status, json };
}

async function idleSprite(pool: SpritePool) {
    const slot = await pool.acquire(new AbortController().signal);
    await pool.release(slot);
    return slot.sprite.name;
}

test('a Sprite allocated after the zero-busy snapshot refuses the removal and is not deleted', async t => {
    const { organization, env, pool, apiRedis, status } = await fixture();
    t.after(() => pool.close());
    const name = await idleSprite(pool);
    assert.equal((await status()).idle, 1);

    const snapshotTaken = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const routes = createInstanceSpritesRoutes({
        env, redis: apiRedis, createProvider: () => sprites(organization),
        readBusy: async () => {
            const busy = await readSpritePoolStatus(apiRedis);
            snapshotTaken.resolve();
            await resume.promise;
            return busy ? busy.inUse + busy.provisioning : 0;
        },
    });
    const removal = call(routes.removeSprites, { count: 1 });
    await snapshotTaken.promise;
    // A queued agent run takes the idle Sprite while the removal holds its zero-busy count.
    const run = await pool.acquire(new AbortController().signal);
    assert.equal(run.sprite.name, name);
    resume.resolve();

    const { status: code, json } = await removal;
    assert.equal(code, 409);
    assert.equal(json.code, 'SPRITES_BUSY');
    assert.deepEqual(organization.deleted, []);
    assert.equal((await status()).inUse, 1);
    await pool.release(run);
});

test('a Sprite reserved for removal is not handed to an agent run; the run gets a new Sprite', async t => {
    const { organization, env, pool, apiRedis, status } = await fixture();
    t.after(() => pool.close());
    const name = await idleSprite(pool);

    const reserved = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    let clients = 0;
    const routes = createInstanceSpritesRoutes({
        env, redis: apiRedis,
        // The first client lists; the second deletes, after the reservation.
        createProvider: async () => {
            if (clients++) { reserved.resolve(); await resume.promise; }
            return sprites(organization);
        },
    });
    const removal = call(routes.removeSprites, { count: 1 });
    await reserved.promise;
    assert.equal((await status()).idle, 0, 'the reserved Sprite is no longer idle in the pool');
    const run = await pool.acquire(new AbortController().signal);
    assert.notEqual(run.sprite.name, name, 'the run did not take the Sprite being removed');
    resume.resolve();

    const { status: code, json } = await removal;
    assert.equal(code, 200);
    assert.deepEqual(json, { deleted: 1, failed: [] });
    assert.deepEqual(organization.deleted, [name]);
    assert.ok(!organization.deleted.includes(run.sprite.name));
    const after = await status();
    assert.deepEqual([after.inUse, after.idle, after.provisioning, after.awaitingCleanup], [1, 0, 0, 0], 'the removed Sprite left the pool');
    await pool.release(run);
    assert.equal((await status()).idle, 1);
});

test('a Sprite that could not be deleted goes back to the sweep as an orphan, never to a run', async t => {
    const { organization, env, pool, apiRedis, status, redis } = await fixture();
    t.after(() => pool.close());
    const name = await idleSprite(pool);
    const provider = sprites(organization);
    const routes = createInstanceSpritesRoutes({
        env, redis: apiRedis,
        createProvider: () => ({ ...provider, deleteSprite: async () => { throw Object.assign(new Error('boom'), { statusCode: 500 }); } }),
    });
    const { status: code } = await call(routes.removeSprites, { count: 1 });
    assert.equal(code, 502);
    assert.equal(await redis.hget(spritePoolKey() + ':runners', name), 'orphan');
    assert.equal(await redis.exists(spritePoolKey() + ':lease:' + name), 0);
    assert.equal((await status()).awaitingCleanup, 1);
    const run = await pool.acquire(new AbortController().signal);
    assert.notEqual(run.sprite.name, name);
    await pool.release(run);
});
