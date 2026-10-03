import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import TaskDetails from './index';

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
vi.mock('./ContextStrip', () => ({ default: () => null }));
vi.mock('./TaskHeader', () => ({ default: () => null }));
vi.mock('./ProgressBar', () => ({ default: () => null }));
vi.mock('./LeftPaneBody', () => ({ default: () => null }));
vi.mock('./SectionLabelHeader', () => ({ default: () => null }));
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

    await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: 'Delete task' })[0]); });
    expect(handleDeleteTask).toHaveBeenCalled();
    expect(onDeleted).toHaveBeenCalledTimes(1);
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
});
