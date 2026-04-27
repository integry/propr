import { test, describe, beforeEach, mock } from 'node:test';
import assert from 'node:assert';
import crypto from 'crypto';

/**
 * Webhook Replay Protection Tests
 *
 * Tests the replay protection middleware in the webhook endpoint:
 * - Missing delivery ID rejection (400)
 * - First delivery accepted (200)
 * - Duplicate delivery rejected (409)
 * - Stale timestamp rejection (400)
 * - Header array normalization
 */

// --- Mock infrastructure ---

interface RedisStore {
  [key: string]: { value: string; expiresAt: number };
}

function createMockRedisClient() {
  const store: RedisStore = {};
  return {
    store,
    set: mock.fn(async (key: string, value: string, opts?: { NX?: boolean; EX?: number }) => {
      if (opts?.NX && store[key] && store[key].expiresAt > Date.now()) {
        return null; // Key already exists
      }
      store[key] = {
        value,
        expiresAt: opts?.EX ? Date.now() + opts.EX * 1000 : Infinity,
      };
      return 'OK';
    }),
    clear() {
      for (const key of Object.keys(store)) {
        delete store[key];
      }
    },
  };
}

function createWebhookPayload(overrides: Record<string, unknown> = {}) {
  return {
    action: 'opened',
    issue: {
      id: 1,
      number: 42,
      title: 'Test issue',
      updated_at: new Date().toISOString(),
      created_at: new Date(Date.now() - 60_000).toISOString(),
    },
    repository: { full_name: 'test/repo' },
    ...overrides,
  };
}

function signPayload(body: string, secret: string): string {
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(body);
  return `sha256=${hmac.digest('hex')}`;
}

// Simulates the webhook handler logic from server.ts
async function simulateWebhookRequest(
  redisClient: ReturnType<typeof createMockRedisClient>,
  headers: Record<string, string | string[] | undefined>,
  body: string,
  webhookSecret?: string,
): Promise<{ status: number; message: string }> {
  // Signature verification
  if (webhookSecret) {
    const signature = headers['x-hub-signature-256'] as string | undefined;
    if (!signature) return { status: 401, message: 'No webhook signature provided.' };
    const hmac = crypto.createHmac('sha256', webhookSecret);
    hmac.update(body);
    const computedSignature = `sha256=${hmac.digest('hex')}`;
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(computedSignature))) {
      return { status: 401, message: 'Webhook signature mismatch.' };
    }
  }

  // Replay protection: reject duplicate or missing delivery IDs
  const rawDeliveryId = headers['x-github-delivery'];
  const deliveryId = Array.isArray(rawDeliveryId) ? rawDeliveryId[0] : rawDeliveryId;
  if (!deliveryId) {
    return { status: 400, message: 'Missing x-github-delivery header.' };
  }

  const deliveryKey = `webhook:delivery:${deliveryId}`;
  const isNew = await redisClient.set(deliveryKey, '1', { NX: true, EX: 300 });
  if (!isNew) {
    return { status: 409, message: 'Duplicate webhook delivery.' };
  }

  // Stale timestamp check
  const payload = JSON.parse(body) as Record<string, unknown>;
  const WEBHOOK_MAX_AGE_MS = 300_000;
  const payloadTimestamp = extractTimestampFromPayload(payload);
  if (payloadTimestamp) {
    const age = Date.now() - payloadTimestamp.getTime();
    if (age > WEBHOOK_MAX_AGE_MS) {
      return { status: 400, message: 'Stale webhook delivery.' };
    }
    if (age < -60_000) {
      return { status: 400, message: 'Stale webhook delivery.' };
    }
  }

  return { status: 200, message: 'Webhook processed.' };
}

// Mirror of extractTimestamp from server.ts
function extractTimestampFromPayload(payload: Record<string, unknown>): Date | null {
  const candidates: string[] = [];
  for (const key of ['issue', 'pull_request', 'comment', 'review', 'release', 'deployment', 'check_run', 'check_suite', 'workflow_run']) {
    const nested = payload[key] as Record<string, unknown> | undefined;
    if (nested?.updated_at && typeof nested.updated_at === 'string') candidates.push(nested.updated_at);
    if (nested?.created_at && typeof nested.created_at === 'string') candidates.push(nested.created_at);
  }
  const headCommit = payload.head_commit as Record<string, unknown> | undefined;
  if (headCommit?.timestamp && typeof headCommit.timestamp === 'string') candidates.push(headCommit.timestamp);

  let latest: Date | null = null;
  for (const ts of candidates) {
    const d = new Date(ts);
    if (!isNaN(d.getTime()) && (!latest || d.getTime() > latest.getTime())) {
      latest = d;
    }
  }
  return latest;
}

// --- Tests ---

describe('Webhook Replay Protection', () => {
  let redisClient: ReturnType<typeof createMockRedisClient>;
  const webhookSecret = 'test-secret';

  beforeEach(() => {
    redisClient = createMockRedisClient();
  });

  describe('Missing delivery ID', () => {
    test('rejects request with no x-github-delivery header', async () => {
      const payload = createWebhookPayload();
      const body = JSON.stringify(payload);
      const result = await simulateWebhookRequest(
        redisClient,
        {
          'x-hub-signature-256': signPayload(body, webhookSecret),
        },
        body,
        webhookSecret,
      );

      assert.strictEqual(result.status, 400);
      assert.strictEqual(result.message, 'Missing x-github-delivery header.');
    });

    test('rejects request with undefined delivery ID', async () => {
      const payload = createWebhookPayload();
      const body = JSON.stringify(payload);
      const result = await simulateWebhookRequest(
        redisClient,
        {
          'x-hub-signature-256': signPayload(body, webhookSecret),
          'x-github-delivery': undefined,
        },
        body,
        webhookSecret,
      );

      assert.strictEqual(result.status, 400);
    });
  });

  describe('Duplicate delivery rejection', () => {
    test('accepts first delivery', async () => {
      const deliveryId = 'unique-delivery-001';
      const payload = createWebhookPayload();
      const body = JSON.stringify(payload);
      const result = await simulateWebhookRequest(
        redisClient,
        {
          'x-hub-signature-256': signPayload(body, webhookSecret),
          'x-github-delivery': deliveryId,
        },
        body,
        webhookSecret,
      );

      assert.strictEqual(result.status, 200);
      assert.strictEqual(result.message, 'Webhook processed.');
    });

    test('rejects second delivery with same ID', async () => {
      const deliveryId = 'unique-delivery-002';
      const payload = createWebhookPayload();
      const body = JSON.stringify(payload);
      const headers = {
        'x-hub-signature-256': signPayload(body, webhookSecret),
        'x-github-delivery': deliveryId,
      };

      // First request succeeds
      const first = await simulateWebhookRequest(redisClient, headers, body, webhookSecret);
      assert.strictEqual(first.status, 200);

      // Second request with same delivery ID is rejected
      const second = await simulateWebhookRequest(redisClient, headers, body, webhookSecret);
      assert.strictEqual(second.status, 409);
      assert.strictEqual(second.message, 'Duplicate webhook delivery.');
    });

    test('accepts different delivery IDs', async () => {
      const payload = createWebhookPayload();
      const body = JSON.stringify(payload);

      const first = await simulateWebhookRequest(
        redisClient,
        {
          'x-hub-signature-256': signPayload(body, webhookSecret),
          'x-github-delivery': 'delivery-aaa',
        },
        body,
        webhookSecret,
      );
      assert.strictEqual(first.status, 200);

      const second = await simulateWebhookRequest(
        redisClient,
        {
          'x-hub-signature-256': signPayload(body, webhookSecret),
          'x-github-delivery': 'delivery-bbb',
        },
        body,
        webhookSecret,
      );
      assert.strictEqual(second.status, 200);
    });
  });

  describe('Header array normalization', () => {
    test('handles x-github-delivery as string array by using first element', async () => {
      const payload = createWebhookPayload();
      const body = JSON.stringify(payload);
      const result = await simulateWebhookRequest(
        redisClient,
        {
          'x-hub-signature-256': signPayload(body, webhookSecret),
          'x-github-delivery': ['delivery-array-1', 'delivery-array-2'],
        },
        body,
        webhookSecret,
      );

      assert.strictEqual(result.status, 200);
      // Verify the first element was used as the key
      assert.ok(redisClient.store['webhook:delivery:delivery-array-1']);
    });

    test('rejects empty string array', async () => {
      const payload = createWebhookPayload();
      const body = JSON.stringify(payload);
      const result = await simulateWebhookRequest(
        redisClient,
        {
          'x-hub-signature-256': signPayload(body, webhookSecret),
          'x-github-delivery': [] as unknown as string[],
        },
        body,
        webhookSecret,
      );

      // Empty array should be treated as missing
      assert.strictEqual(result.status, 400);
    });
  });

  describe('Stale timestamp rejection', () => {
    test('rejects payload with timestamp older than 5 minutes', async () => {
      const staleTime = new Date(Date.now() - 600_000).toISOString(); // 10 minutes ago
      const payload = createWebhookPayload({
        issue: {
          id: 1,
          number: 42,
          title: 'Stale issue',
          updated_at: staleTime,
          created_at: staleTime,
        },
      });
      const body = JSON.stringify(payload);
      const result = await simulateWebhookRequest(
        redisClient,
        {
          'x-hub-signature-256': signPayload(body, webhookSecret),
          'x-github-delivery': 'stale-delivery-001',
        },
        body,
        webhookSecret,
      );

      assert.strictEqual(result.status, 400);
      assert.strictEqual(result.message, 'Stale webhook delivery.');
    });

    test('accepts payload with recent timestamp', async () => {
      const recentTime = new Date(Date.now() - 30_000).toISOString(); // 30 seconds ago
      const payload = createWebhookPayload({
        issue: {
          id: 1,
          number: 42,
          title: 'Recent issue',
          updated_at: recentTime,
          created_at: recentTime,
        },
      });
      const body = JSON.stringify(payload);
      const result = await simulateWebhookRequest(
        redisClient,
        {
          'x-hub-signature-256': signPayload(body, webhookSecret),
          'x-github-delivery': 'recent-delivery-001',
        },
        body,
        webhookSecret,
      );

      assert.strictEqual(result.status, 200);
    });

    test('rejects payload with timestamp far in the future', async () => {
      const futureTime = new Date(Date.now() + 120_000).toISOString(); // 2 minutes in the future
      const payload = createWebhookPayload({
        issue: {
          id: 1,
          number: 42,
          title: 'Future issue',
          updated_at: futureTime,
          created_at: futureTime,
        },
      });
      const body = JSON.stringify(payload);
      const result = await simulateWebhookRequest(
        redisClient,
        {
          'x-hub-signature-256': signPayload(body, webhookSecret),
          'x-github-delivery': 'future-delivery-001',
        },
        body,
        webhookSecret,
      );

      assert.strictEqual(result.status, 400);
      assert.strictEqual(result.message, 'Stale webhook delivery.');
    });

    test('allows slight clock skew (under 1 minute future)', async () => {
      const slightFuture = new Date(Date.now() + 30_000).toISOString(); // 30 seconds in future
      const payload = createWebhookPayload({
        issue: {
          id: 1,
          number: 42,
          title: 'Slight future issue',
          updated_at: slightFuture,
          created_at: slightFuture,
        },
      });
      const body = JSON.stringify(payload);
      const result = await simulateWebhookRequest(
        redisClient,
        {
          'x-hub-signature-256': signPayload(body, webhookSecret),
          'x-github-delivery': 'slight-future-001',
        },
        body,
        webhookSecret,
      );

      assert.strictEqual(result.status, 200);
    });

    test('handles push events with head_commit.timestamp', async () => {
      const staleTime = new Date(Date.now() - 600_000).toISOString();
      const payload = {
        ref: 'refs/heads/main',
        head_commit: {
          id: 'abc123',
          timestamp: staleTime,
          message: 'test commit',
        },
        repository: { full_name: 'test/repo' },
      };
      const body = JSON.stringify(payload);
      const result = await simulateWebhookRequest(
        redisClient,
        {
          'x-hub-signature-256': signPayload(body, webhookSecret),
          'x-github-delivery': 'push-stale-001',
        },
        body,
        webhookSecret,
      );

      assert.strictEqual(result.status, 400);
      assert.strictEqual(result.message, 'Stale webhook delivery.');
    });

    test('accepts payload with no extractable timestamp (no rejection)', async () => {
      // A payload without any known timestamp fields should still be accepted
      const payload = {
        action: 'custom_event',
        repository: { full_name: 'test/repo' },
      };
      const body = JSON.stringify(payload);
      const result = await simulateWebhookRequest(
        redisClient,
        {
          'x-hub-signature-256': signPayload(body, webhookSecret),
          'x-github-delivery': 'no-timestamp-001',
        },
        body,
        webhookSecret,
      );

      assert.strictEqual(result.status, 200);
    });
  });
});
