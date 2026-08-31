import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { GoalListItem, GoalState } from '../api/goalsApi';
import { EmptyGoalsState, GoalRow, GoalStateBadge, GoalsPagination } from './GoalsPageComponents';

const goal: GoalListItem = {
  id: 'goal-1',
  objective: 'Build the durable goal control plane',
  repository: 'integry/propr',
  state: 'running',
  agentAlias: 'codex',
  requestedModel: 'gpt-requested',
  effectiveModel: 'gpt-effective',
  maxConcurrentTasks: 4,
  autoMergePolicy: 'auto_squash',
  ultrafixEnabled: true,
  ultrafixGoal: 8,
  ultrafixMaxCycles: 10,
  checklistTotal: 8,
  checklistCompleted: 3,
  activeTasks: 2,
  issuesProcessed: 6,
  issuesActive: 2,
  issuesFailed: 1,
  issuesBlocked: 1,
  tokenTotal: 12_500,
  elapsedSeconds: 7_500,
  pausedSeconds: 300,
  latestEvent: 'Implementation PR opened',
  epicPrUrl: 'https://github.com/integry/propr/pull/2002',
  connectionState: 'connected',
  createdAt: '2026-08-31T00:00:00Z',
  updatedAt: '2026-08-31T01:00:00Z',
};

const Location = () => <output data-testid="location">{useLocation().pathname}</output>;

describe('GoalsPageComponents', () => {
  it('renders every contractual lifecycle state', () => {
    const states: GoalState[] = ['queued', 'planning', 'running', 'pausing', 'paused', 'recovering', 'completing', 'completed', 'failed', 'cancelled'];
    render(<>{states.map(state => <GoalStateBadge key={state} state={state} />)}</>);
    for (const label of ['Queued', 'Planning', 'Running', 'Pausing', 'Paused', 'Recovering', 'Completing', 'Completed', 'Failed', 'Cancelled']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(screen.queryByText('Active')).not.toBeInTheDocument();
  });

  it('keeps requested/effective models explicit and renders goal statistics/settings', () => {
    render(<MemoryRouter><GoalRow goal={goal} /></MemoryRouter>);

    expect(screen.getByText('Requested: gpt-requested')).toBeInTheDocument();
    expect(screen.getByText('Effective: gpt-effective')).toBeInTheDocument();
    expect(screen.getByText('2 active tasks')).toBeInTheDocument();
    expect(screen.getByText(/6 processed · 2 active/)).toHaveTextContent('1 failed');
    expect(screen.getByText('12.5K tokens')).toBeInTheDocument();
    expect(screen.getByText('2h 5m')).toBeInTheDocument();
    expect(screen.getByText('Concurrency: 4')).toBeInTheDocument();
    expect(screen.getByText('Ultrafix · goal 8/10 · max 10')).toBeInTheDocument();
    expect(screen.getByLabelText('3 of 8 checklist items completed')).toBeInTheDocument();
  });

  it('uses sibling links so the epic PR is valid markup and does not navigate to the goal', () => {
    render(<MemoryRouter initialEntries={['/goals']}><GoalRow goal={goal} /><Location /></MemoryRouter>);
    const goalLink = screen.getByRole('link', { name: `Open goal: ${goal.objective}` });
    const epicLink = screen.getByRole('link', { name: `Open epic pull request for ${goal.objective}` });

    expect(epicLink.closest('a')).toBe(epicLink);
    expect(goalLink.contains(epicLink)).toBe(false);
    fireEvent.click(epicLink);
    expect(screen.getByTestId('location')).toHaveTextContent('/goals');
    fireEvent.click(goalLink);
    expect(screen.getByTestId('location')).toHaveTextContent('/goals/goal-1');
  });

  it('provides focused empty-state actions', () => {
    const create = vi.fn();
    const clear = vi.fn();
    const { rerender } = render(<EmptyGoalsState type="no-goals" onCreateGoal={create} />);
    fireEvent.click(screen.getByRole('button', { name: 'Create first goal' }));
    expect(create).toHaveBeenCalledOnce();

    rerender(<EmptyGoalsState type="no-search-results" searchQuery="missing" onCreateGoal={create} onClearSearch={clear} />);
    expect(screen.getByText('No results for “missing”')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(clear).toHaveBeenCalledOnce();
  });

  it('announces pagination and enforces page bounds', () => {
    const onPageChange = vi.fn();
    render(<GoalsPagination currentPage={2} totalPages={3} totalGoals={120} pageSize={50} hasMore loading={false} onPageChange={onPageChange} />);
    const pagination = screen.getByRole('navigation', { name: 'Goals pagination' });
    expect(pagination).toHaveTextContent('51–100 of 120');
    fireEvent.click(screen.getByRole('button', { name: 'Previous page' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(onPageChange).toHaveBeenNthCalledWith(1, 1);
    expect(onPageChange).toHaveBeenNthCalledWith(2, 3);
  });
});
