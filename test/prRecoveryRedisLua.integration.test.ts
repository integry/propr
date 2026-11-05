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
    withdrawPendingComments,
} = await import('../src/jobs/prPendingComments.js');

async function connectRealRedis(): Promise<Redis | null> {
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
        return redis;
    } catch {
        redis.disconnect();
        return null;
    }
}

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

test('real Redis withdraws exactly the restored comment IDs and keeps unrelated pending work', async t => {
    const redis = await connectRealRedis();
    if (!redis) {
        t.skip('Redis is not available for Lua integration testing');
        return;
    }
    const identity = { repoOwner: `lua-owner-${process.pid}`, repoName: `lua-withdraw-${Date.now()}`, pullRequestNumber: 2231 };
    const pendingKey = getPendingPrCommentsKey(identity.repoOwner, identity.repoName, identity.pullRequestNumber);
    const unrelated = { id: 200, body: 'unrelated', author: 'dave', type: 'issue' as const };
    const restored = [
        { id: 201, body: 'restored a', author: 'erin', type: 'issue' as const },
        { id: 202, body: 'restored b', author: 'frank', type: 'issue' as const },
    ];
    try {
        await redis.rpush(pendingKey, JSON.stringify(unrelated), 'not-json');
        await restorePendingComments(restored, { ...identity, redisClient: redis });
        await withdrawPendingComments(restored.map(comment => comment.id), { ...identity, redisClient: redis });
        assert.deepStrictEqual(await redis.lrange(pendingKey, 0, -1), [JSON.stringify(unrelated), 'not-json']);
        // Idempotent: a retried withdrawal changes nothing.
        await withdrawPendingComments(restored.map(comment => comment.id), { ...identity, redisClient: redis });
        assert.equal(await redis.llen(pendingKey), 2);
    } finally {
        await redis.del(pendingKey);
        await redis.quit();
    }
});

test('the non-eval withdrawal fallback removes only the given comment IDs', async () => {
    const list = [JSON.stringify({ id: 1 }), JSON.stringify({ id: 2 }), 'not-json', JSON.stringify({ id: 3 })];
    const client = {
        async lrange() { return [...list]; },
        async lrem(_key: string, _count: number, value: string) {
            let removed = 0;
            for (let index = list.indexOf(value); index !== -1; index = list.indexOf(value)) { list.splice(index, 1); removed += 1; }
            return removed;
        },
    };
    await withdrawPendingComments([1, 3], { repoOwner: 'o', repoName: 'r', pullRequestNumber: 1, redisClient: client as never });
    assert.deepStrictEqual(list, [JSON.stringify({ id: 2 }), 'not-json']);
});
