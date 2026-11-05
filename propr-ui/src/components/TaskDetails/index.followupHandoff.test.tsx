import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import TaskDetails from './index';
import { AuthProvider } from '../../contexts/AuthContext';
import type { CurrentUser, FollowupRunsResponse, PostFollowupResponse } from '../../api/proprTypes';
import { setDesktopConnectionScope, type DesktopConnectionScope } from '../../api/apiClient';
import { HANDOFF_POLL_MS } from './useFollowupHandoff';

const api = vi.hoisted(() => ({
  postTaskFollowup: vi.fn<(taskId: string, body: string) => Promise<PostFollowupResponse>>(),
  getTaskFollowupRuns: vi.fn<(taskId: string, commentId: number, options?: { signal?: AbortSignal }) => Promise<FollowupRunsResponse>>(),
}));
const loadedTaskIds = vi.hoisted(() => [] as Array<string | undefined>);

vi.mock('../../api/proprApi', async importOriginal => ({ ...await importOriginal<typeof import('../../api/proprApi')>(), ...api }));
vi.mock('./hooks', () => ({
  useTaskData: (taskId?: string) => {
    loadedTaskIds.push(taskId);
    return {
      loading: false, error: null,
      history: [{ id: 1, status: 'failed', timestamp: '2026-10-17T12:00:00Z', metadata: {} }],
      taskInfo: { title: 'Implement the export', repoOwner: 'acme', repoName: 'widgets', type: 'issue', number: 32,
        followupTarget: { taskId: 'failed-issue-run', repository: 'acme/widgets', kind: 'issue', number: 32 } },
      liveDetails: { todos: [], events: [] },
      usageMetricRecords: [], previewMedia: [],
      stoppingExecution: false, stopFailed: false, deletingTask: false,
      handleStopExecution: vi.fn(), handleDeleteTask: vi.fn(),
    };
  },
  usePromptData: () => ({ fetchPrompt: vi.fn(), selectedPrompt: null, loadingPrompt: false, setSelectedPrompt: vi.fn() }),
  useLogFilesData: () => ({ fetchLogFilesData: vi.fn(), logFiles: null, searchMatches: [], closeLogFiles: vi.fn() }),
}));
vi.mock('./useThinkingLog', () => ({
  useThinkingLog: () => ({ eventsCollapsed: true, collapseEvents: vi.fn(), toggleEventsCollapse: vi.fn(), thinkingLogWithTimestamps: [] }),
}));
vi.mock('./useHistoryData', () => ({
  getHistoryDerivedData: () => ({ currentStatus: 'failed', isTaskActive: false, modelName: null, prInfo: null, historyItemWithPaths: null }),
}));
vi.mock('./useDerivedTaskData', () => ({
  useTotalDuration: () => null, useCommitInfo: () => null, useConsumedReviewCommentIds: () => new Set(), useTokenUsage: () => null,
}));
vi.mock('../ui/useToast', () => ({ useToast: () => ({ addToast: vi.fn() }) }));
// The original run's own status, as its header shows it; this suite checks it never changes.
vi.mock('./ActionBar', () => ({
  default: ({ onFollowUp, currentStatus }: { onFollowUp?: () => void; currentStatus: string }) => (
    <div data-testid="source-status" data-status={currentStatus}>{onFollowUp ? <button type="button" onClick={onFollowUp}>Follow Up</button> : null}</div>
  ),
}));
vi.mock('../../api/taskStatsApi', () => ({ getPullRequestScores: vi.fn(async () => null) }));
vi.mock('./ThinkingLog', () => ({ default: () => null }));
vi.mock('./ExecutionEventLog', () => ({ default: () => null }));
vi.mock('./ResultOverview', () => ({ default: () => null }));
vi.mock('./PromptModal', () => ({ default: () => null }));
vi.mock('./LogFilesModal', () => ({ default: () => null }));
vi.mock('./ContextStrip', () => ({ default: () => null, ConsumptionGroup: () => null, MobileGitContext: () => null, MobilePeopleRuntime: () => null }));
vi.mock('./TaskHeader', async importOriginal => ({ ...await importOriginal<typeof import('./TaskHeader')>(), default: () => null }));
vi.mock('./useTaskHeadSummary', async importOriginal => ({ ...await importOriginal<typeof import('./useTaskHeadSummary')>(), useTaskHeadSummary: () => null }));
vi.mock('./ProgressBar', () => ({ default: () => null }));
vi.mock('./LeftPaneBody', () => ({ default: () => <div data-testid="source-timeline">Original failed timeline</div> }));
vi.mock('./TaskVisualPreviews', () => ({ default: () => null }));

const SOURCE = 'failed-issue-run';
const user = (id: string) => ({ id, login: `user-${id}`, permissions: [] }) as unknown as CurrentUser;
const accepted: PostFollowupResponse = {
  success: true, state: 'queued', jobId: 'issue-acme-widgets-32', posted: true, commentId: 500,
  sourceTaskId: SOURCE, intent: 'issue', issueNumber: 32, message: 'Retry queued on issue #32.',
};
const runsOf = (runs: FollowupRunsResponse['runs'], commentId = 500): FollowupRunsResponse => ({ sourceTaskId: SOURCE, commentId, runs });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

const Location = () => <div data-testid="location">{useLocation().pathname}</div>;

function renderPage({ userId = '297689653', embedded = false, onSelectRun }: { userId?: string; embedded?: boolean; onSelectRun?: (id: string) => void } = {}) {
  const tree = (id: string) => (
    <AuthProvider user={user(id)}>
      <MemoryRouter initialEntries={[`/tasks/${SOURCE}`]}>
        <Routes>
          <Route path="/tasks/:taskId" element={<><TaskDetails taskId={SOURCE} embedded={embedded} onSelectRun={onSelectRun} /><Location /></>} />
        </Routes>
      </MemoryRouter>
    </AuthProvider>
  );
  const view = render(tree(userId));
  return { ...view, switchUser: (id: string) => view.rerender(tree(id)) };
}

const flush = () => act(async () => {});
const poll = () => act(async () => { await vi.advanceTimersByTimeAsync(HANDOFF_POLL_MS); });

async function postFollowup() {
  fireEvent.click(screen.getAllByRole('button', { name: 'Follow Up' })[0]);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Post Comment' })); });
}

const banner = () => screen.queryByTestId('followup-handoff');
const expectOriginalUntouched = () => {
  for (const status of screen.getAllByTestId('source-status')) expect(status).toHaveAttribute('data-status', 'failed');
  expect(screen.getByTestId('source-timeline')).toBeInTheDocument();
  expect(new Set(loadedTaskIds)).toEqual(new Set([SOURCE]));
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  sessionStorage.clear();
  loadedTaskIds.length = 0;
  api.postTaskFollowup.mockResolvedValue(accepted);
  api.getTaskFollowupRuns.mockResolvedValue(runsOf([]));
});

afterEach(() => {
  setDesktopConnectionScope(null);
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('an accepted issue follow-up hands off to the run it started', () => {
  it('waits through delayed admission, then exposes the distinct fresh run as it runs and completes', async () => {
    renderPage();
    await flush();
    await postFollowup();
    expect(api.postTaskFollowup).toHaveBeenCalledTimes(1);

    // Accepted, but no run has started: a persistent starting state, and no link to any run yet.
    expect(banner()).toHaveAttribute('data-phase', 'starting');
    expect(banner()).toHaveTextContent('Follow-up accepted. Starting a new run…');
    expect(banner()).toHaveTextContent('issue #32');
    expect(within(banner()!).queryByRole('link')).toBeNull();
    await poll();
    await poll();
    expect(banner()).toHaveAttribute('data-phase', 'starting');
    expect(api.getTaskFollowupRuns).toHaveBeenCalledWith(SOURCE, 500, expect.anything());

    api.getTaskFollowupRuns.mockResolvedValue(runsOf([{ taskId: 'fresh-run', status: 'processing' }]));
    await poll();
    expect(banner()).toHaveAttribute('data-phase', 'started');
    expect(banner()).toHaveTextContent('A new run is working on your follow-up');
    const link = within(banner()!).getByRole('link', { name: /View new run/ });
    expect(link).toHaveAttribute('href', '/tasks/fresh-run');

    api.getTaskFollowupRuns.mockResolvedValue(runsOf([{ taskId: 'fresh-run', status: 'completed' }]));
    await poll();
    expect(banner()).toHaveTextContent('The new run completed');
    // A finished run is not looked up again, and the request is never posted again.
    const lookups = api.getTaskFollowupRuns.mock.calls.length;
    await poll();
    await poll();
    expect(api.getTaskFollowupRuns).toHaveBeenCalledTimes(lookups);
    expect(api.postTaskFollowup).toHaveBeenCalledTimes(1);

    // The page that sent it stays on the original failed run, which is still inspectable.
    expect(screen.getByTestId('location')).toHaveTextContent(`/tasks/${SOURCE}`);
    expectOriginalUntouched();
    // No implementation IDs reach the visible text.
    expect(banner()!.textContent).not.toMatch(/fresh-run|500|issue-acme/);

    fireEvent.click(within(banner()!).getByRole('link', { name: /View new run/ }));
    expect(screen.getByTestId('location')).toHaveTextContent('/tasks/fresh-run');
  });

  it('opens the new run in the task-list pane through its run selection', async () => {
    const onSelectRun = vi.fn();
    api.getTaskFollowupRuns.mockResolvedValue(runsOf([{ taskId: 'fresh-run', status: 'processing' }]));
    renderPage({ embedded: true, onSelectRun });
    await flush();
    await postFollowup();
    await flush();
    fireEvent.click(within(banner()!).getByRole('link', { name: /View new run/ }));
    expect(onSelectRun).toHaveBeenCalledWith('fresh-run');
    expect(screen.getByTestId('location')).toHaveTextContent(`/tasks/${SOURCE}`);
  });

  it('survives a reload and keeps waiting for the same request, without posting it again', async () => {
    const first = renderPage();
    await flush();
    await postFollowup();
    first.unmount();

    api.getTaskFollowupRuns.mockClear();
    renderPage();
    await flush();
    expect(banner()).toHaveAttribute('data-phase', 'starting');
    expect(api.getTaskFollowupRuns).toHaveBeenCalledWith(SOURCE, 500, expect.anything());
    expect(api.postTaskFollowup).toHaveBeenCalledTimes(1);
  });

  it('keeps waiting through a failed lookup and looks again when the connection returns', async () => {
    renderPage();
    await flush();
    api.getTaskFollowupRuns.mockRejectedValueOnce(new Error('offline'));
    await postFollowup();
    await flush();
    expect(banner()).toHaveAttribute('data-phase', 'starting');
    api.getTaskFollowupRuns.mockResolvedValue(runsOf([{ taskId: 'fresh-run', status: 'processing' }]));
    await act(async () => { window.dispatchEvent(new Event('online')); });
    expect(banner()).toHaveAttribute('data-phase', 'started');
  });

  it('ignores a lookup that answers for another request or names the original run', async () => {
    renderPage();
    await flush();
    api.getTaskFollowupRuns.mockResolvedValue(runsOf([{ taskId: 'someone-elses-run', status: 'processing' }], 501));
    await postFollowup();
    await poll();
    api.getTaskFollowupRuns.mockResolvedValue(runsOf([{ taskId: SOURCE, status: 'failed' }]));
    await poll();
    expect(banner()).toHaveAttribute('data-phase', 'starting');
    expect(within(banner()!).queryByRole('link')).toBeNull();
  });

  it('can be dismissed', async () => {
    renderPage();
    await flush();
    await postFollowup();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss follow-up status' }));
    expect(banner()).toBeNull();
    await poll();
    expect(banner()).toBeNull();
  });
});

describe('only an accepted issue retry is presented as a new run', () => {
  it.each([
    ['an unconfirmed submission', { ...accepted, success: false, state: 'unknown', message: 'Comment posted, but submission could not be confirmed.' }],
    ['a refused restart', { ...accepted, success: false, state: 'refused', posted: false, message: 'Your new message was not posted.' }],
    ['a retry that could not start', { ...accepted, success: false, state: 'failed', message: 'Comment posted, but the retry could not be started.' }],
  ] as const)('%s keeps its receipt feedback and shows no new run', async (_name, receipt) => {
    api.postTaskFollowup.mockResolvedValue(receipt as PostFollowupResponse);
    renderPage();
    await flush();
    await postFollowup();
    expect(screen.getByTestId('followup-feedback')).toHaveTextContent(receipt.message);
    expect(banner()).toBeNull();
    await poll();
    expect(api.getTaskFollowupRuns).not.toHaveBeenCalled();
    // Duplicate protection: a possibly posted comment cannot be sent again unedited.
    if (receipt.posted) expect(screen.getByRole('button', { name: 'Post Comment' })).toBeDisabled();
  });

  it('a pull request follow-up is not an issue retry', async () => {
    api.postTaskFollowup.mockResolvedValue({ success: true, state: 'queued', posted: true, commentId: 77, sourceTaskId: SOURCE, jobId: 'pr-comments-batch' });
    renderPage();
    await flush();
    await postFollowup();
    expect(banner()).toBeNull();
    expect(api.getTaskFollowupRuns).not.toHaveBeenCalled();
  });
});

describe('a handoff never crosses an account or instance switch', () => {
  it('drops an acceptance that lands after the account changed', async () => {
    const pending = deferred<PostFollowupResponse>();
    api.postTaskFollowup.mockReturnValue(pending.promise);
    const page = renderPage({ userId: '297689653' });
    await flush();
    fireEvent.click(screen.getAllByRole('button', { name: 'Follow Up' })[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Post Comment' }));
    page.switchUser('42');
    await act(async () => { pending.resolve(accepted); });
    expect(banner()).toBeNull();
    page.switchUser('297689653');
    await flush();
    expect(banner()).toBeNull();
    expect(api.getTaskFollowupRuns).not.toHaveBeenCalled();
  });

  it('applies no lookup that answers after the account changed, and shows another account nothing', async () => {
    const page = renderPage({ userId: '297689653' });
    await flush();
    await postFollowup();
    const lookup = deferred<FollowupRunsResponse>();
    api.getTaskFollowupRuns.mockReturnValue(lookup.promise);
    await poll();
    page.switchUser('42');
    await act(async () => { lookup.resolve(runsOf([{ taskId: 'fresh-run', status: 'completed' }])); });
    expect(banner()).toBeNull();

    api.getTaskFollowupRuns.mockResolvedValue(runsOf([]));
    page.switchUser('297689653');
    await flush();
    expect(banner()).toHaveAttribute('data-phase', 'starting');
  });

  it('keeps a desktop instance’s handoff on that instance', async () => {
    const scope = (profileId: string) => ({ bridge: {} as DesktopConnectionScope['bridge'], profileId, transportScope: `${profileId}-transport` });
    act(() => setDesktopConnectionScope(scope('instance-a')));
    renderPage();
    await flush();
    await postFollowup();
    expect(banner()).toHaveAttribute('data-phase', 'starting');

    const lookup = deferred<FollowupRunsResponse>();
    api.getTaskFollowupRuns.mockReturnValue(lookup.promise);
    await poll();
    act(() => setDesktopConnectionScope(scope('instance-b')));
    await act(async () => { lookup.resolve(runsOf([{ taskId: 'fresh-run', status: 'completed' }])); });
    expect(banner()).toBeNull();

    api.getTaskFollowupRuns.mockResolvedValue(runsOf([]));
    act(() => setDesktopConnectionScope(scope('instance-a')));
    await flush();
    expect(banner()).toHaveAttribute('data-phase', 'starting');
  });
});
