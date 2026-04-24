/**
 * Regression tests for work-reference helper functions.
 *
 * Validates that buildTaskWorkRef and buildAnalysisWorkRef produce correct
 * WorkReference payloads for the main flows: task execution, plan generation,
 * PR follow-up, and repository-scoped analysis.
 *
 * These tests import the real helpers from llmLogger.ts to catch regressions
 * in the production code directly.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { buildTaskWorkRef, buildAnalysisWorkRef } from '../packages/core/src/utils/llmLogger.js';

// ---------------------------------------------------------------------------
// Task execution flow
// ---------------------------------------------------------------------------
describe('buildTaskWorkRef — task execution flow', () => {
  it('produces correct workRef for a standard issue task', () => {
    const ref = buildTaskWorkRef('job-42', 10, 'integry/propr');

    assert.strictEqual(ref.workType, 'task');
    assert.strictEqual(ref.taskId, 'job-42');
    assert.strictEqual(ref.taskNumber, 10);
    assert.strictEqual(ref.prNumber, undefined);
    assert.strictEqual(ref.workRepository, 'integry/propr');
    assert.strictEqual(ref.planDraftId, undefined);
    assert.strictEqual(ref.planIssueId, undefined);
  });

  it('includes prNumber when provided (PR follow-up)', () => {
    const ref = buildTaskWorkRef('pr-comment-99', 99, 'integry/propr', 99);

    assert.strictEqual(ref.workType, 'task');
    assert.strictEqual(ref.taskId, 'pr-comment-99');
    assert.strictEqual(ref.taskNumber, 99);
    assert.strictEqual(ref.prNumber, 99);
    assert.strictEqual(ref.workRepository, 'integry/propr');
  });

  it('handles undefined taskId gracefully', () => {
    const ref = buildTaskWorkRef(undefined, 5, 'org/repo');

    assert.strictEqual(ref.workType, 'task');
    assert.strictEqual(ref.taskId, undefined);
    assert.strictEqual(ref.taskNumber, 5);
    assert.strictEqual(ref.workRepository, 'org/repo');
  });
});

// ---------------------------------------------------------------------------
// Plan generation/refinement flow
// ---------------------------------------------------------------------------
describe('buildAnalysisWorkRef — plan flow', () => {
  it('plan-generation produces plan workRef with planDraftId', () => {
    const ref = buildAnalysisWorkRef('plan-generation', 'draft-abc', 'integry/propr');

    assert.strictEqual(ref.workType, 'plan');
    assert.strictEqual(ref.planDraftId, 'draft-abc');
    assert.strictEqual(ref.taskId, undefined);
    assert.strictEqual(ref.workRepository, 'integry/propr');
  });

  it('plan-refinement produces plan workRef with planDraftId', () => {
    const ref = buildAnalysisWorkRef('plan-refinement', 'draft-xyz', 'integry/propr');

    assert.strictEqual(ref.workType, 'plan');
    assert.strictEqual(ref.planDraftId, 'draft-xyz');
    assert.strictEqual(ref.taskId, undefined);
    assert.strictEqual(ref.workRepository, 'integry/propr');
  });

  it('plan without taskId still has workType plan and undefined planDraftId', () => {
    const ref = buildAnalysisWorkRef('plan-generation', undefined, 'integry/propr');

    assert.strictEqual(ref.workType, 'plan');
    assert.strictEqual(ref.planDraftId, undefined);
    assert.strictEqual(ref.taskId, undefined);
  });

  it('plan ignores taskNumber and prNumber', () => {
    const ref = buildAnalysisWorkRef('plan-generation', 'draft-abc', 'integry/propr', 42, 99);

    assert.strictEqual(ref.workType, 'plan');
    assert.strictEqual(ref.taskNumber, undefined);
    assert.strictEqual(ref.prNumber, undefined);
    assert.strictEqual(ref.planDraftId, 'draft-abc');
  });
});

// ---------------------------------------------------------------------------
// Repository-scoped analysis flow
// ---------------------------------------------------------------------------
describe('buildAnalysisWorkRef — repository flow', () => {
  it('repo-chat without taskId produces repository workRef', () => {
    const ref = buildAnalysisWorkRef('repo-chat', undefined, 'integry/propr');

    assert.strictEqual(ref.workType, 'repository');
    assert.strictEqual(ref.taskId, undefined);
    assert.strictEqual(ref.planDraftId, undefined);
    assert.strictEqual(ref.workRepository, 'integry/propr');
  });

  it('repo-improvements without taskId produces repository workRef', () => {
    const ref = buildAnalysisWorkRef('repo-improvements', undefined, 'integry/propr');

    assert.strictEqual(ref.workType, 'repository');
    assert.strictEqual(ref.workRepository, 'integry/propr');
  });

  it('summarization without taskId produces repository workRef', () => {
    const ref = buildAnalysisWorkRef('summarization', undefined, 'org/repo');

    assert.strictEqual(ref.workType, 'repository');
    assert.strictEqual(ref.workRepository, 'org/repo');
  });

  it('undefined executionType with taskId produces task workRef', () => {
    const ref = buildAnalysisWorkRef(undefined, 'task-123', 'integry/propr');

    assert.strictEqual(ref.workType, 'task');
    assert.strictEqual(ref.taskId, 'task-123');
    assert.strictEqual(ref.planDraftId, undefined);
    assert.strictEqual(ref.workRepository, 'integry/propr');
  });

  it('undefined executionType without taskId produces repository workRef', () => {
    const ref = buildAnalysisWorkRef(undefined, undefined, 'integry/propr');

    assert.strictEqual(ref.workType, 'repository');
    assert.strictEqual(ref.taskId, undefined);
    assert.strictEqual(ref.workRepository, 'integry/propr');
  });
});

// ---------------------------------------------------------------------------
// Task-linked analysis with taskNumber and prNumber
// ---------------------------------------------------------------------------
describe('buildAnalysisWorkRef — task with taskNumber/prNumber', () => {
  it('carries taskNumber when provided', () => {
    const ref = buildAnalysisWorkRef('context-analysis', 'task-abc', 'org/repo', 42);

    assert.strictEqual(ref.workType, 'task');
    assert.strictEqual(ref.taskId, 'task-abc');
    assert.strictEqual(ref.taskNumber, 42);
    assert.strictEqual(ref.prNumber, undefined);
    assert.strictEqual(ref.workRepository, 'org/repo');
  });

  it('carries both taskNumber and prNumber when provided', () => {
    const ref = buildAnalysisWorkRef('context-analysis', 'task-abc', 'org/repo', 42, 99);

    assert.strictEqual(ref.workType, 'task');
    assert.strictEqual(ref.taskId, 'task-abc');
    assert.strictEqual(ref.taskNumber, 42);
    assert.strictEqual(ref.prNumber, 99);
  });
});

// ---------------------------------------------------------------------------
// PR follow-up insert row mapping
// ---------------------------------------------------------------------------
describe('PR follow-up workRef — insert row mapping', () => {
  it('maps prNumber to pr_number DB column', () => {
    const ref = buildTaskWorkRef('pr-job-55', 55, 'integry/propr', 55);

    const dbRow = {
      work_type: ref.workType ?? null,
      task_id: ref.taskId ?? null,
      task_number: ref.taskNumber ?? null,
      pr_number: ref.prNumber ?? null,
      plan_draft_id: ref.planDraftId ?? null,
      plan_issue_id: ref.planIssueId ?? null,
      work_repository: ref.workRepository ?? null,
    };

    assert.strictEqual(dbRow.work_type, 'task');
    assert.strictEqual(dbRow.task_id, 'pr-job-55');
    assert.strictEqual(dbRow.task_number, 55);
    assert.strictEqual(dbRow.pr_number, 55);
    assert.strictEqual(dbRow.plan_draft_id, null);
    assert.strictEqual(dbRow.plan_issue_id, null);
    assert.strictEqual(dbRow.work_repository, 'integry/propr');
  });

  it('pr_number is null for non-PR tasks', () => {
    const ref = buildTaskWorkRef('job-10', 10, 'integry/propr');

    const dbRow = {
      pr_number: ref.prNumber ?? null,
    };

    assert.strictEqual(dbRow.pr_number, null);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------
describe('buildAnalysisWorkRef — edge cases', () => {
  it('all undefined inputs produce repository workRef with undefined fields', () => {
    const ref = buildAnalysisWorkRef(undefined, undefined, undefined);

    assert.strictEqual(ref.workType, 'repository');
    assert.strictEqual(ref.taskId, undefined);
    assert.strictEqual(ref.planDraftId, undefined);
    assert.strictEqual(ref.workRepository, undefined);
  });

  it('non-plan executionType with taskId produces task workRef', () => {
    const ref = buildAnalysisWorkRef('context-analysis', 'task-abc', 'org/repo');

    assert.strictEqual(ref.workType, 'task');
    assert.strictEqual(ref.taskId, 'task-abc');
    assert.strictEqual(ref.planDraftId, undefined);
  });
});
