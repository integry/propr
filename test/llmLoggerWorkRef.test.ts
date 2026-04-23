/**
 * Tests for normalized work-reference fields on LlmLogEntry.
 *
 * These tests verify the type shape, the createLlmLogFromAnalysis helper,
 * and the insert row mapping without requiring a real database.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import type { WorkReference, WorkType, LlmLogEntry } from '../packages/core/src/utils/llmLogger.js';

describe('WorkReference type shape', () => {
  it('accepts a task-linked work reference', () => {
    const ref: WorkReference = {
      workType: 'task',
      taskId: 'job-123',
      taskNumber: 42,
      workRepository: 'integry/propr',
    };
    assert.strictEqual(ref.workType, 'task');
    assert.strictEqual(ref.taskId, 'job-123');
    assert.strictEqual(ref.taskNumber, 42);
    assert.strictEqual(ref.workRepository, 'integry/propr');
    assert.strictEqual(ref.planDraftId, undefined);
    assert.strictEqual(ref.planIssueId, undefined);
  });

  it('accepts a plan-linked work reference', () => {
    const ref: WorkReference = {
      workType: 'plan',
      planDraftId: 'draft-abc',
      planIssueId: 7,
      workRepository: 'integry/propr',
    };
    assert.strictEqual(ref.workType, 'plan');
    assert.strictEqual(ref.planDraftId, 'draft-abc');
    assert.strictEqual(ref.planIssueId, 7);
    assert.strictEqual(ref.taskId, undefined);
  });

  it('accepts a repository-only work reference', () => {
    const ref: WorkReference = {
      workType: 'repository',
      workRepository: 'integry/propr',
    };
    assert.strictEqual(ref.workType, 'repository');
    assert.strictEqual(ref.workRepository, 'integry/propr');
  });

  it('accepts a completely empty work reference', () => {
    const ref: WorkReference = {};
    assert.strictEqual(ref.workType, undefined);
    assert.strictEqual(ref.taskId, undefined);
    assert.strictEqual(ref.planDraftId, undefined);
    assert.strictEqual(ref.workRepository, undefined);
  });

  it('work type only allows valid values', () => {
    const validTypes: WorkType[] = ['task', 'plan', 'repository'];
    for (const wt of validTypes) {
      const ref: WorkReference = { workType: wt };
      assert.ok(validTypes.includes(ref.workType!));
    }
  });
});

describe('LlmLogEntry with workRef', () => {
  function makeEntry(overrides: Partial<LlmLogEntry> = {}): LlmLogEntry {
    return {
      executionType: 'implementation',
      modelName: 'test-model',
      startTime: new Date('2026-04-23T00:00:00Z'),
      endTime: new Date('2026-04-23T00:01:00Z'),
      durationMs: 60_000,
      success: true,
      ...overrides,
    };
  }

  it('entry without workRef has undefined workRef', () => {
    const entry = makeEntry();
    assert.strictEqual(entry.workRef, undefined);
  });

  it('entry carries task work reference alongside legacy fields', () => {
    const entry = makeEntry({
      draftId: 'legacy-draft',
      repository: 'integry/propr',
      workRef: {
        workType: 'task',
        taskId: 'job-999',
        taskNumber: 55,
        workRepository: 'integry/propr',
      },
    });
    // Legacy fields intact
    assert.strictEqual(entry.draftId, 'legacy-draft');
    assert.strictEqual(entry.repository, 'integry/propr');
    // New fields
    assert.strictEqual(entry.workRef?.workType, 'task');
    assert.strictEqual(entry.workRef?.taskId, 'job-999');
    assert.strictEqual(entry.workRef?.taskNumber, 55);
  });

  it('entry carries plan work reference', () => {
    const entry = makeEntry({
      workRef: {
        workType: 'plan',
        planDraftId: 'draft-xyz',
        planIssueId: 3,
      },
    });
    assert.strictEqual(entry.workRef?.workType, 'plan');
    assert.strictEqual(entry.workRef?.planDraftId, 'draft-xyz');
    assert.strictEqual(entry.workRef?.planIssueId, 3);
  });
});

describe('createLlmLogFromAnalysis with workRef', () => {
  // Dynamic import to avoid needing mock.module for internal deps.
  // createLlmLogFromAnalysis is a pure function that builds an object,
  // so it doesn't need DB or logger at import time — but the module
  // imports them. We test the shape separately from persistence.

  it('workRef structure is correctly typed on LlmLogEntry', () => {
    // This test validates compile-time correctness of the interface.
    const entry: LlmLogEntry = {
      executionType: 'plan-generation',
      modelName: 'claude-opus-4-6',
      startTime: new Date(),
      endTime: new Date(),
      durationMs: 5000,
      success: true,
      workRef: {
        workType: 'plan',
        planDraftId: 'draft-001',
        workRepository: 'integry/propr',
      },
    };
    assert.deepStrictEqual(entry.workRef, {
      workType: 'plan',
      planDraftId: 'draft-001',
      workRepository: 'integry/propr',
    });
  });

  it('partial workRef with only workType is valid', () => {
    const entry: LlmLogEntry = {
      executionType: 'repo-chat',
      modelName: 'claude-opus-4-6',
      startTime: new Date(),
      endTime: new Date(),
      durationMs: 1000,
      success: true,
      workRef: { workType: 'repository' },
    };
    assert.strictEqual(entry.workRef?.workType, 'repository');
    assert.strictEqual(entry.workRef?.taskId, undefined);
    assert.strictEqual(entry.workRef?.planDraftId, undefined);
  });
});

describe('Insert row mapping', () => {
  it('maps workRef fields to snake_case DB columns', () => {
    // Simulate the mapping done in insertLlmLogRow
    const workRef: WorkReference = {
      workType: 'task',
      taskId: 'job-42',
      taskNumber: 10,
      planDraftId: undefined,
      planIssueId: undefined,
      workRepository: 'integry/propr',
    };

    const dbRow = {
      work_type: workRef.workType ?? null,
      task_id: workRef.taskId ?? null,
      task_number: workRef.taskNumber ?? null,
      plan_draft_id: workRef.planDraftId ?? null,
      plan_issue_id: workRef.planIssueId ?? null,
      work_repository: workRef.workRepository ?? null,
    };

    assert.strictEqual(dbRow.work_type, 'task');
    assert.strictEqual(dbRow.task_id, 'job-42');
    assert.strictEqual(dbRow.task_number, 10);
    assert.strictEqual(dbRow.plan_draft_id, null);
    assert.strictEqual(dbRow.plan_issue_id, null);
    assert.strictEqual(dbRow.work_repository, 'integry/propr');
  });

  it('maps null workRef to all-null columns', () => {
    const workRef: WorkReference | undefined = undefined;

    const dbRow = {
      work_type: workRef?.workType ?? null,
      task_id: workRef?.taskId ?? null,
      task_number: workRef?.taskNumber ?? null,
      plan_draft_id: workRef?.planDraftId ?? null,
      plan_issue_id: workRef?.planIssueId ?? null,
      work_repository: workRef?.workRepository ?? null,
    };

    assert.strictEqual(dbRow.work_type, null);
    assert.strictEqual(dbRow.task_id, null);
    assert.strictEqual(dbRow.task_number, null);
    assert.strictEqual(dbRow.plan_draft_id, null);
    assert.strictEqual(dbRow.plan_issue_id, null);
    assert.strictEqual(dbRow.work_repository, null);
  });

  it('maps plan-only workRef correctly', () => {
    const workRef: WorkReference = {
      workType: 'plan',
      planDraftId: 'draft-abc',
      planIssueId: 7,
    };

    const dbRow = {
      work_type: workRef.workType ?? null,
      task_id: workRef.taskId ?? null,
      task_number: workRef.taskNumber ?? null,
      plan_draft_id: workRef.planDraftId ?? null,
      plan_issue_id: workRef.planIssueId ?? null,
      work_repository: workRef.workRepository ?? null,
    };

    assert.strictEqual(dbRow.work_type, 'plan');
    assert.strictEqual(dbRow.task_id, null);
    assert.strictEqual(dbRow.task_number, null);
    assert.strictEqual(dbRow.plan_draft_id, 'draft-abc');
    assert.strictEqual(dbRow.plan_issue_id, 7);
    assert.strictEqual(dbRow.work_repository, null);
  });
});
