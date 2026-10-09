import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import TaskStatusTable from './TaskStatusTable';
import type { HistoryItem, NetworkEgressSummary } from './types';

const at = (second: number) => new Date(Date.UTC(2026, 9, 1, 0, 50, second)).toISOString();

describe('Task timeline lifecycle', () => {
  it('updates a running phase in place and measures it from its original start', () => {
    const first = { state: 'PROCESSING', timestamp: at(29) };
    const { rerender } = render(<TaskStatusTable history={[first]} />);
    expect(screen.getByText('Running...')).toBeInTheDocument();
    rerender(<TaskStatusTable history={[first, { state: 'processing', timestamp: at(30) }]} />);
    expect(screen.getAllByText('Analyzing Request')).toHaveLength(1);
    expect(screen.getAllByText('Running...')).toHaveLength(1);
    rerender(<TaskStatusTable history={[
      first, { state: 'PROCESSING', timestamp: at(30) },
      { state: 'CLAUDE_EXECUTION', timestamp: at(37) },
      { state: 'COMPLETED', timestamp: at(47) },
    ]} />);
    expect(screen.getAllByText('Analyzing Request')).toHaveLength(1);
    expect(screen.getByText('8s')).toBeInTheDocument();
    expect(screen.queryByText('0s')).not.toBeInTheDocument();
    expect(screen.queryByText('Running...')).not.toBeInTheDocument();
  });

  it('preserves separate pipeline cycles and execution checkpoints and pool attempts', () => {
    render(<TaskStatusTable history={[
      { state: 'PROCESSING', timestamp: at(1) },
      { state: 'CLAUDE_EXECUTION', timestamp: at(2), metadata: { description: 'First checkpoint' } },
      { state: 'CLAUDE_EXECUTION', timestamp: at(3), metadata: { description: 'Second checkpoint' } },
      { state: 'PROCESSING', timestamp: at(4) },
      { state: 'CLAUDE_EXECUTION_STARTED', timestamp: at(5), metadata: { syntheticRouting: { attemptNumber: 1, callId: 'a' } } },
      { state: 'CLAUDE_EXECUTION_STARTED', timestamp: at(6), metadata: { syntheticRouting: { attemptNumber: 2, callId: 'b' } } },
    ]} />);
    expect(screen.getAllByText('Analyzing Request')).toHaveLength(2);
    for (const label of ['First checkpoint', 'Second checkpoint', 'Pool attempt 1', 'Pool attempt 2']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });
});

describe('repository workflow capacity waits', () => {
  const retryAt = '2026-10-01T00:52:30.000Z';
  const waiting = [
    { state: 'pending', timestamp: at(1) },
    { state: 'pending', timestamp: at(5), reason: 'Waiting for repository workflow capacity', metadata: { repositoryWorkflowDeferrals: 1, repositoryWorkflowRetryAt: at(15) } },
    { state: 'pending', timestamp: at(15), reason: 'Waiting for repository workflow capacity', metadata: { repositoryWorkflowDeferrals: 2, repositoryWorkflowRetryAt: retryAt } },
  ];

  it('explains why a queued task is not progressing, with the latest count and next retry', () => {
    render(<TaskStatusTable history={waiting} />);
    expect(screen.getByText('Waiting for Repository Capacity')).toBeInTheDocument();
    expect(screen.queryByText('Task Queued')).not.toBeInTheDocument();
    const time = new Date(retryAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    expect(screen.getByTestId('repository-workflow-deferral')).toHaveTextContent(`Admission deferred 2 times · next retry ${time}`);
  });

  it('keeps the wait in history without a stale retry time once the task is admitted', () => {
    render(<TaskStatusTable history={[...waiting, { state: 'processing', timestamp: at(40) }]} />);
    expect(screen.getByTestId('repository-workflow-deferral')).toHaveTextContent(/^Admission deferred 2 times$/);
    expect(screen.getByText('Analyzing Request')).toBeInTheDocument();
  });

  it('labels a single deferral in the singular', () => {
    render(<TaskStatusTable history={waiting.slice(0, 2)} />);
    expect(screen.getByTestId('repository-workflow-deferral')).toHaveTextContent(/^Admission deferred 1 time · next retry/);
  });
});

describe('task terminal reasons', () => {
  it.each([
    ['cancelled_issue_closed', 'Cancelled because the issue was closed.'],
    ['cancelled_label_removed', 'Cancelled because the processing trigger label was removed.'],
    ['cancelled_pr_closed', 'Cancelled because the pull request was closed without merging.'],
    ['cancelled_by_user', 'Cancelled by a user.'],
    ['timed_out', 'The task exceeded its time limit.'],
    ['pr_merged', 'The pull request was merged.'],
    ['unknown_internal_code', 'The task ended.'],
  ])('shows a readable explanation for %s in the task timeline', (reason, explanation) => {
    render(<TaskStatusTable history={[{ state: reason === 'timed_out' ? 'failed' : 'cancelled', timestamp: '2026-09-30T23:55:00Z', metadata: { terminalReason: reason } }]} />);
    expect(screen.getByTestId('task-terminal-reason')).toHaveTextContent(explanation);
    expect(screen.queryByText(reason)).not.toBeInTheDocument();
  });

  it('omits the explanation when no terminal reason is recorded', () => {
    render(<TaskStatusTable history={[{ state: 'cancelled', timestamp: '2026-09-30T23:55:00Z' }]} />);
    expect(screen.getByText('Task Cancelled')).toBeInTheDocument();
    expect(screen.queryByTestId('task-terminal-reason')).not.toBeInTheDocument();
  });

  it('shows a spend cap stop as its own event, not another implementation attempt', () => {
    render(<TaskStatusTable history={[
      { state: 'PROCESSING', timestamp: at(1) },
      { state: 'CLAUDE_EXECUTION', timestamp: at(2) },
      {
        state: 'CLAUDE_EXECUTION', timestamp: at(20), reason: 'Spend cap reached',
        metadata: { event: 'budget.exceeded', budget: { capUsd: 5, spentUsd: 5.12, percent: 102, source: 'workflow' } },
      },
      { state: 'COMPLETED', timestamp: at(30), metadata: { terminalReason: 'cost_cap_exceeded' } },
    ]} />);
    expect(screen.getByText('Implementing Changes')).toBeInTheDocument();
    expect(screen.getByText('Spend Cap Reached')).toBeInTheDocument();
    expect(screen.queryByText(/Retry Implementing Changes/)).not.toBeInTheDocument();
    expect(screen.getByTestId('budget-exceeded')).toHaveTextContent('Estimated $5.12 of a $5.00 cap · .propr/workflow.yml');
    expect(screen.getByTestId('task-terminal-reason')).toHaveTextContent('The run was stopped because it reached its spend cap.');
  });
});


describe('network egress events', () => {
  const at = (minute: number) => new Date(Date.UTC(2026, 9, 6, 12, minute)).toISOString();
  const networkEvent = (networkEgress: Partial<NetworkEgressSummary>): HistoryItem => ({
    state: 'CLAUDE_EXECUTION', timestamp: at(20), reason: 'Restricted network',
    metadata: { event: 'network.egress', networkEgress: { mode: 'restricted', source: 'workflow', deniedConnections: 0, deniedHosts: [], ...networkEgress } },
  });

  it('shows the mode and every denied host without counting the event as another attempt', () => {
    const deniedHosts = Array.from({ length: 10 }, (_, index) => ({ host: `host${index}.example.com`, count: 10 - index }));
    render(<TaskStatusTable history={[
      { state: 'CLAUDE_EXECUTION', timestamp: at(2) },
      networkEvent({ deniedConnections: 58, deniedHosts, omittedDeniedHosts: 1, omittedDeniedAttempts: 3 }),
      { state: 'CLAUDE_EXECUTION', timestamp: at(21), reason: 'claude agent execution completed' },
    ]} />);
    expect(screen.getByText('Restricted Network: Connections Denied')).toBeInTheDocument();
    expect(screen.queryByText(/Retry Implementing Changes/)).not.toBeInTheDocument();
    const detail = screen.getByTestId('network-egress');
    expect(detail).toHaveTextContent('Network: restricted · .propr/workflow.yml');
    expect(detail).toHaveTextContent('host0.example.com × 10');
    expect(detail).toHaveTextContent('host7.example.com × 3');
    expect(detail).not.toHaveTextContent('host8.example.com');
    // Two hosts beyond the shown list plus one beyond the recorded list; none disappear.
    expect(detail).toHaveTextContent('+3 more hosts (6 attempts)');
  });

  it('warns when an agent fell back to open networking', () => {
    render(<TaskStatusTable history={[networkEvent({ restrictedContainers: 0, fallbacks: [{ agentType: 'antigravity', reason: 'not verified' }] })]} />);
    expect(screen.getByText('Restricted Network')).toBeInTheDocument();
    expect(screen.getByTestId('network-egress')).toHaveTextContent('antigravity ran with open network: not verified');
  });

  it('labels a run by its final outcome when a refused agent was followed by one behind the proxy', () => {
    render(<TaskStatusTable history={[networkEvent({ source: 'instance_enforced', restrictedContainers: 1, refusals: [{ agentType: 'antigravity', reason: 'not verified' }] })]} />);
    expect(screen.getByText('Restricted Network')).toBeInTheDocument();
    expect(screen.queryByText('Restricted Network: Agent Refused')).not.toBeInTheDocument();
    expect(screen.getByTestId('network-egress')).toHaveTextContent('antigravity refused (restricted mode is enforced): not verified');
  });

  it('flags allowed connections that failed upstream', () => {
    render(<TaskStatusTable history={[networkEvent({ restrictedContainers: 1, failedConnections: 2, failedHosts: [{ host: 'api.example.com', count: 2 }] })]} />);
    expect(screen.getByTestId('network-egress')).toHaveTextContent('2 allowed connections failed upstream: api.example.com × 2');
    expect(screen.getByLabelText('Network policy needs attention')).toBeInTheDocument();
  });

  it('says so when no agent container started', () => {
    render(<TaskStatusTable history={[networkEvent({ restrictedContainers: 0 })]} />);
    expect(screen.getByText('Restricted Network: No Agent Container Started')).toBeInTheDocument();
  });

  it('still labels a run whose only agent was refused', () => {
    render(<TaskStatusTable history={[networkEvent({ source: 'instance_enforced', restrictedContainers: 0, refusals: [{ agentType: 'antigravity', reason: 'not verified' }] })]} />);
    expect(screen.getByText('Restricted Network: Agent Refused')).toBeInTheDocument();
  });
});

describe('TaskStatusTable replacement events', () => {
  it('labels replacement timeline events by event instead of repeating the failure', () => {
    render(<TaskStatusTable history={[
      { state: 'processing', timestamp: at(0) },
      { state: 'failed', timestamp: at(10), reason: 'Task failed: orphaned' },
      { state: 'failed', timestamp: at(11), reason: 'Replacement attempt 2 dispatched', metadata: { event: 'replacement.dispatched', attemptNumber: 2, replacementTaskId: 'attempt-2' } },
    ]} />);
    expect(screen.getAllByText('Task Failed')).toHaveLength(1);
    expect(screen.getByText('Replacement Attempt 2 Started')).toBeInTheDocument();
  });

  it('shows why a replacement was skipped', () => {
    render(<TaskStatusTable history={[
      { state: 'failed', timestamp: '2026-10-06T09:00:00.000Z' },
      { state: 'failed', timestamp: '2026-10-06T09:00:01.000Z', reason: 'Replacement skipped: the replacement cap was reached', metadata: { event: 'replacement.skipped' } },
    ]} />);
    expect(screen.getByText('Replacement skipped: the replacement cap was reached')).toBeInTheDocument();
  });

  // Any item carrying `metadata.event` is its own step, so a replacement event recorded during a
  // pipeline phase no longer merges into the step before it, while plain updates still do.
  it('keeps a replacement event recorded in a pipeline phase as its own step', () => {
    render(<TaskStatusTable history={[
      { state: 'PROCESSING', timestamp: at(0) },
      { state: 'PROCESSING', timestamp: at(1) },
      { state: 'PROCESSING', timestamp: at(2), reason: 'Replacement attempt 2 dispatched', metadata: { event: 'replacement.dispatched', attemptNumber: 2, replacementTaskId: 'attempt-2' } },
      { state: 'PROCESSING', timestamp: at(3), reason: 'Replacement skipped: the replacement cap was reached', metadata: { event: 'replacement.skipped' } },
    ]} />);
    expect(screen.getAllByText('Analyzing Request')).toHaveLength(1);
    expect(screen.getByText('Replacement Attempt 2 Started')).toBeInTheDocument();
    expect(screen.getByText('Replacement skipped: the replacement cap was reached')).toBeInTheDocument();
  });
});

describe('pull request auto-assignment events', () => {
  it('shows the assignment as its own step after the pull request is created', () => {
    render(<TaskStatusTable history={[
      { state: 'POST_PROCESSING', timestamp: at(1) },
      {
        state: 'POST_PROCESSING', timestamp: at(5), reason: 'Assigned pull request to alice and requested their review',
        metadata: { event: 'pull_request.auto_assignment', description: 'Assigned pull request to alice and requested their review' },
      },
      { state: 'COMPLETED', timestamp: at(6) },
    ]} />);
    expect(screen.getByText('Creating Pull Request')).toBeInTheDocument();
    expect(screen.getByText('Assigned pull request to alice and requested their review')).toBeInTheDocument();
  });
});
