import assert from 'node:assert/strict';
import { networkInterfaces } from 'node:os';
import { after, test } from 'node:test';
import express from 'express';
import session from 'express-session';
import {
  configureApiProxyTrust,
  createRequestRateLimiter,
  resolveRequestRateLimitPolicies,
} from '../requestRateLimits.js';

interface TestAppOptions {
  proxyEnvironment?: Record<string, string | undefined>;
  remoteAddress?: string;
  secureSession?: boolean;
}

async function listenTestApp(app: ReturnType<typeof express>): Promise<{ origin: string; close: () => Promise<void> }> {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    }),
  };
}

async function startTestApp(
  limit = 2,
  options: TestAppOptions = {},
): Promise<{ origin: string; close: () => Promise<void> }> {
  const app = express();
  if (options.proxyEnvironment) configureApiProxyTrust(app, options.proxyEnvironment);
  if (options.remoteAddress) {
    app.use((request, _response, next) => {
      Object.defineProperty(request.socket, 'remoteAddress', {
        configurable: true,
        value: options.remoteAddress,
      });
      next();
    });
  }
  app.use(createRequestRateLimiter({ identifier: 'test', limit, windowMs: 60_000 }));
  if (options.secureSession) {
    app.use(session({
      secret: 'production-shaped-proxy-test-secret',
      resave: false,
      saveUninitialized: true,
      cookie: { secure: true, httpOnly: true, sameSite: 'lax' },
    }));
  }
  app.all('/resource', (_request, response) => response.json({ ok: true }));
  return listenTestApp(app);
}

const openServers: Array<() => Promise<void>> = [];
after(async () => Promise.all(openServers.map(close => close())));

test('returns a standard 429 response after the configured quota', async () => {
  const app = await startTestApp();
  openServers.push(app.close);

  const first = await fetch(`${app.origin}/resource`);
  const second = await fetch(`${app.origin}/resource`);
  const limited = await fetch(`${app.origin}/resource`);

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(limited.status, 429);
  assert.match(limited.headers.get('ratelimit') ?? '', /"test"/);
  assert.deepEqual(await limited.json(), {
    code: 'RATE_LIMIT_EXCEEDED',
    error: 'Too many requests. Please try again later.',
  });
});

test('does not charge CORS preflight requests against the quota', async () => {
  const app = await startTestApp(1);
  openServers.push(app.close);

  assert.equal((await fetch(`${app.origin}/resource`, { method: 'OPTIONS' })).status, 200);
  assert.equal((await fetch(`${app.origin}/resource`)).status, 200);
  assert.equal((await fetch(`${app.origin}/resource`)).status, 429);
});

test('route-level webhook limiting preserves alternate-case raw bodies and rejects excess requests before parsing', async () => {
  const app = express();
  let bodyParserRuns = 0;
  let rawBodySeen = false;
  app.post(
    '/webhook',
    createRequestRateLimiter({ identifier: 'webhook-test', limit: 1, windowMs: 60_000 }),
    (_request, _response, next) => {
      bodyParserRuns++;
      next();
    },
    express.raw({ type: 'application/json' }),
    (request, response) => {
      rawBodySeen = Buffer.isBuffer(request.body);
      response.sendStatus(204);
    },
  );
  app.use(express.json());
  const server = await listenTestApp(app);
  openServers.push(server.close);

  const request = (): Promise<Response> => fetch(`${server.origin}/WEBHOOK`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"event":"test"}',
  });

  assert.equal((await request()).status, 204);
  assert.equal((await request()).status, 429);
  assert.equal(bodyParserRuns, 1);
  assert.equal(rawBodySeen, true);
});

test('does not let an unconfigured private peer rotate quota buckets with X-Forwarded-For', async () => {
  const app = await startTestApp(2, {
    proxyEnvironment: { PROPR_TRUSTED_PROXY_PEERS: '10.0.0.2' },
    remoteAddress: '10.0.0.3',
  });
  openServers.push(app.close);

  const first = await fetch(`${app.origin}/resource`, {
    headers: { 'X-Forwarded-For': '192.0.2.1' },
  });
  const second = await fetch(`${app.origin}/resource`, {
    headers: { 'X-Forwarded-For': '192.0.2.2' },
  });
  const limited = await fetch(`${app.origin}/resource`, {
    headers: { 'X-Forwarded-For': '192.0.2.3' },
  });

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(limited.status, 429);
});

test('tunnel trust does not let an unrelated private peer rotate quota buckets', async () => {
  const assignedAddresses = new Set(
    Object.values(networkInterfaces()).flatMap(interfaces =>
      (interfaces ?? []).map(networkInterface => networkInterface.address)),
  );
  const privatePeer = Array.from({ length: 254 }, (_, index) => `10.255.255.${index + 1}`)
    .find(address => !assignedAddresses.has(address));
  assert.ok(privatePeer);

  const app = await startTestApp(2, {
    proxyEnvironment: { PROPR_TRUSTED_PROXY_PEERS: 'self' },
    remoteAddress: privatePeer,
  });
  openServers.push(app.close);

  const first = await fetch(`${app.origin}/resource`, {
    headers: { 'X-Forwarded-For': '192.0.2.1' },
  });
  const second = await fetch(`${app.origin}/resource`, {
    headers: { 'X-Forwarded-For': '192.0.2.2' },
  });
  const limited = await fetch(`${app.origin}/resource`, {
    headers: { 'X-Forwarded-For': '192.0.2.3' },
  });

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(limited.status, 429);
});

test('trusted TLS proxy preserves per-client quotas and secure session cookies', async () => {
  const app = await startTestApp(1, {
    proxyEnvironment: { PROPR_TRUSTED_PROXY_PEERS: '10.0.0.2' },
    remoteAddress: '10.0.0.2',
    secureSession: true,
  });
  openServers.push(app.close);

  const firstClient = await fetch(`${app.origin}/resource`, {
    headers: {
      'X-Forwarded-For': '192.0.2.1',
      'X-Forwarded-Proto': 'https',
    },
  });
  const secondClient = await fetch(`${app.origin}/resource`, {
    headers: {
      'X-Forwarded-For': '192.0.2.2',
      'X-Forwarded-Proto': 'https',
    },
  });
  const limited = await fetch(`${app.origin}/resource`, {
    headers: {
      'X-Forwarded-For': '192.0.2.2',
      'X-Forwarded-Proto': 'https',
    },
  });

  assert.equal(firstClient.status, 200);
  assert.equal(secondClient.status, 200);
  assert.equal(limited.status, 429);
  assert.match(firstClient.headers.get('set-cookie') ?? '', /; Secure(?:;|$)/i);
});

test('resolves secure defaults and explicit positive-integer overrides', () => {
  const defaults = resolveRequestRateLimitPolicies({});
  assert.deepEqual(defaults.api, { identifier: 'api', limit: 600, windowMs: 60_000 });
  assert.deepEqual(defaults.auth, { identifier: 'auth', limit: 30, windowMs: 900_000 });
  assert.deepEqual(defaults.webhook, { identifier: 'webhook', limit: 300, windowMs: 60_000 });

  const configured = resolveRequestRateLimitPolicies({
    PROPR_API_RATE_LIMIT_MAX: '42',
    PROPR_AUTH_RATE_LIMIT_WINDOW_MS: '120000',
  });
  assert.equal(configured.api.limit, 42);
  assert.equal(configured.auth.windowMs, 120_000);
});

test('rejects invalid overrides instead of silently disabling protection', () => {
  assert.throws(
    () => resolveRequestRateLimitPolicies({ PROPR_WEBHOOK_RATE_LIMIT_MAX: '0' }),
    /must be a positive integer/,
  );
  assert.throws(
    () => resolveRequestRateLimitPolicies({ PROPR_API_RATE_LIMIT_WINDOW_MS: '1.5' }),
    /must be a positive integer/,
  );
  assert.equal(
    resolveRequestRateLimitPolicies({ PROPR_API_RATE_LIMIT_WINDOW_MS: '2147483647' }).api.windowMs,
    2_147_483_647,
  );
  assert.throws(
    () => resolveRequestRateLimitPolicies({ PROPR_API_RATE_LIMIT_WINDOW_MS: '2147483648' }),
    /must be at most 2147483647/,
  );
});
