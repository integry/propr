import { test, mock, after } from 'node:test';
import assert from 'node:assert';
import type { UnprocessedComment } from '@propr/core';
import {
    acknowledgePendingCommentClaim,
    pickUpPendingCommentsWithClaim,
    processPendingComments,
    restorePendingComments,
    restoreSupersededProviderLimitComments,
} from '../src/jobs/prPendingComments.js';
import { applyPendingCommentCommandContext } from '../src/jobs/prCommentCommandContext.js';
import { buildProviderLimitRetryJobData } from '../src/jobs/prCommentRouting.js';
import { closeConnection } from '../packages/core/src/db/connection.js';
import { shutdownQueue } from '../packages/core/src/queue/taskQueue.js';

const logger = { info: mock.fn(), warn: mock.fn(), error: mock.fn(), debug: mock.fn() };

after(async () => {
    await shutdownQueue();
    await closeConnection();
});

class MemoryRedis {
    lists = new Map<string, string[]>();

    async lrange(key: string): Promise<string[]> {
        return [...(this.lists.get(key) ?? [])];
    }

    async del(key: string): Promise<number> {
        return this.lists.delete(key) ? 1 : 0;
    }

    async eval(_script: string, keyCount: number, ...args: string[]): Promise<string[] | number> {
        if (keyCount === 2) {
            const [pendingKey, claimKey] = args;
            const existingClaim = this.lists.get(claimKey);
            if (existingClaim) return [...existingClaim];
            const pending = [...(this.lists.get(pendingKey) ?? [])];
            if (pending.length > 0) {
                this.lists.delete(pendingKey);
                this.lists.set(claimKey, pending);
            }
            return pending;
        }

        const [pendingKey, ...identityPayloadPairs] = args;
        const existing = this.lists.get(pendingKey) ?? [];
        const identity = (raw: string): string => {
            const value = JSON.parse(raw) as UnprocessedComment;
            return `${value.type}:${value.id}:${value.updatedAt ?? value.createdAt ?? ''}`;
        };
        const seen = new Set(existing.map(identity));
        const missing: string[] = [];
        for (let index = 0; index < identityPayloadPairs.length; index += 2) {
            if (!seen.has(identityPayloadPairs[index])) {
                seen.add(identityPayloadPairs[index]);
                missing.push(identityPayloadPairs[index + 1]);
            }
        }
        this.lists.set(pendingKey, [...missing, ...existing]);
        return missing.length;
    }
}

function issue(id: number, body: string, updatedAt: string): UnprocessedComment {
    return { id, body, updatedAt, author: 'alice', type: 'issue' };
}

test('picked /use comment is persisted with the normal comment before provider retry reconstruction', () => {
    const jobData = {
        pullRequestNumber: 42,
        repoOwner: 'integry',
        repoName: 'propr',
        correlationId: 'claimed-routing',
        comments: [issue(10, 'normal request', 'r1')],
        llm: 'claude-opus-4-8',
    };
    const comments = [...jobData.comments];
    processPendingComments(comments, [JSON.stringify({
        ...issue(20, 'selected follow-up', 'r1'),
        commandMode: 'use',
        requestedModels: ['gpt-5.6-sol'],
        llmOverride: 'gpt-5.6-sol',
        agentAlias: 'codex',
        modelName: 'gpt-5.6-sol',
        modelLabel: 'llm-codex-gpt56-sol',
    })], logger as never);

    applyPendingCommentCommandContext(jobData, comments, logger as never);
    const retry = buildProviderLimitRetryJobData(jobData);

    assert.deepStrictEqual(retry.comments?.map(comment => comment.id), [10, 20]);
    assert.strictEqual(retry.agentAlias, 'codex');
    assert.strictEqual(retry.modelName, 'gpt-5.6-sol');
    assert.strictEqual(retry.modelLabel, 'llm-codex-gpt56-sol');
    assert.strictEqual(retry.llm, 'gpt-5.6-sol');
});

test('comment identity preserves issue/review ID collisions, revisions, order, and code context', () => {
    const comments = [issue(7, 'issue request', 'issue-r1')];
    processPendingComments(comments, [
        JSON.stringify({ id: 7, body: 'review r1', updatedAt: 'review-r1', author: 'bob', type: 'review', hasCodeContext: true }),
        JSON.stringify({ id: 7, body: 'review r1 duplicate', updatedAt: 'review-r1', author: 'bob', type: 'review', hasCodeContext: true }),
        JSON.stringify({ id: 7, body: 'review r2', updatedAt: 'review-r2', author: 'bob', type: 'review', hasCodeContext: true }),
    ], logger as never);

    assert.deepStrictEqual(comments.map(comment => `${comment.type}:${comment.id}:${comment.updatedAt}`), [
        'issue:7:issue-r1',
        'review:7:review-r1',
        'review:7:review-r2',
    ]);
    assert.deepStrictEqual(comments.filter(comment => comment.type === 'review').map(comment => comment.hasCodeContext), [true, true]);
});

test('claim replay and repeated restoration are idempotent and crash recoverable', async () => {
    const redis = new MemoryRedis();
    const pendingKey = 'pending-pr-comments:integry:propr:42';
    const pendingUse = issue(20, 'use request', 'r1');
    redis.lists.set(pendingKey, [JSON.stringify(pendingUse)]);
    const options = {
        repoOwner: 'integry', repoName: 'propr', pullRequestNumber: 42,
        correlatedLogger: logger as never, redisClient: redis as never, claimId: 'job-1',
    };

    const firstAttempt = await pickUpPendingCommentsWithClaim([issue(10, 'normal', 'r1')], options);
    assert.deepStrictEqual(firstAttempt.commentsToProcess.map(comment => comment.id), [10, 20]);
    assert.strictEqual(redis.lists.has(pendingKey), false);

    // Simulate a crash before BullMQ data is updated/claim is acknowledged.
    const redelivery = await pickUpPendingCommentsWithClaim([issue(10, 'normal', 'r1')], options);
    assert.deepStrictEqual(redelivery.commentsToProcess.map(comment => comment.id), [10, 20]);
    await acknowledgePendingCommentClaim(options);

    await restorePendingComments(redelivery.commentsToProcess, options);
    await restorePendingComments(redelivery.commentsToProcess, options);
    const restored = redis.lists.get(pendingKey)!.map(raw => JSON.parse(raw) as UnprocessedComment);
    assert.deepStrictEqual(restored.map(comment => comment.id), [10, 20]);
});

test('a delayed provider retry activated during /use supersession restores ownership and drops stale routing', async () => {
    const redis = new MemoryRedis();
    const context = {
        commentsToProcess: [issue(10, 'original retry request', 'r1')],
        llm: 'claude-opus-4-8',
        agentAlias: 'claude',
        modelName: 'claude-opus-4-8',
        modelLabel: 'llm-claude-opus48',
    };
    const options = {
        repoOwner: 'integry', repoName: 'propr', pullRequestNumber: 42,
        redisClient: redis as never,
    };

    await restoreSupersededProviderLimitComments(context, options);
    await restoreSupersededProviderLimitComments(context, options);

    assert.deepStrictEqual(
        redis.lists.get('pending-pr-comments:integry:propr:42')!.map(raw => (JSON.parse(raw) as UnprocessedComment).id),
        [10],
    );
    assert.strictEqual(context.llm, null);
    assert.strictEqual(context.agentAlias, undefined);
    assert.strictEqual(context.modelName, undefined);
    assert.strictEqual(context.modelLabel, undefined);
});
