import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { HistoryItem, TaskInfo } from './types';
import type { TaskHeadSummary } from './useTaskHeadSummary';
import type { TaskRunEntry } from '../TaskList/rowModel';

const entry = (state: string, minute: number, inputTokens?: number): HistoryItem => ({
  state,
  timestamp: `2026-10-04T08:${String(minute).padStart(2, '0')}:00.000Z`,
  ...(inputTokens ? { metadata: { tokenUsage: { input_tokens: inputTokens, output_tokens: 1 } } } : {}),
});
const info = (modelName: string) => ({ title: 'Stop work', repoOwner: 'integry', repoName: 'propr', modelName }) as TaskInfo;

// The newest run, as read from the API: still working, and the bigger spender.
const head: TaskHeadSummary = {
  history: [entry('queued', 10), entry('claude_execution', 11, 3_900_000)],
  taskInfo: info('gpt-6-astra'), usageMetricRecords: [],
};
vi.mock('./useTaskHeadSummary', async importOriginal => ({
  ...await importOriginal<typeof import('./useTaskHeadSummary')>(),
  useTaskHeadSummary: (taskId?: string) => (taskId ? head : null),
}));

const { useTaskHeaderView } = await import('./useTaskHeaderView');

const run = (id: string, number: number, outcome: TaskRunEntry['outcome']): TaskRunEntry => ({
  task: { id, status: outcome === 'active' ? 'claude_execution' : 'completed', createdAt: '2026-10-04T08:00:00Z' }, number, type: 'Review', summary: '', outcome,
});

describe('useTaskHeaderView', () => {
  it('keeps the task tier on the newest run and gives the run line the opened run\'s own telemetry', () => {
    const own: TaskHeadSummary = {
      history: [entry('queued', 0), entry('processing', 1), entry('completed', 4, 420_000)],
      taskInfo: info('opus-5-5'), usageMetricRecords: [],
    };
    const runs = [run('run-3', 3, 'passed'), run('run-8', 8, 'active')];
    const { result } = renderHook(() => useTaskHeaderView('run-3', runs, own));

    // Tier 1: the task, which is still working on its newest run.
    expect(result.current.headerProps.currentStatus).toBe('CLAUDE_EXECUTION');
    expect(result.current.contextStripProps.tokenUsage?.input_tokens).toBe(3_900_000);
    expect(result.current.inspection?.headActive).toBe(true);

    // Tier 2: the run on screen, with its own model, runtime and consumption.
    expect(result.current.runStripProps.modelName).toContain('opus-5-5');
    expect(result.current.runStripProps.tokenUsage?.input_tokens).toBe(420_000);
    expect(result.current.runStripProps.duration).toBe(4 * 60_000);
    expect(result.current.runState).toEqual({ status: 'COMPLETED', isActive: false, lastActivity: own.history[2].timestamp });
  });
});
