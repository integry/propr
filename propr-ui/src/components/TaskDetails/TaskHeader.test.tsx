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
});
