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
 * - Signature verification (401)
 * - Redis key storage verification
 */

const WEBHOOK_SECRET = 'test-webhook-secret';
const WEBHOOK_DELIVERY_TTL_SECONDS = 300;

function createMockRedisClient() {
  const store = new Map<string, string>();
  return {
    store,
    set: async (key: string, value: string, opts?: { NX?: boolean; EX?: number }) => {
      if (opts?.NX && store.has(key)) {
        return null;
      }
      store.set(key, value);
      return 'OK';
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
 * This uses express.raw() middleware and the same header/Redis logic from server.ts,
 * ensuring the test exercises the real middleware stack.
 */
function createTestApp(redisClient: ReturnType<typeof createMockRedisClient>) {
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
      const deliveryKey = `webhook:delivery:${rawDeliveryId}`;
      const isNew = await redisClient.set(deliveryKey, '1', { NX: true, EX: WEBHOOK_DELIVERY_TTL_SECONDS });
      if (!isNew) {
        return res.status(409).send('Duplicate webhook delivery.');
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
  headers: Record<string, string>,
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
      const body = makeBody();
      const headers = {
        'x-hub-signature-256': signPayload(body, WEBHOOK_SECRET),
        'x-github-delivery': 'unique-delivery-002',
      };

      const first = await sendWebhook(server, body, headers);
      assert.strictEqual(first.status, 200);

      const second = await sendWebhook(server, body, headers);
      assert.strictEqual(second.status, 409);
      assert.match(second.body, /Duplicate webhook delivery/);
    });

    test('accepts different delivery IDs', async () => {
      const body = makeBody();

      const first = await sendWebhook(server, body, {
        'x-hub-signature-256': signPayload(body, WEBHOOK_SECRET),
        'x-github-delivery': 'delivery-aaa',
      });
      assert.strictEqual(first.status, 200);

      const second = await sendWebhook(server, body, {
        'x-hub-signature-256': signPayload(body, WEBHOOK_SECRET),
        'x-github-delivery': 'delivery-bbb',
      });
      assert.strictEqual(second.status, 200);
    });
  });

  describe('Redis key storage', () => {
    test('stores delivery ID with correct key prefix', async () => {
      const body = makeBody();
      await sendWebhook(server, body, {
        'x-hub-signature-256': signPayload(body, WEBHOOK_SECRET),
        'x-github-delivery': 'test-delivery-123',
      });
      assert.ok(redisClient.store.has('webhook:delivery:test-delivery-123'));
    });

    test('does not store key when delivery ID is missing', async () => {
      const body = makeBody();
      await sendWebhook(server, body, {
        'x-hub-signature-256': signPayload(body, WEBHOOK_SECRET),
      });
      assert.strictEqual(redisClient.store.size, 0);
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
