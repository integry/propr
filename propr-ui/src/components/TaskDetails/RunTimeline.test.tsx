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
const scoresHistory = {
  repository: 'integry/propr', pr_number: 2664, outcome: 'merged' as const, merged_at: '2026-09-10T12:20:00Z', closed_at: null,
  scores: [4, 6].map((score, index) => ({
    cycle_number: index + 1, source: 'ultrafix' as const, score, goal: 8, blocker_count: 0, suggestion_count: 0, reviewer_agent: 'codex',
    reviewer_model: 'gpt-6-astra', implementer_model: 'gpt-6-astra', head_sha: null, task_id: `run-${index * 2 + 1}`, created_at: '2026-09-10T12:00:00Z',
  })),
};

const steps = [
  { state: 'PENDING', timestamp: '2026-09-10T12:09:00Z' },
  { state: 'CLAUDE_EXECUTION', timestamp: '2026-09-10T12:09:12Z', metadata: { description: 'Read withdrawal handlers' } },
  { state: 'CLAUDE_EXECUTION', timestamp: '2026-09-10T12:09:24Z', metadata: { description: 'Run the lint suite' } },
];

describe('RunTimeline', () => {
  it('keeps all 50 runs in the shared task scroll flow', () => {
    const many: TaskGroup = {
      ...group,
      tasks: Array.from({ length: 50 }, (_, index) => ({
        id: `many-${49 - index}`, title: 'Review PR #2664: Stop work', subtitle: `Pass ${49 - index}`, status: 'completed',
        createdAt: new Date(Date.UTC(2026, 8, 10, 12, 49 - index)).toISOString(), prNumber: 2664,
      })),
    };
    const manyRuns = buildTaskRuns(buildTaskRow(many));
    const scroll = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scroll });
    const { rerender } = render(<RunTimeline runs={manyRuns} selectedTaskId="many-44" onSelectRun={vi.fn()}>steps</RunTimeline>);
    const scroller = screen.getByTestId('run-timeline-scroll');
    expect(scroller.className).not.toMatch(/max-h-|overflow-y-|overscroll-/);
    expect(within(scroller).getAllByTestId('run-timeline-run')).toHaveLength(50);
    expect(scroll).not.toHaveBeenCalled();
    rerender(<RunTimeline runs={[...manyRuns]} selectedTaskId="many-43" onSelectRun={vi.fn()}>updated steps</RunTimeline>);
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(scroll.mock.instances[0]).toBe(screen.getByRole('button', { current: true }).closest('li'));
    rerender(<RunTimeline runs={[...manyRuns]} selectedTaskId="many-43" onSelectRun={vi.fn()}>streamed steps</RunTimeline>);
    expect(scroll).toHaveBeenCalledTimes(1);
    rerender(<RunTimeline runs={manyRuns} selectedTaskId="many-0" onSelectRun={vi.fn()}>first run again</RunTimeline>);
    expect(scroll).toHaveBeenCalledTimes(2);
    expect(scroll.mock.instances[1]).toBe(screen.getByRole('button', { current: true }).closest('li'));
    delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
  });

  it('preserves the overview when runs arrive after mount', () => {
    const scroll = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scroll });
    const { rerender } = render(<RunTimeline runs={[]} selectedTaskId="run-3" onSelectRun={vi.fn()}>{null}</RunTimeline>);
    expect(scroll).not.toHaveBeenCalled();
    rerender(<RunTimeline runs={runs} selectedTaskId="run-3" onSelectRun={vi.fn()}>{null}</RunTimeline>);
    expect(scroll).not.toHaveBeenCalled();
    delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
  });

  it('leaves the first run at the top even when its steps are tall', () => {
    const scroll = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scroll });
    render(<RunTimeline runs={runs} selectedTaskId="run-1" onSelectRun={vi.fn()}><div style={{ height: 2000 }}>steps</div></RunTimeline>);
    expect(scroll).not.toHaveBeenCalled();
    delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
  });

  it('does not move a later run whose header is already visible above tall steps', () => {
    const scroll = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scroll });
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return { top: this.tagName === 'BUTTON' ? 160 : 100, bottom: this.tagName === 'BUTTON' ? 204 : 700 } as DOMRect;
    });
    const view = (id: string) => <div style={{ overflowY: 'auto' }}><RunTimeline runs={runs} selectedTaskId={id} onSelectRun={vi.fn()}><div style={{ height: 2000 }}>steps</div></RunTimeline></div>;
    const { rerender } = render(view('run-1'));
    rerender(view('run-3'));
    expect(scroll).not.toHaveBeenCalled();
    rect.mockRestore();
    delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
  });

  it('lists every run oldest first, with only the run shown open over its steps', () => {
    render(
      <RunTimeline runs={runs} selectedTaskId="run-4" onSelectRun={vi.fn()}>
        <TaskStatusTable history={steps} variant="branch" />
      </RunTimeline>,
    );
    const rows = within(screen.getByRole('list', { name: 'Runs' })).getAllByTestId('run-timeline-run');
    expect(rows.map(row => row.querySelector('button')!.textContent)).toEqual([
      expect.stringMatching(/^Run 1ReviewInitial review\[4\]/),
      expect.stringMatching(/^Run 2FixFixed seedCommit test9f3c21e/),
      expect.stringMatching(/^Run 3ReviewFound 2 issues\[6\].*3m 30s$/),
      expect.stringMatching(/^Run 4UltrafixUltrafix cycle 3 \(linting\)Active.*Running…$/),
    ]);
    expect(rows.map(row => row.querySelector('button')!.getAttribute('aria-expanded'))).toEqual(['false', 'false', 'false', 'true']);
    // Plain nodes on the rail: the type and the result slot say how each run went, not a coloured marker.
    expect(screen.queryAllByTestId('run-timeline-node')).toHaveLength(4);
    expect(screen.getByRole('list', { name: 'Runs' }).querySelector('[data-outcome]')).toBeNull();
    // A closed fix keeps its commit out of the way, so its summary has the room; hovering the row shows it.
    expect(within(rows[1]).getByTestId('run-commit')).toHaveTextContent('9f3c21e');
    expect(within(rows[1]).getByTestId('run-commit')).toHaveClass('hidden', 'group-hover:inline-flex');
    expect(rows[1].querySelector('button')).toHaveClass('group');
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
      expect(newest.textContent).toMatch(/Waiting.*Queued$/);
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

  it("shows a fix's commit once its run is open", () => {
    render(<RunTimeline runs={runs} selectedTaskId="run-2" onSelectRun={vi.fn()}>{null}</RunTimeline>);
    const commit = within(screen.getByRole('button', { name: /^Run 2/ })).getByTestId('run-commit');
    expect(commit).toHaveClass('inline-flex');
    expect(commit).not.toHaveClass('hidden');
  });

  it('ends on the merge status, its own entry after every run and review', () => {
    render(
      <RunTimeline runs={runs} selectedTaskId="run-3" onSelectRun={vi.fn()} outcome={{ prNumber: 2664, state: 'merged', at: '2026-09-10T12:20:00Z' }}>
        steps
      </RunTimeline>,
    );
    const items = within(screen.getByRole('list', { name: 'Runs' })).getAllByRole('listitem');
    expect(items).toHaveLength(5);
    // After all four runs, not folded into the open run's steps.
    expect(items[4]).toBe(screen.getByTestId('pr-outcome-entry'));
    expect(items[4]).toHaveTextContent(/^MergedPR #2664/);
    expect(within(items[2]).queryByText('Merged')).toBeNull();
  });

  it('puts the review scores on the trunk after every run, before the merge status', () => {
    render(
      <RunTimeline
        runs={runs}
        selectedTaskId="run-3"
        onSelectRun={vi.fn()}
        reviewScores={{ prNumber: 2664, history: scoresHistory }}
        outcome={{ prNumber: 2664, state: 'merged', at: '2026-09-10T12:20:00Z' }}
      >
        steps
      </RunTimeline>,
    );
    const items = [...screen.getByRole('list', { name: 'Runs' }).querySelectorAll<HTMLElement>(':scope > li')];
    expect(items.map(item => item.dataset.testid)).toEqual([
      'run-timeline-run', 'run-timeline-run', 'run-timeline-run', 'run-timeline-run', 'review-score-history', 'pr-outcome-entry',
    ]);
  });

  it('moves a run\'s time, duration and result to their own phone line, under the run label', () => {
    render(<RunTimeline runs={runs} selectedTaskId="run-2" onSelectRun={vi.fn()}>{null}</RunTimeline>);
    const meta = within(screen.getByRole('button', { name: /^Run 2/ })).getByTestId('run-timeline-meta');
    expect(meta).toHaveClass('max-sm:basis-full', 'max-sm:ml-0', 'max-sm:pl-12');
    expect(within(meta).getByTestId('run-commit')).toHaveClass('max-sm:order-last');
  });

  it('has no final entry while the PR is open', () => {
    render(<RunTimeline runs={runs} selectedTaskId="run-4" onSelectRun={vi.fn()} outcome={null}>steps</RunTimeline>);
    expect(screen.queryByTestId('pr-outcome-entry')).toBeNull();
  });
});

it('retains reveal history across keyed remounts, but preserves a new group overview', () => {
  const scroll = vi.fn();
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scroll });
  const revealHistory = { current: null };
  const view = (id: string, entries = runs) => <RunTimeline key={id} revealHistory={revealHistory} runs={entries} selectedTaskId={id} onSelectRun={() => {}}>Steps</RunTimeline>;
  const { rerender, unmount } = render(view('run-4'));
  expect(scroll).not.toHaveBeenCalled();
  rerender(view('run-3'));
  expect(scroll).toHaveBeenCalledTimes(1);
  rerender(view('run-3', [...runs]));
  expect(scroll).toHaveBeenCalledTimes(1);
  const other = runs.map(run => ({ ...run, task: { ...run.task, id: `other-${run.task.id}` } }));
  rerender(view('other-run-4', other));
  expect(scroll).toHaveBeenCalledTimes(1);
  unmount();
  delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
});
