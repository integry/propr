import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { PlanIssue } from '../../api/planIssuesApi';
import { PlanIssuesManager } from './PlanIssuesManager';

const state = vi.hoisted(() => ({
  handleImplementIssue: vi.fn(),
  issue: null as PlanIssue | null,
}));

vi.mock('./usePlanIssuesManager', () => ({
  usePlanIssuesManager: () => {
    const issues = state.issue ? [state.issue] : [];
    return {
      issues,
      agents: [],
      loading: false,
      error: null,
      clearError: vi.fn(),
      implementingIssue: null,
      issueTitles: { 1725: 'Notification intents' },
      issueTaskMap: {},
      activeIssues: issues,
      mergedIssues: [],
      pendingCount: issues.length,
      hasActiveIssues: false,
      firstPendingIssueNumber: state.issue?.issue_number ?? null,
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
vi.mock('./PlanIssueRow', () => ({ default: () => <div>Issue row</div> }));
vi.mock('./PlanIssuesManagerToolbar', () => ({
  ExecutionOptionsToolbar: () => <div>Execution options</div>,
  TasksBeingCreated: () => null,
}));

const issue: PlanIssue = {
  id: 1,
  draft_id: 'draft-1',
  repository: 'integry/propr',
  issue_number: 1725,
  pr_number: null,
  status: 'pending',
  agent_alias: 'codex',
  model_name: 'gpt-5.6-sol',
  followup_count: 0,
  task_id: null,
  created_at: '2026-08-24T12:00:00.000Z',
  updated_at: '2026-08-24T12:00:00.000Z',
};

function renderManager(options: { readOnly?: boolean; onConsumed?: () => void } = {}) {
  return render(
    <PlanIssuesManager
      draftId="draft-1"
      repository="integry/propr"
      tasks={[]}
      notificationIntent="approve_execute"
      onNotificationIntentConsumed={options.onConsumed}
      isReadOnly={options.readOnly}
      useEpic
      autoMerge
    />,
  );
}

describe('PlanIssuesManager execution intent', () => {
  beforeEach(() => {
    state.issue = issue;
    state.handleImplementIssue.mockReset();
    state.handleImplementIssue.mockResolvedValue(undefined);
  });

  test('requires confirmation and reuses the selected issue implementation handler', async () => {
    const onConsumed = vi.fn();
    renderManager({ onConsumed });

    expect(await screen.findByRole('dialog', { name: 'Start agent work?' })).toBeInTheDocument();
    expect(screen.getByText('codex / gpt-5.6-sol')).toBeInTheDocument();
    expect(screen.getByText('Epic PR with automatic merging of issue PRs')).toBeInTheDocument();
    expect(state.handleImplementIssue).not.toHaveBeenCalled();
    expect(onConsumed).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Start Agent Work' }));
    expect(state.handleImplementIssue).toHaveBeenCalledWith(1725, undefined);
    expect(state.handleImplementIssue).toHaveBeenCalledTimes(1);
  });

  test('cancel closes without starting implementation', async () => {
    renderManager();
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(state.handleImplementIssue).not.toHaveBeenCalled();
  });

  test('selection and demo guards keep execution disabled', async () => {
    state.issue = { ...issue, agent_alias: null, model_name: null };
    const view = renderManager();
    expect(await screen.findByText(/Select an agent\/model/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start Agent Work' })).toBeDisabled();
    view.unmount();

    state.issue = issue;
    renderManager({ readOnly: true });
    expect(await screen.findByText(/Demo mode is read-only/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start Agent Work' })).toBeDisabled();
    expect(state.handleImplementIssue).not.toHaveBeenCalled();
  });
});
