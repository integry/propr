import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import TaskHeader from './TaskHeader';
import type { TaskInfo } from './types';

describe('TaskHeader', () => {
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
