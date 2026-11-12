import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { after, afterEach, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import knex, { type Knex } from 'knex';
import type { Request, Response } from 'express';
import { appendRepositoryEvent, closeConnection } from '@propr/core';
import { createRepositoryEventRoutes } from '../routes/repositoryEventRoutes.js';
import { activeRepositoryEventWaiterCount, waitForRepositoryEvents } from '../services/repositoryEventWait.js';

const migrations = fileURLToPath(new URL('../../core/src/db/migrations/', import.meta.url));
const repository = 'acme/app';
let db: Knex;

after(closeConnection);
beforeEach(async () => {
  db = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true, pool: { min: 1, max: 1 } });
  await db.migrate.latest({ directory: migrations });
});
afterEach(async () => {
  await db.destroy();
  assert.equal(activeRepositoryEventWaiterCount(), 0, 'no wake listener outlives its request');
});

/** A response that emits `close` like Express does when the client goes away. */
function connection() {
  const res = Object.assign(new EventEmitter(), {
    writableEnded: false,
    destroyed: false,
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) { res.statusCode = code; return res; },
    json(body: unknown) { res.body = body; res.writableEnded = true; return res; },
    disconnect() { res.destroyed = true; res.emit('close'); },
  });
  const req = { query: { repository, timeoutSeconds: '30' }, user: { id: '123' } } as unknown as Request;
  return { req, res };
}

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

test('a client that disconnects while authorization is pending never opens a waiter', async () => {
  const access = deferred();
  const waits: AbortSignal[] = [];
  const routes = createRepositoryEventRoutes({
    db,
    configuredRepositories: async () => [repository],
    verifyAccess: () => access.promise,
    waitForEvents: options => { waits.push(options.signal!); return waitForRepositoryEvents({ ...options, maxConcurrentPerOwner: 1 }); },
  });
  const { req, res } = connection();
  const pending = routes.waitEvents(req, res as unknown as Response);
  await new Promise(resolve => setTimeout(resolve, 10));
  res.disconnect();
  access.resolve();
  await pending;
  assert.deepEqual(waits, [], 'no wait is allocated for a closed connection');
  assert.equal(res.listenerCount('close'), 0);

  // The owner's (single) slot is free for a live request.
  const live = connection();
  live.req.query.timeoutSeconds = '0';
  await routes.waitEvents(live.req, live.res as unknown as Response);
  assert.equal(live.res.statusCode, 200);
  assert.equal((live.res.body as { outcome: string }).outcome, 'timeout');
});

test('a connection already destroyed before its close listener is attached never opens a waiter', async () => {
  let waits = 0;
  const routes = createRepositoryEventRoutes({
    db,
    configuredRepositories: async () => [repository],
    verifyAccess: async () => {},
    waitForEvents: async options => { waits++; return waitForRepositoryEvents(options); },
  });
  const { req, res } = connection();
  res.destroyed = true;
  await routes.waitEvents(req, res as unknown as Response);
  assert.equal(waits, 0);
  assert.equal(res.listenerCount('close'), 0);
});

test('a disconnect during the wait releases it, and every exit path removes the close listener', async () => {
  const routes = createRepositoryEventRoutes({ db, configuredRepositories: async () => [repository], verifyAccess: async () => {} });
  const { req, res } = connection();
  const pending = routes.waitEvents(req, res as unknown as Response);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(activeRepositoryEventWaiterCount(repository), 1);
  res.disconnect();
  await pending;
  assert.equal(activeRepositoryEventWaiterCount(repository), 0);
  assert.equal(res.listenerCount('close'), 0);

  // Denied authorization answers and removes the listener.
  const denied = createRepositoryEventRoutes({ db, configuredRepositories: async () => [], verifyAccess: async () => {} });
  const refused = connection();
  await denied.waitEvents(refused.req, refused.res as unknown as Response);
  assert.equal(refused.res.statusCode, 404);
  assert.equal(refused.res.listenerCount('close'), 0);

  // So does an unexpected authorization failure.
  const failing = createRepositoryEventRoutes({ db, configuredRepositories: async () => { throw new Error('config unavailable'); } });
  const failed = connection();
  await assert.rejects(failing.waitEvents(failed.req, failed.res as unknown as Response), /config unavailable/);
  assert.equal(failed.res.listenerCount('close'), 0);
});

test('an explicitly empty or non-string afterCursor is a cursor error on both endpoints, not a fresh boundary', async () => {
  const appended = await appendRepositoryEvent(db, {
    repository, domain: 'pull_request', type: 'head_changed', entityId: 7, prNumber: 7, headSha: 'a'.repeat(40), payload: {},
  }, { publish: false });
  assert.equal(appended.status, 'appended', 'the repository has an event the caller has not read');
  const calls: string[] = [];
  const routes = createRepositoryEventRoutes({
    db,
    configuredRepositories: async () => [repository],
    verifyAccess: async () => {},
    listEvents: async () => { calls.push('list'); throw new Error('no read for a malformed cursor'); },
    waitForEvents: async () => { calls.push('wait'); throw new Error('no wait for a malformed cursor'); },
  });
  // `?afterCursor=` and `?afterCursor` parse to '', `?afterCursor[x]=y` to an object.
  for (const afterCursor of ['', [''], { x: 'y' }, [{ x: 'y' }]]) {
    for (const endpoint of ['listEvents', 'waitEvents'] as const) {
      const { req, res } = connection();
      req.query = { ...req.query, afterCursor } as Request['query'];
      await routes[endpoint](req, res as unknown as Response);
      assert.equal(res.statusCode, 400, `${endpoint} ${JSON.stringify(afterCursor)}`);
      const body = res.body as { code: string; cursor?: unknown; hint?: unknown };
      assert.equal(body.code, 'CURSOR_INVALID');
      assert.equal(typeof body.hint, 'string');
      assert.equal(body.cursor, undefined, 'no replacement cursor is returned');
      assert.equal(res.listenerCount('close'), 0);
    }
  }
  assert.deepEqual(calls, [], 'the journal is never read from a substituted boundary');

  // The real journal service on the same input also refuses rather than answering at the end.
  const real = createRepositoryEventRoutes({ db, configuredRepositories: async () => [repository], verifyAccess: async () => {} });
  for (const endpoint of ['listEvents', 'waitEvents'] as const) {
    const { req, res } = connection();
    req.query = { ...req.query, afterCursor: '' } as Request['query'];
    await real[endpoint](req, res as unknown as Response);
    assert.equal(res.statusCode, 400);
    assert.equal((res.body as { code: string }).code, 'CURSOR_INVALID');
  }

  // An absent afterCursor still starts at the current end.
  const absent = connection();
  await real.listEvents(absent.req, absent.res as unknown as Response);
  assert.equal(absent.res.statusCode, 200);
  assert.deepEqual((absent.res.body as { events: unknown[] }).events, []);
});
