import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { PlanIssue } from '../../api/planIssuesApi';
import type { PlanTask } from '../../api/plannerApi';
import { PlanIssuesManager } from './PlanIssuesManager';

const state = vi.hoisted(() => ({
  handleImplementIssue: vi.fn(),
  handleQueueRemaining: vi.fn(),
  issues: [] as PlanIssue[],
  queued: new Set<number>(),
}));

vi.mock('./usePlanIssuesManager', () => ({
  usePlanIssuesManager: () => {
    const sorted = [...state.issues].sort((left, right) => left.issue_number - right.issue_number);
    const active = sorted.filter(issue => issue.status !== 'merged');
    const firstUnmerged = active[0];
    return {
      issues: state.issues,
      agents: [],
      loading: false,
      error: null,
      clearError: vi.fn(),
      implementingIssue: null,
      queuedIssueNumbers: state.queued,
      queueingRemaining: false,
      handleQueueRemaining: state.handleQueueRemaining,
      issueTitles: {},
      issueTaskMap: {},
      activeIssues: active,
      mergedIssues: sorted.filter(issue => issue.status === 'merged'),
      pendingCount: active.filter(issue => issue.status === 'pending').length,
      hasActiveIssues: false,
      firstPendingIssueNumber: firstUnmerged?.status === 'pending' ? firstUnmerged.issue_number : null,
      globalAgent: null,
      globalModel: null,
      globalIsMulti: false,
      globalSelectedModels: [],
      applyingGlobal: false,
      issueMultiModeMap: {},
      issueSelectedModelsMap: {},
      issueCreationProgress: { status: 'idle', createdCount: 0, totalCount: 0, failedCount: 0 },
      resetIssueCreationProgress: vi.fn(),
      handleImplementIssue: state.handleImplementIssue,
      handleGlobalAgentChange: vi.fn(),
      handleGlobalModelChange: vi.fn(),
      handleGlobalMultiToggle: vi.fn(),
      handleGlobalMultiModelChange: vi.fn(),
      handleApplyToAll: vi.fn(),
      handleAgentChange: vi.fn(),
      handleModelChange: vi.fn(),
      handleIssueMultiToggle: vi.fn(),
      handleIssueMultiModelChange: vi.fn(),
      handleRefresh: vi.fn(),
      getUnmergedIssuesBefore: vi.fn(() => []),
    };
  },
}));
vi.mock('./PlanIssueRow', () => ({
  default: ({ issue, showImplementButton, implementButtonLabel = 'Implement', isQueued }: {
    issue: PlanIssue; showImplementButton?: boolean; implementButtonLabel?: string; isQueued?: boolean;
  }) => (
    <div data-testid="row">#{issue.issue_number}{showImplementButton !== false && issue.status === 'pending' ? ` ${implementButtonLabel}` : ''}{isQueued ? ' Queued' : ''}</div>
  ),
}));
vi.mock('./PlanIssuesManagerToolbar', () => ({
  ExecutionOptionsToolbar: () => null,
  TasksBeingCreated: () => null,
}));

const issue = (issueNumber: number, status: PlanIssue['status']): PlanIssue => ({
  id: issueNumber,
  draft_id: 'draft-1',
  repository: 'integry/propr',
  issue_number: issueNumber,
  pr_number: null,
  status,
  agent_alias: 'claude',
  model_name: 'claude-opus-5-5',
  followup_count: 0,
  task_id: null,
  created_at: '2026-10-06T12:00:00.000Z',
  updated_at: '2026-10-06T12:00:00.000Z',
});
const tasks = (count: number) => Array.from({ length: count }, (_, index) => ({ id: `t${index}`, title: `Task ${index}` })) as PlanTask[];

function renderManager(options: {
  useEpic?: boolean; autoMerge?: boolean; taskCount?: number; isReadOnly?: boolean; isSavingExecutionSettings?: boolean;
} = {}) {
  return render(
    <PlanIssuesManager draftId="draft-1" repository="integry/propr" tasks={tasks(options.taskCount ?? state.issues.length)}
      useEpic={options.useEpic} autoMerge={options.autoMerge} isReadOnly={options.isReadOnly}
      isSavingExecutionSettings={options.isSavingExecutionSettings} />,
  );
}

describe('PlanIssuesManager batch queue', () => {
  beforeEach(() => {
    state.handleImplementIssue.mockReset();
    state.handleImplementIssue.mockResolvedValue(undefined);
    state.handleQueueRemaining.mockReset();
    state.handleQueueRemaining.mockResolvedValue(undefined);
    state.queued = new Set();
  });

  test('starts the first pending issue when nothing is running', () => {
    state.issues = [issue(1, 'merged'), issue(2, 'pending'), issue(3, 'pending')];
    renderManager({ autoMerge: true });
    fireEvent.click(screen.getByRole('button', { name: 'Queue Remaining (2 tasks)' }));
    expect(state.handleImplementIssue).toHaveBeenCalledWith(2, undefined);
  });

  test('queues the backlog behind a running auto-merge head instead of starting a successor', () => {
    state.issues = [issue(1, 'processing'), issue(2, 'pending'), issue(3, 'pending')];
    renderManager({ autoMerge: true });
    const button = screen.getByRole('button', { name: 'Queue Remaining (2 tasks)' });
    expect(button).toBeEnabled();
    expect(screen.getByTestId('execute-all-hint')).toHaveTextContent('Queues 2 tasks behind the running work');
    fireEvent.click(button);
    expect(state.handleQueueRemaining).toHaveBeenCalledTimes(1);
    expect(state.handleImplementIssue).not.toHaveBeenCalled();
  });

  test('queues the backlog while an earlier issue awaits review', () => {
    state.issues = [issue(1, 'under_review'), issue(2, 'pending'), issue(3, 'pending')];
    renderManager({ autoMerge: true });
    fireEvent.click(screen.getByRole('button', { name: 'Queue Remaining (2 tasks)' }));
    expect(state.handleQueueRemaining).toHaveBeenCalledTimes(1);
  });

  test('keeps the epic batch enabled while issues are running', () => {
    state.issues = [issue(1, 'refinement_processing'), issue(2, 'pending'), issue(3, 'pending')];
    renderManager({ useEpic: true });
    fireEvent.click(screen.getByRole('button', { name: 'Queue Remaining (2 tasks)' }));
    expect(state.handleQueueRemaining).toHaveBeenCalledTimes(1);
  });

  test('marks queued rows and only offers the issues the queue does not own yet', () => {
    state.issues = [issue(1, 'processing'), issue(2, 'pending'), issue(3, 'pending'), issue(4, 'pending')];
    state.queued = new Set([2, 3]);
    renderManager({ autoMerge: true });
    expect(screen.getByRole('button', { name: 'Queue Remaining (1 task)' })).toBeEnabled();
    expect(screen.getAllByTestId('row').map(row => row.textContent)).toEqual(['#1', '#2 Queued', '#3 Queued', '#4 Implement']);
  });

  test('replaces the button with a queued summary once the queue owns every pending issue', () => {
    state.issues = [issue(1, 'processing'), issue(2, 'pending'), issue(3, 'pending')];
    state.queued = new Set([2, 3]);
    renderManager({ useEpic: true });
    expect(screen.queryByRole('button', { name: /Queue Remaining/ })).not.toBeInTheDocument();
    expect(screen.getByTestId('execute-all-hint')).toHaveTextContent('2 tasks queued. Each starts automatically');
  });

  test('read-only viewers cannot queue the backlog', () => {
    state.issues = [issue(1, 'processing'), issue(2, 'pending'), issue(3, 'pending')];
    render(<PlanIssuesManager draftId="draft-1" repository="integry/propr" tasks={tasks(3)} autoMerge isReadOnly />);
    expect(screen.getByRole('button', { name: 'Queue Remaining (2 tasks)' })).toBeDisabled();
  });

  test('sizes the epic batch from the created issues, not plan_json', () => {
    state.issues = [issue(1, 'pending'), issue(2, 'pending')];
    renderManager({ useEpic: true, taskCount: 0 });
    expect(screen.getByRole('button', { name: 'Start Epic PR (2 tasks)' })).toBeEnabled();
    expect(screen.queryByText(/Implement/)).not.toBeInTheDocument();
  });

  test('falls back to an "Implement Epic" row button when an epic has a single issue', () => {
    state.issues = [issue(1, 'pending')];
    renderManager({ useEpic: true, taskCount: 0 });
    expect(screen.queryByRole('button', { name: /Queue Remaining/ })).not.toBeInTheDocument();
    expect(screen.getByTestId('row')).toHaveTextContent('#1 Implement Epic');
  });

  test('starts the remaining epic after a closed predecessor', () => {
    state.issues = [issue(1, 'closed'), issue(2, 'pending'), issue(3, 'pending')];
    renderManager({ useEpic: true });
    const button = screen.getByRole('button', { name: 'Queue Remaining (2 tasks)' });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    expect(state.handleImplementIssue).toHaveBeenCalledWith(2, undefined);
  });

  test('heads the batch with the earliest-created pending issue, matching the server', () => {
    state.issues = [{ ...issue(5, 'pending'), id: 10 }, { ...issue(7, 'pending'), id: 3 }, issue(1, 'merged')];
    renderManager({ autoMerge: true });
    fireEvent.click(screen.getByRole('button', { name: 'Queue Remaining (2 tasks)' }));
    expect(state.handleImplementIssue).toHaveBeenCalledWith(7, undefined);
  });

  test.each([
    ['demo mode', { isReadOnly: true }],
    ['an execution-settings save', { isSavingExecutionSettings: true }],
  ])('locks the idle epic batch during %s', (_label, flags) => {
    state.issues = [issue(1, 'pending'), issue(2, 'pending'), issue(3, 'pending')];
    renderManager({ useEpic: true, ...flags });
    const button = screen.getByRole('button', { name: 'Start Epic PR (3 tasks)' });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(state.handleImplementIssue).not.toHaveBeenCalled();
    expect(state.handleQueueRemaining).not.toHaveBeenCalled();
  });

  test('does not queue behind running work while settings are saving', () => {
    state.issues = [issue(1, 'processing'), issue(2, 'pending'), issue(3, 'pending')];
    renderManager({ autoMerge: true, isSavingExecutionSettings: true });
    const button = screen.getByRole('button', { name: 'Queue Remaining (2 tasks)' });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(state.handleQueueRemaining).not.toHaveBeenCalled();
  });
});
