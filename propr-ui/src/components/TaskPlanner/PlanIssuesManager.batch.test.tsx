import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { PlanIssue } from '../../api/planIssuesApi';
import type { PlanTask } from '../../api/plannerApi';
import { PlanIssuesManager } from './PlanIssuesManager';

const state = vi.hoisted(() => ({
  handleImplementIssue: vi.fn(),
  issues: [] as PlanIssue[],
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
  default: ({ issue, showImplementButton }: { issue: PlanIssue; showImplementButton?: boolean }) => (
    <div data-testid="row">#{issue.issue_number}{showImplementButton !== false && issue.status === 'pending' ? ' Implement' : ''}</div>
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

function renderManager(options: { useEpic?: boolean; autoMerge?: boolean; taskCount?: number } = {}) {
  return render(
    <PlanIssuesManager draftId="draft-1" repository="integry/propr" tasks={tasks(options.taskCount ?? state.issues.length)}
      useEpic={options.useEpic} autoMerge={options.autoMerge} />,
  );
}

describe('PlanIssuesManager batch queue', () => {
  beforeEach(() => {
    state.handleImplementIssue.mockReset();
    state.handleImplementIssue.mockResolvedValue(undefined);
  });

  test('starts the first pending issue when nothing is running', () => {
    state.issues = [issue(1, 'merged'), issue(2, 'pending'), issue(3, 'pending')];
    renderManager({ autoMerge: true });
    fireEvent.click(screen.getByRole('button', { name: 'Queue Remaining (2 tasks)' }));
    expect(state.handleImplementIssue).toHaveBeenCalledWith(2, undefined);
  });

  test('does not start a successor while the auto-merge queue head is running', () => {
    state.issues = [issue(1, 'processing'), issue(2, 'pending'), issue(3, 'pending')];
    renderManager({ autoMerge: true });
    const button = screen.getByRole('button', { name: 'Queue Remaining (2 tasks)' });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(state.handleImplementIssue).not.toHaveBeenCalled();
  });

  test('does not start a successor while an earlier issue awaits review', () => {
    state.issues = [issue(1, 'under_review'), issue(2, 'pending'), issue(3, 'pending')];
    renderManager({ autoMerge: true });
    expect(screen.getByRole('button', { name: 'Queue Remaining (2 tasks)' })).toBeDisabled();
    expect(screen.getByTestId('execute-all-hint')).toHaveTextContent('There is no eligible pending issue to start.');
  });

  test('blocks the epic batch while issues are running', () => {
    state.issues = [issue(1, 'refinement_processing'), issue(2, 'pending'), issue(3, 'pending')];
    renderManager({ useEpic: true });
    expect(screen.getByRole('button', { name: 'Queue Remaining (2 tasks)' })).toBeDisabled();
    expect(screen.getByTestId('execute-all-hint')).toHaveTextContent('Wait for the running issues to finish');
  });

  test('sizes the epic batch from the created issues, not plan_json', () => {
    state.issues = [issue(1, 'pending'), issue(2, 'pending')];
    renderManager({ useEpic: true, taskCount: 0 });
    expect(screen.getByRole('button', { name: 'Queue Remaining (2 tasks)' })).toBeEnabled();
    expect(screen.queryByText(/Implement/)).not.toBeInTheDocument();
  });

  test('falls back to the row button when an epic has a single issue', () => {
    state.issues = [issue(1, 'pending')];
    renderManager({ useEpic: true, taskCount: 0 });
    expect(screen.queryByRole('button', { name: /Queue Remaining/ })).not.toBeInTheDocument();
    expect(screen.getByTestId('row')).toHaveTextContent('#1 Implement');
  });
});
