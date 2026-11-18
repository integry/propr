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
    expect(screen.getByTestId('plan-queue-blocked')).toHaveTextContent(/^Setting up the issue…/);
    expect(screen.getByTestId('plan-queue-blocked')).not.toHaveTextContent('Preparing queued issue');
    // Skip alone keeps the dependents waiting, and says so.
    expect(screen.getByTestId('plan-queue-skip')).toHaveTextContent('Skip (keep #3, #4 waiting)');
    fireEvent.click(screen.getByTestId('plan-queue-skip_release'));
    expect(screen.getByTestId('plan-queue-skip_release')).toHaveTextContent('Skip and start #3, #4');
    expect(onAction).toHaveBeenCalledWith('skip_release');
  });

  it('explains a skipped prerequisite and a dependent waiting on it', () => {
    const onAction = vi.fn();
    const { rerender } = render(<PlanIssueQueueNotice onAction={onAction} dependents={[3]}
      state={state({ state: 'skipped', schedule: 'skipped', skipSatisfiesDependents: false })} />);
    expect(screen.getByTestId('plan-queue-skipped')).toHaveTextContent('Skipped. The queue does not run it again in this execution. #3 waits on it.');
    expect(screen.getByTestId('plan-queue-skip_release')).toHaveTextContent(/^Start #3$/);
    fireEvent.click(screen.getByTestId('plan-queue-skip_release'));
    expect(onAction).toHaveBeenCalledWith('skip_release');
    rerender(<PlanIssueQueueNotice onAction={onAction} state={state({ issue: 3, schedule: 'waiting', dependsOn: [2], waitingOn: [2], waitingOnSkipped: [2] })} />);
    expect(screen.getByTestId('plan-queue-waiting-skipped')).toHaveTextContent('Waiting on skipped #2. Start it from that row.');
    // Once its dependents are released, a skipped issue only says it stays skipped: the queue has no un-skip.
    rerender(<PlanIssueQueueNotice onAction={onAction} state={state({ state: 'skipped', schedule: 'skipped', skipSatisfiesDependents: true })} dependents={[3]} />);
    expect(screen.getByTestId('plan-queue-skipped')).toHaveTextContent(/^Skipped\. The queue does not run it again in this execution\.$/);
    expect(screen.queryByTestId('plan-queue-skip_release')).toBeNull();
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

  it('says what a person can do instead of the server reason for setup and human-merge blockers', () => {
    const { rerender } = render(<PlanIssueQueueNotice onAction={vi.fn()} state={state({ state: 'blocked', blockedKind: 'setup_not_ready',
      blockedReason: 'Initial epic dispatch did not establish model and branch labels; inspect the implementation operation before recovery.' })} />);
    expect(screen.getByTestId('plan-queue-blocked').querySelector('p')).toHaveTextContent(/^The first issue could not be set up\. Open its task to see why\.$/);
    rerender(<PlanIssueQueueNotice onAction={vi.fn()} state={state({ state: 'blocked', blockedKind: 'awaiting_human_merge',
      blockedReason: 'Waiting for human merge: auto-merge was not armed for PR #41 (issue #2, checks failing). The queue resumes once a person merges it.' })} />);
    expect(screen.getByTestId('plan-queue-blocked')).toHaveTextContent(/^PR #41 must be merged by a person\. The queue continues after that\./);
    expect(screen.getByTestId('plan-queue-blocked')).not.toHaveTextContent('auto-merge was not armed');
    // A kind this UI does not know reads "Blocked" with the server reason below, never the raw key.
    rerender(<PlanIssueQueueNotice onAction={vi.fn()} state={state({ state: 'blocked',
      blockedKind: 'quota_exhausted' as PlanExecutionQueueIssue['blockedKind'], blockedReason: 'Provider quota is used up until 14:00.' })} />);
    const notice = screen.getByTestId('plan-queue-blocked');
    expect(notice.querySelector('p')).toHaveTextContent(/^Blocked$/);
    expect(notice).toHaveTextContent('Provider quota is used up until 14:00.');
    expect(notice).not.toHaveTextContent('quota_exhausted');
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
