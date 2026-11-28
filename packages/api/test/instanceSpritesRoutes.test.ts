import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import type { Request, Response } from 'express';
import { spritePoolKey } from '@propr/shared';
import { createInstanceSpritesRoutes, type InstanceSpritesRouteDeps } from '../routes/instanceSpritesRoutes.js';
import { instanceSpritesPrefix, type SpritesProvider } from '../services/instanceSprites.js';
import type { SpriteRemovalFence } from '../services/spriteRemovalFence.js';

const MARKER = 'a21b1d274add47ba';
const PREFIX = `propr-${MARKER}-`;

function fakeProvider(names: string[], failing: string[] = []) {
  const live = new Set(names);
  const calls = { listed: [] as Array<string | undefined>, deleted: [] as string[] };
  const provider: SpritesProvider = {
    async listAllSprites(prefix) {
      calls.listed.push(prefix);
      // The API matches by prefix server-side; also return a lookalike so the route filters too.
      return [...live, 'propr-other-1'].filter(name => name.startsWith(prefix ?? '') || name === 'propr-other-1')
        .map(name => ({ name, status: 'cold', createdAt: new Date('2026-11-27T22:56:00Z') }));
    },
    async deleteSprite(name) {
      calls.deleted.push(name);
      if (failing.includes(name)) throw Object.assign(new Error('boom'), { statusCode: 500 });
      if (!live.delete(name)) throw Object.assign(new Error('gone'), { statusCode: 404 });
    },
  };
  return { provider, calls, live };
}

/** Records reservations; `reserve` decides what the pool's atomic check answers. */
function fakeFence(reserve: SpriteRemovalFence['reserve'] = async () => ({ token: 'removal' })) {
  const calls = { reserved: [] as string[][], released: [] as Array<{ token: string; deleted: string[]; failed: string[] }> };
  const fence: SpriteRemovalFence = {
    async reserve(names) { calls.reserved.push(names); return reserve(names); },
    async release(reservation, deleted, failed) { calls.released.push({ token: reservation.token, deleted, failed }); },
  };
  return { fence, calls };
}

function harness(options: { names?: string[]; failing?: string[]; busy?: number | (() => Promise<number>); token?: string | null; marker?: string | null; env?: NodeJS.ProcessEnv; reserve?: SpriteRemovalFence['reserve'] } = {}) {
  const fake = fakeProvider(options.names ?? [`${PREFIX}aaa`, `${PREFIX}bbb`], options.failing);
  const removal = fakeFence(options.reserve);
  const env: NodeJS.ProcessEnv = { DATA_DIR: mkdtempSync(path.join(tmpdir(), 'sprites-')), ...options.env };
  if (options.token !== null) env.SPRITES_TOKEN = options.token ?? 'tok';
  const marker = options.marker === undefined ? MARKER : options.marker;
  const deps: InstanceSpritesRouteDeps = {
    env,
    redis: { get: async key => (key === spritePoolKey(env.PROPR_INSTANCE_ID) + ':deployment' ? marker : null) },
    createProvider: () => fake.provider,
    readBusy: typeof options.busy === 'function' ? options.busy : async () => (options.busy as number | undefined) ?? 0,
    fence: removal.fence,
  };
  return { routes: createInstanceSpritesRoutes(deps), ...fake, env, removal: removal.calls };
}

async function call(handler: (req: Request, res: Response) => Promise<void>, body?: unknown) {
  let status = 200;
  let json: Record<string, unknown> = {};
  const res = {
    status(code: number) { status = code; return this; },
    json(value: Record<string, unknown>) { json = value; return this; },
  } as unknown as Response;
  await handler({ body } as Request, res);
  return { status, json };
}

describe('instance Sprites admin routes', () => {
  test('lists only the Sprites named with this instance prefix', async () => {
    const h = harness();
    const { status, json } = await call(h.routes.getSprites);
    assert.equal(status, 200);
    assert.equal(json.configured, true);
    assert.equal(json.prefix, PREFIX);
    assert.equal(json.count, 2);
    assert.deepEqual((json.sprites as Array<{ name: string }>).map(sprite => sprite.name), [`${PREFIX}aaa`, `${PREFIX}bbb`]);
    assert.deepEqual(h.calls.listed, [PREFIX]);
  });

  test('reports not configured without a Sprites token and never calls the API', async () => {
    const h = harness({ token: null });
    const { json } = await call(h.routes.getSprites);
    assert.deepEqual(json, { configured: false, prefix: null, count: 0, busy: 0, sprites: [] });
    assert.deepEqual(h.calls.listed, []);
    assert.equal((await call(h.routes.removeSprites, { count: 1 })).json.code, 'SPRITES_NOT_CONFIGURED');
  });

  test('an instance with no Sprite marker yet has nothing to list', async () => {
    const h = harness({ marker: null });
    const { json } = await call(h.routes.getSprites);
    assert.equal(json.prefix, null);
    assert.equal(json.count, 0);
    assert.deepEqual(h.calls.listed, []);
  });

  test('removes every Sprite when the confirmed count matches', async () => {
    const h = harness();
    const { status, json } = await call(h.routes.removeSprites, { count: 2 });
    assert.equal(status, 200);
    assert.deepEqual(json, { deleted: 2, failed: [] });
    assert.deepEqual(h.calls.deleted.sort(), [`${PREFIX}aaa`, `${PREFIX}bbb`]);
    assert.equal(h.live.size, 0);
    assert.deepEqual(h.removal.reserved, [[`${PREFIX}aaa`, `${PREFIX}bbb`]]);
    assert.deepEqual(h.removal.released, [{ token: 'removal', deleted: [`${PREFIX}aaa`, `${PREFIX}bbb`], failed: [] }]);
  });

  test('deletes nothing when a Sprite turned busy after the zero-busy snapshot', async () => {
    const h = harness({ reserve: async () => ({ busy: 1 }) });
    const { status, json } = await call(h.routes.removeSprites, { count: 2 });
    assert.equal(status, 409);
    assert.equal(json.code, 'SPRITES_BUSY');
    assert.equal(json.busy, 1);
    assert.deepEqual(h.calls.deleted, []);
    assert.deepEqual(h.removal.released, []);
  });

  test('deletes nothing when the Sprites cannot be reserved in the pool', async () => {
    const h = harness({ reserve: async () => { throw new Error('redis down'); } });
    const { status, json } = await call(h.routes.removeSprites, { count: 2 });
    assert.equal(status, 503);
    assert.equal(json.code, 'SPRITES_ACTIVITY_UNAVAILABLE');
    assert.deepEqual(h.calls.deleted, []);
  });

  test('a Sprites client that cannot start releases every reservation as failed', async () => {
    const h = harness();
    const removal = fakeFence();
    let provided = 0;
    const routes = createInstanceSpritesRoutes({
      env: h.env, redis: { get: async () => MARKER }, readBusy: async () => 0, fence: removal.fence,
      // The listing gets a client; the deletion's client fails to start.
      createProvider: () => { if (provided++) throw new Error('sdk'); return h.provider; },
    });
    const { status, json } = await call(routes.removeSprites, { count: 2 });
    assert.equal(status, 502);
    assert.equal(json.code, 'SPRITES_UNAVAILABLE');
    assert.deepEqual(removal.calls.released, [{ token: 'removal', deleted: [], failed: [`${PREFIX}aaa`, `${PREFIX}bbb`] }]);
    assert.deepEqual(h.calls.deleted, []);
  });

  test('deletes nothing when the count changed since the confirmation', async () => {
    const h = harness({ names: [`${PREFIX}aaa`, `${PREFIX}bbb`, `${PREFIX}ccc`] });
    const { status, json } = await call(h.routes.removeSprites, { count: 2 });
    assert.equal(status, 409);
    assert.equal(json.code, 'COUNT_CHANGED');
    assert.equal(json.count, 3);
    assert.deepEqual(h.calls.deleted, []);
  });

  test('refuses while an agent run uses a Sprite', async () => {
    const h = harness({ busy: 1 });
    const { status, json } = await call(h.routes.removeSprites, { count: 2 });
    assert.equal(status, 409);
    assert.equal(json.code, 'SPRITES_BUSY');
    assert.deepEqual(h.calls.deleted, []);
  });

  test('deletes nothing when the agent activity cannot be read', async () => {
    const h = harness({ busy: async () => { throw new Error('redis down'); } });
    const { status, json } = await call(h.routes.removeSprites, { count: 2 });
    assert.equal(status, 503);
    assert.equal(json.code, 'SPRITES_ACTIVITY_UNAVAILABLE');
    assert.deepEqual(h.calls.listed, [PREFIX]);
    assert.deepEqual(h.calls.deleted, []);
    assert.equal(h.live.size, 2);
  });

  test('deletes nothing when the activity read returns no usable count', async () => {
    for (const busy of [Number.NaN, -1, 0.5]) {
      const h = harness({ busy: async () => busy });
      const { status } = await call(h.routes.removeSprites, { count: 2 });
      assert.equal(status, 503, String(busy));
      assert.deepEqual(h.calls.deleted, []);
    }
  });

  test('the listing does not report zero busy when the activity cannot be read', async () => {
    const h = harness({ busy: async () => { throw new Error('redis down'); } });
    const { status, json } = await call(h.routes.getSprites);
    assert.equal(status, 503);
    assert.equal(json.code, 'SPRITES_ACTIVITY_UNAVAILABLE');
    assert.equal(json.busy, undefined);
  });

  test('the default activity read fails closed when Redis rejects', async () => {
    const fake = fakeProvider([`${PREFIX}aaa`]);
    const env: NodeJS.ProcessEnv = { DATA_DIR: mkdtempSync(path.join(tmpdir(), 'sprites-')), SPRITES_TOKEN: 'tok' };
    const redis = {
      get: async (key: string) => (key === spritePoolKey(env.PROPR_INSTANCE_ID) + ':deployment' ? MARKER : null),
      eval: async () => { throw new Error('redis down'); },
    };
    const routes = createInstanceSpritesRoutes({ env, redis, createProvider: () => fake.provider } as InstanceSpritesRouteDeps);
    const { status } = await call(routes.removeSprites, { count: 1 });
    assert.equal(status, 503);
    assert.deepEqual(fake.calls.deleted, []);
  });

  test('reports Sprites that could not be deleted', async () => {
    const h = harness({ failing: [`${PREFIX}bbb`] });
    const { status, json } = await call(h.routes.removeSprites, { count: 2 });
    assert.equal(status, 502);
    assert.equal(json.code, 'PARTIAL_FAILURE');
    assert.equal(json.deleted, 1);
    assert.deepEqual(json.failed, [`${PREFIX}bbb`]);
    assert.deepEqual(h.removal.released, [{ token: 'removal', deleted: [`${PREFIX}aaa`], failed: [`${PREFIX}bbb`] }]);
  });

  test('rejects a body without a positive count', async () => {
    const h = harness();
    for (const body of [undefined, {}, { count: 0 }, { count: '2' }, { count: 2, all: true }]) {
      assert.equal((await call(h.routes.removeSprites, body)).status, 400, JSON.stringify(body));
    }
    assert.deepEqual(h.calls.deleted, []);
  });
});

describe('instance Sprites prefix', () => {
  test('falls back to the marker the worker persisted in DATA_DIR', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sprites-'));
    const digest = createHash('sha256').update(spritePoolKey(undefined)).digest('hex').slice(0, 16);
    writeFileSync(path.join(dir, `sprites-deployment-${digest}`), 'b'.repeat(16));
    const prefix = await instanceSpritesPrefix({ env: { DATA_DIR: dir }, redis: { get: async () => null } });
    assert.equal(prefix, `propr-${'b'.repeat(16)}-`);
  });

  test('with PROPR_INSTANCE_ID and nothing persisted, uses the digest the pool derives', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sprites-'));
    const digest = createHash('sha256').update(spritePoolKey('propr-dash')).digest('hex').slice(0, 16);
    const prefix = await instanceSpritesPrefix({ env: { DATA_DIR: dir, PROPR_INSTANCE_ID: 'propr-dash' }, redis: { get: async () => { throw new Error('down'); } } });
    assert.equal(prefix, `propr-${digest}-`);
  });

  test('without an instance id or persisted marker there is none', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sprites-'));
    assert.equal(await instanceSpritesPrefix({ env: { DATA_DIR: dir }, redis: { get: async () => null } }), undefined);
  });
});
