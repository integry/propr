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
let pricing: Record<string, number> | null = null;
const costInputs: Array<Record<string, number>> = [];
await mock.module('../packages/core/src/services/pricingService.js', { namedExports: {
    getModelPricing: async () => pricing,
} });
await mock.module('../packages/core/src/config/modelAliases.js', { namedExports: {
    getOpenRouterId: (model: string) => model,
} });
await mock.module('../packages/core/src/utils/tokenCalculation.js', { namedExports: {
    calculateCostWithCachePricing: (_model: string, tokens: Record<string, number>) => { costInputs.push(tokens); return 0; },
} });
const { recordLLMMetrics } = await import('../packages/core/src/utils/llmMetrics.js');
const { parseCodexStreamOutput } = await import('../packages/core/src/codex/codexHelpers.js');
const { sumAntigravityStepUsage } = await import('../packages/core/src/agents/impl/antigravityGoalStream.js');
const { sumAntigravitySegmentUsage } = await import('../packages/core/src/agents/impl/antigravityNativeGoal.js');

beforeEach(() => { persisted.length = 0; redisWrites.length = 0; errors.length = 0; queueConstructions = 0; pricing = null; costInputs.length = 0; });

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

test('a conversation whose prompts all carry a cache breakdown persists it as reported', async () => {
    await recordLLMMetrics({
        model: 'test-model', success: true, sessionId: 'session-cache', executionTime: 1000,
        conversationLog: [
            { type: 'assistant', message: { id: 'm1', usage: { input_tokens: 100, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 100 } } },
            { type: 'assistant', message: { id: 'm2', usage: { input_tokens: 50, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } },
        ],
    }, { repoOwner: 'integry', repoName: 'propr', number: 2683 }, { taskId: 'task-2683', correlationId: 'correlation-cache' });
    assert.deepEqual(errors, []);
    const execution = persisted[0].value as Record<string, unknown>;
    assert.equal(execution.cache_usage_reported, true);
    assert.equal(execution.cache_read_input_tokens, 100);
    assert.equal(execution.input_tokens, 250);
});

test('a conversation whose cache breakdown covers only some prompts is persisted as unreported', async () => {
    // The second prompt's cache usage is unknown, so storing the first prompt's
    // count as the execution's measurement would read as a 10% hit rate over 1,000 tokens.
    await recordLLMMetrics({
        model: 'test-model', success: true, sessionId: 'session-partial', executionTime: 1000,
        conversationLog: [
            { type: 'assistant', message: { id: 'm1', usage: { input_tokens: 0, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 100 } } },
            { type: 'assistant', message: { id: 'm2', usage: { input_tokens: 900, output_tokens: 5 } } },
        ],
    }, { repoOwner: 'integry', repoName: 'propr', number: 2683 }, { taskId: 'task-2683', correlationId: 'correlation-partial' });
    assert.deepEqual(errors, []);
    const execution = persisted[0].value as Record<string, unknown>;
    assert.equal(execution.cache_usage_reported, false);
    assert.equal(execution.cache_read_input_tokens, null);
    assert.equal(execution.cache_creation_input_tokens, null);
    assert.equal(execution.input_tokens, 1000);
});

test('a reported usage whose breakdown covers every prompt is trusted when the log lacks usage', async () => {
    await recordLLMMetrics({
        model: 'test-model', success: true, sessionId: 'session-reported', executionTime: 1000,
        tokenUsage: { input_tokens: 40, output_tokens: 5, cache_read_input_tokens: 60 },
        conversationLog: [{ type: 'assistant', message: { content: [{ type: 'text' }] } }],
    }, { repoOwner: 'integry', repoName: 'propr', number: 2683 }, { taskId: 'task-2683', correlationId: 'correlation-reported' });
    assert.deepEqual(errors, []);
    const execution = persisted[0].value as Record<string, unknown>;
    assert.equal(execution.cache_usage_reported, true);
    assert.equal(execution.cache_read_input_tokens, 60);
});

test('a Codex execution whose cache count covers only its first prompt prices its known cached tokens as cached', async () => {
    // 900,000 of the first prompt's 1,000,000 tokens were cached; the second prompt reported
    // no cache count. All 1,100,000 prompt tokens are stored, the 900,000 known cached tokens
    // reach pricing as cache reads rather than full-rate input, and the cache breakdown is
    // withheld from the row so the Analytics hit rate excludes the incomplete measurement.
    const stdout = [
        { type: 'turn.completed', usage: { input_tokens: 1_000_000, cached_input_tokens: 900_000, output_tokens: 25 } },
        { type: 'turn.completed', usage: { input_tokens: 100_000, output_tokens: 5 } },
    ].map(event => JSON.stringify(event)).join('\n');
    const codexOutput = parseCodexStreamOutput(stdout);
    pricing = { prompt: 1, completion: 2 };
    await recordLLMMetrics({
        model: 'test-model', success: true, sessionId: 'session-mixed', executionTime: 1000,
        tokenUsage: codexOutput.tokenUsage, conversationLog: codexOutput.conversationLog as never,
    }, { repoOwner: 'integry', repoName: 'propr', number: 2683 }, { taskId: 'task-2683', correlationId: 'correlation-mixed' });
    assert.deepEqual(errors, []);
    const execution = persisted[0].value as Record<string, unknown>;
    assert.equal(execution.input_tokens, 1_100_000);
    assert.equal(execution.output_tokens, 30);
    assert.equal(execution.cache_usage_reported, false);
    assert.equal(execution.cache_read_input_tokens, null);
    assert.equal(costInputs.length, 1);
    assert.equal(costInputs[0].inputTokens, 200_000);
    assert.equal(costInputs[0].cacheReadTokens, 900_000);
    assert.equal(costInputs[0].totalInputWithCache, 1_100_000);
    assert.equal(costInputs[0].totalTokens, 1_100_030);
});

test('an Antigravity goal whose cache count covers only its first segment prices its known cached tokens as cached', async () => {
    // The first invocation's steps measured 900,000 cached tokens beside 100,000 uncached; the
    // second invocation's step reported no cache count. The goal's usage keeps the cached subtotal
    // for pricing and marks it incomplete, so the row stores every prompt token without a breakdown.
    const segments = [
        { tokenUsage: sumAntigravityStepUsage([{ input_tokens: 100_000, output_tokens: 25, cache_read_tokens: 900_000 }]) },
        { tokenUsage: sumAntigravityStepUsage([{ input_tokens: 100_000, output_tokens: 5 }]) },
    ];
    const tokenUsage = sumAntigravitySegmentUsage(segments);
    assert.deepEqual(tokenUsage, {
        input_tokens: 200_000, output_tokens: 30, reasoning_output_tokens: 0, cache_read_input_tokens: 900_000, cache_usage_incomplete: true,
    });
    pricing = { prompt: 1, completion: 2 };
    await recordLLMMetrics({
        model: 'test-model', success: true, sessionId: 'session-antigravity-mixed', executionTime: 1000,
        tokenUsage, conversationLog: [{ type: 'assistant', message: { content: [{ type: 'text' }] } }],
    }, { repoOwner: 'integry', repoName: 'propr', number: 2683 }, { taskId: 'task-2683', correlationId: 'correlation-antigravity-mixed' });
    assert.deepEqual(errors, []);
    const execution = persisted[0].value as Record<string, unknown>;
    assert.equal(execution.input_tokens, 1_100_000);
    assert.equal(execution.output_tokens, 30);
    assert.equal(execution.cache_usage_reported, false);
    assert.equal(execution.cache_read_input_tokens, null);
    assert.equal(costInputs.length, 1);
    assert.equal(costInputs[0].inputTokens, 200_000);
    assert.equal(costInputs[0].cacheReadTokens, 900_000);
    assert.equal(costInputs[0].totalInputWithCache, 1_100_000);
});
