import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { Knex } from 'knex';
import { createDashboardRoutes } from '../routes/dashboardRoutes.js';
import { call } from './dashboardTestHarness.js';

const unreadable = (() => { throw new Error('Must not query'); }) as unknown as Knex;

test('narrative status reports the opt-in without reading data or resolving a model', async () => {
  for (const enabled of [false, true]) {
    const routes = createDashboardRoutes({
      db: unreadable, redisClient: {} as never, taskQueue: {} as never,
      isSummaryEnabled: async () => enabled,
      narrativeModel: async () => { assert.fail('Must not resolve model'); },
    });
    const result = await call(routes.getNarrativeStatus);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { enabled });
  }
});

test('an unreadable opt-in is a retryable 503, not a confirmed disablement', async () => {
  const routes = createDashboardRoutes({
    db: unreadable, redisClient: {} as never, taskQueue: {} as never,
    isSummaryEnabled: async () => { throw new Error('Config unavailable'); },
  });
  const result = await call(routes.getNarrativeStatus);
  assert.equal(result.status, 503);
  assert.deepEqual(result.body, { error: 'Dashboard summary status is unavailable' });
});

// The production dependency over a real config table: only a missing setting
// is the default-off answer; a failed read or parse must reach the 503 above.
test('the production opt-in read keeps missing as off and unreadable as 503', async () => {
  const isolatedDir = await mkdtemp(path.join(tmpdir(), 'propr-dashboard-summary-setting-'));
  const originalEnv = { NODE_ENV: process.env.NODE_ENV, DATA_DIR: process.env.DATA_DIR, DB_FILENAME: process.env.DB_FILENAME };
  Object.assign(process.env, { NODE_ENV: 'test', DATA_DIR: isolatedDir, DB_FILENAME: path.join(isolatedDir, 'propr.sqlite') });
  const { db, runMigrations, closeConnection } = await import('@propr/core');
  const { isDashboardSummaryEnabled } = await import('../routes/dashboardSummarySetting.js');
  try {
    await runMigrations();
    const status = () => call(createDashboardRoutes({
      db: unreadable, redisClient: {} as never, taskQueue: {} as never, isSummaryEnabled: isDashboardSummaryEnabled,
    }).getNarrativeStatus);
    const setValue = (value: string) => db('system_configs').insert({ key: 'dashboard_summary_enabled', value }).onConflict('key').merge();

    assert.deepEqual(await status(), { status: 200, body: { enabled: false } });
    await setValue('true');
    assert.deepEqual(await status(), { status: 200, body: { enabled: true } });
    await setValue('{not json');
    assert.deepEqual(await status(), { status: 503, body: { error: 'Dashboard summary status is unavailable' } });
    await setValue('true');
    await db.schema.renameTable('system_configs', 'system_configs_offline');
    try {
      assert.deepEqual(await status(), { status: 503, body: { error: 'Dashboard summary status is unavailable' } });
    } finally {
      await db.schema.renameTable('system_configs_offline', 'system_configs');
    }
    assert.deepEqual(await status(), { status: 200, body: { enabled: true } });
  } finally {
    await closeConnection();
    await rm(isolatedDir, { recursive: true, force: true });
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
