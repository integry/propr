import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';

const persisted: Array<{ table: string; value: Record<string, unknown> | Array<Record<string, unknown>> }> = [];

await mock.module('ioredis', { namedExports: { Redis: class {
    async setex() {} async lpush() {} async ltrim() {} async sadd() {} async incr() {}
    async get() { return null; } async set() { return 'OK'; } async quit() {}
} } });
await mock.module('bullmq', { namedExports: { Queue: class {}, Worker: class {}, Job: class {} } });
await mock.module('../packages/core/src/db/connection.js', { namedExports: {
    db: (table: string) => ({
        where() { return this; },
        async first() { return { task_id: 'task-1' }; },
        insert(value: Record<string, unknown> | Array<Record<string, unknown>>) {
            persisted.push({ table, value });
            return Object.assign(Promise.resolve(), { returning: async () => [{ execution_id: 'execution-1' }] });
        },
    }),
} });
await mock.module('../packages/core/src/utils/logger.js', { defaultExport: { info() {}, debug() {}, warn() {}, error() {} } });
let pricing: Record<string, number> | null = null;
await mock.module('../packages/core/src/services/pricingService.js', { namedExports: { getModelPricing: async () => pricing } });
await mock.module('../packages/core/src/config/modelAliases.js', { namedExports: { getOpenRouterId: (model: string) => model } });
// A catalog estimate that no test expects, so a catalog price shows up as a wrong cost.
await mock.module('../packages/core/src/utils/tokenCalculation.js', { namedExports: { calculateCostWithCachePricing: () => 99 } });
const { recordLLMMetrics } = await import('../packages/core/src/utils/llmMetrics.js');

const issueRef = { repoOwner: 'o', repoName: 'r', number: 1 };
// A custom LiteLLM model the pricing catalog does not know.
const result = (overrides: Record<string, unknown> = {}) => ({
    model: 'opencode-litellm/custom/unlisted-model', success: true, executionTime: 1000, sessionId: 's1', conversationLog: [],
    tokenUsage: { input_tokens: 100, output_tokens: 10 }, ...overrides,
});
const executionCost = () => (persisted.find(entry => entry.table === 'llm_executions')!.value as Record<string, unknown>).cost_usd;

beforeEach(() => { persisted.length = 0; pricing = null; });

test('execution cost uses the provider cost for a model unknown to the pricing catalog', async () => {
    await recordLLMMetrics(result({ providerCostUsd: 1.25 }), issueRef, { taskId: 'task-1', correlationId: 'c1' });
    assert.equal(executionCost(), 1.25);
});

test('a provider cost beats the catalog estimate, and a reported zero is kept', async () => {
    pricing = { prompt: 1, completion: 1 };
    await recordLLMMetrics(result({ providerCostUsd: 0 }), issueRef, { taskId: 'task-1', correlationId: 'c2' });
    assert.equal(executionCost(), 0);
});

test('invalid provider costs fall back to the other cost sources', async () => {
    for (const providerCostUsd of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
        persisted.length = 0;
        await recordLLMMetrics(result({ providerCostUsd, finalResult: { total_cost_usd: 0.4 } }), issueRef, { taskId: 'task-1', correlationId: `c-${providerCostUsd}` });
        assert.equal(executionCost(), 0.4);
    }
});

test('without a provider cost the execution keeps its existing cost fallback', async () => {
    await recordLLMMetrics(result({ finalResult: { total_cost_usd: 0.7 } }), issueRef, { taskId: 'task-1', correlationId: 'c3' });
    assert.equal(executionCost(), 0.7);
});

test('without a provider cost a catalog price still estimates the cost', async () => {
    pricing = { prompt: 1, completion: 1 };
    await recordLLMMetrics(result(), issueRef, { taskId: 'task-1', correlationId: 'c4' });
    assert.equal(executionCost(), 99);
});
