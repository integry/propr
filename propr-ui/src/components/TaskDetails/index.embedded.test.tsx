import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import TaskDetails from './index';
import type { TaskRunEntry } from '../TaskList/rowModel';

const handleDeleteTask = vi.fn(async () => true);
const loadedTaskIds: Array<string | undefined> = [];

vi.mock('./hooks', () => ({
  useTaskData: (taskId?: string) => {
    loadedTaskIds.push(taskId);
    return {
      loading: false, error: null,
      history: [{ id: 1, status: 'completed', timestamp: '2026-10-01T12:00:00Z', metadata: {} }],
      taskInfo: { title: 'Fix PR #12: Stop work', issueNumber: 12 },
      liveDetails: { todos: [], events: [] },
      usageMetricRecords: [], previewMedia: [],
      stoppingExecution: false, stopFailed: false, deletingTask: false,
      handleStopExecution: vi.fn(), handleDeleteTask,
    };
  },
  usePromptData: () => ({ fetchPrompt: vi.fn(), selectedPrompt: null, loadingPrompt: false, setSelectedPrompt: vi.fn() }),
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
  default: ({ onDeleteTask }: { onDeleteTask: () => void }) => <button type="button" onClick={onDeleteTask}>Delete task</button>,
}));
// Children have their own suites; this one is about the details shell.
vi.mock('./ThinkingLog', () => ({ default: () => null }));
vi.mock('./ExecutionEventLog', () => ({ default: () => null }));
vi.mock('./ResultOverview', () => ({ default: () => null }));
vi.mock('./PromptModal', () => ({ default: () => null }));
vi.mock('./LogFilesModal', () => ({ default: () => null }));
vi.mock('./FollowupModal', () => ({ default: () => null }));
vi.mock('./ContextStrip', () => ({ default: ({ lead }: { lead?: React.ReactNode }) => <>{lead}</> }));
vi.mock('./TaskHeader', async importOriginal => ({ ...await importOriginal<typeof import('./TaskHeader')>(), default: () => null }));
// The newest run is read from the API in its own suite.
vi.mock('./useTaskHeadSummary', async importOriginal => ({ ...await importOriginal<typeof import('./useTaskHeadSummary')>(), useTaskHeadSummary: () => null }));
vi.mock('./ProgressBar', () => ({ default: () => null }));
vi.mock('./LeftPaneBody', () => ({ default: () => null }));
vi.mock('./TaskVisualPreviews', () => ({ default: () => null }));

const LocationProbe = () => <output data-testid="location">{useLocation().pathname}</output>;

afterEach(() => {
  vi.clearAllMocks();
  loadedTaskIds.length = 0;
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
    expect(screen.getByTestId('task-workspace-scroll').className).not.toContain('lg:flex-row');
    expect(screen.getByTestId('task-timeline-scroll').className).not.toContain('lg:w-[30%]');
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
    expect(screen.getByTestId('task-workspace-scroll').className).toContain('lg:flex-row');
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
