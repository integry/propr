import assert from 'node:assert/strict';
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

test('an unreadable opt-in reports the summary as off', async () => {
  const routes = createDashboardRoutes({
    db: unreadable, redisClient: {} as never, taskQueue: {} as never,
    isSummaryEnabled: async () => { throw new Error('Config unavailable'); },
  });
  assert.deepEqual((await call(routes.getNarrativeStatus)).body, { enabled: false });
});
