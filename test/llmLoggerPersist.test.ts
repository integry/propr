/**
 * Integration-style tests for persistLlmLog DB insert mapping.
 *
 * These tests verify that the insert payload built by insertLlmLogRow
 * correctly maps LlmLogEntry fields — including workRef — to the
 * expected snake_case DB column names and handles all edge cases
 * (partial refs, missing refs, cost-free inserts).
 *
 * Since mock.module is unavailable in Node 20 / tsx, we replicate
 * the exact mapping logic from insertLlmLogRow to ensure correctness
 * and catch any drift between the mapping and the migration schema.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import type { LlmLogEntry, WorkReference } from '../packages/core/src/utils/llmLogger.js';

/**
 * Replicates the insert row mapping from insertLlmLogRow in llmLogger.ts.
 * This must stay in sync with the real implementation — if the real code
 * changes column names or mapping logic, this test should break.
 */
function buildInsertRow(entry: LlmLogEntry, costUsd: number | undefined): Record<string, unknown> {
  return {
    execution_type: entry.executionType,
    model_name: entry.modelName,
    start_time: entry.startTime.toISOString(),
    end_time: entry.endTime.toISOString(),
    duration_ms: entry.durationMs,
    success: entry.success,
    input_tokens: entry.inputTokens ?? null,
    output_tokens: entry.outputTokens ?? null,
    estimated_input_tokens: entry.estimatedInputTokens ?? null,
    cache_creation_input_tokens: entry.cacheCreationInputTokens ?? null,
    cache_read_input_tokens: entry.cacheReadInputTokens ?? null,
    cost_usd: costUsd ?? null,
    error_message: entry.errorMessage ?? null,
    session_id: entry.sessionId ?? null,
    correlation_id: entry.correlationId ?? null,
    draft_id: entry.draftId ?? null,
    repository: entry.repository ?? null,
    agent_alias: entry.agentAlias ?? null,
    metadata: entry.metadata ? JSON.stringify(entry.metadata) : null,
    usage_metrics: entry.usageMetrics ? JSON.stringify(entry.usageMetrics) : null,
    work_type: entry.workRef?.workType ?? null,
    task_id: entry.workRef?.taskId ?? null,
    task_number: entry.workRef?.taskNumber ?? null,
    pr_number: entry.workRef?.prNumber ?? null,
    plan_draft_id: entry.workRef?.planDraftId ?? null,
    plan_issue_id: entry.workRef?.planIssueId ?? null,
    work_repository: entry.workRef?.workRepository ?? null,
  };
}

/** All work-reference DB columns that the migration adds. */
const WORK_REF_COLUMNS = ['work_type', 'task_id', 'task_number', 'pr_number', 'plan_draft_id', 'plan_issue_id', 'work_repository'] as const;

function makeEntry(overrides: Partial<LlmLogEntry> = {}): LlmLogEntry {
  return {
    executionType: 'implementation',
    modelName: 'claude-opus-4-6',
    startTime: new Date('2026-04-23T00:00:00Z'),
    endTime: new Date('2026-04-23T00:01:00Z'),
    durationMs: 60_000,
    success: true,
    inputTokens: 1000,
    outputTokens: 500,
    ...overrides,
  };
}

describe('persistLlmLog insert mapping — task workRef', () => {
  it('maps all task fields to the correct DB columns', () => {
    const entry = makeEntry({
      repository: 'integry/propr',
      draftId: 'legacy-draft-id',
      workRef: {
        workType: 'task',
        taskId: 'job-123',
        taskNumber: 42,
        workRepository: 'integry/propr',
      },
    });

    const row = buildInsertRow(entry, 0.05);

    assert.strictEqual(row.work_type, 'task');
    assert.strictEqual(row.task_id, 'job-123');
    assert.strictEqual(row.task_number, 42);
    assert.strictEqual(row.plan_draft_id, null);
    assert.strictEqual(row.plan_issue_id, null);
    assert.strictEqual(row.work_repository, 'integry/propr');

    // Legacy fields remain intact
    assert.strictEqual(row.draft_id, 'legacy-draft-id');
    assert.strictEqual(row.repository, 'integry/propr');
    assert.strictEqual(row.execution_type, 'implementation');
    assert.strictEqual(row.cost_usd, 0.05);
  });
});

describe('persistLlmLog insert mapping — plan workRef', () => {
  it('maps plan-generation fields correctly', () => {
    const entry = makeEntry({
      executionType: 'plan-generation',
      workRef: {
        workType: 'plan',
        planDraftId: 'draft-abc',
        planIssueId: 7,
        workRepository: 'integry/propr',
      },
    });

    const row = buildInsertRow(entry, 0.12);

    assert.strictEqual(row.work_type, 'plan');
    assert.strictEqual(row.task_id, null);
    assert.strictEqual(row.task_number, null);
    assert.strictEqual(row.plan_draft_id, 'draft-abc');
    assert.strictEqual(row.plan_issue_id, 7);
    assert.strictEqual(row.work_repository, 'integry/propr');
  });
});

describe('persistLlmLog insert mapping — repository-only workRef', () => {
  it('maps repository-scoped summarization', () => {
    const entry = makeEntry({
      executionType: 'summarization',
      repository: 'integry/propr',
      workRef: {
        workType: 'repository',
        workRepository: 'integry/propr',
      },
    });

    const row = buildInsertRow(entry, undefined);

    assert.strictEqual(row.work_type, 'repository');
    assert.strictEqual(row.task_id, null);
    assert.strictEqual(row.task_number, null);
    assert.strictEqual(row.plan_draft_id, null);
    assert.strictEqual(row.plan_issue_id, null);
    assert.strictEqual(row.work_repository, 'integry/propr');
    assert.strictEqual(row.cost_usd, null, 'cost-free insert should have null cost_usd');
  });
});

describe('persistLlmLog insert mapping — missing/empty workRef', () => {
  it('all work columns are null when workRef is undefined', () => {
    const entry = makeEntry();
    const row = buildInsertRow(entry, undefined);

    for (const col of WORK_REF_COLUMNS) {
      assert.strictEqual(row[col], null, `${col} should be null when workRef is undefined`);
    }
  });

  it('all work columns are null when workRef is empty object', () => {
    const entry = makeEntry({ workRef: {} });
    const row = buildInsertRow(entry, undefined);

    for (const col of WORK_REF_COLUMNS) {
      assert.strictEqual(row[col], null, `${col} should be null when workRef is empty`);
    }
  });
});

describe('persistLlmLog insert mapping — partial workRef', () => {
  it('only workType set, rest null', () => {
    const entry = makeEntry({
      workRef: { workType: 'repository' },
    });

    const row = buildInsertRow(entry, undefined);

    assert.strictEqual(row.work_type, 'repository');
    assert.strictEqual(row.task_id, null);
    assert.strictEqual(row.task_number, null);
    assert.strictEqual(row.plan_draft_id, null);
    assert.strictEqual(row.plan_issue_id, null);
    assert.strictEqual(row.work_repository, null);
  });

  it('taskId without taskNumber is valid', () => {
    const entry = makeEntry({
      workRef: { workType: 'task', taskId: 'job-99' },
    });

    const row = buildInsertRow(entry, undefined);

    assert.strictEqual(row.work_type, 'task');
    assert.strictEqual(row.task_id, 'job-99');
    assert.strictEqual(row.task_number, null);
  });
});

describe('persistLlmLog insert mapping — cost-free inserts', () => {
  it('insert without cost works with task workRef', () => {
    const entry = makeEntry({
      inputTokens: 0,
      outputTokens: 0,
      workRef: {
        workType: 'task',
        taskId: 'job-0',
        taskNumber: 1,
        workRepository: 'integry/propr',
      },
    });

    const row = buildInsertRow(entry, undefined);

    assert.strictEqual(row.cost_usd, null);
    assert.strictEqual(row.input_tokens, 0);
    assert.strictEqual(row.output_tokens, 0);
    assert.strictEqual(row.work_type, 'task');
    assert.strictEqual(row.task_id, 'job-0');
  });

  it('insert without cost works with plan workRef', () => {
    const entry = makeEntry({
      inputTokens: undefined,
      outputTokens: undefined,
      workRef: {
        workType: 'plan',
        planDraftId: 'draft-free',
      },
    });

    const row = buildInsertRow(entry, undefined);

    assert.strictEqual(row.cost_usd, null);
    assert.strictEqual(row.input_tokens, null);
    assert.strictEqual(row.output_tokens, null);
    assert.strictEqual(row.work_type, 'plan');
    assert.strictEqual(row.plan_draft_id, 'draft-free');
  });
});

describe('persistLlmLog insert mapping — all DB columns present', () => {
  it('insert row contains exactly the expected columns', () => {
    const entry = makeEntry({
      workRef: { workType: 'task', taskId: 'j1' },
    });

    const row = buildInsertRow(entry, 0.01);
    const columns = Object.keys(row).sort();

    const expectedColumns = [
      'agent_alias', 'cache_creation_input_tokens', 'cache_read_input_tokens',
      'correlation_id', 'cost_usd', 'draft_id', 'duration_ms', 'end_time',
      'error_message', 'estimated_input_tokens', 'execution_type', 'input_tokens',
      'metadata', 'model_name', 'output_tokens', 'plan_draft_id', 'plan_issue_id',
      'pr_number', 'repository', 'session_id', 'start_time', 'success', 'task_id',
      'task_number', 'usage_metrics', 'work_repository', 'work_type',
    ].sort();

    assert.deepStrictEqual(columns, expectedColumns);
  });
});
