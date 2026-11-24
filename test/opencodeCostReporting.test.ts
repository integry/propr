import assert from 'node:assert/strict';
import { after, describe, mock, test } from 'node:test';

const core = await import('@propr/core');
// The issue job's shared Redis client is created at import; nothing here needs it.
await mock.module('../src/jobs/issueJob/config.js', { namedExports: {
    redisClient: {}, DEFAULT_MODEL_NAME: null, getPrimaryProcessingLabels: async () => ['AI'], getPrLabel: () => 'propr',
} });

const { toClaudeResult } = await import('../src/jobs/issueJob/agent.js');
const { agentResultToMetricsResult, failedExecutionResult } = await import('../packages/core/src/agents/impl/utils/failedAgentExecution.js');

const { parseOpenCodeJsonl } = await import('../packages/core/src/agents/impl/openCodeParsing.js');
const { createLlmLogFromAgentExecution, createLlmLogFromAnalysis } = await import('../packages/core/src/utils/llmLogger.js');

const jsonl = (...events: unknown[]) => events.map(event => JSON.stringify(event)).join('\n');
const stepFinish = (id: string, cost: unknown, tokens = { input: 10, output: 5, cache: { read: 0, write: 0 } }) =>
    ({ type: 'step_finish', sessionID: 's1', part: { id, type: 'step-finish', cost, tokens } });

after(async () => {
    await core.closeConnection?.();
    const { db } = await import('../packages/core/src/db/connection.js');
    await db.destroy();
});

describe('OpenCode cost parsing', () => {
    test('sums the incremental cost of each step_finish', () => {
        const parsed = parseOpenCodeJsonl(jsonl(stepFinish('a', 0.25), stepFinish('b', 0.5), stepFinish('c', 0.125)));
        assert.equal(parsed.cost, 0.875);
    });

    test('counts a repeated step_finish part once', () => {
        const parsed = parseOpenCodeJsonl(jsonl(stepFinish('a', 0.25), stepFinish('a', 0.25), stepFinish('b', 0.5)));
        assert.equal(parsed.cost, 0.75);
    });

    test('a cumulative result total replaces the step sum instead of adding to it', () => {
        const parsed = parseOpenCodeJsonl(jsonl(
            stepFinish('a', 0.25), stepFinish('b', 0.5),
            { type: 'result', sessionID: 's1', total_cost_usd: 0.75, usage: { input_tokens: 20, output_tokens: 10 } },
            { type: 'result', sessionID: 's1', total_cost_usd: 0.75 },
        ));
        assert.equal(parsed.cost, 0.75);
    });

    test('keeps the largest cumulative total when snapshots repeat', () => {
        const parsed = parseOpenCodeJsonl(jsonl(
            { type: 'result', sessionID: 's1', stats: { cost: 0.5 } },
            { type: 'result', sessionID: 's1', stats: { cost: 1.5 } },
            { type: 'result', sessionID: 's1', stats: { cost: 1.5 } },
        ));
        assert.equal(parsed.cost, 1.5);
    });

    test('an explicit zero cost is reported, a missing cost is not', () => {
        assert.equal(parseOpenCodeJsonl(jsonl(stepFinish('a', 0), stepFinish('b', 0))).cost, 0);
        assert.equal(parseOpenCodeJsonl(jsonl({ type: 'step_finish', sessionID: 's1', part: { id: 'a', type: 'step-finish', tokens: { input: 1, output: 1 } } })).cost, undefined);
        assert.equal(parseOpenCodeJsonl(jsonl({ type: 'text', sessionID: 's1', part: { type: 'text', text: 'hi' } })).cost, undefined);
    });

    test('ignores negative, non-finite, malformed and non-numeric costs', () => {
        const parsed = parseOpenCodeJsonl(jsonl(
            stepFinish('a', -1), stepFinish('b', 'NaN'), stepFinish('c', null), stepFinish('d', {}), stepFinish('e', 'abc'), stepFinish('f', ''),
            stepFinish('g', Number.MAX_VALUE * 10),
            { type: 'result', sessionID: 's1', total_cost_usd: -3 },
        ) + '\n{not json');
        assert.equal(parsed.cost, undefined);
        const mixed = parseOpenCodeJsonl(jsonl(stepFinish('a', -1), stepFinish('b', 0.4), stepFinish('c', '0.1')));
        assert.equal(mixed.cost, 0.5);
    });

    test('does not read costs from other event types', () => {
        const parsed = parseOpenCodeJsonl(jsonl({ type: 'tool_use', sessionID: 's1', part: { id: 't', type: 'tool', cost: 9 } }));
        assert.equal(parsed.cost, undefined);
    });

    test('leaves token accounting unchanged', () => {
        const parsed = parseOpenCodeJsonl(jsonl(
            stepFinish('a', 0.25, { input: 100, output: 10, cache: { read: 80, write: 0 } }),
            stepFinish('b', 0.5, { input: 200, output: 20, cache: { read: 150, write: 0 } }),
        ));
        assert.deepEqual(parsed.tokenUsage, { input_tokens: 300, output_tokens: 30, cache_read_input_tokens: 230 });
    });
});

describe('OpenCode cost propagation', () => {
    const agentResult = (overrides: Record<string, unknown> = {}) => ({
        success: true, logs: '', modifiedFiles: [], modelUsed: 'opencode-litellm/custom/unlisted-model', executionTimeMs: 1000,
        executionId: 'exec-1', sessionId: 's1', conversationLog: [], tokenUsage: { input_tokens: 100, output_tokens: 10 },
        ...overrides,
    });

    test('toClaudeResult carries the provider cost, including zero, and omits it when absent', () => {
        assert.equal(toClaudeResult(agentResult({ providerCostUsd: 1.25 }) as never).providerCostUsd, 1.25);
        assert.equal(toClaudeResult(agentResult({ providerCostUsd: 0 }) as never).providerCostUsd, 0);
        assert.equal('providerCostUsd' in toClaudeResult(agentResult() as never), false);
    });

    test('the failure-path adapters keep the provider cost', () => {
        const completed = agentResult({ providerCostUsd: 2 }) as never;
        assert.equal(agentResultToMetricsResult(completed).providerCostUsd, 2);
        assert.equal(failedExecutionResult(new Error('later step failed'), { executionTimeMs: 5, model: 'm', completed }).providerCostUsd, 2);
    });

    test('log entries carry the provider cost, including zero', () => {
        const base = { executionType: 'implementation' as const, modelUsed: 'm', executionTimeMs: 10, success: true };
        assert.equal(createLlmLogFromAgentExecution({ ...base, costUsd: 3.5 }).costUsd, 3.5);
        assert.equal(createLlmLogFromAnalysis({ ...base, costUsd: 0 }).costUsd, 0);
        assert.equal(createLlmLogFromAnalysis(base).costUsd, undefined);
    });
});
