import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import crypto from 'crypto';
import http from 'node:http';
import express, { Request, Response } from 'express';
import { handleWebhookRequest, WEBHOOK_DELIVERY_TTL_SECONDS, WEBHOOK_MAX_AGE_SECONDS } from '../packages/api/webhookHandler.js';

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
 * - Signature verification (401), including malformed signature lengths
 * - Missing x-github-event header rejection (400)
 * - Redis key storage with correct TTL
 * - Failed processing cleans up Redis key so retries work
 * - Parse failure cleans up Redis key so retries work
 */

const WEBHOOK_SECRET = 'test-webhook-secret';

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
 * Creates a minimal Express app that wires the production `handleWebhookRequest`
 * with injectable dependencies (mock Redis, configurable processor).
 */
function createTestApp(
  redisClient: ReturnType<typeof createMockRedisClient>,
  processor: (payload: Record<string, unknown>, event: string, correlationId: string) => Promise<void> = async () => {},
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
    issue: { id: 1, number: 42, title: 'Test issue' },
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
      assert.strictEqual(entry.ex, WEBHOOK_DELIVERY_TTL_SECONDS, 'delivery key TTL should match exported constant');
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
    test('cleans up Redis key when processing fails so retries work', async () => {
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
        assert.ok(!failRedis.store.has(`webhook:delivery:${deliveryId}`), 'delivery key should be removed after failure');
      } finally {
        await new Promise<void>((resolve) => failServer.close(() => resolve()));
      }
    });

    test('cleans up Redis key when body parsing fails so retries work', async () => {
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

        try {
          await handleWebhookRequest(req, res, {
            webhookSecret: WEBHOOK_SECRET,
            redis: parseRedis,
            processor: async () => {},
            correlationId: 'test-parse-fail',
          });
        } catch (error) {
          if (!res.headersSent) {
            res.status(500).send((error as Error).message);
          }
        }
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
        assert.strictEqual(result.status, 500);
        assert.ok(!parseRedis.store.has(`webhook:delivery:${deliveryId}`), 'delivery key should be removed after parse failure');
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
      // Redis key should be cleaned up
      assert.ok(!redisClient.store.has('webhook:delivery:delivery-no-event'), 'delivery key should be removed when event header is missing');
    });
  });

  describe('Stale delivery rejection', () => {
    test('rejects request with Date header older than WEBHOOK_MAX_AGE_SECONDS', async () => {
      const staleRedis = createMockRedisClient();
      const nowSec = Math.floor(Date.now() / 1000);
      // Create a Date header that is older than the max age
      const staleDate = new Date((nowSec - WEBHOOK_MAX_AGE_SECONDS - 60) * 1000).toUTCString();

      const staleApp = express();
      staleApp.use('/webhook', express.raw({ type: 'application/json' }));
      staleApp.post('/webhook', async (req: Request, res: Response) => {
        try {
          await handleWebhookRequest(req, res, {
            webhookSecret: WEBHOOK_SECRET,
            redis: staleRedis,
            processor: async () => {},
            correlationId: 'test-stale',
            nowSeconds: nowSec,
          });
        } catch (error) {
          if (!res.headersSent) {
            res.status(500).send((error as Error).message);
          }
        }
      });
      const staleServer = staleApp.listen(0);
      await new Promise<void>((resolve) => staleServer.on('listening', resolve));

      try {
        const body = makeBody();
        const res = await sendWebhook(staleServer, body, {
          'x-hub-signature-256': signPayload(body, WEBHOOK_SECRET),
          'x-github-delivery': 'delivery-stale',
          'x-github-event': 'issues',
          'date': staleDate,
        });
        assert.strictEqual(res.status, 400);
        assert.match(res.body, /Stale webhook request/);
        // Should not store in Redis since request was rejected before dedup
        assert.ok(!staleRedis.store.has('webhook:delivery:delivery-stale'), 'stale request should not be stored in Redis');
      } finally {
        await new Promise<void>((resolve) => staleServer.close(() => resolve()));
      }
    });

    test('accepts request with Date header within WEBHOOK_MAX_AGE_SECONDS', async () => {
      const freshRedis = createMockRedisClient();
      const nowSec = Math.floor(Date.now() / 1000);
      // Create a Date header that is recent (10 seconds ago)
      const freshDate = new Date((nowSec - 10) * 1000).toUTCString();

      const freshApp = express();
      freshApp.use('/webhook', express.raw({ type: 'application/json' }));
      freshApp.post('/webhook', async (req: Request, res: Response) => {
        try {
          await handleWebhookRequest(req, res, {
            webhookSecret: WEBHOOK_SECRET,
            redis: freshRedis,
            processor: async () => {},
            correlationId: 'test-fresh',
            nowSeconds: nowSec,
          });
        } catch (error) {
          if (!res.headersSent) {
            res.status(500).send((error as Error).message);
          }
        }
      });
      const freshServer = freshApp.listen(0);
      await new Promise<void>((resolve) => freshServer.on('listening', resolve));

      try {
        const body = makeBody();
        const res = await sendWebhook(freshServer, body, {
          'x-hub-signature-256': signPayload(body, WEBHOOK_SECRET),
          'x-github-delivery': 'delivery-fresh',
          'x-github-event': 'issues',
          'date': freshDate,
        });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body, 'Webhook processed.');
      } finally {
        await new Promise<void>((resolve) => freshServer.close(() => resolve()));
      }
    });

    test('accepts request with no Date header (best-effort check)', async () => {
      // When no Date header is present, the stale check is skipped
      const body = makeBody();
      const res = await sendWebhook(server, body, {
        'x-hub-signature-256': signPayload(body, WEBHOOK_SECRET),
        'x-github-delivery': 'delivery-no-date',
        'x-github-event': 'issues',
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body, 'Webhook processed.');
    });

    test('accepts request with unparseable Date header', async () => {
      const body = makeBody();
      const res = await sendWebhook(server, body, {
        'x-hub-signature-256': signPayload(body, WEBHOOK_SECRET),
        'x-github-delivery': 'delivery-bad-date',
        'x-github-event': 'issues',
        'date': 'not-a-valid-date',
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body, 'Webhook processed.');
    });
  });
});
