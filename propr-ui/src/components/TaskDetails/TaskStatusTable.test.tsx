import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import TaskStatusTable from './TaskStatusTable';

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
