import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import TaskStatusTable from './TaskStatusTable';

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
});
