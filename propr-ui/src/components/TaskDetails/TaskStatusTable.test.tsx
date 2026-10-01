import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import TaskStatusTable from './TaskStatusTable';

describe('task terminal reasons', () => {
  it.each(['cancelled_issue_closed', 'cancelled_label_removed', 'cancelled_pr_closed', 'cancelled_by_user', 'timed_out'])('shows %s in the task timeline', reason => {
    render(<TaskStatusTable history={[{ state: reason === 'timed_out' ? 'failed' : 'cancelled', timestamp: '2026-09-30T23:55:00Z', metadata: { terminalReason: reason } }]} />);
    expect(screen.getByTestId('task-terminal-reason')).toHaveTextContent(reason);
  });
});
