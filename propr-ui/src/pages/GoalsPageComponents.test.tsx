import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { GoalListItem, GoalState } from '../api/goalsApi';
import { EmptyGoalsState, GoalRow, GoalStateBadge, GoalsPagination } from './GoalsPageComponents';

const goal: GoalListItem = {
  goalId: 'goal-1',
  objective: 'Build the durable goal control plane',
  repository: 'integry/propr',
  state: 'running',
  agent: 'codex',
  requestedModel: 'gpt-requested',
  effectiveModel: 'gpt-effective',
  maxActiveTasks: 4,
  mergePolicy: 'auto_squash',
  ultrafixEnabled: true,
  ultrafixGoal: 8,
  ultrafixMaxCycles: 10,
  version: 4,
  nodeCount: 8,
  activeNodeCount: 2,
  latestSequence: 19,
  createdAt: '2026-08-31T00:00:00Z',
  updatedAt: '2026-08-31T01:00:00Z',
  projection: {
    status: 'ready',
    checklist: { total: 8, completed: 3 },
    issues: { total: 9, active: 2, processed: 6, failed: 1, blocked: 1 },
    pullRequests: { open: 2, reviewPending: 1, ultrafixPending: 0, mergeReady: 1, merged: 4 },
    tokens: { total: 12_500 },
    time: { elapsedSeconds: 7_500, activeSeconds: 6_900, pausedSeconds: 300 },
    latestEvent: 'Implementation PR opened',
    epicPrUrl: 'https://github.com/integry/propr/pull/2002',
    connectionState: 'connected',
  },
};

const Location = () => <output data-testid="location">{useLocation().pathname}</output>;

describe('GoalsPageComponents', () => {
  it('renders every contractual lifecycle state', () => {
    const states: GoalState[] = ['queued', 'planning', 'running', 'pausing', 'paused', 'recovering', 'completing', 'completed', 'failed', 'cancelled'];
    render(<>{states.map(state => <GoalStateBadge key={state} state={state} />)}</>);
    for (const label of ['Queued', 'Planning', 'Running', 'Pausing', 'Paused', 'Recovering', 'Completing', 'Completed', 'Failed', 'Cancelled']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it('keeps canonical settings/models and renders a labeled checklist progressbar', () => {
    render(<MemoryRouter><GoalRow goal={goal} /></MemoryRouter>);

    expect(screen.getByText('Requested: gpt-requested')).toBeInTheDocument();
    expect(screen.getByText('Effective: gpt-effective')).toBeInTheDocument();
    expect(screen.getByText('2 active work items · 8 total')).toBeInTheDocument();
    expect(screen.getByText(/6 processed · 2 active · 1 failed · 1 blocked/)).toBeInTheDocument();
    expect(screen.getByText('12.5K tokens')).toBeInTheDocument();
    expect(screen.getByText('2h 5m elapsed · 1h 55m active · 5m paused')).toBeInTheDocument();
    expect(screen.getByText('Concurrency: 4')).toBeInTheDocument();
    expect(screen.getByText('Ultrafix · goal 8/10 · max 10')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: '3 of 8 checklist items completed' })).toHaveAttribute('aria-valuenow', '3');
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuetext', '38% complete');
  });

  it('marks unavailable extension statistics explicitly instead of displaying authoritative zeros', () => {
    render(<MemoryRouter><GoalRow goal={{ ...goal, projection: { status: 'not-yet-projected' } }} /></MemoryRouter>);
    expect(screen.getByText('Detailed statistics are not yet projected.')).toBeInTheDocument();
    expect(screen.queryByText(/0 processed/)).not.toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('uses sibling links so the epic PR does not navigate to the goal', () => {
    render(<MemoryRouter initialEntries={['/goals']}><GoalRow goal={goal} /><Location /></MemoryRouter>);
    const goalLink = screen.getByRole('link', { name: `Open goal: ${goal.objective}` });
    const epicLink = screen.getByRole('link', { name: `Open epic pull request for ${goal.objective}` });
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
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(clear).toHaveBeenCalledOnce();
  });

  it('announces keyset pagination without inventing totals', () => {
    const previous = vi.fn();
    const next = vi.fn();
    render(<GoalsPagination currentPage={2} hasPrevious hasNext loading={false} onPrevious={previous} onNext={next} />);
    expect(screen.getByRole('navigation', { name: 'Goals pagination' })).toHaveTextContent('Page 2');
    expect(screen.queryByText(/of 120/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Previous page' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(previous).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledOnce();
  });
});
