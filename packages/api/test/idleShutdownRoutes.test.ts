import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { Request, Response } from 'express';
import {
  IDLE_ACTIVITY_REDIS_PREFIX,
  IDLE_SHUTDOWN_ACKS_REDIS_PREFIX,
  IDLE_STATUS_REDIS_KEY,
  IDLE_WAKE_SIGNAL_REDIS_KEY,
  type StoredIdleShutdownSetting,
} from '@propr/shared';
import {
  closeConnection,
  idleActivity,
  issueIdleShutdownIntent,
  newIdleShutdownIntent,
  parseIdleActivity,
  waitForIdleAcks,
  withdrawIdleShutdownIntent,
} from '@propr/core';
import { createIdleShutdownRoutes } from '../routes/idleShutdownRoutes.js';
import { classifyIdleRequest, createIdleActivityMiddleware, createWakeHandler, startApiIdleShutdown } from '../idleShutdownIntegration.js';

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

test('a malformed stored setting is reported as unavailable, and a full update replaces it', async () => {
  let stored: StoredIdleShutdownSetting | null = null;
  let malformed = true;
  const handlers = createIdleShutdownRoutes({
    env: {},
    redisClient: { get: async () => null },
    loadStored: async () => { if (malformed) throw new Error('The stored idle_shutdown setting is malformed'); return stored; },
    saveStored: async setting => { stored = setting; malformed = false; return true; },
  });
  const get = await call(handlers.getSettings);
  assert.equal(get.statusCode, 503);
  assert.equal((get.body as { code: string }).code, 'SETTINGS_UNAVAILABLE');
  // Keeping the stored window needs the stored window.
  assert.equal((await call(handlers.putSettings, { enabled: true })).statusCode, 503);
  assert.equal(stored, null);
  const put = await call(handlers.putSettings, { enabled: true, after: '20m' });
  assert.equal(put.statusCode, 200);
  assert.deepEqual(stored, { enabled: true, afterMs: 1_200_000 });
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
  const second = response();
  middleware({ path: '/api/tasks' } as Request, second as unknown as Response, () => undefined);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(writes, [[IDLE_WAKE_SIGNAL_REDIS_KEY, 'http']]);
  second.emit('close');
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

/** Shared Redis state; `duplicate()` opens another connection on it, like ioredis. */
class FakeRedis {
  constructor(
    private readonly state: { strings: Map<string, string>; hashes: Map<string, Map<string, string>>; rejectActivityWrites: boolean; connections: FakeRedis[] } = {
      strings: new Map(), hashes: new Map(), rejectActivityWrites: false, connections: [],
    },
  ) { state.connections.push(this); }
  private listeners: Record<string, Array<(...args: string[]) => void>> = {};
  private channels = new Set<string>();
  get strings() { return this.state.strings; }
  set rejectActivityWrites(reject: boolean) { this.state.rejectActivityWrites = reject; }
  duplicate() { return new FakeRedis(this.state); }
  on(event: string, listener: (...args: string[]) => void) { (this.listeners[event] ||= []).push(listener); return this; }
  async subscribe(channel: string) { this.channels.add(channel); }
  async publish(channel: string, message: string) {
    for (const connection of this.state.connections) {
      if (connection.channels.has(channel)) for (const listener of connection.listeners.message ?? []) listener(channel, message);
    }
    return 1;
  }
  async get(key: string) { return this.state.strings.get(key) ?? null; }
  async set(key: string, value: string) {
    if (this.state.rejectActivityWrites && key.startsWith(IDLE_ACTIVITY_REDIS_PREFIX)) throw new Error('OOM command not allowed');
    this.state.strings.set(key, value);
    return 'OK';
  }
  async del(key: string) { return this.state.strings.delete(key) ? 1 : 0; }
  async expire() { return 1; }
  async hset(key: string, field: string, value: string) {
    if (!this.state.hashes.has(key)) this.state.hashes.set(key, new Map());
    this.state.hashes.get(key)!.set(field, value);
    return 1;
  }
  async hdel(key: string, field: string) { return this.state.hashes.get(key)?.delete(field) ? 1 : 0; }
  async hgetall(key: string) { return Object.fromEntries(this.state.hashes.get(key) ?? []); }
  async quit() { return 'OK'; }
}

test('a quiesced API does not acknowledge while its activity record cannot be written', async () => {
  const redis = new FakeRedis();
  let sessions = 0;
  const inFlight = idleActivity.snapshot();
  assert.equal(inFlight.httpRequests + inFlight.mcpRequests, 0, 'no request is in flight, so the drain itself does not delay the acknowledgement');
  const stop = startApiIdleShutdown({ redis: redis as never, countSessions: () => sessions });
  try {
    await new Promise(resolve => setTimeout(resolve, 20));
    const activityKey = [...redis.strings.keys()].find(key => key.startsWith(IDLE_ACTIVITY_REDIS_PREFIX))!;
    assert.equal(parseIdleActivity(redis.strings.get(activityKey) ?? null)?.uiSessions, 0, 'an earlier quiet record');

    // A Web UI session opens, but activity writes now fail: the quiet record stays (and stays fresh).
    redis.rejectActivityWrites = true;
    sessions = 1;
    const intent = newIdleShutdownIntent('quiesce', 'idle');
    await issueIdleShutdownIntent(redis as never, intent);
    const unconfirmed = await waitForIdleAcks(redis as never, intent, { roles: ['api'], timeoutMs: 6_000, pollMs: 50 });
    assert.equal(unconfirmed.confirmed, false, 'the daemon never gets to re-check against the earlier quiet record');
    assert.deepEqual(await redis.hgetall(`${IDLE_SHUTDOWN_ACKS_REDIS_PREFIX}${intent.id}`), {});
    assert.equal(parseIdleActivity(redis.strings.get(activityKey) ?? null)?.uiSessions, 0);

    // Once the record can be written, the retried quiesce publishes the session and acknowledges.
    redis.rejectActivityWrites = false;
    const confirmed = await waitForIdleAcks(redis as never, intent, { roles: ['api'], timeoutMs: 8_000, pollMs: 50 });
    assert.equal(confirmed.confirmed, true);
    assert.equal(parseIdleActivity(redis.strings.get(activityKey) ?? null)?.uiSessions, 1, 'the acknowledged record shows the open session');
    await withdrawIdleShutdownIntent(redis as never, intent.id);
  } finally {
    await stop();
  }
});
