import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import type { PlanExecutionQueueIssue, PlanIssue } from '../../api/planIssuesApi';
import { PlanIssueQueueNotice } from './PlanIssueQueueNotice';
import { PlanIssueRow } from './PlanIssueRow';

const state = (overrides: Partial<PlanExecutionQueueIssue>): PlanExecutionQueueIssue => ({
  issue: 2, state: 'pending', blockedKind: null, blockedReason: null, schedule: 'ready', dependsOn: [], waitingOn: [], ...overrides,
});

describe('PlanIssueQueueNotice', () => {
  it('shows which blocker holds the issue and why, with retry and skip', () => {
    const onAction = vi.fn();
    render(<PlanIssueQueueNotice onAction={onAction} state={state({ state: 'blocked', schedule: 'blocked', blockedKind: 'closed_unmerged',
      blockedReason: 'Issue #2 is closed; this epic advances only after it is merged.' })} />);
    const notice = screen.getByTestId('plan-queue-blocked');
    expect(notice).toHaveTextContent('Blocked · Closed without merge');
    expect(notice).toHaveTextContent('Issue #2 is closed; this epic advances only after it is merged.');
    fireEvent.click(screen.getByTestId('plan-queue-retry'));
    fireEvent.click(screen.getByTestId('plan-queue-skip'));
    expect(onAction.mock.calls).toEqual([['retry'], ['skip']]);
    expect(screen.queryByTestId('plan-queue-skip_release')).toBeNull();
  });

  it('offers to release graph dependents, and no retry while setup is unfinished', () => {
    const onAction = vi.fn();
    render(<PlanIssueQueueNotice onAction={onAction} dependents={[3, 4]} state={state({ state: 'blocked', schedule: 'blocked',
      blockedKind: 'setup_not_ready', blockedReason: 'Preparing queued issue model and epic branch labels.' })} />);
    expect(screen.queryByTestId('plan-queue-retry')).toBeNull();
    fireEvent.click(screen.getByTestId('plan-queue-skip_release'));
    expect(screen.getByTestId('plan-queue-skip_release')).toHaveTextContent('Skip and start #3, #4');
    expect(onAction).toHaveBeenCalledWith('skip_release');
  });

  it('explains a skipped prerequisite and a dependent waiting on it', () => {
    const onAction = vi.fn();
    const { rerender } = render(<PlanIssueQueueNotice onAction={onAction} dependents={[3]}
      state={state({ state: 'skipped', schedule: 'skipped', skipSatisfiesDependents: false })} />);
    expect(screen.getByTestId('plan-queue-skipped')).toHaveTextContent('#3 waits on it');
    fireEvent.click(screen.getByTestId('plan-queue-skip_release'));
    expect(onAction).toHaveBeenCalledWith('skip_release');
    rerender(<PlanIssueQueueNotice onAction={onAction} state={state({ issue: 3, schedule: 'waiting', dependsOn: [2], waitingOn: [2], waitingOnSkipped: [2] })} />);
    expect(screen.getByTestId('plan-queue-waiting-skipped')).toHaveTextContent('Waiting on skipped #2');
    rerender(<PlanIssueQueueNotice onAction={onAction} state={state({ state: 'skipped', schedule: 'skipped', skipSatisfiesDependents: true })} dependents={[3]} />);
    expect(screen.queryByTestId('plan-queue-skipped')).toBeNull();
  });

  it('explains a blocker without actions in a read-only plan, and offers nothing else there', () => {
    const { rerender } = render(<PlanIssueQueueNotice dependents={[3]} state={state({ state: 'blocked', schedule: 'blocked',
      blockedKind: 'agent_blocked', blockedReason: 'Issue #2 stopped on a blocker reported by the agent.' })} />);
    const notice = screen.getByTestId('plan-queue-blocked');
    expect(notice).toHaveTextContent('Blocked · ');
    expect(notice).toHaveTextContent('Issue #2 stopped on a blocker reported by the agent.');
    expect(screen.queryByRole('button')).toBeNull();
    rerender(<PlanIssueQueueNotice dependents={[3]} state={state({ state: 'skipped', schedule: 'skipped', skipSatisfiesDependents: false })} />);
    expect(screen.queryByTestId('plan-queue-skipped')).toBeNull();
    rerender(<PlanIssueQueueNotice state={state({})} />);
    expect(screen.queryByTestId('plan-queue-pending')).toBeNull();
  });

  it('disables the actions while one runs', () => {
    render(<PlanIssueQueueNotice onAction={vi.fn()} pendingAction="retry" state={state({ state: 'blocked', blockedKind: 'dispatch_failed', blockedReason: 'Could not start' })} />);
    expect(screen.getByTestId('plan-queue-retry')).toBeDisabled();
    expect(screen.getByTestId('plan-queue-skip')).toBeDisabled();
  });

  it('a read-only plan row still explains its blocker, without actions', () => {
    const issue = { id: 1, draft_id: 'd', repository: 'integry/propr', issue_number: 2, pr_number: null, status: 'processing',
      agent_alias: null, model_name: null, followup_count: 0, task_id: null, created_at: '', updated_at: '' } as PlanIssue;
    const blocked = state({ state: 'blocked', schedule: 'blocked', blockedKind: 'closed_unmerged', blockedReason: 'Issue #2 is closed.' });
    const row = (onQueueAction?: () => void) => (
      <MemoryRouter>
        <PlanIssueRow issue={issue} agents={[]} onImplement={vi.fn()} onAgentChange={vi.fn()} onModelChange={vi.fn()}
          queueState={blocked} onQueueAction={onQueueAction} />
      </MemoryRouter>
    );
    const { rerender } = render(row());
    expect(screen.getByTestId('plan-queue-blocked')).toHaveTextContent('Issue #2 is closed.');
    expect(screen.queryByTestId('plan-queue-retry')).toBeNull();
    expect(screen.queryByTestId('plan-queue-skip')).toBeNull();
    rerender(row(vi.fn()));
    expect(screen.getByTestId('plan-queue-retry')).toBeInTheDocument();
  });
});
