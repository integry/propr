import assert from 'node:assert/strict';
import { test } from 'node:test';
import { automationTaskKind } from '../routes/automationTaskKind.js';

test('automation run tasks are named by phase', () => {
  assert.equal(automationTaskKind('agent-run-18e98dff-report', 'agent-run'), 'automation-report');
  assert.equal(automationTaskKind('agent-run-18e98dff-action', 'agent-run'), 'automation-action');
});
test('issue and pull request tasks have no automation kind', () => {
  assert.equal(automationTaskKind('agent-run-18e98dff-report', 'issue'), undefined);
  assert.equal(automationTaskKind('issue-12-report', 'agent-run'), undefined);
  assert.equal(automationTaskKind('pr-comments-batch-7', 'pr-comment'), undefined);
});
