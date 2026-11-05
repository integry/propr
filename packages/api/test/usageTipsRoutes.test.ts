import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import knex from 'knex';
import { closeConnection, createUsageTipsStore } from '@propr/core';
import { USAGE_TIPS_CATALOG, USAGE_TIPS_DAY_MS, type UsageTipsResponse } from '@propr/shared';
import { createUsageTipsRoutes } from '../routes/usageTipsRoutes.js';
import { extractSettingSaves } from '../routes/configSettings.js';
import { up } from '../../core/src/db/migrations/20260928000000_add_usage_tips.js';
import { parseSettingValue, isValidSettingKey } from '../../cli/src/api/settings.js';

after(() => closeConnection());
function response<T = unknown>() {
  let status = 200; let body: T | undefined; const headers: Record<string, string> = {};
  const res = { status(code: number) { status = code; return res; }, json(value: T) { body = value; return res; },
    setHeader(key: string, value: string) { headers[key] = value; } } as unknown as Response;
  return { res, get status() { return status; }, get body() { assert.ok(body !== undefined); return body; }, headers };
}
const request = (id?: string, body?: unknown) => ({ user: id ? { id } : undefined, body }) as Request;

test('GET uses only indexed reads; POST authenticates, validates, deduplicates and expires per user', async () => {
  const db = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  try {
    await db.schema.createTable('system_configs', t => { t.string('key').primary(); t.text('value'); });
    await up(db);
    let now = 1000;
    const store = createUsageTipsStore(db, () => now);
    const pool = USAGE_TIPS_CATALOG.slice(0, 5).map(t => ({ id: t.id, score: 85, reason: 'Relevant usage gap' }));
    await store.persist({ candidates: pool, model: null, source: 'heuristic', signals: {}, generatedAt: now, rotationEpoch: 0 }, null);
    const routes = createUsageTipsRoutes(store);
    for (const method of ['get', 'dismiss'] as const) {
      const unauthorized = response(); await routes[method](request(), unauthorized.res); assert.equal(unauthorized.status, 401);
    }
    for (const body of [{ tipId: 'unknown', eventId: randomUUID() }, { tipId: pool[0].id }, { tipId: pool[0].id, eventId: 'invalid' }]) {
      const invalid = response(); await routes.dismiss(request('alice', body), invalid.res); assert.equal(invalid.status, 400);
    }
    const action = { tipId: pool[0].id, eventId: randomUUID() };
    for (let index = 0; index < 2; index++) { const saved = response(); await routes.dismiss(request('alice', action), saved.res); assert.equal(saved.status, 200); }
    const statements: string[] = [];
    const listener = (q: { sql: string }) => statements.push(q.sql);
    db.on('query', listener);
    const alice = response<UsageTipsResponse>(); await routes.get(request('alice'), alice.res);
    assert.deepEqual(alice.body.tips.map(t => t.id), pool.slice(1, 4).map(t => t.id));
    assert.equal(alice.headers['Cache-Control'], 'no-store');
    assert.equal(statements.length, 3);
    assert.ok(statements.every(sql => /^select /i.test(sql) && /where /i.test(sql)));
    db.removeListener('query', listener);
    const bob = response<UsageTipsResponse>(); await routes.get(request('bob'), bob.res); assert.equal(bob.body.tips[0].id, pool[0].id);
    now += 45 * USAGE_TIPS_DAY_MS;
    const expired = response<UsageTipsResponse>(); await routes.get(request('alice'), expired.res); assert.equal(expired.body.tips[0].id, pool[0].id);
    assert.equal((await db('usage_tip_dismissals').first()).dismissal_count, 1);
    await db('system_configs').where({ key: 'usage_tips_enabled' }).update({ value: 'false' });
    const disabled = response(); await routes.get(request('bob'), disabled.res); assert.deepEqual(disabled.body, { enabled: false, tips: [] });
  } finally { await db.destroy(); }
});

test('API and CLI validate the usage tips setting and no longer accept a cooldown', async () => {
  assert.equal(isValidSettingKey('usage_tips_dismissal_cooldown_days'), false);
  assert.equal(isValidSettingKey('usage_tips_enabled'), true);
  assert.equal(parseSettingValue('usage_tips_enabled', 'false'), false);
  assert.ok((await extractSettingSaves({ usage_tips_enabled: 'false' })).error);
  assert.equal((await extractSettingSaves({ usage_tips_enabled: false })).normalized.usage_tips_enabled, false);
});
