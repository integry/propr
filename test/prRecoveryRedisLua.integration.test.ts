import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { Redis } from 'ioredis';
import {
    acquirePRProcessingLock,
    ensurePRProcessingLockToken,
    releasePRProcessingLock,
} from '../src/jobs/prProcessingLock.js';

const getPendingPrCommentsKey = (owner: string, repo: string, pr: number) =>
    `pending-pr-comments:${owner}:${repo}:${pr}`;
await mock.module('@propr/core', {
    namedExports: { getPendingPrCommentsKey },
});
const {
    pickUpPendingCommentsWithClaim,
    restorePendingComments,
} = await import('../src/jobs/prPendingComments.js');

test('real Redis atomically claims/restores comments and fences a replacement lease', async t => {
    const redis = new Redis({
        host: process.env.REDIS_HOST ?? '127.0.0.1',
        port: Number.parseInt(process.env.REDIS_PORT ?? '6379', 10),
        connectTimeout: 250,
        enableReadyCheck: false,
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        retryStrategy: () => null,
    });
    redis.on('error', () => {});
    try {
        await redis.connect();
    } catch {
        redis.disconnect();
        t.skip('Redis is not available for Lua integration testing');
        return;
    }

    const identity = {
        repoOwner: `lua-owner-${process.pid}`,
        repoName: `lua-repo-${Date.now()}`,
        pullRequestNumber: 2230,
    };
    const pendingKey = getPendingPrCommentsKey(
        identity.repoOwner,
        identity.repoName,
        identity.pullRequestNumber,
    );
    const lockKey = `test:pr-recovery-lock:${process.pid}:${Date.now()}`;
    const older = { id: 100, body: 'older', author: 'alice', type: 'issue' as const };
    const middle = { id: 101, body: 'middle', author: 'bob', type: 'issue' as const };
    const newer = { id: 102, body: 'newer', author: 'carol', type: 'issue' as const };
    const correlatedLogger = { info() {}, warn() {} };

    try {
        await redis.rpush(pendingKey, JSON.stringify(older), JSON.stringify(middle));
        const pickupOptions = { ...identity, correlatedLogger: correlatedLogger as never, redisClient: redis };
        const claims = await Promise.all([
            pickUpPendingCommentsWithClaim([], pickupOptions),
            pickUpPendingCommentsWithClaim([], pickupOptions),
        ]);
        assert.deepStrictEqual(
            claims.map(claim => claim.pickedUpComments.length).sort((a, b) => a - b),
            [0, 2],
        );
        assert.equal(await redis.exists(pendingKey), 0);

        const claimed = claims.find(claim => claim.pickedUpComments.length > 0)?.pickedUpComments ?? [];
        await redis.rpush(pendingKey, JSON.stringify(newer));
        await restorePendingComments(claimed, { ...identity, redisClient: redis });
        await restorePendingComments(claimed, { ...identity, redisClient: redis });
        assert.deepStrictEqual(
            (await redis.lrange(pendingKey, 0, -1)).map(value => JSON.parse(value).id),
            [100, 101, 102],
        );
        assert.ok(await redis.ttl(pendingKey) > 0);

        await redis.set(lockKey, 'lease-b', 'EX', 60);
        const replacementData: { prProcessingLockToken?: string } = {};
        const leaseC = await ensurePRProcessingLockToken(replacementData, 'correlation-c', async () => {});
        assert.notEqual(leaseC, 'lease-b');
        assert.equal(await acquirePRProcessingLock(redis, lockKey, leaseC, 60), false);
        assert.equal(await releasePRProcessingLock(redis, lockKey, leaseC), false);
        assert.equal(await redis.get(lockKey), 'lease-b');
    } finally {
        await redis.del(pendingKey, lockKey).catch(() => 0);
        redis.disconnect();
    }
});
