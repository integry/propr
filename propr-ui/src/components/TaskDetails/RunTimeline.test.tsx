import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import RunTimeline from './RunTimeline';
import TaskStatusTable from './TaskStatusTable';
import { buildTaskRow, buildTaskRuns } from '../TaskList/rowModel';
import type { TaskGroup } from '../TaskList/types';

const group: TaskGroup = {
  key: 'integry/propr-pr-2664', repoOwner: 'integry', repoName: 'propr', prNumber: 2664,
  tasks: [
    { id: 'run-4', title: 'Ultrafix PR #2664: Stop work when intent is withdrawn', subtitle: 'Ultrafix cycle 3 (linting)', status: 'processing', createdAt: '2026-09-10T12:09:00Z', processedAt: '2026-09-10T12:09:00Z', prNumber: 2664 },
    { id: 'run-3', title: 'Review PR #2664: Stop work when intent is withdrawn', subtitle: 'Found 2 issues', status: 'completed', score: 6, createdAt: '2026-09-10T12:05:00Z', processedAt: '2026-09-10T12:05:00Z', completedAt: '2026-09-10T12:08:30Z', prNumber: 2664 },
    // The ultrafix loop recorded a score against this fix; a fix never shows one.
    { id: 'run-2', title: 'Followup: Update 2', subtitle: 'Fixed seedCommit test', status: 'completed', score: 5, commitHash: '9f3c21e81a4d', createdAt: '2026-09-10T12:02:00Z', prNumber: 2664 },
    { id: 'run-1', title: 'Review PR #2664: Stop work when intent is withdrawn', subtitle: 'Initial review', status: 'completed', score: 4, createdAt: '2026-09-10T12:00:00Z', prNumber: 2664 },
  ],
};
const runs = buildTaskRuns(buildTaskRow(group));

const steps = [
  { state: 'PENDING', timestamp: '2026-09-10T12:09:00Z' },
  { state: 'CLAUDE_EXECUTION', timestamp: '2026-09-10T12:09:12Z', metadata: { description: 'Read withdrawal handlers' } },
  { state: 'CLAUDE_EXECUTION', timestamp: '2026-09-10T12:09:24Z', metadata: { description: 'Run the lint suite' } },
];

describe('RunTimeline', () => {
  it('lists every run oldest first, with only the run shown open over its steps', () => {
    render(
      <RunTimeline runs={runs} selectedTaskId="run-4" onSelectRun={vi.fn()}>
        <TaskStatusTable history={steps} variant="branch" />
      </RunTimeline>,
    );
    const rows = within(screen.getByRole('list', { name: 'Runs' })).getAllByTestId('run-timeline-run');
    expect(rows.map(row => row.querySelector('button')!.textContent)).toEqual([
      expect.stringMatching(/^Run 1·ReviewInitial review.*\[4\]$/),
      expect.stringMatching(/^Run 2·FixFixed seedCommit test.*9f3c21e$/),
      expect.stringMatching(/^Run 3·ReviewFound 2 issues.*3m 30s\[6\]$/),
      expect.stringMatching(/^Run 4·UltrafixUltrafix cycle 3 \(linting\).*Running…Active$/),
    ]);
    expect(rows.map(row => row.querySelector('button')!.getAttribute('aria-expanded'))).toEqual(['false', 'false', 'false', 'true']);
    // Plain nodes on the rail: the type and the result slot say how each run went, not a coloured marker.
    expect(screen.queryAllByTestId('run-timeline-node')).toHaveLength(4);
    expect(screen.getByRole('list', { name: 'Runs' }).querySelector('[data-outcome]')).toBeNull();
    expect(within(rows[1]).getByTestId('run-commit')).toHaveTextContent('9f3c21e');
    expect(within(rows[1]).queryByTitle(/score/i)).toBeNull();
    // Only the open run carries its steps, each a branch off the rail.
    const stepList = within(rows[3]).getByRole('list', { name: 'Run steps' });
    expect(within(stepList).getAllByRole('listitem').map(step => step.textContent)).toEqual([
      expect.stringMatching(/Task Queued12s$/),
      expect.stringMatching(/Read withdrawal handlers12s$/),
      expect.stringMatching(/Run the lint suiteRunning…$/),
    ]);
    expect(screen.getAllByRole('list', { name: 'Run steps' })).toHaveLength(1);
  });

  it('shows a queued run as waiting, with no runtime and no Active badge', () => {
    for (const status of ['queued', 'pending', 'waiting']) {
      const queued = buildTaskRuns(buildTaskRow({ ...group, tasks: [{ ...group.tasks[0], status, processedAt: undefined }, ...group.tasks.slice(1)] }));
      const { unmount } = render(<RunTimeline runs={queued} selectedTaskId="run-3" onSelectRun={vi.fn()}>{null}</RunTimeline>);
      const newest = screen.getByRole('button', { name: /^Run 4/ });
      expect(newest.textContent).toMatch(/QueuedWaiting$/);
      expect(newest).not.toHaveTextContent(/Running…|Active/);
      expect(newest).toHaveAttribute('title', 'Run 4 waiting to start');
      unmount();
    }
  });

  it('opens an earlier run in the pane, and folds the open one in place', () => {
    const onSelectRun = vi.fn();
    render(
      <RunTimeline runs={runs} selectedTaskId="run-4" onSelectRun={onSelectRun}>
        <TaskStatusTable history={steps} variant="branch" />
      </RunTimeline>,
    );
    fireEvent.click(screen.getByRole('button', { name: /^Run 3/ }));
    expect(onSelectRun).toHaveBeenCalledExactlyOnceWith('run-3');
    const open = screen.getByRole('button', { name: /^Run 4/ });
    fireEvent.click(open);
    expect(open).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('list', { name: 'Run steps' })).not.toBeInTheDocument();
    expect(onSelectRun).toHaveBeenCalledTimes(1);
  });
});
