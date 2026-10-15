import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import TaskHeader, { TaskStatusBadge } from './TaskHeader';
import type { TaskInfo } from './types';

describe('TaskHeader', () => {
  it.each(['processing', 'claude_execution', 'claude_execution_started', 'post_processing'])(
    'marks a review as Review during %s', currentStatus => {
      render(<TaskStatusBadge taskInfo={{ commandMode: 'review' } as TaskInfo} currentStatus={currentStatus} />);
      expect(screen.getByTestId('task-status-badge')).toHaveTextContent('Review');
      expect(screen.queryByText(/Implementing|Fixing|Creating PR/)).not.toBeInTheDocument();
    }
  );

  it('titles the task the way the task list row does', () => {
    const taskInfo = {
      title: 'Ultrafix PR #2664: [2659 by GPT-6 Astra] Stop work when an issue or PR withdraws intent',
      type: 'pr', number: 2664, repoOwner: 'integry', repoName: 'propr',
    } as unknown as TaskInfo;
    render(<TaskHeader taskInfo={taskInfo} currentStatus="processing" />);
    const heading = screen.getByRole('heading', { level: 2 });
    expect(heading).toHaveTextContent(/^Stop work when an issue or PR withdraws intent$/);
    expect(heading).toHaveAttribute('title', 'Stop work when an issue or PR withdraws intent');
  });

  it('ends a 100-character title that may have been hard-cut on a whole word', () => {
    const title = 'New Issue: Expose task changes, logs and events through the MCP server so that an MCP client can act';
    expect(title).toHaveLength(100);
    const taskInfo = { title, type: 'issue', number: 12, repoOwner: 'integry', repoName: 'propr' } as unknown as TaskInfo;
    render(<TaskHeader taskInfo={taskInfo} currentStatus="completed" />);
    const heading = screen.getByRole('heading', { level: 2 });
    expect(heading).toHaveTextContent(/MCP client can…$/);
    expect(heading).toHaveAttribute('title', 'Expose task changes, logs and events through the MCP server so that an MCP client can act');
  });
});

describe('TaskHeader for an automation report', () => {
  const report = { type: 'agent-run', number: 0, taskKind: 'automation-report', title: 'Agent: Desktop acceptance', subtitle: 'Report run' } as TaskInfo;

  it.each([
    ['claude_execution', 'Generating Report'],
    ['claude_execution_completed', 'Report Generated'],
    ['post_processing', 'Storing Report'],
    ['completed', 'Completed'],
  ])('names the report phase during %s', (currentStatus, label) => {
    render(<TaskStatusBadge taskInfo={report} currentStatus={currentStatus} />);
    expect(screen.getByTestId('task-status-badge')).toHaveTextContent(label);
    expect(screen.queryByText(/Implementing|Creating PR/)).not.toBeInTheDocument();
  });

  it('marks the task as a report and keeps issue tasks implementing', () => {
    render(<TaskHeader taskInfo={report} currentStatus="claude_execution" />);
    expect(screen.getAllByText('Report').length).toBeGreaterThan(0);
    render(<TaskStatusBadge taskInfo={{ type: 'issue', number: 12 } as TaskInfo} currentStatus="claude_execution" />);
    expect(screen.getAllByTestId('task-status-badge')[0]).toHaveTextContent('Implementing');
  });
});
