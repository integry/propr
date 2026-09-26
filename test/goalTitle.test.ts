import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';
import { closeConnection } from '@propr/core';
import {
  buildGoalTitlePrompt,
  generateGoalTitle,
  goalTitleFallback,
  normalizeGoalTitle,
} from '../packages/core/src/goals/goalTitle.ts';
import { buildGoalPullRequestTitle } from '../src/jobs/goalCheckpointPublisher.ts';

after(async () => closeConnection());

test('goal titles are generated from the full objective with the configured summarization model', async () => {
  const runAnalysis = mock.fn(async () => '"Update Supported Coding Agent Models"');
  const title = await generateGoalTitle({
    objective: 'Bring all coding agents up to date and update the supported model list.',
    repository: 'integry/propr',
    taskId: 'goal-123',
  }, {
    loadSettings: async () => ({ agent_alias: 'summary-model' }) as never,
    resolveModel: async () => 'codex:gpt-5.6-sol',
    runAnalysis,
  });

  assert.equal(title, 'Update Supported Coding Agent Models');
  assert.equal(runAnalysis.mock.calls[0].arguments[0].model, 'codex:gpt-5.6-sol');
  assert.equal(runAnalysis.mock.calls[0].arguments[0].taskId, 'goal-123');
  assert.match(runAnalysis.mock.calls[0].arguments[0].prompt, /Bring all coding agents up to date/);
  assert.match(buildGoalTitlePrompt('Ship it'), /5-8 words/);
});

test('goal title normalization and fallback stay concise and presentation-safe', () => {
  assert.equal(normalizeGoalTitle('**Goal: Improve goal title rendering**'), 'Improve goal title rendering');
  assert.equal(
    goalTitleFallback('First deliver the API. Then migrate every existing client with extensive compatibility notes.'),
    'First deliver the API.',
  );
});

test('goal pull request titles use the summarized title and formatted model name', () => {
  assert.equal(buildGoalPullRequestTitle({
    title: 'Update Supported Coding Agent Models',
    objective: 'Bring all the coding agents up to date and update the supported model list.',
    requested_model: 'gpt-5.6-sol',
  }), '[Goal by GPT-5.6 Sol] Update Supported Coding Agent Models');
});
