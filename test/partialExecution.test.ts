import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { closeConnection } from '@propr/core';
import {
    executeDockerCommand,
    runWithExecutionAbortSignal,
    type ExecutionResult,
} from '../packages/core/src/claude/docker/dockerExecutor.js';
import { parseStreamJsonOutput } from '../packages/core/src/claude/claudeHelpers.js';
import { processDockerResult } from '../packages/core/src/agents/impl/utils/dockerResultProcessor.js';
import {
    isIncompleteAgentExecution,
    resolveAgentTerminationReason,
} from '../packages/core/src/agents/termination.js';
import { generateCompletionComment } from '../packages/core/src/utils/github/logFiles.js';
import { buildCompletionComment } from '../src/jobs/prCompletionComment.js';
import { getPostExecutionDisposition } from '../src/jobs/prCommentPostExecution.js';
import { getTaskCompletionStatus } from '../src/jobs/issueJob/completion.js';
import { buildCommitMessage } from '../src/jobs/prCommentJobUtils.js';
import { buildIssueReference } from '../src/jobs/issueJobHelpers.js';
import type { ClaudeCodeResponse } from '../packages/core/src/claude/claudeService.js';

after(async () => {
    await closeConnection();
});

function executionResult(stdout: string, overrides: Partial<ExecutionResult> = {}): ExecutionResult {
    return {
        stdout,
        stderr: '',
        exitCode: 0,
        messageTimestamps: new Map(),
        ...overrides,
    };
}

function partialClaudeResult(reason: 'timeout' | 'max_turns'): ClaudeCodeResponse {
    return {
        success: false,
        executionTime: 60_000,
        output: null,
        logs: '',
        exitCode: null,
        finalResult: reason === 'max_turns'
            ? { type: 'result', subtype: 'error_max_turns' }
            : null,
        modifiedFiles: ['src/feature.ts', 'test/feature.test.ts'],
        commitMessage: null,
        summary: 'Implemented the main feature path and added initial tests.',
        error: reason === 'timeout' ? 'Command timed out after 60000ms' : 'Maximum turns reached',
        terminationReason: reason,
    };
}

describe('partial agent execution', () => {
    test('preserves buffered output when the execution deadline is reached', async () => {
        const result = await executeDockerCommand(process.execPath, [
            '-e',
            'process.stdout.write("partial-agent-output"); setInterval(() => {}, 1000);',
        ], { timeout: 200, preserveOutputOnTimeout: true });

        assert.strictEqual(result.timedOut, true);
        assert.strictEqual(result.timeoutMs, 200);
        assert.match(result.stdout, /partial-agent-output/);
        assert.match(result.stderr, /Command timed out after 200ms/);
    });

    test('terminates nested agent commands when protected execution ownership is lost', async () => {
        const controller = new AbortController();
        const leaseError = new Error('lease superseded');
        const execution = runWithExecutionAbortSignal(controller.signal, () => executeDockerCommand(
            process.execPath,
            ['-e', 'setInterval(() => {}, 1000);'],
            { timeout: 10_000 },
        ));
        setTimeout(() => controller.abort(leaseError), 50);

        await assert.rejects(execution, error => error === leaseError);
    });

    test('does not spawn a command after protected execution ownership is already lost', async () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'propr-pre-aborted-execution-'));
        const sentinel = path.join(tempDir, 'spawned');
        const controller = new AbortController();
        const leaseError = new Error('lease already superseded');
        controller.abort(leaseError);

        try {
            await assert.rejects(
                runWithExecutionAbortSignal(controller.signal, () => executeDockerCommand(
                    process.execPath,
                    ['-e', `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'spawned')`],
                )),
                error => error === leaseError,
            );
            assert.equal(fs.existsSync(sentinel), false);
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    test('retains Claude max-turn metadata and the latest assistant update', () => {
        const stdout = [
            JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Implemented the parser; validation remains.' }] } }),
            JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, num_turns: 12 }),
        ].join('\n');
        const result = executionResult(stdout, { exitCode: 1 });

        const parsed = parseStreamJsonOutput(result);
        const processed = processDockerResult(result, 'Implement the feature', 'claude-test', 1_000).response;

        assert.strictEqual(parsed.finalResult?.subtype, 'error_max_turns');
        assert.strictEqual(parsed.finalResult?.num_turns, 12);
        assert.strictEqual(processed.terminationReason, 'max_turns');
        assert.match(processed.summary || '', /validation remains/);
    });

    test('classifies only execution deadlines and turn limits as publishable interruptions', () => {
        assert.strictEqual(resolveAgentTerminationReason({ error: 'Command timed out after 86400000ms' }), 'timeout');
        assert.strictEqual(resolveAgentTerminationReason({ subtype: 'error_max_turns' }), 'max_turns');
        assert.strictEqual(isIncompleteAgentExecution({ success: false, terminationReason: 'timeout' }), true);
        assert.strictEqual(isIncompleteAgentExecution({ success: false, error: 'Connection timeout contacting provider' }), false);
        assert.strictEqual(isIncompleteAgentExecution({ success: false, error: 'Authentication failed' }), false);
        assert.strictEqual(getPostExecutionDisposition(partialClaudeResult('timeout')), 'partial');
        assert.strictEqual(getPostExecutionDisposition({ ...partialClaudeResult('timeout'), success: true }), 'complete');
        assert.strictEqual(getPostExecutionDisposition({ ...partialClaudeResult('timeout'), terminationReason: undefined, error: 'Authentication failed' }), 'failed');
        assert.strictEqual(getTaskCompletionStatus(partialClaudeResult('timeout'), {
            success: true,
            pr: { number: 7, url: 'https://example.test/pr/7', title: 'Partial work' },
            updatedLabels: [],
        }), 'partial_with_pr');
        assert.strictEqual(buildIssueReference(42, true, partialClaudeResult('timeout')), 'Addresses #42');
        assert.strictEqual(buildIssueReference(42, true, { ...partialClaudeResult('timeout'), success: true, terminationReason: undefined, error: undefined }), 'Closes #42');
    });

    test('marks an initial PR summary as incomplete and lists remaining review work', async () => {
        const comment = await generateCompletionComment(partialClaudeResult('timeout'), {
            number: 42,
            repoOwner: 'acme',
            repoName: 'widgets',
        });

        assert.match(comment, /AI Processing Incomplete/);
        assert.match(comment, /Partial work published for review/);
        assert.match(comment, /Work completed before interruption/);
        assert.match(comment, /Remaining work/);
        assert.doesNotMatch(comment, /AI Processing Failed/);
    });

    test('reports a partial follow-up commit instead of claiming full completion', async () => {
        const result = partialClaudeResult('max_turns');
        const requestedComments = [{ id: 99, body: 'Please add validation', author: 'reviewer', createdAt: new Date().toISOString() }];
        const commitMessage = buildCommitMessage({
            changesSummary: result.summary || '',
            unprocessedComments: requestedComments,
            pullRequestNumber: 7,
            claudeResult: result,
            llm: 'claude-test',
            authorsText: '@reviewer',
        });
        const comment = await buildCompletionComment(
            { commitHash: 'abcdef1234567890' },
            requestedComments,
            {
                changesSummary: result.summary || '',
                commitMessage,
                llm: 'claude-test',
                authorsText: '@reviewer',
            },
            result,
        );

        assert.match(comment, /Applied partial follow-up changes/);
        assert.match(comment, /This work may be incomplete/);
        assert.match(comment, /Last Agent Update/);
        assert.match(comment, /Remaining Work/);
        assert.match(commitMessage, /Partial execution:/);
        assert.doesNotMatch(comment, /Applied the requested follow-up changes/);
    });
});
