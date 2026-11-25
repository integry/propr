import { test, describe, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert';
import crypto from 'crypto';
import http from 'node:http';
import express, { Request, Response } from 'express';
import { handleWebhookRequest, WEBHOOK_DELIVERY_TTL_SECONDS } from '../packages/api/webhookHandler.js';
import { recoverDirectWebhooks } from '../src/daemon/directWebhookRecovery.js';
import { closeConnection } from '@propr/core';

after(async () => {
  await closeConnection();
});

/**
 * Webhook Replay Protection Tests
 *
 * These tests exercise the exported `handleWebhookRequest` handler from
 * packages/api/webhookHandler.ts — the same function used in production — via
 * a thin Express wrapper that only supplies the raw-body middleware. Importing
 * the standalone module avoids triggering server startup side effects.
 *
 * Covers:
 * - Missing delivery ID rejection (400)
 * - Array-valued delivery ID rejection (400)
 * - First delivery accepted (200)
 * - Duplicate delivery rejected (409)
 * - Signature verification (401), including malformed signature lengths and multi-valued headers
 * - Missing x-github-event header rejection (400)
 * - Unsupported event type ignored with 200 (e.g. ping)
 * - Redis key storage with correct TTL
 * - Failed processing retains Redis key to block duplicate side effects
 * - Parse failure returns generic 400 and retains Redis key
 * - Fail-closed behavior when webhook secret is not configured (500)
 */

const WEBHOOK_SECRET = 'test-webhook-secret';

interface StoredEntry {
  value: string;
  expiresAt: number;
}

function createMockRedisClient(now = Date.now) {
  const store = new Map<string, StoredEntry>();
  return {
    store,
    set: async (key: string, value: string, opts: { GET: true; EX: number }) => {
      const time = now();
      const previous = store.get(key);
      store.set(key, { value, expiresAt: time + opts.EX * 1000 });
      assert.equal(opts.GET, true);
      return previous && previous.expiresAt > time ? previous.value : null;
    },
  };
}

function signPayload(body: string, secret: string): string {
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(body);
  return `sha256=${hmac.digest('hex')}`;
}

/**
 * Creates a minimal Express app that wires the production `handleWebhookRequest`
 * with injectable dependencies (mock Redis, configurable processor).
 */
function createTestApp(
  redisClient: ReturnType<typeof createMockRedisClient>,
  processor: (payload: Record<string, unknown>, event: string, correlationId: string, deliveryId: string) => Promise<void> = async () => {},
) {
  const app = express();
  app.use('/webhook', express.raw({ type: 'application/json' }));

  app.post('/webhook', async (req: Request, res: Response) => {
    try {
      await handleWebhookRequest(req, res, {
        webhookSecret: WEBHOOK_SECRET,
        redis: redisClient,
        processor,
        correlationId: 'test-correlation-id',
      });
    } catch (error) {
      if (!res.headersSent) {
        res.status(500).send((error as Error).message);
      }
    }
  });

  return app;
}

function makeBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    action: 'opened',
    issue: { id: 1, number: 42, title: 'Test issue', updated_at: new Date().toISOString() },
    repository: { full_name: 'test/repo' },
    ...overrides,
  });
}

function sendWebhook(
  server: http.Server,
  body: string,
  headers: Record<string, string | string[]>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const req = http.request(
      { hostname: '127.0.0.1', port: addr.port, path: '/webhook', method: 'POST', headers: { 'content-type': 'application/json', ...headers } },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve({ status: res.statusCode!, body: data }));
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

describe('Webhook Replay Protection', () => {
  let redisClient: ReturnType<typeof createMockRedisClient>;
  let server: http.Server;
  let now: number;
  let processed: number;

  beforeEach(async () => {
    now = Date.UTC(2026, 10, 1);
    processed = 0;
    redisClient = createMockRedisClient(() => now);
    const app = createTestApp(redisClient, async () => { processed++; });
    server = app.listen(0);
    await new Promise<void>((resolve) => server.on('listening', resolve));
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  describe('Missing delivery ID', () => {
    test('rejects request with no x-github-delivery header', async () => {
      const body = makeBody();
      const res = await sendWebhook(server, body, {
        'x-hub-signature-256': signPayload(body, WEBHOOK_SECRET),
      });
      assert.strictEqual(res.status, 400);
      assert.match(res.body, /Missing x-github-delivery/);
    });
  });

  describe('Array-valued delivery ID', () => {
    test('rejects request with multi-valued x-github-delivery header', async () => {
      const body = makeBody();
      const res = await sendWebhook(server, body, {
        'x-hub-signature-256': signPayload(body, WEBHOOK_SECRET),
        'x-github-delivery': ['id-1', 'id-2'],
      });
      assert.strictEqual(res.status, 400);
      assert.match(res.body, /Invalid x-github-delivery/);
    });
  });

  describe('Duplicate delivery rejection', () => {
    test('accepts first delivery', async () => {
      const body = makeBody();
      const res = await sendWebhook(server, body, {
        'x-hub-signature-256': signPayload(body, WEBHOOK_SECRET),
        'x-github-delivery': 'unique-delivery-001',
        'x-github-event': 'issues',
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body, 'Webhook processed.');
    });

    test('rejects second delivery with same ID', async () => {
      const body1 = makeBody({ nonce: 'first' });
      const body2 = makeBody({ nonce: 'second' });

      const first = await sendWebhook(server, body1, {
        'x-hub-signature-256': signPayload(body1, WEBHOOK_SECRET),
        'x-github-delivery': 'unique-delivery-002',
        'x-github-event': 'issues',
      });
      assert.strictEqual(first.status, 200);

      const second = await sendWebhook(server, body2, {
        'x-hub-signature-256': signPayload(body2, WEBHOOK_SECRET),
        'x-github-delivery': 'unique-delivery-002',
        'x-github-event': 'issues',
      });
      assert.strictEqual(second.status, 409);
      assert.match(second.body, /Duplicate webhook delivery/);
    });

    test('idle recovery rejects a recent duplicate after the original reservation would expire', async () => {
      const guid = 'retained-across-idle-stop';
      const body = makeBody();
      const deliver = () => sendWebhook(server, body, {
        'x-hub-signature-256': signPayload(body, WEBHOOK_SECRET),
        'x-github-event': 'issues',
        'x-github-delivery': guid,
      });

      assert.equal((await deliver()).status, 200);
      now += WEBHOOK_DELIVERY_TTL_SECONDS * 1000 - 100;
      const duplicate = await deliver();
      assert.equal(duplicate.status, 409);
      const deliveredAt = new Date(now).toISOString();
      now += 200;

      // GitHub's visible history contains only the rejected attempt.
      const result = await recoverDirectWebhooks(deliveredAt, {
        async list() {
          return {
            deliveries: [{ id: 2, guid, delivered_at: deliveredAt, status_code: duplicate.status, status: 'Failure' }],
            next: null,
            exhausted: false,
          };
        },
        async redeliver(id) {
          assert.equal(id, 2);
          assert.equal((await deliver()).status, 409);
          return false;
        },
      });
      assert.deepEqual(result, { scanned: 1, failed: 1, redelivered: 1, skipped: 0 });
      assert.equal(processed, 1);
    });

    test('accepts different delivery IDs with same body', async () => {
      const body = makeBody();

      const first = await sendWebhook(server, body, {
        'x-hub-signature-256': signPayload(body, WEBHOOK_SECRET),
        'x-github-delivery': 'delivery-aaa',
        'x-github-event': 'issues',
      });
      assert.strictEqual(first.status, 200);

      // Same body, different delivery ID — should be accepted (GitHub may
      // legitimately re-send the same payload with a new delivery ID)
      const second = await sendWebhook(server, body, {
        'x-hub-signature-256': signPayload(body, WEBHOOK_SECRET),
        'x-github-delivery': 'delivery-bbb',
        'x-github-event': 'issues',
      });
      assert.strictEqual(second.status, 200);
    });
  });

  test('a redelivery while the original is still processing runs the processor once', async () => {
    let calls = 0;
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const app = createTestApp(redisClient, async () => {
      calls++;
      started.resolve();
      await finish.promise;
    });
    const listener = app.listen(0);
    await new Promise<void>(resolve => listener.on('listening', resolve));
    const body = makeBody();
    const headers = {
      'x-hub-signature-256': signPayload(body, WEBHOOK_SECRET),
      'x-github-event': 'issues',
      'x-github-delivery': 'same-waking-delivery',
    };
    const original = sendWebhook(listener, body, headers);
    try {
      await started.promise;
      assert.equal((await sendWebhook(listener, body, headers)).status, 409);
      assert.equal(calls, 1);
    } finally {
      finish.resolve();
      await new Promise<void>(resolve => listener.close(() => resolve()));
    }
    assert.equal((await original).status, 200);
  });

  describe('Redis key storage', () => {
    test('stores delivery ID with correct key prefix and TTL', async () => {
      const body = makeBody();
      await sendWebhook(server, body, {
        'x-hub-signature-256': signPayload(body, WEBHOOK_SECRET),
        'x-github-delivery': 'test-delivery-123',
        'x-github-event': 'issues',
      });
      const entry = redisClient.store.get('webhook:delivery:test-delivery-123');
      assert.ok(entry, 'delivery key should be stored');
      assert.strictEqual(entry.expiresAt, now + WEBHOOK_DELIVERY_TTL_SECONDS * 1000, 'delivery key TTL should match exported constant');
    });

    test('does not store key when delivery ID is missing', async () => {
      const body = makeBody();
      await sendWebhook(server, body, {
        'x-hub-signature-256': signPayload(body, WEBHOOK_SECRET),
      });
      assert.strictEqual(redisClient.store.size, 0);
    });
  });

  describe('Failure keeps delivery ID reserved', () => {
    test('retains Redis key when processing fails to prevent duplicate side effects', async () => {
      const failRedis = createMockRedisClient();
      const failApp = createTestApp(failRedis, async () => {
        throw new Error('Simulated processing failure');
      });
      const failServer = failApp.listen(0);
      await new Promise<void>((resolve) => failServer.on('listening', resolve));

      try {
        const body = makeBody();
        const deliveryId = 'delivery-will-fail';

        const first = await sendWebhook(failServer, body, {
          'x-hub-signature-256': signPayload(body, WEBHOOK_SECRET),
          'x-github-delivery': deliveryId,
          'x-github-event': 'issues',
        });
        assert.strictEqual(first.status, 500);
        assert.ok(failRedis.store.has(`webhook:delivery:${deliveryId}`), 'delivery key must be retained after failure to block duplicate processing');

        // A retry with the same delivery ID should be rejected
        const retry = await sendWebhook(failServer, body, {
          'x-hub-signature-256': signPayload(body, WEBHOOK_SECRET),
          'x-github-delivery': deliveryId,
          'x-github-event': 'issues',
        });
        assert.strictEqual(retry.status, 409, 'retry after failure must be rejected as duplicate');
      } finally {
        await new Promise<void>((resolve) => failServer.close(() => resolve()));
      }
    });

    test('retains Redis key when body parsing fails and returns generic 400', async () => {
      const parseRedis = createMockRedisClient();
      const parseApp = express();
      parseApp.use('/webhook', express.raw({ type: 'application/json' }));
      parseApp.post('/webhook', async (req: Request, res: Response) => {
        // Overwrite req.body with invalid JSON to trigger a parse failure
        // inside the production handler
        (req as { body: Buffer }).body = Buffer.from('not valid json{{{');
        // Re-sign the mangled body so signature check passes
        const hmac = crypto.createHmac('sha256', WEBHOOK_SECRET);
        hmac.update(req.body);
        req.headers['x-hub-signature-256'] = `sha256=${hmac.digest('hex')}`;

        await handleWebhookRequest(req, res, {
          webhookSecret: WEBHOOK_SECRET,
          redis: parseRedis,
          processor: async () => {},
          correlationId: 'test-parse-fail',
        });
      });

      const parseServer = parseApp.listen(0);
      await new Promise<void>((resolve) => parseServer.on('listening', resolve));

      try {
        const body = makeBody();
        const deliveryId = 'delivery-bad-parse';

        const result = await sendWebhook(parseServer, body, {
          'x-hub-signature-256': signPayload(body, WEBHOOK_SECRET),
          'x-github-delivery': deliveryId,
          'x-github-event': 'issues',
        });
        assert.strictEqual(result.status, 400);
        assert.strictEqual(result.body, 'Invalid JSON payload.');
        assert.ok(parseRedis.store.has(`webhook:delivery:${deliveryId}`), 'delivery key must be retained after parse failure to block duplicate processing');
      } finally {
        await new Promise<void>((resolve) => parseServer.close(() => resolve()));
      }
    });
  });

  describe('Signature verification', () => {
    test('rejects request with missing signature', async () => {
      const body = makeBody();
      const res = await sendWebhook(server, body, {
        'x-github-delivery': 'delivery-no-sig',
      });
      assert.strictEqual(res.status, 401);
      assert.match(res.body, /No webhook signature/);
    });

    test('rejects request with invalid signature', async () => {
      const body = makeBody();
      const res = await sendWebhook(server, body, {
        'x-hub-signature-256': 'sha256=0000000000000000000000000000000000000000000000000000000000000000',
        'x-github-delivery': 'delivery-bad-sig',
      });
      assert.strictEqual(res.status, 401);
      assert.match(res.body, /Webhook signature mismatch/);
    });

    test('rejects request with malformed signature of different length', async () => {
      const body = makeBody();
      const res = await sendWebhook(server, body, {
        'x-hub-signature-256': 'sha256=tooshort',
        'x-github-delivery': 'delivery-bad-sig-len',
        'x-github-event': 'issues',
      });
      assert.strictEqual(res.status, 401);
      assert.match(res.body, /Webhook signature mismatch/);
    });

    test('rejects request with multi-valued x-hub-signature-256 header', async () => {
      const body = makeBody();
      const res = await sendWebhook(server, body, {
        'x-hub-signature-256': [signPayload(body, WEBHOOK_SECRET), 'sha256=extra'],
        'x-github-delivery': 'delivery-multi-sig',
        'x-github-event': 'issues',
      });
      assert.strictEqual(res.status, 401);
      assert.match(res.body, /Invalid webhook signature/);
    });

    test('does not store delivery ID when signature is invalid', async () => {
      const body = makeBody();
      await sendWebhook(server, body, {
        'x-hub-signature-256': 'sha256=0000000000000000000000000000000000000000000000000000000000000000',
        'x-github-delivery': 'delivery-bad-sig-2',
      });
      assert.strictEqual(redisClient.store.size, 0);
    });
  });

  describe('Missing x-github-event header', () => {
    test('rejects request with no x-github-event header', async () => {
      const body = makeBody();
      const res = await sendWebhook(server, body, {
        'x-hub-signature-256': signPayload(body, WEBHOOK_SECRET),
        'x-github-delivery': 'delivery-no-event',
      });
      assert.strictEqual(res.status, 400);
      assert.match(res.body, /Missing x-github-event/);
      // Event header is validated before Redis write, so no key should exist
      assert.strictEqual(redisClient.store.size, 0, 'no Redis key should be written when event header is missing');
    });
  });

  describe('Webhook secret not configured (fail closed)', () => {
    test('rejects request when webhookSecret is undefined', async () => {
      const noSecretRedis = createMockRedisClient();
      const noSecretApp = express();
      noSecretApp.use('/webhook', express.raw({ type: 'application/json' }));
      noSecretApp.post('/webhook', async (req: Request, res: Response) => {
        await handleWebhookRequest(req, res, {
          webhookSecret: undefined,
          redis: noSecretRedis,
          processor: async () => {},
          correlationId: 'test-no-secret',
        });
      });
      const noSecretServer = noSecretApp.listen(0);
      await new Promise<void>((resolve) => noSecretServer.on('listening', resolve));

      try {
        const body = makeBody();
        const res = await sendWebhook(noSecretServer, body, {
          'x-hub-signature-256': signPayload(body, WEBHOOK_SECRET),
          'x-github-delivery': 'delivery-no-secret',
          'x-github-event': 'issues',
        });
        assert.strictEqual(res.status, 500);
        assert.match(res.body, /Webhook secret not configured/);
        assert.strictEqual(noSecretRedis.store.size, 0, 'no Redis key should be written when secret is not configured');
      } finally {
        await new Promise<void>((resolve) => noSecretServer.close(() => resolve()));
      }
    });
  });

  describe('Unsupported event type', () => {
    test('ignores request with unsupported x-github-event value with 200', async () => {
      const body = makeBody();
      const res = await sendWebhook(server, body, {
        'x-hub-signature-256': signPayload(body, WEBHOOK_SECRET),
        'x-github-delivery': 'delivery-unsupported-event',
        'x-github-event': 'unknown_event_type',
      });
      // Unsupported events (e.g. ping) are acknowledged with 200 to avoid
      // marking them as failed in GitHub's UI, but no processing occurs.
      assert.strictEqual(res.status, 200);
      assert.match(res.body, /ignored/i);
      // Unsupported events are filtered before Redis dedup, so no key is written
      assert.strictEqual(redisClient.store.size, 0, 'no Redis key should be written for unsupported events');
    });
  });

  describe('Preview routing: delivery ID passed to processor', () => {
    test('processor receives the delivery ID for downstream forwarding', async () => {
      let receivedDeliveryId: string | undefined;
      const captureRedis = createMockRedisClient();
      const captureApp = createTestApp(captureRedis, async (_payload, _event, _cid, deliveryId) => {
        receivedDeliveryId = deliveryId;
      });
      const captureServer = captureApp.listen(0);
      await new Promise<void>((resolve) => captureServer.on('listening', resolve));

      try {
        const body = makeBody();
        const deliveryId = 'delivery-for-forwarding';
        const res = await sendWebhook(captureServer, body, {
          'x-hub-signature-256': signPayload(body, WEBHOOK_SECRET),
          'x-github-delivery': deliveryId,
          'x-github-event': 'issues',
        });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(receivedDeliveryId, deliveryId, 'processor must receive the original delivery ID');
      } finally {
        await new Promise<void>((resolve) => captureServer.close(() => resolve()));
      }
    });

    test('forwarded delivery with fwd- prefix is accepted as a distinct delivery', async () => {
      // Simulates the scenario where the main instance processes a delivery,
      // then forwards it with a fwd- prefixed delivery ID to a preview instance.
      // Both should be accepted since they have different delivery IDs.
      const body = makeBody();
      const originalDeliveryId = 'delivery-original';
      const forwardedDeliveryId = `fwd-${originalDeliveryId}`;

      const original = await sendWebhook(server, body, {
        'x-hub-signature-256': signPayload(body, WEBHOOK_SECRET),
        'x-github-delivery': originalDeliveryId,
        'x-github-event': 'issues',
      });
      assert.strictEqual(original.status, 200);

      const forwarded = await sendWebhook(server, body, {
        'x-hub-signature-256': signPayload(body, WEBHOOK_SECRET),
        'x-github-delivery': forwardedDeliveryId,
        'x-github-event': 'issues',
      });
      assert.strictEqual(forwarded.status, 200, 'forwarded delivery with fwd- prefix must not collide with original');
    });
  });
});
