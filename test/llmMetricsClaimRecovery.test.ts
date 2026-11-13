import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';

// One store shared by every client, as every worker shares one Redis. A claim's value is its claimant's token.
const claims = new Map<string, string>();
const counters = new Map<string, number>();
const executions: Array<Record<string, unknown>> = [];
const details: unknown[] = [];
const failNext = { setex: 0, incr: 0, executionInsert: 0, detailsInsert: 0 };

await mock.module('ioredis', { namedExports: { Redis: class {
    async setex() { if (failNext.setex > 0) { failNext.setex--; throw new Error('redis setex failed'); } }
    async lpush() {}
    async ltrim() {}
    async sadd() {}
    async incr(key: string) {
        if (failNext.incr > 0) { failNext.incr--; throw new Error('redis incr failed'); }
        counters.set(key, (counters.get(key) ?? 0) + 1);
        return counters.get(key);
    }
    async get() { return null; }
    async set(key: string, value: string, ...args: unknown[]) {
        if (args.includes('NX')) {
            if (claims.has(key)) return null;
            claims.set(key, value);
        }
        return 'OK';
    }
    async eval(_script: string, _keys: number, key: string, token: string) {
        if (claims.get(key) !== token) return 0;
        claims.delete(key);
        return 1;
    }
    async quit() {}
} } });
await mock.module('../packages/core/src/db/connection.js', { namedExports: {
    closeConnection: async () => {},
    db: (table: string) => ({
        where() { return this; },
        async first() { return { task_id: 'task-3437' }; },
        insert(value: Record<string, unknown> | Array<Record<string, unknown>>) {
            if (table === 'llm_executions') {
                if (failNext.executionInsert > 0) {
                    failNext.executionInsert--;
                    const rejected = Promise.reject(new Error('insert failed'));
                    rejected.catch(() => {});
                    return Object.assign(rejected, { returning: () => rejected });
                }
                const uuid = (value as Record<string, unknown>).execution_uuid;
                if (uuid && executions.some(row => row.execution_uuid === uuid)) {
                    // What better-sqlite3 raises for the unique execution_uuid index.
                    const rejected = Promise.reject(Object.assign(new Error('UNIQUE constraint failed: llm_executions.execution_uuid'), { code: 'SQLITE_CONSTRAINT_UNIQUE' }));
                    rejected.catch(() => {});
                    return Object.assign(rejected, { returning: () => rejected });
                }
                executions.push(value as Record<string, unknown>);
            }
            if (table === 'llm_execution_details') details.push(value);
            if (table === 'llm_execution_details' && failNext.detailsInsert > 0) {
                failNext.detailsInsert--;
                return Promise.reject(new Error('details insert failed'));
            }
            return Object.assign(Promise.resolve(), { returning: async () => [{ execution_id: `row-${executions.length}` }] });
        },
    }),
} });
await mock.module('../packages/core/src/utils/logger.js', { defaultExport: { info() {}, debug() {}, warn() {}, error() {} } });
await mock.module('../packages/core/src/services/pricingService.js', { namedExports: {
    getModelPricing: async () => ({ prompt: 0.001, completion: 0.002 }),
} });

const { recordLLMMetrics } = await import('../packages/core/src/utils/llmMetrics.js');
const { releaseExecutionStage } = await import('../packages/core/src/utils/llmMetricsExecutionClaim.js');

const issueRef = { repoOwner: 'integry', repoName: 'propr', number: 3437 };
const failedCount = () => counters.get('llm:metrics:total:failed') ?? 0;
const failedResult = (executionId: string) => ({
    executionId, model: 'test-model', success: false, error: 'worktree verification failed', executionTime: 1000,
    tokenUsage: { input_tokens: 2000, output_tokens: 100 },
    conversationLog: [{ type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } }],
});
const record = (executionId: string) =>
    recordLLMMetrics(failedResult(executionId), issueRef, { jobType: 'issue', correlationId: `correlation-${executionId}`, taskId: 'task-3437' });

beforeEach(() => {
    claims.clear(); counters.clear(); executions.length = 0; details.length = 0;
    Object.assign(failNext, { setex: 0, incr: 0, executionInsert: 0, detailsInsert: 0 });
});

test('a row insert that fails leaves the execution recordable: the next record inserts exactly one row and counts once', async () => {
    failNext.executionInsert = 1;
    await record('insert-fails');
    assert.equal(executions.length, 0);
    assert.equal(failedCount(), 1, 'the counters were written by the first attempt');
    assert.equal(claims.has('llm:metrics:persisted:insert-fails'), false, 'the row claim is released');

    // The failure handler records the same result again.
    await record('insert-fails');
    assert.equal(executions.length, 1);
    assert.ok(Number(executions[0].cost_usd) > 0);
    assert.equal(failedCount(), 1, 'the counters are not incremented twice');

    await record('insert-fails');
    assert.equal(executions.length, 1, 'a completed record still deduplicates');
});

test('a Redis failure before any counter is written releases the claim, and the next record writes both once', async () => {
    failNext.setex = 1;
    await record('redis-fails-early');
    assert.equal(executions.length, 0);
    assert.equal(failedCount(), 0);
    assert.equal(claims.size, 0, 'no stage stays claimed');

    await record('redis-fails-early');
    assert.equal(executions.length, 1);
    assert.equal(failedCount(), 1);
});

test('a failure while counting keeps the counters claimed; the next record inserts the row without recounting', async () => {
    failNext.incr = 1;
    await record('counting-fails');
    assert.equal(executions.length, 0);
    const countedFirst = failedCount();

    await record('counting-fails');
    assert.equal(executions.length, 1);
    assert.equal(failedCount(), countedFirst, 'partly written counters are not written again');
});

test('a row whose details fail to insert still counts as recorded', async () => {
    failNext.detailsInsert = 1;
    await record('details-fail');
    assert.equal(failNext.detailsInsert, 0, 'the details insert was attempted and failed');
    assert.equal(executions.length, 1);
    await record('details-fail');
    assert.equal(executions.length, 1);
    assert.equal(failedCount(), 1);
});

test('a release never removes a claim another recorder holds', async () => {
    // Another worker holds the row claim; this worker's insert attempt never happens, so it releases nothing.
    claims.set('llm:metrics:persisted:held-elsewhere', 'other-token');
    failNext.executionInsert = 1;
    await record('held-elsewhere');
    assert.equal(claims.get('llm:metrics:persisted:held-elsewhere'), 'other-token');
    assert.equal(executions.length, 0);
});

test('the row stays unique after every claim is gone: a late record of a persisted execution inserts nothing', async () => {
    await record('claims-expired');
    assert.equal(executions.length, 1);
    assert.equal(executions[0].execution_uuid, 'claims-expired', 'the execution id is stored on its row');
    const detailRows = details.length;

    // Both protections disappear: the Redis claims expire and this process's bounded set evicts the ids.
    for (const key of ['llm:metrics:recorded:claims-expired', 'llm:metrics:persisted:claims-expired']) {
        await releaseExecutionStage({ set: async () => 'OK', eval: async () => 1 }, { key, token: claims.get(key) ?? '' });
    }
    claims.clear();
    await record('claims-expired');
    assert.equal(executions.length, 1, 'the unique execution id rejects a second row');
    assert.equal(details.length, detailRows, 'no details are written for the rejected row');
    assert.equal(claims.has('llm:metrics:persisted:claims-expired'), true, 'the row stage stays claimed');

    await record('claims-expired');
    assert.equal(executions.length, 1);
});

test('results without an execution id are stored without one and never collide', async () => {
    const { executionId: _omitted, ...withoutId } = failedResult('unused');
    await recordLLMMetrics(withoutId, issueRef, { jobType: 'issue', correlationId: 'no-id-1', taskId: 'task-3437' });
    await recordLLMMetrics(withoutId, issueRef, { jobType: 'issue', correlationId: 'no-id-2', taskId: 'task-3437' });
    assert.equal(executions.length, 2);
    assert.deepEqual(executions.map(row => row.execution_uuid), [null, null]);
});
