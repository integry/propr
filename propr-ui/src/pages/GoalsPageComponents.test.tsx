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
  maxActiveTasks: 4, mergePolicy: 'manual', ultrafixEnabled: true, ultrafixGoal: 8, ultrafixMaxCycles: 10,
  version: 4,
  latestSequence: 19,
  createdAt: '2026-08-31T00:00:00Z',
  updatedAt: '2026-08-31T01:00:00Z',
  projection: {
    status: 'ready',
    provider: { status: 'working', statusDetail: 'Implementing', updatedAt: '2026-08-31T01:00:00Z' },
    plan: { total: 8, completed: 3 },
    stats: {
      tokens: { total: 12_500, byProviderModel: [] },
      time: { elapsedSeconds: 7_500, activeSeconds: 6_900, pausedSeconds: 300 },
      messages: { queued: 2, oldestQueuedSeconds: 30 },
      artifacts: {
        issues: { total: 9, open: 3, closed: 6 },
        pullRequests: { total: 6, open: 2, merged: 4, draft: 1 },
        finalPullRequest: { number: 2002, url: 'https://github.com/integry/propr/pull/2002', draft: true },
      },
    },
    latestEvent: 'Implementation PR opened',
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
    expect(screen.getByText('9 associated issues · 6 associated PRs')).toBeInTheDocument();
    expect(screen.getByText('12.5K tokens')).toBeInTheDocument();
    expect(screen.getByText('2h 5m elapsed · 1h 55m active · 5m paused')).toBeInTheDocument();
    expect(screen.getByText('Parallelism preference: 4')).toBeInTheDocument();
    expect(screen.getByText('Ultrafix preference · goal 8/10 · max 10')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: '3 of 8 checklist items completed' })).toHaveAttribute('aria-valuenow', '3');
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuetext', '38% complete');
  });

  it('marks unavailable extension statistics explicitly instead of displaying authoritative zeros', () => {
    render(<MemoryRouter><GoalRow goal={{ ...goal, projection: { status: 'not-yet-projected' } }} /></MemoryRouter>);
    expect(screen.getByText('Detailed statistics are not yet projected.')).toBeInTheDocument();
    expect(screen.queryByText(/0 processed/)).not.toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('navigates goal rows to the operator page without hijacking the passive final PR link', () => {
    render(<MemoryRouter initialEntries={['/goals']}><GoalRow goal={goal} /><Location /></MemoryRouter>);
    const finalPrLink = screen.getByRole('link', { name: `Open associated final pull request for ${goal.objective}` });
    expect(screen.getByRole('link', { name: `Open goal: ${goal.objective}` })).toBeInTheDocument();
    fireEvent.click(screen.getByText(goal.objective));
    expect(screen.getByTestId('location')).toHaveTextContent('/goals/goal-1');
    fireEvent.click(finalPrLink);
    expect(screen.getByTestId('location')).toHaveTextContent('/goals/goal-1');
  });

  it.each([
    ['javascript:alert(1)', false],
    ['data:text/html,unsafe', false],
    ['//github.com/integry/propr/pull/2002', false],
    ['not a url', false],
    ['https://', false],
    ['http://github.com/integry/propr/pull/2002', false],
    ['https://github.com/integry/propr/pull/2002', true],
  ])('renders an associated final PR URL %s only when it is absolute HTTPS', (finalPrUrl, allowed) => {
    if (goal.projection.status !== 'ready') throw new Error('ready projection fixture required');
    render(<MemoryRouter><GoalRow goal={{ ...goal, projection: { ...goal.projection, stats: { ...goal.projection.stats, artifacts: { ...goal.projection.stats.artifacts, finalPullRequest: { number: 2002, url: finalPrUrl, draft: true } } } } }} /></MemoryRouter>);
    const link = screen.queryByRole('link', { name: `Open associated final pull request for ${goal.objective}` });
    if (!allowed) {
      expect(link).not.toBeInTheDocument();
      return;
    }
    expect(link).toHaveAttribute('href', finalPrUrl);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
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
