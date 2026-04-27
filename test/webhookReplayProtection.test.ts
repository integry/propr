import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import crypto from 'crypto';
import http from 'node:http';
import express, { Request, Response } from 'express';

/**
 * Webhook Replay Protection Integration Tests
 *
 * Tests the webhook route's replay protection behavior using a minimal Express
 * app that mirrors the production route logic. Unlike the previous tests, these
 * exercise the actual Express middleware stack (raw body parsing, header handling,
 * response codes) via real HTTP requests.
 *
 * Covers:
 * - Missing delivery ID rejection (400)
 * - Array-valued delivery ID rejection (400)
 * - First delivery accepted (200)
 * - Duplicate delivery rejected (409)
 * - Stale/replayed body rejected (409)
 * - Signature verification (401)
 * - Redis key storage verification with TTL
 * - Failed processing allows retry (keys cleaned up)
 */

const WEBHOOK_SECRET = 'test-webhook-secret';
const WEBHOOK_DELIVERY_TTL_SECONDS = 300;
const WEBHOOK_MAX_AGE_SECONDS = 600;

interface StoredEntry {
  value: string;
  ex?: number;
}

function createMockRedisClient() {
  const store = new Map<string, StoredEntry>();
  return {
    store,
    set: async (key: string, value: string, opts?: { NX?: boolean; EX?: number }) => {
      if (opts?.NX && store.has(key)) {
        return null;
      }
      store.set(key, { value, ex: opts?.EX });
      return 'OK';
    },
    del: async (key: string) => {
      store.delete(key);
      return 1;
    },
  };
}

function signPayload(body: string, secret: string): string {
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(body);
  return `sha256=${hmac.digest('hex')}`;
}

/**
 * Creates a minimal Express app with the same webhook route structure as production.
 * This uses express.raw() middleware and the same header/Redis/body-hash logic from
 * server.ts, ensuring the test exercises the real middleware stack.
 *
 * @param shouldProcessingFail - if true, simulates a processing failure after dedup
 */
function createTestApp(
  redisClient: ReturnType<typeof createMockRedisClient>,
  shouldProcessingFail = false,
) {
  const app = express();
  app.use('/webhook', express.raw({ type: 'application/json' }));

  app.post('/webhook', async (req: Request, res: Response) => {
    try {
      // Signature verification (matches production)
      const signature = req.headers['x-hub-signature-256'] as string | undefined;
      if (!signature) {
        return res.status(401).send('No webhook signature provided.');
      }
      const hmac = crypto.createHmac('sha256', WEBHOOK_SECRET);
      hmac.update(req.body);
      const computedSignature = `sha256=${hmac.digest('hex')}`;
      if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(computedSignature))) {
        return res.status(401).send('Webhook signature mismatch.');
      }

      // Replay protection (matches production)
      const rawDeliveryId = req.headers['x-github-delivery'];
      if (Array.isArray(rawDeliveryId)) {
        return res.status(400).send('Invalid x-github-delivery header.');
      }
      if (!rawDeliveryId) {
        return res.status(400).send('Missing x-github-delivery header.');
      }

      // Stale payload protection (matches production)
      const bodyHash = crypto.createHash('sha256').update(req.body).digest('hex');
      const bodyKey = `webhook:body:${bodyHash}`;
      const bodyIsNew = await redisClient.set(bodyKey, '1', { NX: true, EX: WEBHOOK_MAX_AGE_SECONDS });
      if (!bodyIsNew) {
        return res.status(409).send('Stale webhook payload.');
      }

      const deliveryKey = `webhook:delivery:${rawDeliveryId}`;
      const isNew = await redisClient.set(deliveryKey, '1', { NX: true, EX: WEBHOOK_DELIVERY_TTL_SECONDS });
      if (!isNew) {
        return res.status(409).send('Duplicate webhook delivery.');
      }

      // Simulate processing (parse body, call handler)
      JSON.parse(req.body.toString());

      try {
        if (shouldProcessingFail) {
          throw new Error('Simulated processing failure');
        }
      } catch (processingError) {
        // Clean up Redis keys so retries work (matches production)
        await redisClient.del(deliveryKey).catch(() => {});
        await redisClient.del(bodyKey).catch(() => {});
        throw processingError;
      }

      res.status(200).send('Webhook processed.');
    } catch (error) {
      res.status(500).send((error as Error).message);
    }
  });

  return app;
}

function makeBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    action: 'opened',
    issue: { id: 1, number: 42, title: 'Test issue' },
    repository: { full_name: 'test/repo' },
    ...overrides,
  });
}

/**
 * Send a real HTTP request to the test server. This exercises the full Express
 * middleware chain including body parsing.
 */
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

  beforeEach(async () => {
    redisClient = createMockRedisClient();
    const app = createTestApp(redisClient);
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
      });
      assert.strictEqual(first.status, 200);

      const second = await sendWebhook(server, body2, {
        'x-hub-signature-256': signPayload(body2, WEBHOOK_SECRET),
        'x-github-delivery': 'unique-delivery-002',
      });
      assert.strictEqual(second.status, 409);
      assert.match(second.body, /Duplicate webhook delivery/);
    });

    test('accepts different delivery IDs', async () => {
      const body1 = makeBody({ nonce: 'aaa' });
      const body2 = makeBody({ nonce: 'bbb' });

      const first = await sendWebhook(server, body1, {
        'x-hub-signature-256': signPayload(body1, WEBHOOK_SECRET),
        'x-github-delivery': 'delivery-aaa',
      });
      assert.strictEqual(first.status, 200);

      const second = await sendWebhook(server, body2, {
        'x-hub-signature-256': signPayload(body2, WEBHOOK_SECRET),
        'x-github-delivery': 'delivery-bbb',
      });
      assert.strictEqual(second.status, 200);
    });
  });

  describe('Stale payload protection', () => {
    test('rejects replayed body with a different delivery ID', async () => {
      const body = makeBody();

      const first = await sendWebhook(server, body, {
        'x-hub-signature-256': signPayload(body, WEBHOOK_SECRET),
        'x-github-delivery': 'delivery-original',
      });
      assert.strictEqual(first.status, 200);

      // Same body, different delivery ID — should be rejected as stale
      const second = await sendWebhook(server, body, {
        'x-hub-signature-256': signPayload(body, WEBHOOK_SECRET),
        'x-github-delivery': 'delivery-replay-attempt',
      });
      assert.strictEqual(second.status, 409);
      assert.match(second.body, /Stale webhook payload/);
    });
  });

  describe('Redis key storage', () => {
    test('stores delivery ID with correct key prefix and TTL', async () => {
      const body = makeBody();
      await sendWebhook(server, body, {
        'x-hub-signature-256': signPayload(body, WEBHOOK_SECRET),
        'x-github-delivery': 'test-delivery-123',
      });
      const entry = redisClient.store.get('webhook:delivery:test-delivery-123');
      assert.ok(entry, 'delivery key should be stored');
      assert.strictEqual(entry.ex, WEBHOOK_DELIVERY_TTL_SECONDS, 'delivery key TTL should match');
    });

    test('stores body hash with correct key prefix and TTL', async () => {
      const body = makeBody();
      const bodyHash = crypto.createHash('sha256').update(body).digest('hex');
      await sendWebhook(server, body, {
        'x-hub-signature-256': signPayload(body, WEBHOOK_SECRET),
        'x-github-delivery': 'test-delivery-body-ttl',
      });
      const entry = redisClient.store.get(`webhook:body:${bodyHash}`);
      assert.ok(entry, 'body hash key should be stored');
      assert.strictEqual(entry.ex, WEBHOOK_MAX_AGE_SECONDS, 'body hash TTL should match');
    });

    test('does not store key when delivery ID is missing', async () => {
      const body = makeBody();
      await sendWebhook(server, body, {
        'x-hub-signature-256': signPayload(body, WEBHOOK_SECRET),
      });
      assert.strictEqual(redisClient.store.size, 0);
    });
  });

  describe('Failed processing cleanup', () => {
    let failServer: http.Server;
    let failRedis: ReturnType<typeof createMockRedisClient>;

    beforeEach(async () => {
      failRedis = createMockRedisClient();
      const app = createTestApp(failRedis, true);
      failServer = app.listen(0);
      await new Promise<void>((resolve) => failServer.on('listening', resolve));
    });

    afterEach(async () => {
      await new Promise<void>((resolve) => failServer.close(() => resolve()));
    });

    test('cleans up Redis keys when processing fails so retries work', async () => {
      const body = makeBody();
      const deliveryId = 'delivery-will-fail';

      const first = await sendWebhook(failServer, body, {
        'x-hub-signature-256': signPayload(body, WEBHOOK_SECRET),
        'x-github-delivery': deliveryId,
      });
      assert.strictEqual(first.status, 500);

      // Both keys should be cleaned up
      assert.ok(!failRedis.store.has(`webhook:delivery:${deliveryId}`), 'delivery key should be removed after failure');
      const bodyHash = crypto.createHash('sha256').update(body).digest('hex');
      assert.ok(!failRedis.store.has(`webhook:body:${bodyHash}`), 'body hash key should be removed after failure');
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

    test('does not store delivery ID when signature is invalid', async () => {
      const body = makeBody();
      await sendWebhook(server, body, {
        'x-hub-signature-256': 'sha256=0000000000000000000000000000000000000000000000000000000000000000',
        'x-github-delivery': 'delivery-bad-sig-2',
      });
      assert.strictEqual(redisClient.store.size, 0);
    });
  });
});
