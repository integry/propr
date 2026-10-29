import assert from 'node:assert/strict';
import { after, describe, mock, test } from 'node:test';
import { closeConnection } from '@propr/core';
import { markTaskTerminalState } from '../src/jobs/issueJob/completion.js';
import type { TaskCompletionParams } from '../src/jobs/issueJob/types.js';

type StateManager = TaskCompletionParams['stateManager'];

after(async () => {
  await closeConnection();
});

function createStateManager() {
  return {
    markTaskCompleted: mock.fn(async () => undefined),
    markTaskFailed: mock.fn(async () => undefined),
  };
}

describe('issue job terminal state', () => {
  test('records an agent execution failure as failed', async () => {
    const stateManager = createStateManager();

    await markTaskTerminalState({
      stateManager: stateManager as unknown as StateManager,
      taskId: 'failed-agent-task',
      claudeResult: {
        success: false,
        error: 'Agent authentication failed',
        executionTime: 100,
        output: null,
        logs: '',
        modifiedFiles: [],
        commitMessage: null,
        summary: null,
      },
      postProcessingResult: null,
      commitResult: null,
    });

    assert.equal(stateManager.markTaskCompleted.mock.callCount(), 0);
    assert.equal(stateManager.markTaskFailed.mock.callCount(), 1);
    const [taskId, error, metadata] = stateManager.markTaskFailed.mock.calls[0].arguments;
    assert.equal(taskId, 'failed-agent-task');
    assert.match(error.message, /authentication failed/);
    assert.equal(metadata.errorCategory, 'claude_execution');
    assert.equal(metadata.prResult.status, 'claude_processing_failed');
  });

  test('names the Antigravity CLI error, not the entrypoint preamble, as the failure reason', async () => {
    const stateManager = createStateManager();
    const cliError = 'error: invalid model selection (--model "gemini-3.7-flash-medium" --effort ""): model gemini-3.7-flash-medium is not recognized as a known model or custom model in settings';
    const stderr = [
      'GitHub token detected (using environment variable)',
      'GitHub CLI will use GH_TOKEN environment variable for authentication',
      'Using disposable Antigravity runtime state',
      'Antigravity config directory mounted at /home/node/.gemini',
      'Executing command: exec agy --dangerously-skip-permissions --model gemini-3.7-flash-medium',
      cliError,
      'Available models: Gemini 4 Argon (L/M/H), Gemini 3.8 Flash (L/M/H), Claude Opus 5.5 (L/M/H), Claude Sonnet 5.5 (L/M/H), GPT-OSS 120B (Medium)',
    ].join('\n');

    await markTaskTerminalState({
      stateManager: stateManager as unknown as StateManager,
      taskId: 'antigravity-model-task',
      claudeResult: {
        success: false, error: stderr, executionTime: 100, output: null, logs: stderr,
        modifiedFiles: [], commitMessage: null, summary: null,
      },
      postProcessingResult: null,
      commitResult: null,
    });

    const [, error] = stateManager.markTaskFailed.mock.calls[0].arguments;
    assert.equal(error.message, cliError);
  });

  test('keeps an interrupted execution with a published PR completed', async () => {
    const stateManager = createStateManager();

    await markTaskTerminalState({
      stateManager: stateManager as unknown as StateManager,
      taskId: 'partial-agent-task',
      claudeResult: {
        success: false,
        error: 'Maximum turns reached',
        terminationReason: 'max_turns',
        executionTime: 100,
        output: null,
        logs: '',
        modifiedFiles: ['src/change.ts'],
        commitMessage: null,
        summary: 'Partial implementation',
      },
      postProcessingResult: {
        success: true,
        pr: { number: 42, url: 'https://example.test/pull/42', title: 'Partial work' },
        updatedLabels: [],
      },
      commitResult: null,
    });

    assert.equal(stateManager.markTaskFailed.mock.callCount(), 0);
    assert.equal(stateManager.markTaskCompleted.mock.callCount(), 1);
    const [taskId, result] = stateManager.markTaskCompleted.mock.calls[0].arguments;
    assert.equal(taskId, 'partial-agent-task');
    assert.equal(result.status, 'partial_with_pr');
    assert.equal(result.prNumber, 42);
    assert.equal(result.notificationRecap, 'Partial result: Partial implementation');
  });
});
