import assert from 'node:assert';
import { after, describe, test } from 'node:test';
import { closeConnection } from '@propr/core';
import type { ExecutionResult } from '../packages/core/src/claude/docker/dockerExecutor.js';
import { parseStreamJsonOutput } from '../packages/core/src/claude/claudeHelpers.js';
import { processDockerResult } from '../packages/core/src/agents/impl/utils/dockerResultProcessor.js';
import { agentResultToClaudeResponse } from '../src/jobs/prFileUtils.js';
import { getPostExecutionDisposition } from '../src/jobs/prCommentPostExecution.js';

after(async () => {
    await closeConnection();
});

const usage = { input_tokens: 120, output_tokens: 45 };

function execution(exitCode: number | null, isError: boolean, overrides: Partial<ExecutionResult> = {}): ExecutionResult {
    return {
        exitCode,
        stdout: [
            JSON.stringify({ type: 'assistant', session_id: 'session-1', message: { id: 'm1', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Running sleep 60 before editing.' }] } }),
            JSON.stringify({
                type: 'result', subtype: isError ? 'error_during_execution' : 'success', is_error: isError,
                result: 'Synthetic terminal result', session_id: 'session-1', total_cost_usd: 0.25, usage,
            }),
        ].join('\n') + '\n',
        stderr: '',
        messageTimestamps: new Map(),
        ...overrides,
    };
}

describe('Claude nonzero exit after a streamed success result', () => {
    for (const exitCode of [137, 143, 1]) {
        test(`exit ${exitCode} with a non-error terminal result is a failed run`, () => {
            const result = execution(exitCode, false);

            const parsed = parseStreamJsonOutput(result);
            assert.strictEqual(parsed.success, false);
            // Terminal diagnostics are preserved.
            assert.strictEqual(parsed.finalResult?.result, 'Synthetic terminal result');
            assert.strictEqual(parsed.finalResult?.is_error, false);
            assert.strictEqual(parsed.tokenUsage?.output_tokens, usage.output_tokens);
            assert.strictEqual(parsed.sessionId, 'session-1');
            assert.strictEqual(parsed.conversationLog.length, 1);

            const { response } = processDockerResult(result, 'Synthetic prompt', 'claude-opus-5-5', 1);
            assert.strictEqual(response.success, false);
            assert.strictEqual(response.exitCode, exitCode);
            assert.strictEqual(response.terminationReason, undefined);
            assert.strictEqual(response.error, `Claude process exited with code ${exitCode} after reporting a successful result`);
            assert.strictEqual(response.summary, 'Synthetic terminal result');
            assert.strictEqual(response.cost, 0.25);
            assert.strictEqual(response.tokenUsage?.input_tokens, usage.input_tokens);
            assert.strictEqual(response.conversationLog?.some(entry => entry.type === 'assistant'), true);

            // The PR follow-up treats it as an ordinary failed attempt (thrown, so
            // the queue's automatic retry applies), not a no-change completion.
            assert.strictEqual(getPostExecutionDisposition(agentResultToClaudeResponse(response)), 'failed');
        });
    }

    test('includes stderr with the exit failure', () => {
        const { response } = processDockerResult(execution(137, false, { stderr: 'container killed\n' }), 'Synthetic prompt', 'claude-opus-5-5', 1);
        assert.strictEqual(response.error, 'Claude process exited with code 137 after reporting a successful result\ncontainer killed');
    });

    test('keeps explicit termination policies for nonzero exits', () => {
        const timedOut = processDockerResult(execution(143, false, { timedOut: true, stderr: 'Command timed out after 60000ms' }), 'Synthetic prompt', 'claude-opus-5-5', 1).response;
        assert.strictEqual(timedOut.success, false);
        assert.strictEqual(timedOut.terminationReason, 'timeout');
        assert.match(timedOut.error || '', /execution time limit/);
        assert.strictEqual(getPostExecutionDisposition(agentResultToClaudeResponse(timedOut)), 'partial');

        const costCap = processDockerResult(execution(137, false, { costCapExceeded: true }), 'Synthetic prompt', 'claude-opus-5-5', 1).response;
        assert.strictEqual(costCap.terminationReason, 'cost_cap');
        assert.match(costCap.error || '', /spend cap/);
    });

    test('zero exit with a non-error terminal result stays successful', () => {
        const result = execution(0, false);
        assert.strictEqual(parseStreamJsonOutput(result).success, true);
        const { response } = processDockerResult(result, 'Synthetic prompt', 'claude-opus-5-5', 1);
        assert.strictEqual(response.success, true);
        assert.strictEqual(response.error, undefined);
        assert.strictEqual(getPostExecutionDisposition(agentResultToClaudeResponse(response)), 'complete');
    });

    test('error terminal results stay unsuccessful for zero and nonzero exits', () => {
        for (const exitCode of [0, 137]) {
            const result = execution(exitCode, true);
            assert.strictEqual(parseStreamJsonOutput(result).success, false);
            const { response } = processDockerResult(result, 'Synthetic prompt', 'claude-opus-5-5', 1);
            assert.strictEqual(response.success, false);
            assert.strictEqual(response.error, 'Synthetic terminal result');
        }
    });

    test('an unknown exit keeps the terminal result outcome', () => {
        assert.strictEqual(parseStreamJsonOutput(execution(null, false)).success, true);
        assert.strictEqual(parseStreamJsonOutput(execution(null, true)).success, false);
    });
});
