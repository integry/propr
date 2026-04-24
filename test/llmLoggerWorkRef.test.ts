/**
 * Tests for normalized work-reference fields on LlmLogEntry.
 *
 * These tests exercise production helpers: buildLlmLogRow, buildTaskWorkRef,
 * buildAnalysisWorkRef, and createLlmLogFromAnalysis — verifying actual
 * output rather than hand-written object shapes.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  buildLlmLogRow,
  buildTaskWorkRef,
  buildAnalysisWorkRef,
  createLlmLogFromAnalysis,
  WORK_TYPES,
} from '../packages/core/src/utils/llmLogger.js';
import type { WorkReference, LlmLogEntry } from '../packages/core/src/utils/llmLogger.js';

/* ------------------------------------------------------------------ */
/*  WORK_TYPES constant                                                */
/* ------------------------------------------------------------------ */

describe('WORK_TYPES constant', () => {
  it('contains exactly the three expected work types', () => {
    assert.deepStrictEqual([...WORK_TYPES], ['task', 'plan', 'repository']);
  });
});

/* ------------------------------------------------------------------ */
/*  buildTaskWorkRef                                                   */
/* ------------------------------------------------------------------ */

describe('buildTaskWorkRef', () => {
  it('builds a task work reference with all fields', () => {
    const ref = buildTaskWorkRef('job-123', 42, 'integry/propr', 99);
    assert.deepStrictEqual(ref, {
      workType: 'task',
      taskId: 'job-123',
      taskNumber: 42,
      prNumber: 99,
      workRepository: 'integry/propr',
    });
  });

  it('builds a task work reference without prNumber', () => {
    const ref = buildTaskWorkRef('job-456', 10, 'integry/propr');
    assert.strictEqual(ref.workType, 'task');
    assert.strictEqual(ref.taskId, 'job-456');
    assert.strictEqual(ref.taskNumber, 10);
    assert.strictEqual(ref.prNumber, undefined);
    assert.strictEqual(ref.workRepository, 'integry/propr');
  });

  it('handles undefined taskId', () => {
    const ref = buildTaskWorkRef(undefined, 5, 'integry/propr');
    assert.strictEqual(ref.workType, 'task');
    assert.strictEqual(ref.taskId, undefined);
    assert.strictEqual(ref.taskNumber, 5);
  });
});

/* ------------------------------------------------------------------ */
/*  buildAnalysisWorkRef                                               */
/* ------------------------------------------------------------------ */

describe('buildAnalysisWorkRef', () => {
  it('returns plan workType for plan-generation', () => {
    const ref = buildAnalysisWorkRef('plan-generation', 'draft-abc', 'integry/propr');
    assert.strictEqual(ref.workType, 'plan');
    assert.strictEqual(ref.planDraftId, 'draft-abc');
    assert.strictEqual(ref.taskId, undefined);
    assert.strictEqual(ref.workRepository, 'integry/propr');
  });

  it('returns plan workType for plan-refinement', () => {
    const ref = buildAnalysisWorkRef('plan-refinement', 'draft-xyz', 'integry/propr');
    assert.strictEqual(ref.workType, 'plan');
    assert.strictEqual(ref.planDraftId, 'draft-xyz');
  });

  it('returns task workType when taskId is present', () => {
    const ref = buildAnalysisWorkRef('implementation', 'job-1', 'integry/propr', { taskNumber: 7 });
    assert.strictEqual(ref.workType, 'task');
    assert.strictEqual(ref.taskId, 'job-1');
    assert.strictEqual(ref.taskNumber, 7);
    assert.strictEqual(ref.planDraftId, undefined);
  });

  it('returns task workType when only taskNumber is present', () => {
    const ref = buildAnalysisWorkRef('implementation', undefined, 'integry/propr', { taskNumber: 3 });
    assert.strictEqual(ref.workType, 'task');
    assert.strictEqual(ref.taskNumber, 3);
  });

  it('returns repository workType when no task context', () => {
    const ref = buildAnalysisWorkRef('repo-chat', undefined, 'integry/propr');
    assert.strictEqual(ref.workType, 'repository');
    assert.strictEqual(ref.taskId, undefined);
    assert.strictEqual(ref.taskNumber, undefined);
    assert.strictEqual(ref.workRepository, 'integry/propr');
  });

  it('passes prNumber through for non-plan types', () => {
    const ref = buildAnalysisWorkRef('implementation', 'job-1', 'integry/propr', { taskNumber: 5, prNumber: 88 });
    assert.strictEqual(ref.prNumber, 88);
  });

  it('does not pass prNumber for plan types', () => {
    const ref = buildAnalysisWorkRef('plan-generation', 'draft-1', 'integry/propr', { prNumber: 88 });
    assert.strictEqual(ref.prNumber, undefined);
  });
});

/* ------------------------------------------------------------------ */
/*  buildLlmLogRow                                                     */
/* ------------------------------------------------------------------ */

describe('buildLlmLogRow', () => {
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

  it('includes work-ref columns when hasWorkRefColumns is true', () => {
    const entry = makeEntry({
      workRef: {
        workType: 'task',
        taskId: 'job-42',
        taskNumber: 10,
        prNumber: 55,
        workRepository: 'integry/propr',
      },
    });
    const row = buildLlmLogRow(entry, 0.05, true);
    assert.strictEqual(row.work_type, 'task');
    assert.strictEqual(row.task_id, 'job-42');
    assert.strictEqual(row.task_number, 10);
    assert.strictEqual(row.pr_number, 55);
    assert.strictEqual(row.work_repository, 'integry/propr');
    assert.strictEqual(row.plan_draft_id, null);
    assert.strictEqual(row.plan_issue_id, null);
  });

  it('omits work-ref columns when hasWorkRefColumns is false', () => {
    const entry = makeEntry({
      workRef: { workType: 'task', taskId: 'job-42' },
    });
    const row = buildLlmLogRow(entry, undefined, false);
    assert.strictEqual(row.work_type, undefined);
    assert.strictEqual(row.task_id, undefined);
    assert.strictEqual(row.execution_type, 'implementation');
  });

  it('maps plan workRef to correct columns', () => {
    const entry = makeEntry({
      workRef: {
        workType: 'plan',
        planDraftId: 'draft-abc',
        planIssueId: 7,
        workRepository: 'integry/propr',
      },
    });
    const row = buildLlmLogRow(entry, undefined, true);
    assert.strictEqual(row.work_type, 'plan');
    assert.strictEqual(row.plan_draft_id, 'draft-abc');
    assert.strictEqual(row.plan_issue_id, 7);
    assert.strictEqual(row.task_id, null);
    assert.strictEqual(row.task_number, null);
  });

  it('maps undefined workRef to all-null columns', () => {
    const entry = makeEntry(); // no workRef
    const row = buildLlmLogRow(entry, undefined, true);
    assert.strictEqual(row.work_type, null);
    assert.strictEqual(row.task_id, null);
    assert.strictEqual(row.task_number, null);
    assert.strictEqual(row.plan_draft_id, null);
    assert.strictEqual(row.plan_issue_id, null);
    assert.strictEqual(row.work_repository, null);
  });

  it('preserves standard columns regardless of work-ref flag', () => {
    const entry = makeEntry({
      inputTokens: 100,
      outputTokens: 50,
      sessionId: 'sess-1',
      draftId: 'legacy-draft',
      repository: 'integry/propr',
    });
    const row = buildLlmLogRow(entry, 0.01, false);
    assert.strictEqual(row.execution_type, 'implementation');
    assert.strictEqual(row.model_name, 'test-model');
    assert.strictEqual(row.input_tokens, 100);
    assert.strictEqual(row.output_tokens, 50);
    assert.strictEqual(row.session_id, 'sess-1');
    assert.strictEqual(row.draft_id, 'legacy-draft');
    assert.strictEqual(row.repository, 'integry/propr');
    assert.strictEqual(row.cost_usd, 0.01);
  });
});

/* ------------------------------------------------------------------ */
/*  createLlmLogFromAnalysis                                           */
/* ------------------------------------------------------------------ */

describe('createLlmLogFromAnalysis', () => {
  it('creates a complete LlmLogEntry with workRef', () => {
    const entry = createLlmLogFromAnalysis({
      executionType: 'plan-generation',
      modelUsed: 'claude-opus-4-6',
      executionTimeMs: 5000,
      success: true,
      tokenUsage: { input_tokens: 200, output_tokens: 100 },
      repository: 'integry/propr',
      workRef: {
        workType: 'plan',
        planDraftId: 'draft-001',
        workRepository: 'integry/propr',
      },
    });
    assert.strictEqual(entry.executionType, 'plan-generation');
    assert.strictEqual(entry.modelName, 'claude-opus-4-6');
    assert.strictEqual(entry.durationMs, 5000);
    assert.strictEqual(entry.success, true);
    assert.strictEqual(entry.inputTokens, 200);
    assert.strictEqual(entry.outputTokens, 100);
    assert.deepStrictEqual(entry.workRef, {
      workType: 'plan',
      planDraftId: 'draft-001',
      workRepository: 'integry/propr',
    });
  });

  it('creates entry without workRef when not provided', () => {
    const entry = createLlmLogFromAnalysis({
      executionType: 'repo-chat',
      modelUsed: 'test-model',
      executionTimeMs: 1000,
      success: true,
    });
    assert.strictEqual(entry.workRef, undefined);
    assert.strictEqual(entry.executionType, 'repo-chat');
  });

  it('sets startTime and endTime based on executionTimeMs', () => {
    const before = Date.now();
    const entry = createLlmLogFromAnalysis({
      executionType: 'implementation',
      modelUsed: 'test-model',
      executionTimeMs: 3000,
      success: true,
    });
    const after = Date.now();

    assert.ok(entry.endTime.getTime() >= before);
    assert.ok(entry.endTime.getTime() <= after);
    assert.strictEqual(entry.endTime.getTime() - entry.startTime.getTime(), 3000);
  });

  it('passes through error, sessionId, correlationId, metadata', () => {
    const entry = createLlmLogFromAnalysis({
      executionType: 'implementation',
      modelUsed: 'test-model',
      executionTimeMs: 100,
      success: false,
      error: 'something failed',
      sessionId: 'sess-1',
      correlationId: 'corr-1',
      metadata: { key: 'value' },
    });
    assert.strictEqual(entry.errorMessage, 'something failed');
    assert.strictEqual(entry.sessionId, 'sess-1');
    assert.strictEqual(entry.correlationId, 'corr-1');
    assert.deepStrictEqual(entry.metadata, { key: 'value' });
  });

  it('passes through usageMetricRecords', () => {
    const records = [{ agent: 'claude', metricKey: 'tokens', metricValue: 500 }];
    const entry = createLlmLogFromAnalysis({
      executionType: 'implementation',
      modelUsed: 'test-model',
      executionTimeMs: 100,
      success: true,
      usageMetricRecords: records,
    });
    assert.deepStrictEqual(entry.usageMetricRecords, records);
  });
});
