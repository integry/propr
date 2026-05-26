import crypto from 'crypto';
import { after, mock, test } from 'node:test';
import assert from 'node:assert';

process.env.GH_APP_ID ??= '1';
process.env.GH_PRIVATE_KEY_PATH ??= '.propr/test-private-key.pem';
process.env.GH_INSTALLATION_ID ??= '1';
process.env.NODE_ENV ??= 'test';

const { handleWebhookRequest } = await import('../packages/api/webhookHandler.js');

after(async () => {
    const corePackage = await import('@propr/core');
    const { closeConnection } = await import('../packages/core/src/db/connection.ts');
    await Promise.all([
        corePackage.closeConnection(),
        closeConnection(),
    ]);
});

function createSignedRequest(payload: Record<string, unknown>, secret: string) {
    const body = Buffer.from(JSON.stringify(payload));
    const signature = `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;

    return {
        body,
        headers: {
            'x-hub-signature-256': signature,
            'x-github-delivery': 'delivery-1',
            'x-github-event': 'pull_request',
        },
    };
}

function createResponse() {
    return {
        statusCode: 200,
        body: '',
        status(code: number) {
            this.statusCode = code;
            return this;
        },
        send(body: string) {
            this.body = body;
            return this;
        },
    };
}

test('duplicate deliveries are rejected before merged-PR cancellation side effects run', async () => {
    const request = createSignedRequest({
        action: 'closed',
        repository: { full_name: 'owner/repo' },
        pull_request: { number: 42, merged: true },
    }, 'secret');
    const response = createResponse();
    const callOrder: string[] = [];
    const redis = {
        set: mock.fn(async () => {
            callOrder.push('redis.set');
            return null;
        }),
        get: mock.fn(async () => {
            callOrder.push('redis.get');
            return null;
        }),
        del: mock.fn(async () => 1),
    };
    const processor = mock.fn(async () => {
        callOrder.push('processor');
    });
    const cancelMerged = mock.fn(async () => {
        callOrder.push('cancelMergedPullRequestTasks');
    });

    await handleWebhookRequest(request as never, response as never, {
        webhookSecret: 'secret',
        redis,
        processor,
        correlationId: 'cid-1',
        supportedEvents: ['pull_request'],
        isMergedPullRequestClose: () => true,
        cancelMergedPullRequestTasks: cancelMerged,
        mergeTaskCancellation: {
            redisClient: {} as never,
        },
    });

    assert.strictEqual(response.statusCode, 409);
    assert.strictEqual(response.body, 'Duplicate webhook delivery.');
    assert.deepStrictEqual(callOrder, ['redis.set', 'redis.get']);
    assert.strictEqual(cancelMerged.mock.calls.length, 0);
    assert.strictEqual(processor.mock.calls.length, 0);
});

test('merged-PR cancellation dependency failures do not consume delivery reservations', async () => {
    const request = createSignedRequest({
        action: 'closed',
        repository: { full_name: 'owner/repo' },
        pull_request: { number: 42, merged: true },
    }, 'secret');
    const response = createResponse();
    const redis = {
        set: mock.fn(async () => 'OK'),
        get: mock.fn(async () => null),
        del: mock.fn(async () => 1),
    };
    const processor = mock.fn(async () => {});

    await handleWebhookRequest(request as never, response as never, {
        webhookSecret: 'secret',
        redis,
        processor,
        correlationId: 'cid-missing-deps',
        supportedEvents: ['pull_request'],
        isMergedPullRequestClose: () => true,
    });

    assert.strictEqual(response.statusCode, 500);
    assert.strictEqual(response.body, 'Merge task cancellation dependencies are not configured.');
    assert.strictEqual(redis.set.mock.calls.length, 0);
    assert.strictEqual(processor.mock.calls.length, 0);
});

test('merged-PR cancellation failures open the delivery reservation for immediate retry when release fails', async () => {
    const request = createSignedRequest({
        action: 'closed',
        repository: { full_name: 'owner/repo' },
        pull_request: { number: 42, merged: true },
    }, 'secret');
    const response = createResponse();
    const redis = {
        set: mock.fn(async () => 'OK'),
        get: mock.fn(async () => redis.set.mock.calls[0]?.arguments[1] as string),
        del: mock.fn(async () => {
            throw new Error('redis unavailable');
        }),
    };

    await handleWebhookRequest(request as never, response as never, {
        webhookSecret: 'secret',
        redis,
        processor: async () => {},
        correlationId: 'cid-2',
        supportedEvents: ['pull_request'],
        isMergedPullRequestClose: () => true,
        cancelMergedPullRequestTasks: async () => {
            throw new Error('cancellation failed');
        },
        mergeTaskCancellation: {
            redisClient: {} as never,
        },
    });

    assert.strictEqual(response.statusCode, 500);
    assert.strictEqual(response.body, 'Merged pull request task cancellation failed.');
    assert.strictEqual(redis.set.mock.calls.length, 2);
    const reservationToken = redis.set.mock.calls[0]?.arguments[1];
    assert.strictEqual(typeof reservationToken, 'string');
    assert.deepStrictEqual(redis.set.mock.calls[0]?.arguments, [
        'webhook:delivery:delivery-1',
        reservationToken,
        { NX: true, EX: 300 },
    ]);
    assert.deepStrictEqual(redis.set.mock.calls[1]?.arguments, [
        'webhook:delivery:delivery-1',
        `retry-open:${reservationToken}`,
        { EX: 30 },
    ]);
    assert.strictEqual(redis.del.mock.calls.length, 1);
});

test('processor failures after successful merged-PR cancellation release delivery reservation for retry', async () => {
    const request = createSignedRequest({
        action: 'closed',
        repository: { full_name: 'owner/repo' },
        pull_request: { number: 42, merged: true },
    }, 'secret');
    const response = createResponse();
    const redis = {
        set: mock.fn(async () => 'OK'),
        get: mock.fn(async () => redis.set.mock.calls[0]?.arguments[1] as string),
        del: mock.fn(async () => 1),
    };

    await handleWebhookRequest(request as never, response as never, {
        webhookSecret: 'secret',
        redis,
        processor: async () => {
            throw new Error('processor failed');
        },
        correlationId: 'cid-3',
        supportedEvents: ['pull_request'],
        isMergedPullRequestClose: () => true,
        cancelMergedPullRequestTasks: async () => {},
        mergeTaskCancellation: {
            redisClient: {} as never,
        },
    });

    assert.strictEqual(response.statusCode, 500);
    assert.strictEqual(response.body, 'Webhook processor failed after merged pull request task cancellation.');
    assert.deepStrictEqual(redis.del.mock.calls.map((call) => call.arguments[0]), ['webhook:delivery:delivery-1']);
    assert.deepStrictEqual(redis.set.mock.calls[0]?.arguments, [
        'webhook:delivery:delivery-1',
        redis.set.mock.calls[0]?.arguments[1],
        { NX: true, EX: 300 },
    ]);
});

test('merged-PR retry marker allows the next GitHub retry through', async () => {
    const request = createSignedRequest({
        action: 'closed',
        repository: { full_name: 'owner/repo' },
        pull_request: { number: 42, merged: true },
    }, 'secret');
    const firstResponse = createResponse();
    const secondResponse = createResponse();
    const store = new Map<string, string>();
    const redis = {
        set: mock.fn(async (key: string, value: string, opts?: { NX?: boolean }) => {
            if (opts?.NX && store.has(key)) {
                return null;
            }
            store.set(key, value);
            return 'OK';
        }),
        get: mock.fn(async (key: string) => store.get(key) ?? null),
        del: mock.fn(async () => {
            throw new Error('redis delete unavailable');
        }),
    };
    let cancellationAttempts = 0;
    const processor = mock.fn(async () => {});

    await handleWebhookRequest(request as never, firstResponse as never, {
        webhookSecret: 'secret',
        redis,
        processor,
        correlationId: 'cid-retry-open',
        supportedEvents: ['pull_request'],
        isMergedPullRequestClose: () => true,
        cancelMergedPullRequestTasks: async () => {
            cancellationAttempts += 1;
            if (cancellationAttempts === 1) {
                throw new Error('cancellation failed');
            }
        },
        mergeTaskCancellation: {
            redisClient: {} as never,
        },
    });

    await handleWebhookRequest(request as never, secondResponse as never, {
        webhookSecret: 'secret',
        redis,
        processor,
        correlationId: 'cid-retry-open',
        supportedEvents: ['pull_request'],
        isMergedPullRequestClose: () => true,
        cancelMergedPullRequestTasks: async () => {
            cancellationAttempts += 1;
        },
        mergeTaskCancellation: {
            redisClient: {} as never,
        },
    });

    assert.strictEqual(firstResponse.statusCode, 500);
    assert.strictEqual(secondResponse.statusCode, 200);
    assert.strictEqual(cancellationAttempts, 2);
    assert.strictEqual(processor.mock.calls.length, 1);
});
