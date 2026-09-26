import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import express from 'express';
import {
  createApiPerformanceTimingMiddleware,
  timeApiMiddleware,
  timeApiRouteHandler,
  timeApiStage,
  type ApiPerformanceTimingRecord,
} from '../apiPerformanceTiming.js';

test('sampled API timing logs only bounded static attribution', async () => {
  const records: ApiPerformanceTimingRecord[] = [];
  const app = express();
  app.use('/api', createApiPerformanceTimingMiddleware({
    sampleRate: 1,
    random: () => 0,
    log: record => records.push(record),
  }));
  app.use('/api', timeApiMiddleware('authentication', async (_req, _res, next) => {
    await timeApiStage('auth.fixture', async () => undefined);
    next();
  }));
  app.use('/api', timeApiMiddleware('authorization', (_req, _res, next) => next()));
  app.get('/api/items/:id', timeApiRouteHandler('get', '/api/items/:id', async (_req, res) => {
    for (let index = 0; index < 30; index += 1) {
      await timeApiStage(`sql.fixture-${index}`, async () => undefined);
    }
    await timeApiStage('INVALID PRIVATE VALUE', async () => undefined);
    res.json({ ok: true });
  }));

  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/api/items/private-id?token=private-query`, {
      headers: { authorization: 'Bearer private-token' },
    });
    assert.equal(response.status, 200);
    await new Promise<void>(resolve => setImmediate(resolve));
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }

  assert.equal(records.length, 1);
  assert.equal(records[0].route, 'GET /api/items/:id');
  assert.equal(records[0].method, 'GET');
  assert.equal(records[0].status, 200);
  assert.ok(records[0].stages.authentication);
  assert.ok(records[0].stages.authorization);
  assert.ok(records[0].stages.route);
  assert.ok(Object.keys(records[0].stages).length <= 24);
  const serialized = JSON.stringify(records[0]);
  for (const privateValue of ['private-id', 'private-query', 'private-token', 'INVALID PRIVATE VALUE']) {
    assert.equal(serialized.includes(privateValue), false);
  }
});

test('API timing is disabled at a zero sample rate', () => {
  let logged = false;
  const middleware = createApiPerformanceTimingMiddleware({ sampleRate: 0, log: () => { logged = true; } });
  let nextCalls = 0;
  middleware({} as express.Request, {} as express.Response, (() => { nextCalls += 1; }) as express.NextFunction);
  assert.equal(nextCalls, 1);
  assert.equal(logged, false);
});
