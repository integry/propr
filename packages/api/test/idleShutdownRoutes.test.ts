import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { Request, Response } from 'express';
import { IDLE_STATUS_REDIS_KEY, IDLE_WAKE_SIGNAL_REDIS_KEY, type StoredIdleShutdownSetting } from '@propr/shared';
import { closeConnection, idleActivity } from '@propr/core';
import { createIdleShutdownRoutes } from '../routes/idleShutdownRoutes.js';
import { classifyIdleRequest, createIdleActivityMiddleware, createWakeHandler } from '../idleShutdownIntegration.js';

after(() => closeConnection());

function response() {
  const listeners: Record<string, Array<() => void>> = {};
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    status(code: number) { this.statusCode = code; return this; },
    setHeader(name: string, value: string) { this.headers[name] = value; return this; },
    json(value: unknown) { this.body = value; return this; },
    once(event: string, listener: () => void) { (listeners[event] ||= []).push(listener); return this; },
    emit(event: string) { for (const listener of listeners[event] ?? []) listener(); },
  };
  return res;
}

function routes(env: NodeJS.ProcessEnv = {}, status: unknown = null) {
  let stored: StoredIdleShutdownSetting | null = null;
  const handlers = createIdleShutdownRoutes({
    env,
    redisClient: { get: async key => (key === IDLE_STATUS_REDIS_KEY && status ? JSON.stringify(status) : null) },
    loadStored: async () => stored,
    saveStored: async setting => { stored = setting; return true; },
  });
  return { handlers, stored: () => stored };
}

const call = async (handler: (req: Request, res: Response) => Promise<void>, body?: unknown) => {
  const res = response();
  await handler({ body } as Request, res as unknown as Response);
  return res;
};

test('GET reports off by default', async () => {
  const { handlers } = routes();
  const res = await call(handlers.getSettings);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, {
    enabled: false, afterMs: 900_000, after: '15m', source: 'default', environmentManaged: false,
    environment: { PROPR_IDLE_SHUTDOWN: null, PROPR_IDLE_SHUTDOWN_AFTER: null }, warnings: [], status: null,
  });
});

test('PUT saves the instance setting and returns the effective value', async () => {
  const { handlers, stored } = routes();
  const res = await call(handlers.putSettings, { enabled: true, after: '30m' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(stored(), { enabled: true, afterMs: 1_800_000 });
  assert.equal((res.body as { source: string }).source, 'settings');
  assert.equal((res.body as { after: string }).after, '30m');
  // Turning it off keeps the window.
  await call(handlers.putSettings, { enabled: false });
  assert.deepEqual(stored(), { enabled: false, afterMs: 1_800_000 });
});

test('PUT rejects invalid bodies and windows', async () => {
  const { handlers, stored } = routes();
  assert.equal((await call(handlers.putSettings, { enabled: 'yes' })).statusCode, 400);
  assert.equal((await call(handlers.putSettings, { enabled: true, after: '10s' })).statusCode, 400);
  assert.equal((await call(handlers.putSettings, { enabled: true, extra: 1 })).statusCode, 400);
  assert.equal(stored(), null);
});

test('the environment pins the setting', async () => {
  const { handlers, stored } = routes({ PROPR_IDLE_SHUTDOWN: 'on', PROPR_IDLE_SHUTDOWN_AFTER: '5m' });
  const get = await call(handlers.getSettings);
  assert.equal((get.body as { environmentManaged: boolean }).environmentManaged, true);
  assert.equal((get.body as { enabled: boolean }).enabled, true);
  const put = await call(handlers.putSettings, { enabled: false });
  assert.equal(put.statusCode, 409);
  assert.equal((put.body as { code: string }).code, 'ENVIRONMENT_MANAGED');
  assert.equal(stored(), null);
});

test('GET includes the daemon status when published', async () => {
  const status = { enabled: true, afterMs: 900_000, source: 'environment', idle: false, idleSince: null, shutdownAt: null,
    blockers: [{ signal: 'ui_sessions', detail: '1 open Web UI session' }], nextDueAt: null, checkedAt: new Date().toISOString(), lastShutdown: null, lastWake: null };
  const { handlers } = routes({}, status);
  const res = await call(handlers.getSettings);
  assert.deepEqual((res.body as { status: unknown }).status, status);
});

test('health checks and wake pings are not activity; MCP and other requests are', () => {
  assert.equal(classifyIdleRequest('/health'), null);
  assert.equal(classifyIdleRequest('/wake'), null);
  assert.equal(classifyIdleRequest('/api/mcp'), 'mcp');
  assert.equal(classifyIdleRequest('/mcp/authorize'), 'mcp');
  assert.equal(classifyIdleRequest('/api/tasks'), 'http');
});

test('the middleware counts a request until its response closes and records the first request as the wake', async () => {
  const writes: Array<[string, string]> = [];
  const redis = { set: async (key: string, value: string) => { writes.push([key, value]); return 'OK' as const; } };
  const middleware = createIdleActivityMiddleware(() => redis as never);
  const res = response();
  let nexted = false;
  middleware({ path: '/api/tasks' } as Request, res as unknown as Response, () => { nexted = true; });
  assert.equal(nexted, true);
  assert.equal(idleActivity.snapshot().httpRequests, 1);
  res.emit('finish');
  res.emit('close');
  assert.equal(idleActivity.snapshot().httpRequests, 0);
  middleware({ path: '/api/tasks' } as Request, response() as unknown as Response, () => undefined);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(writes, [[IDLE_WAKE_SIGNAL_REDIS_KEY, 'http']]);
});

test('while the daemon drains, a quiesced API turns requests away and records them as activity', async () => {
  const middleware = createIdleActivityMiddleware(() => null);
  const before = idleActivity.snapshot();
  idleActivity.quiesce('intent-1');
  try {
    const res = response();
    let nexted = false;
    await new Promise(resolve => setTimeout(resolve, 2));
    middleware({ path: '/api/tasks' } as Request, res as unknown as Response, () => { nexted = true; });
    assert.equal(nexted, false, 'no new request can produce work during the drain');
    assert.equal(res.statusCode, 503);
    assert.equal(res.headers['Retry-After'], '5');
    const during = idleActivity.snapshot();
    assert.equal(during.httpRequests, before.httpRequests, 'a refused request is not in flight');
    assert.ok(during.lastRequestAt > before.lastRequestAt, 'but it is activity, so the daemon aborts the drain');
    let probed = false;
    middleware({ path: '/health' } as Request, response() as unknown as Response, () => { probed = true; });
    assert.equal(probed, true, 'health probes still pass');
  } finally {
    idleActivity.resume();
  }
  let resumed = false;
  const res = response();
  middleware({ path: '/api/tasks' } as Request, res as unknown as Response, () => { resumed = true; });
  res.emit('close');
  assert.equal(resumed, true);
});

test('/wake answers at once and records a Connect wake ping', async () => {
  const writes: unknown[][] = [];
  const handler = createWakeHandler(() => ({ set: async (...args: unknown[]) => { writes.push(args); return 'OK'; } }) as never);
  const res = response();
  handler({} as Request, res as unknown as Response, () => undefined);
  assert.equal(res.statusCode, 202);
  assert.deepEqual(res.body, { status: 'awake' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(writes, [[IDLE_WAKE_SIGNAL_REDIS_KEY, 'connect_ping', 'EX', 300, 'NX']]);
});
