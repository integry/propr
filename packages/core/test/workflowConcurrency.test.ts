import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Redis } from 'ioredis';
import { ACQUIRE_WORKFLOW_SLOT, withRepositoryWorkflowSlot } from '../src/workflow/workflowConcurrency.js';

const binary = process.env.PROPR_TEST_REDIS_SERVER || 'redis-server';
const available = spawnSync(binary, ['--version']).status === 0;

test('shared admission respects active branch caps, legacy runs, expiry, release and cancellation', { skip: !available && 'redis-server is needed for the Lua integration test' }, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'workflow-redis-'));
    const socket = path.join(directory, 'redis.sock');
    const server = spawn(binary, ['--port', '0', '--unixsocket', socket, '--save', '', '--appendonly', 'no'], { stdio: 'ignore' });
    const redis = new Redis({ path: socket, lazyConnect: true, retryStrategy: () => 25, maxRetriesPerRequest: 20 });
    redis.on('error', () => undefined);
    try {
        for (let attempt = 0; ; attempt++) {
            try { await access(socket); break; }
            catch {
                if (attempt > 100) throw new Error('Redis test server did not create its socket');
                await new Promise(resolve => setTimeout(resolve, 25));
            }
        }
        await redis.connect();
        const key = 'slots';
        const claim = (token: string, limit: number) => redis.eval(ACQUIRE_WORKFLOW_SLOT, 2, key, 'limits', token, limit);
        assert.equal(await claim('legacy', 0), 1);
        const admissions = await Promise.all(Array.from({ length: 12 }, (_, index) => claim(`run-${index}`, 3)));
        assert.equal(admissions.filter(value => value === 1).length, 2, 'legacy run counts toward a workflow cap across workers');
        assert.equal(await claim('other-branch', 20), 0, 'larger branch policy cannot exceed an active lower cap');
        assert.equal(await claim('no-workflow', 0), 0, 'a legacy run cannot bypass an active cap');
        await redis.zadd(key, 1, 'legacy', 1, 'run-0', 1, 'run-1');
        assert.equal(await claim('recovered', 1), 1, 'abandoned leases are reclaimed');
        assert.equal(await redis.hlen('limits'), 1);

        const options = { redis, repository: 'example/workflow', limit: 1, checkCancelled: async () => {}, onLeaseError: (error: unknown) => { throw error; } };
        await assert.rejects(withRepositoryWorkflowSlot(options, async () => { throw new Error('agent failed'); }), /agent failed/);
        const counts = await withRepositoryWorkflowSlot(options, () => redis.zcard('propr:workflow:slots:{example/workflow}'));
        assert.equal(counts, 1);
        assert.equal(await redis.zcard('propr:workflow:slots:{example/workflow}'), 0);
        await assert.rejects(withRepositoryWorkflowSlot({ ...options, checkCancelled: async () => { throw new Error('cancelled'); } }, async () => assert.fail('cancelled task must never run')), /cancelled/);
    } finally {
        redis.disconnect();
        server.kill('SIGTERM');
        await new Promise<void>(resolve => server.once('exit', () => resolve()));
        await rm(directory, { recursive: true, force: true });
    }
});
