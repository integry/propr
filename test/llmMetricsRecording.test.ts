import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';

const persisted: Array<{ table: string; value: Record<string, unknown> | Array<Record<string, unknown>> }> = [];
const redisWrites: string[] = [];
const errors: unknown[] = [];
let queueConstructions = 0;

await mock.module('ioredis', { namedExports: { Redis: class {
    async setex(key: string) { redisWrites.push(key); }
    async lpush(key: string) { redisWrites.push(key); }
    async ltrim() {}
    async sadd() {}
    async incr() {}
    async get() { return null; }
    async set(key: string) { redisWrites.push(key); }
    async quit() {}
} } });
await mock.module('bullmq', { namedExports: {
    Queue: class { constructor() { queueConstructions++; } },
    Worker: class {}, Job: class {},
} });
await mock.module('../packages/core/src/db/connection.js', { namedExports: {
    db: (table: string) => ({
        where() { return this; },
        async first() { return { task_id: 'task-2683' }; },
        insert(value: Record<string, unknown> | Array<Record<string, unknown>>) {
            persisted.push({ table, value });
            return Object.assign(Promise.resolve(), { returning: async () => [{ execution_id: 'execution-2683' }] });
        },
    }),
} });
await mock.module('../packages/core/src/utils/logger.js', { defaultExport: {
    info() {}, debug() {}, warn() {}, error(error: unknown) { errors.push(error); },
} });
await mock.module('../packages/core/src/services/pricingService.js', { namedExports: {
    getModelPricing: async () => null,
} });
await mock.module('../packages/core/src/config/modelAliases.js', { namedExports: {
    getOpenRouterId: (model: string) => model,
} });
await mock.module('../packages/core/src/utils/tokenCalculation.js', { namedExports: {
    calculateCostWithCachePricing: () => 0,
} });
const { recordLLMMetrics } = await import('../packages/core/src/utils/llmMetrics.js');

beforeEach(() => { persisted.length = 0; redisWrites.length = 0; errors.length = 0; queueConstructions = 0; });

for (const executionType of [undefined, 'implementation', 'pr-review'] as const) {
    test(`recording ${executionType ?? 'default implementation'} persists the execution and conversation without creating a queue`, async () => {
        await recordLLMMetrics({
            model: 'test-model', success: true, sessionId: 'session-2683', executionTime: 1000,
            tokenUsage: { input_tokens: 12, output_tokens: 34 },
            conversationLog: [{ type: 'assistant', message: { content: [{ type: 'text' }] } }],
        }, { repoOwner: 'integry', repoName: 'propr', number: 2683 }, {
            taskId: 'task-2683', correlationId: 'correlation-2683', executionType,
        });
        assert.deepEqual(errors, []);
        assert.equal(queueConstructions, 0);
        assert.deepEqual(persisted.map(entry => entry.table), ['llm_executions', 'llm_execution_details']);
        assert.equal((persisted[0].value as Record<string, unknown>).task_id, 'task-2683');
        assert.equal((persisted[0].value as Record<string, unknown>).input_tokens, 12);
        assert.equal((persisted[1].value as Array<Record<string, unknown>>)[0].execution_id, 'execution-2683');
        assert.ok(redisWrites.includes('llm:metrics:correlation-2683'));
    });
}
