import crypto from 'crypto';
import { after, mock, test } from 'node:test';
import assert from 'node:assert';

process.env.GH_APP_ID ??= '1';
process.env.GH_PRIVATE_KEY_PATH ??= '.propr/test-private-key.pem';
process.env.GH_INSTALLATION_ID ??= '1';
process.env.NODE_ENV ??= 'test';

const { handleWebhookRequest } = await import('../packages/api/webhookHandler.js');

after(async () => {
    const { closeConnection } = await import('../packages/core/src/db/connection.ts');
    await closeConnection();
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
    assert.deepStrictEqual(callOrder, ['redis.set']);
    assert.strictEqual(cancelMerged.mock.calls.length, 0);
    assert.strictEqual(processor.mock.calls.length, 0);
});

test('merged-PR cancellation failures shorten the delivery reservation TTL when reservation release fails', async () => {
    const request = createSignedRequest({
        action: 'closed',
        repository: { full_name: 'owner/repo' },
        pull_request: { number: 42, merged: true },
    }, 'secret');
    const response = createResponse();
    const redis = {
        set: mock.fn(async () => 'OK'),
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
    assert.deepStrictEqual(redis.set.mock.calls[0]?.arguments, [
        'webhook:delivery:delivery-1',
        '1',
        { NX: true, EX: 300 },
    ]);
    assert.deepStrictEqual(redis.set.mock.calls[1]?.arguments, [
        'webhook:delivery:delivery-1',
        '1',
        { EX: 5 },
    ]);
    assert.strictEqual(redis.del.mock.calls.length, 1);
});
