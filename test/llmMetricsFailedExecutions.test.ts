import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';

// One store shared by every client, as every worker shares one Redis.
const claimed = new Set<string>();
const counters = new Map<string, number>();
const executions: Array<Record<string, unknown>> = [];
const llmLogs: Array<Record<string, unknown>> = [];
const errors: unknown[] = [];

await mock.module('ioredis', { namedExports: { Redis: class {
    async setex() {}
    async lpush() {}
    async ltrim() {}
    async sadd() {}
    async incr(key: string) { counters.set(key, (counters.get(key) ?? 0) + 1); return counters.get(key); }
    async get() { return null; }
    async set(key: string, _value: string, ...args: unknown[]) {
        if (args.includes('NX')) {
            if (claimed.has(key)) return null;
            claimed.add(key);
        }
        return 'OK';
    }
    async quit() {}
} } });
await mock.module('../packages/core/src/db/connection.js', { namedExports: {
    closeConnection: async () => {},
    db: (table: string) => ({
        where() { return this; },
        async first() { return { task_id: 'task-3437' }; },
        insert(value: Record<string, unknown>) {
            if (table === 'llm_executions') executions.push(value);
            if (table === 'llm_logs') llmLogs.push(value);
            return Object.assign(Promise.resolve(), { returning: async () => [{ execution_id: `row-${executions.length}` }] });
        },
    }),
} });
await mock.module('../packages/core/src/utils/logger.js', { defaultExport: {
    info() {}, debug() {}, warn() {}, error(error: unknown) { errors.push(error); },
} });
await mock.module('../packages/core/src/services/pricingService.js', { namedExports: {
    getModelPricing: async () => ({ prompt: 0.001, completion: 0.002 }),
} });

const { recordLLMMetrics } = await import('../packages/core/src/utils/llmMetrics.js');
const { parseStreamJsonOutput, UsageLimitError } = await import('../packages/core/src/claude/claudeHelpers.js');
const {
    failedExecutionResult, recordUnreturnedFailedExecution, usageLimitExecutionResult, agentResultToMetricsResult,
} = await import('../packages/core/src/agents/impl/utils/failedAgentExecution.js');

const issueRef = { repoOwner: 'integry', repoName: 'propr', number: 3437 };
const options = { issueRef, taskId: 'task-3437' };
const failedCount = () => counters.get('llm:metrics:total:failed') ?? 0;
const successfulCount = () => counters.get('llm:metrics:total:successful') ?? 0;

beforeEach(() => { claimed.clear(); counters.clear(); executions.length = 0; llmLogs.length = 0; errors.length = 0; });

test('a second record of the same execution id inserts no second row and counts nothing twice', async () => {
    const result = { executionId: 'execution-once', model: 'test-model', success: true, executionTime: 1000, tokenUsage: { input_tokens: 10, output_tokens: 5 } };
    await recordLLMMetrics(result, issueRef, { correlationId: 'correlation-once', taskId: 'task-3437' });
    // The failure handler records the result the run already recorded.
    await recordLLMMetrics({ ...result }, issueRef, { correlationId: 'correlation-once', taskId: 'task-3437' });
    assert.deepEqual(errors, []);
    assert.equal(executions.length, 1);
    assert.equal(successfulCount(), 1);
});

test('the claim holds across workers: a record whose id another process claimed is skipped', async () => {
    // Another worker recorded the execution: its claim is in the shared store, not in this process.
    claimed.add('llm:metrics:recorded:execution-elsewhere');
    await recordLLMMetrics({ executionId: 'execution-elsewhere', model: 'test-model', success: false, error: 'boom' }, issueRef, { taskId: 'task-3437' });
    assert.equal(executions.length, 0);
    assert.equal(failedCount(), 0);
});

test('distinct executions, and results without an id, are each recorded', async () => {
    await recordLLMMetrics({ executionId: 'execution-a', model: 'test-model', success: true }, issueRef, { correlationId: 'a' });
    await recordLLMMetrics({ executionId: 'execution-b', model: 'test-model', success: true }, issueRef, { correlationId: 'b' });
    await recordLLMMetrics({ model: 'test-model', success: true }, issueRef, { correlationId: 'c' });
    await recordLLMMetrics({ model: 'test-model', success: true }, issueRef, { correlationId: 'c' });
    assert.equal(executions.length, 4);
    assert.equal(successfulCount(), 4);
});

test('a usage limit keeps the stream it interrupted, and records one failed row with its tokens and cost', async () => {
    const stdout = [
        { type: 'system', session_id: 'session-limit', model: 'claude-opus-5-5' },
        { type: 'assistant', message: { id: 'm1', model: 'claude-opus-5-5', usage: { input_tokens: 1200, output_tokens: 300 }, content: [{ type: 'text', text: 'working' }] } },
        { type: 'result', is_error: true, result: 'Claude AI usage limit reached|1900000000', total_cost_usd: 0.42,
            usage: { input_tokens: 1200, output_tokens: 300 } },
    ].map(line => JSON.stringify(line)).join('\n');
    let thrown: InstanceType<typeof UsageLimitError> | undefined;
    try {
        parseStreamJsonOutput({ stdout, stderr: '', exitCode: 1, messageTimestamps: new Map() } as never);
    } catch (error) {
        thrown = error as InstanceType<typeof UsageLimitError>;
    }
    assert.ok(thrown instanceof UsageLimitError);
    assert.equal(thrown.partialOutput?.sessionId, 'session-limit');
    assert.equal(thrown.partialOutput?.finalResult?.total_cost_usd, 0.42);

    const result = usageLimitExecutionResult(thrown, { prompt: 'Fix it', model: 'requested-model', executionTimeMs: 5000, reasoningLevel: 'high' });
    await recordUnreturnedFailedExecution(result, options, 'claude');

    assert.deepEqual(errors, []);
    assert.equal(executions.length, 1);
    const [row] = executions;
    assert.equal(row.success, false);
    assert.match(String(row.error_message), /usage limit/i);
    assert.equal(row.model_name, 'claude-opus-5-5');
    assert.equal(row.session_id, 'session-limit');
    assert.equal(row.input_tokens, 1200);
    assert.equal(row.output_tokens, 300);
    assert.ok(Number(row.cost_usd) > 0, 'the tokens spent before the limit are priced');
    assert.equal(row.reasoning_level, 'high');
    assert.equal(failedCount(), 1);
    // The agent's own log row is written too, as for a run that completed.
    assert.equal(llmLogs.length, 1);
    assert.equal(llmLogs[0].success, false);
});

test('a usage limit before any streamed turn still records one failed row, with zero tokens and cost', async () => {
    const error = new UsageLimitError('Claude usage limit reached. Limit resets at timestamp 1900000000.', 1900000000);
    await recordUnreturnedFailedExecution(usageLimitExecutionResult(error, { model: 'claude-opus-5-5', executionTimeMs: 10 }), options, 'claude');
    assert.equal(executions.length, 1);
    assert.equal(executions[0].success, false);
    assert.equal(executions[0].input_tokens, 0);
    assert.equal(executions[0].output_tokens, 0);
    assert.equal(executions[0].cost_usd, 0);
    assert.equal(failedCount(), 1);
});

test('a thrown agent error is one failed row with what the run had spent, however many paths record it', async () => {
    // The run produced a result, then a later step (worktree verification) threw.
    const completed = {
        executionId: 'execution-thrown', success: true, executionTimeMs: 4000, logs: '', modifiedFiles: [], commitMessage: null,
        modelUsed: 'gpt-5.6', sessionId: 'session-thrown', tokenUsage: { input_tokens: 2000, output_tokens: 100 },
    };
    const failed = failedExecutionResult(new Error('worktree verification failed'), { completed, model: 'fallback', executionTimeMs: 4500 });
    assert.equal(failed.executionId, 'execution-thrown');
    assert.equal(failed.success, false);
    // The job records the returned result, and its error handler records it again.
    await recordLLMMetrics(agentResultToMetricsResult(failed), issueRef, { jobType: 'issue', correlationId: 'thrown', taskId: 'task-3437' });
    await recordLLMMetrics(agentResultToMetricsResult(failed), issueRef, { jobType: 'issue', correlationId: 'thrown', taskId: 'task-3437' });

    assert.equal(executions.length, 1);
    assert.equal(executions[0].success, false);
    assert.equal(executions[0].error_message, 'worktree verification failed');
    assert.equal(executions[0].input_tokens, 2000);
    assert.ok(Number(executions[0].cost_usd) > 0);
    assert.equal(failedCount(), 1);
    assert.equal(successfulCount(), 0);
});

test('a thrown error before any run is a failed result with a fresh id and no tokens', async () => {
    const failed = failedExecutionResult(new Error('could not chown worktree'), { model: 'claude-opus-5-5', executionTimeMs: 3 });
    assert.ok(failed.executionId);
    assert.equal(failed.tokenUsage, undefined);
    await recordLLMMetrics(agentResultToMetricsResult(failed), issueRef, { correlationId: 'early' });
    assert.equal(executions.length, 1);
    assert.equal(executions[0].input_tokens, 0);
    assert.equal(executions[0].cost_usd, 0);
    assert.equal(executions[0].error_message, 'could not chown worktree');
});
