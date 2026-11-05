import { version as reactVersion } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import TaskDetails from './index';
import type { TaskRunEntry } from '../TaskList/rowModel';

const handleDeleteTask = vi.fn(async () => true);
const loadedTaskIds: Array<string | undefined> = [];
// What the task's own record says it is; a test can make it a numbered PR or issue.
const loadedTaskInfo = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));

vi.mock('./hooks', () => ({
  useTaskData: (taskId?: string) => {
    loadedTaskIds.push(taskId);
    return {
      loading: false, error: null,
      history: [{ id: 1, status: 'completed', timestamp: '2026-10-01T12:00:00Z', metadata: {} }],
      taskInfo: { title: 'Fix PR #12: Stop work', issueNumber: 12, ...loadedTaskInfo.current },
      liveDetails: { todos: [], events: [] },
      usageMetricRecords: [], previewMedia: [],
      stoppingExecution: false, stopFailed: false, deletingTask: false,
      handleStopExecution: vi.fn(), handleDeleteTask,
    };
  },
  usePromptData: () => ({ fetchPrompt: vi.fn(), selectedPrompt: null, loadingPrompt: false, closePrompt: vi.fn() }),
  useLogFilesData: () => ({ fetchLogFilesData: vi.fn(), logFiles: null, searchMatches: [], closeLogFiles: vi.fn() }),
}));
vi.mock('./useThinkingLog', () => ({
  useThinkingLog: () => ({ eventsCollapsed: true, collapseEvents: vi.fn(), toggleEventsCollapse: vi.fn(), thinkingLogWithTimestamps: [] }),
}));
vi.mock('./useHistoryData', () => ({
  getHistoryDerivedData: () => ({ currentStatus: 'completed', isTaskActive: false, modelName: null, prInfo: null, historyItemWithPaths: null }),
}));
vi.mock('./useDerivedTaskData', () => ({
  useTotalDuration: () => null, useCommitInfo: () => null, useConsumedReviewCommentIds: () => new Set(), useTokenUsage: () => null,
}));
vi.mock('../ui/useToast', () => ({ useToast: () => ({ addToast: vi.fn() }) }));
vi.mock('./ActionBar', () => ({
  default: ({ onDeleteTask, onFollowUp, followupCommands }: { onDeleteTask: () => void; onFollowUp?: () => void; followupCommands?: React.ReactNode }) => (
    <>
      <button type="button" onClick={onDeleteTask}>Delete task</button>
      {onFollowUp && <button type="button" onClick={onFollowUp}>Follow Up</button>}
      {followupCommands && <span data-testid="followup-commands" />}
    </>
  ),
}));
// The task's PR is open unless a test merges it, or makes its read fail or hang.
const pullRequestScores = vi.hoisted(() => ({ outcome: null as 'merged' | 'closed' | null, read: 'resolves' as 'resolves' | 'rejects' | 'pending' }));
vi.mock('../../api/taskStatsApi', () => ({
  getPullRequestScores: vi.fn(async (repository: string, prNumber: number) => {
    if (pullRequestScores.read === 'rejects') throw new Error('scores unavailable');
    if (pullRequestScores.read === 'pending') return new Promise(() => {});
    return { repository, pr_number: prNumber, outcome: pullRequestScores.outcome, merged_at: null, closed_at: null, scores: [] };
  }),
}));
// Children have their own suites; this one is about the details shell.
vi.mock('./ThinkingLog', () => ({ default: () => null }));
vi.mock('./ExecutionEventLog', () => ({ default: () => null }));
vi.mock('./ResultOverview', () => ({ default: () => null }));
vi.mock('./PromptModal', () => ({ default: () => null }));
vi.mock('./LogFilesModal', () => ({ default: () => null }));
vi.mock('./FollowupModal', () => ({ default: () => null }));
vi.mock('./ContextStrip', () => ({
  default: ({ lead }: { lead?: React.ReactNode }) => <>{lead}</>,
  ConsumptionGroup: () => null,
  MobileGitContext: () => null,
  MobilePeopleRuntime: () => null,
}));
vi.mock('./TaskHeader', async importOriginal => ({ ...await importOriginal<typeof import('./TaskHeader')>(), default: () => null }));
// The newest run is read from the API in its own suite.
vi.mock('./useTaskHeadSummary', async importOriginal => ({ ...await importOriginal<typeof import('./useTaskHeadSummary')>(), useTaskHeadSummary: () => null }));
vi.mock('./ProgressBar', () => ({ default: () => null }));
vi.mock('./LeftPaneBody', () => ({ default: () => null }));
vi.mock('./TaskVisualPreviews', () => ({ default: () => null }));

const LocationProbe = () => <output data-testid="location">{useLocation().pathname}</output>;

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  loadedTaskIds.length = 0;
  loadedTaskInfo.current = {};
  pullRequestScores.outcome = null;
  pullRequestScores.read = 'resolves';
  document.title = '';
});

describe('TaskDetails embedded beside the task list', () => {
  it('shows the task it is given, leaves the title to the list and reports a delete instead of navigating', async () => {
    const onDeleted = vi.fn();
    document.title = 'Tasks | ProPR';
    render(
      <MemoryRouter initialEntries={['/tasks?task=pane-task']}>
        <Routes><Route path="/tasks" element={<TaskDetails taskId="pane-task" embedded onDeleted={onDeleted} />} /></Routes>
        <LocationProbe />
      </MemoryRouter>,
    );
    expect(loadedTaskIds).toContain('pane-task');
    expect(document.title).toBe('Tasks | ProPR');
    // A pane is never wide enough for the timeline/output split: no desktop-only column classes.
    expect(screen.getByTestId('task-workspace-scroll').className).not.toContain('[@container_task-workspace_(min-width:960px)]:grid');
    expect(screen.getByTestId('task-workspace-scroll').className).not.toContain('[@container_task-workspace_(min-width:960px)]:grid-cols-[max(30%,576px)_minmax(0,1fr)]');
    // The list is beside the pane: no breadcrumb back to it.
    expect(screen.queryByTestId('task-breadcrumb')).not.toBeInTheDocument();

    await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: 'Delete task' })[0]); });
    expect(handleDeleteTask).toHaveBeenCalled();
    expect(onDeleted).toHaveBeenCalledTimes(1);
    expect(onDeleted).toHaveBeenCalledWith('pane-task');
    expect(screen.getByTestId('location')).toHaveTextContent('/tasks');
  });

  it('keeps the route page behaviour when not embedded', async () => {
    render(
      <MemoryRouter initialEntries={['/tasks/route-task']}>
        <Routes>
          <Route path="/tasks/:taskId" element={<TaskDetails />} />
          <Route path="/tasks" element={<p>task list</p>} />
        </Routes>
        <LocationProbe />
      </MemoryRouter>,
    );
    expect(loadedTaskIds).toContain('route-task');
    expect(document.title).toContain('ProPR');
    expect(screen.getByTestId('task-workspace-scroll').className).toContain('[@container_task-workspace_(min-width:960px)]:grid');
    await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: 'Delete task' })[0]); });
    expect(screen.getByTestId('location')).toHaveTextContent(/^\/tasks$/);
  });

  it('leads the full page with a breadcrumb back to the task list', () => {
    render(
      <MemoryRouter initialEntries={['/tasks/route-task']}>
        <Routes>
          <Route path="/tasks/:taskId" element={<TaskDetails />} />
          <Route path="/tasks" element={<p>task list</p>} />
        </Routes>
        <LocationProbe />
      </MemoryRouter>,
    );
    const crumb = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(crumb).toHaveTextContent('Tasks/Task');
    fireEvent.click(within(crumb).getByRole('link', { name: 'Tasks' }));
    expect(screen.getByTestId('location')).toHaveTextContent(/^\/tasks$/);
  });

  it.each([
    ['pr', 'PR #2664'],
    ['pr-comment', 'PR #2664'],
    ['issue', 'Issue #2664'],
  ])('names a numbered %s task in the breadcrumb as %s', (type, label) => {
    loadedTaskInfo.current = { type, number: 2664 };
    render(
      <MemoryRouter initialEntries={['/tasks/route-task']}>
        <Routes><Route path="/tasks/:taskId" element={<TaskDetails />} /></Routes>
      </MemoryRouter>,
    );
    expect(screen.getByRole('navigation', { name: 'Breadcrumb' })).toHaveTextContent(`Tasks/${label}`);
  });

  const run = (id: string, number: number, outcome: TaskRunEntry['outcome'] = 'passed'): TaskRunEntry => ({
    task: { id, status: outcome === 'active' ? 'claude_execution' : 'completed', createdAt: '2026-10-01T12:00:00Z' }, number, type: 'Review', summary: 'Found 2 issues', outcome,
  });
  // The pane's TIMELINE header; the other is for phones and the route page's wide layout.
  const timelineHeader = () => {
    const shown = screen.getAllByText('TIMELINE').filter(node => !node.closest('.sm\\:hidden'));
    expect(shown).toHaveLength(1);
    return shown[0].parentElement!;
  };
  const renderInspecting = (head: TaskRunEntry, onSelectRun = vi.fn()) => {
    render(
      <MemoryRouter initialEntries={['/tasks?task=run-1']}>
        <Routes><Route path="/tasks" element={(
          <TaskDetails taskId="run-1" embedded runs={[run('run-1', 1), head]} onSelectRun={onSelectRun}
            paneControls={<button type="button">Close pane</button>} />
        )} /></Routes>
      </MemoryRouter>,
    );
    // One section header is for the wide route page only; the pane shows the other.
    const shown = screen.getAllByTestId('inspected-run-context').filter(node => !node.closest('.hidden'));
    expect(shown).toHaveLength(1);
    return shown[0];
  };

  it('keeps the header about the task, names an earlier run in the panel below, and puts the way back in the timeline header', () => {
    const onSelectRun = vi.fn();
    const context = renderInspecting(run('run-2', 2), onSelectRun);
    expect(context).toHaveTextContent('Run 1 of 2 · Completed');
    expect(context.closest('header')).toBeNull();
    // The first tier stays on the task, with the pane's controls; the run line names the run whose telemetry it shows.
    const header = screen.getByTestId('task-header-tiers');
    expect(screen.getByTestId('header-run-label')).toHaveTextContent(/^Run 1\/2 \(Completed .+\):?$/);
    expect(header).not.toHaveTextContent('Run 2/2');
    expect(screen.getByTestId('task-header-identity')).toContainElement(screen.getByRole('button', { name: 'Close pane' }));
    // The way back sits where the run was opened, in the timeline's header, not in the panel below.
    expect(within(context).queryByRole('button')).toBeNull();
    fireEvent.click(within(timelineHeader()).getByRole('button', { name: 'Back to Run 2' }));
    expect(onSelectRun).toHaveBeenCalledWith('run-2');
  });

  it('offers to return to the newest run as live while it is still working', () => {
    renderInspecting(run('run-2', 2, 'active'));
    expect(within(timelineHeader()).getByRole('button', { name: 'Return to live Run 2' })).toBeInTheDocument();
  });
});

describe('follow-up actions', () => {
  const renderPullRequestTask = (runs?: TaskRunEntry[]) => {
    loadedTaskInfo.current = { type: 'pr-comment', number: 12, repoOwner: 'integry', repoName: 'propr' };
    render(<MemoryRouter><TaskDetails taskId="pr-task" embedded runs={runs} /></MemoryRouter>);
  };
  const expectNoFollowups = () => {
    expect(screen.queryByRole('button', { name: 'Follow Up' })).toBeNull();
    expect(screen.queryByTestId('followup-commands')).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Delete task' }).length).toBeGreaterThan(0);
  };
  const mergedRun: TaskRunEntry = {
    task: { id: 'pr-task', status: 'completed', prState: 'merged', prNumber: 12, createdAt: '2026-10-01T12:00:00Z' },
    number: 1, type: 'Follow-up', summary: 'Stopped work', outcome: 'passed',
  };

  it('offers no follow-up actions when the runs record a merge and the scores read fails', async () => {
    pullRequestScores.read = 'rejects';
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    renderPullRequestTask([mergedRun]);
    await act(async () => {});
    expectNoFollowups();
  });

  it('offers no follow-up actions when the runs record a merge and the scores say the PR is open', async () => {
    renderPullRequestTask([mergedRun]);
    await act(async () => {});
    expectNoFollowups();
  });

  it('holds follow-up actions back while the pull request\'s state is loading', async () => {
    pullRequestScores.read = 'pending';
    renderPullRequestTask();
    await act(async () => {});
    expectNoFollowups();
  });

  it('holds follow-up actions back when the pull request\'s state could not be read', async () => {
    pullRequestScores.read = 'rejects';
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    renderPullRequestTask();
    await act(async () => {});
    expectNoFollowups();
  });

  it('offers a follow-up on an issue task with no pull request', () => {
    loadedTaskInfo.current = { type: 'issue', number: 42, repoOwner: 'integry', repoName: 'propr' };
    render(<MemoryRouter><TaskDetails taskId="plain-task" embedded /></MemoryRouter>);
    expect(screen.getAllByRole('button', { name: 'Follow Up' }).length).toBeGreaterThan(0);
  });

  it('keeps the follow-up retry path on a failed issue task', () => {
    loadedTaskInfo.current = { type: 'issue', number: 42, repoOwner: 'integry', repoName: 'propr', subtitle: 'Agent failed' };
    render(<MemoryRouter><TaskDetails taskId="failed-issue-task" embedded /></MemoryRouter>);
    expect(screen.getAllByRole('button', { name: 'Follow Up' }).length).toBeGreaterThan(0);
  });

  it.each([
    ['a repository report', { repoOwner: 'acme', repoName: 'web', taskKind: 'automation-report' }],
    ['a report without repositories', { repoOwner: '', repoName: '', taskKind: 'automation-report' }],
    ['an action on a report', { repoOwner: 'acme', repoName: 'web', taskKind: 'automation-action' }],
  ])('offers no GitHub follow-up on %s, which has no issue or pull request', async (_name, info) => {
    loadedTaskInfo.current = { type: 'agent-run', number: 0, title: 'Agent: Desktop acceptance', subtitle: 'Report run', issueNumber: undefined, ...info };
    render(<MemoryRouter><TaskDetails taskId="agent-run-run-1-report" embedded /></MemoryRouter>);
    await act(async () => {});
    expectNoFollowups();
  });

  it('offers a follow-up while the pull request is open', async () => {
    renderPullRequestTask();
    await act(async () => {});
    expect(screen.getAllByRole('button', { name: 'Follow Up' }).length).toBeGreaterThan(0);
    expect(screen.getAllByTestId('followup-commands').length).toBeGreaterThan(0);
  });

  it('offers no follow-up actions once the pull request has merged', async () => {
    pullRequestScores.outcome = 'merged';
    renderPullRequestTask();
    await act(async () => {});
    expectNoFollowups();
  });
});

it('disconnects timeline observers across keyed task remounts', () => {
  // observeTimeline returns ref cleanup, a React 19 API.
  expect(Number(reactVersion.split('.')[0])).toBeGreaterThanOrEqual(19);
  const observers: Array<{ observe: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }> = [];
  vi.stubGlobal('ResizeObserver', class {
    observe = vi.fn();
    disconnect = vi.fn();
    unobserve = vi.fn();
    constructor() { observers.push(this); }
  });
  const view = (id: string) => <MemoryRouter><TaskDetails key={id} taskId={id} /></MemoryRouter>;
  const { rerender, unmount } = render(view('first'));
  const timelineObserver = () => observers.find(observer => observer.observe.mock.calls.some(([node]) => node === screen.getByTestId('task-timeline-scroll')))!;
  const first = timelineObserver();
  expect(first.observe).toHaveBeenCalledWith(screen.getByTestId('task-workspace-scroll'));
  rerender(view('second'));
  expect(first.disconnect).toHaveBeenCalledOnce();
  const second = timelineObserver();
  expect(second).not.toBe(first);
  unmount();
  expect(second.disconnect).toHaveBeenCalledOnce();
  vi.unstubAllGlobals();
});

it('defers timeline positioning changes until the workspace returns to the top', () => {
  const callbacks: ResizeObserverCallback[] = [];
  vi.stubGlobal('ResizeObserver', class {
    observe = vi.fn();
    disconnect = vi.fn();
    constructor(callback: ResizeObserverCallback) { callbacks.push(callback); }
  });
  const { unmount } = render(<MemoryRouter><TaskDetails taskId="streaming" /></MemoryRouter>);
  const timeline = screen.getByTestId('task-timeline-scroll');
  const scroller = screen.getByTestId('task-workspace-scroll');
  Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 600 });
  const resize = (height: number) => {
    Object.defineProperty(timeline, 'offsetHeight', { configurable: true, value: height });
    act(() => callbacks.forEach(callback => callback([], {} as ResizeObserver)));
  };
  resize(300);
  expect(timeline.style.getPropertyValue('--timeline-position')).toBe('sticky');
  scroller.scrollTop = 100;
  resize(800);
  expect(timeline.style.getPropertyValue('--timeline-position')).toBe('sticky');
  scroller.scrollTop = 0;
  fireEvent.scroll(scroller);
  expect(timeline.style.getPropertyValue('--timeline-position')).toBe('static');
  scroller.scrollTop = 100;
  resize(300);
  expect(timeline.style.getPropertyValue('--timeline-position')).toBe('static');
  scroller.scrollTop = 0;
  fireEvent.scroll(scroller);
  expect(timeline.style.getPropertyValue('--timeline-position')).toBe('sticky');
  unmount();
  timeline.style.removeProperty('--timeline-position');
  fireEvent.scroll(scroller);
  expect(timeline.style.getPropertyValue('--timeline-position')).toBe('');
  vi.unstubAllGlobals();
});
