/**
 * Tests for work-reference display helpers in the LLM logs UI.
 *
 * Validates getWorkReferenceDisplay, getWorkTypeLabel, and hasDetailedInfo
 * by importing the real production implementations.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  getWorkReferenceDisplay,
  getWorkTypeLabel,
  hasDetailedInfo,
  WorkRefFields,
} from '../propr-ui/src/pages/llmLogsDisplayUtils.js';

interface LlmLogEntry extends WorkRefFields {
  logId: number;
  executionType: string;
  modelName: string | null;
  startTime: string | null;
  endTime: string | null;
  durationMs: number | null;
  success: boolean;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheCreationInputTokens: number | null;
  cacheReadInputTokens: number | null;
  costUsd: number | null;
  agentAlias: string | null;
  usageMetrics: Record<string, unknown> | null;
  usageMetricRecords: { agent: string; metricKey: string; metricValue: number }[];
  workType: 'task' | 'plan' | 'repository' | null;
  taskId: string | null;
  taskNumber: number | null;
  prNumber: number | null;
  planDraftId: string | null;
  planIssueId: number | null;
  workRepository: string | null;
}

function makeLog(overrides: Partial<LlmLogEntry> = {}): LlmLogEntry {
  return {
    logId: 1,
    executionType: 'implementation',
    modelName: 'claude-opus-4-6',
    startTime: '2026-04-23T00:00:00Z',
    endTime: '2026-04-23T00:01:00Z',
    durationMs: 60000,
    success: true,
    inputTokens: 100,
    outputTokens: 50,
    cacheCreationInputTokens: null,
    cacheReadInputTokens: null,
    costUsd: 0.01,
    errorMessage: null,
    sessionId: null,
    correlationId: null,
    draftId: null,
    repository: null,
    agentAlias: null,
    metadata: null,
    usageMetrics: null,
    usageMetricRecords: [],
    workType: null,
    taskId: null,
    taskNumber: null,
    prNumber: null,
    planDraftId: null,
    planIssueId: null,
    workRepository: null,
    ...overrides,
  };
}

describe('getWorkReferenceDisplay', () => {
  it('returns dash when no workType', () => {
    assert.strictEqual(getWorkReferenceDisplay(makeLog()), '-');
  });

  it('shows issue number for task work type', () => {
    const log = makeLog({ workType: 'task', taskNumber: 42, workRepository: 'integry/propr' });
    assert.strictEqual(getWorkReferenceDisplay(log), 'integry/propr · Issue #42');
  });

  it('shows issue and PR for task with both', () => {
    const log = makeLog({ workType: 'task', taskNumber: 42, prNumber: 99, workRepository: 'integry/propr' });
    assert.strictEqual(getWorkReferenceDisplay(log), 'integry/propr · Issue #42, PR #99');
  });

  it('shows truncated task ID when no issue/PR numbers', () => {
    const log = makeLog({ workType: 'task', taskId: 'abcdefghijklmnop' });
    assert.strictEqual(getWorkReferenceDisplay(log), 'Task abcdefgh');
  });

  it('shows plan issue ID for plan work type', () => {
    const log = makeLog({ workType: 'plan', planIssueId: 7, planDraftId: 'draft-abc-12345' });
    assert.strictEqual(getWorkReferenceDisplay(log), 'Plan Issue #7');
  });

  it('shows truncated draft ID when no plan issue', () => {
    const log = makeLog({ workType: 'plan', planDraftId: 'draft-abc-12345' });
    assert.strictEqual(getWorkReferenceDisplay(log), 'Draft draft-ab');
  });

  it('shows repository for repository work type', () => {
    const log = makeLog({ workType: 'repository', workRepository: 'integry/propr' });
    assert.strictEqual(getWorkReferenceDisplay(log), 'integry/propr');
  });

  it('shows fallback for repository with no repo', () => {
    const log = makeLog({ workType: 'repository' });
    assert.strictEqual(getWorkReferenceDisplay(log), 'Repository analysis');
  });

  it('falls back to legacy repository field', () => {
    const log = makeLog({ workType: 'task', taskNumber: 10, repository: 'legacy/repo' });
    assert.strictEqual(getWorkReferenceDisplay(log), 'legacy/repo · Issue #10');
  });

  it('returns dash for task with no identifiers', () => {
    const log = makeLog({ workType: 'task' });
    assert.strictEqual(getWorkReferenceDisplay(log), '-');
  });
});

describe('getWorkTypeLabel', () => {
  it('returns Task for task', () => {
    assert.strictEqual(getWorkTypeLabel('task'), 'Task');
  });
  it('returns Plan for plan', () => {
    assert.strictEqual(getWorkTypeLabel('plan'), 'Plan');
  });
  it('returns Repo for repository', () => {
    assert.strictEqual(getWorkTypeLabel('repository'), 'Repo');
  });
  it('returns dash for null', () => {
    assert.strictEqual(getWorkTypeLabel(null), '-');
  });
  it('returns dash for unknown', () => {
    assert.strictEqual(getWorkTypeLabel('unknown'), '-');
  });
});

describe('hasDetailedInfo with work references', () => {
  it('returns false for minimal log', () => {
    assert.strictEqual(hasDetailedInfo(makeLog()), false);
  });

  it('returns true when workType is set', () => {
    assert.strictEqual(hasDetailedInfo(makeLog({ workType: 'task' })), true);
  });

  it('returns true when errorMessage is set', () => {
    assert.strictEqual(hasDetailedInfo(makeLog({ errorMessage: 'boom' })), true);
  });

  it('returns true when metadata is set', () => {
    assert.strictEqual(hasDetailedInfo(makeLog({ metadata: { foo: 'bar' } })), true);
  });
});

describe('API response shape', () => {
  it('work-reference fields are present in LlmLogEntry type', () => {
    const log = makeLog({
      workType: 'task',
      taskId: 'job-1',
      taskNumber: 100,
      prNumber: 200,
      planDraftId: null,
      planIssueId: null,
      workRepository: 'integry/propr',
    });

    // Verify all work-reference fields exist and are typed correctly
    assert.strictEqual(log.workType, 'task');
    assert.strictEqual(log.taskId, 'job-1');
    assert.strictEqual(log.taskNumber, 100);
    assert.strictEqual(log.prNumber, 200);
    assert.strictEqual(log.planDraftId, null);
    assert.strictEqual(log.planIssueId, null);
    assert.strictEqual(log.workRepository, 'integry/propr');
  });

  it('all work-reference fields can be null', () => {
    const log = makeLog();
    assert.strictEqual(log.workType, null);
    assert.strictEqual(log.taskId, null);
    assert.strictEqual(log.taskNumber, null);
    assert.strictEqual(log.prNumber, null);
    assert.strictEqual(log.planDraftId, null);
    assert.strictEqual(log.planIssueId, null);
    assert.strictEqual(log.workRepository, null);
  });
});
