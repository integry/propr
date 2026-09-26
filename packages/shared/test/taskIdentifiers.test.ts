import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildIssueTaskId,
  isLegacyProviderTaskId,
  MAX_TASK_ID_LENGTH,
  sanitizeTaskIdComponent,
  TASK_ID_PATTERN,
} from '../src/taskIdentifiers.js';

test('buildIssueTaskId sanitizes provider-qualified model IDs', () => {
  const taskId = buildIssueTaskId({
    repoOwner: 'integry',
    repoName: 'propr-test',
    issueNumber: 1511,
    agentAlias: 'opencode',
    modelName: 'opencode-openai/gpt-5.6-luna',
    correlationId: '99667e8e-59a6-4aa2-9e2f-448fa02827ef',
  });

  assert.equal(
    taskId,
    'integry-propr-test-1511-opencode-opencode-openai-gpt-5.6-luna-99667e8e-59a6-4aa2-9e2f-448fa02827ef',
  );
  assert.match(taskId, TASK_ID_PATTERN);
  assert.ok(!taskId.includes('/'));
});

test('buildIssueTaskId bounds long external components while retaining the correlation ID', () => {
  const correlationId = '99667e8e-59a6-4aa2-9e2f-448fa02827ef';
  const taskId = buildIssueTaskId({
    repoOwner: 'owner'.repeat(30),
    repoName: 'repository'.repeat(30),
    issueNumber: 1511,
    agentAlias: 'agent'.repeat(30),
    modelName: 'provider/model'.repeat(30),
    correlationId,
  });

  assert.equal(taskId.length, MAX_TASK_ID_LENGTH);
  assert.ok(taskId.endsWith(`-${correlationId}`));
  assert.match(taskId, TASK_ID_PATTERN);
});

test('sanitizeTaskIdComponent provides a safe fallback for unusable values', () => {
  assert.equal(sanitizeTaskIdComponent(' ../../ ', 'model'), 'model');
});

test('legacy compatibility recognizes only generated provider-qualified task IDs', () => {
  assert.equal(isLegacyProviderTaskId(
    'integry-propr-test-1511-opencode-opencode-openai/gpt-5.6-luna-99667e8e-59a6-4aa2-9e2f-448fa02827ef',
  ), true);
  assert.equal(isLegacyProviderTaskId('bad/task'), false);
  assert.equal(isLegacyProviderTaskId('../bad-task'), false);
});
