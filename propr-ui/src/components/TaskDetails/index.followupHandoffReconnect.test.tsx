import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, within } from '@testing-library/react';
import type { FollowupRunsResponse, PostFollowupResponse } from '../../api/proprTypes';
import { API_BASE_URL, getDesktopConnectionScope, setDesktopConnectionScope } from '../../api/apiClient';
import { storedProfile } from '../../desktop/electronAdapters.test-fixture';
import {
  SOURCE, accepted, banner, deferred, desktopConnection, expectOriginalUntouched, flush, handoffKeys, poll, postFollowup, renderPage, runsOf,
} from './index.followupHandoffReconnect.testSupport';

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

const initialBaseUrl = API_BASE_URL;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  sessionStorage.clear();
  loadedTaskIds.length = 0;
  api.postTaskFollowup.mockResolvedValue(accepted);
  api.getTaskFollowupRuns.mockResolvedValue(runsOf([]));
});

afterEach(() => {
  setDesktopConnectionScope(null, initialBaseUrl);
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('an accepted issue follow-up survives a same-profile desktop reconnect', () => {
  it('restores the request on the remounted task view and follows it to the new run without posting again', async () => {
    const desktop = desktopConnection();
    await desktop.connect('first-transport-generation');
    const first = renderPage();
    await flush();
    await postFollowup();
    expect(banner()).toHaveAttribute('data-phase', 'starting');
    first.unmount();

    await desktop.disconnect();
    await desktop.connect('reconnected-transport-generation');
    expect(getDesktopConnectionScope()?.transportScope).toBe('reconnected-transport-generation');
    expect(handoffKeys()).toHaveLength(1);
    // The remembered request carries no transport generation, so it outlives the one it was sent on.
    expect(handoffKeys()[0]).not.toContain('first-transport-generation');

    api.getTaskFollowupRuns.mockClear();
    renderPage();
    await flush();
    expect(banner()).toHaveAttribute('data-phase', 'starting');
    expect(api.getTaskFollowupRuns).toHaveBeenCalledWith(SOURCE, 500, expect.anything());

    // Admission is delayed: still starting, with no run guessed.
    await poll();
    expect(banner()).toHaveAttribute('data-phase', 'starting');
    expect(within(banner()!).queryByRole('link')).toBeNull();

    api.getTaskFollowupRuns.mockResolvedValue(runsOf([{ taskId: 'fresh-run', status: 'processing' }]));
    await poll();
    expect(banner()).toHaveTextContent('A new run is working on your follow-up');
    expect(within(banner()!).getByRole('link', { name: /View new run/ })).toHaveAttribute('href', '/tasks/fresh-run');

    api.getTaskFollowupRuns.mockResolvedValue(runsOf([{ taskId: 'fresh-run', status: 'completed' }]));
    await poll();
    expect(banner()).toHaveTextContent('The new run completed');
    expect(within(banner()!).getByRole('link', { name: /View new run/ })).toBeInTheDocument();
    expect(api.postTaskFollowup).toHaveBeenCalledTimes(1);
    expectOriginalUntouched(loadedTaskIds);
  });

  it('keeps the started run across a reconnect while the view stays mounted', async () => {
    const desktop = desktopConnection();
    await desktop.connect('first-transport-generation');
    renderPage();
    await flush();
    api.getTaskFollowupRuns.mockResolvedValue(runsOf([{ taskId: 'fresh-run', status: 'processing' }]));
    await postFollowup();
    await flush();
    expect(banner()).toHaveAttribute('data-phase', 'started');

    await desktop.disconnect();
    await desktop.connect('reconnected-transport-generation');
    await flush();
    expect(banner()).toHaveAttribute('data-phase', 'started');
    expect(within(banner()!).getByRole('link', { name: /View new run/ })).toHaveAttribute('href', '/tasks/fresh-run');
    expect(api.postTaskFollowup).toHaveBeenCalledTimes(1);
  });
});

describe('a same-profile credential replacement clears the handoff for good', () => {
  const REPLACED_IDENTITY = 'BBBBBBBBBBBBBBBBBBBBBB';

  it('does not bring back a cleared starting handoff on the mounted view, nor write it back by looking it up', async () => {
    const desktop = desktopConnection();
    await desktop.connect('first-transport-generation');
    renderPage();
    await flush();
    await postFollowup();
    expect(banner()).toHaveAttribute('data-phase', 'starting');

    await desktop.disconnect();
    api.getTaskFollowupRuns.mockClear();
    api.getTaskFollowupRuns.mockResolvedValue(runsOf([{ taskId: 'fresh-run', status: 'processing' }]));
    await desktop.connect('replaced-identity-generation', storedProfile, REPLACED_IDENTITY);
    await flush();
    expect(banner()).toBeNull();
    expect(handoffKeys()).toHaveLength(0);

    await poll();
    expect(banner()).toBeNull();
    expect(handoffKeys()).toHaveLength(0);
    expect(api.getTaskFollowupRuns).not.toHaveBeenCalled();
    expect(api.postTaskFollowup).toHaveBeenCalledTimes(1);
  });

  it('does not bring back the cleared run link on the mounted view', async () => {
    const desktop = desktopConnection();
    await desktop.connect('first-transport-generation');
    renderPage();
    await flush();
    api.getTaskFollowupRuns.mockResolvedValue(runsOf([{ taskId: 'fresh-run', status: 'completed' }]));
    await postFollowup();
    await flush();
    expect(within(banner()!).getByRole('link', { name: /View new run/ })).toHaveAttribute('href', '/tasks/fresh-run');

    await desktop.disconnect();
    await desktop.connect('replaced-identity-generation', storedProfile, REPLACED_IDENTITY);
    await flush();
    expect(banner()).toBeNull();
    expect(screen.queryByRole('link', { name: /View new run/ })).toBeNull();
    expect(handoffKeys()).toHaveLength(0);
  });
});

describe('a response from a connection that is gone is never applied', () => {
  it('drops a lookup from the old generation that lands after a same-profile renewal, then looks again on the new one', async () => {
    const desktop = desktopConnection();
    await desktop.connect('first-transport-generation');
    renderPage();
    await flush();
    await postFollowup();
    const late = deferred<FollowupRunsResponse>();
    api.getTaskFollowupRuns.mockReturnValue(late.promise);
    await poll();

    await desktop.disconnect();
    api.getTaskFollowupRuns.mockResolvedValue(runsOf([]));
    await desktop.connect('reconnected-transport-generation');
    await act(async () => { late.resolve(runsOf([{ taskId: 'stale-run', status: 'completed' }])); });
    expect(banner()).toHaveAttribute('data-phase', 'starting');
    expect(within(banner()!).queryByRole('link')).toBeNull();

    api.getTaskFollowupRuns.mockResolvedValue(runsOf([{ taskId: 'fresh-run', status: 'processing' }]));
    await poll();
    expect(within(banner()!).getByRole('link', { name: /View new run/ })).toHaveAttribute('href', '/tasks/fresh-run');
  });

  it('does not adopt an acceptance from the old generation that lands after a same-profile renewal', async () => {
    const desktop = desktopConnection();
    await desktop.connect('first-transport-generation');
    renderPage();
    await flush();
    const pending = deferred<PostFollowupResponse>();
    api.postTaskFollowup.mockReturnValue(pending.promise);
    fireEvent.click(screen.getAllByRole('button', { name: 'Follow Up' })[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Post Comment' }));

    await desktop.disconnect();
    await desktop.connect('reconnected-transport-generation');
    await act(async () => { pending.resolve(accepted); });
    expect(banner()).toBeNull();
    expect(handoffKeys()).toHaveLength(0);
    await poll();
    expect(api.getTaskFollowupRuns).not.toHaveBeenCalled();
    expect(api.postTaskFollowup).toHaveBeenCalledTimes(1);
  });

  it('drops a late lookup after a switch to another profile, which sees nothing of the handoff', async () => {
    const desktop = desktopConnection();
    await desktop.connect('first-transport-generation');
    renderPage();
    await flush();
    await postFollowup();
    const late = deferred<FollowupRunsResponse>();
    api.getTaskFollowupRuns.mockReturnValue(late.promise);
    await poll();

    await desktop.disconnect();
    api.getTaskFollowupRuns.mockResolvedValue(runsOf([]));
    await desktop.connect('second-profile-generation', desktop.otherProfile);
    await act(async () => { late.resolve(runsOf([{ taskId: 'fresh-run', status: 'completed' }])); });
    expect(banner()).toBeNull();
    // Switching profiles still clears this renderer's state, the handoff included.
    expect(handoffKeys()).toHaveLength(0);
    // Nothing is looked up for the other profile: only the two lookups made before the switch.
    await poll();
    expect(api.getTaskFollowupRuns).toHaveBeenCalledTimes(2);
  });
});

describe('the remembered request stays with its account, instance and endpoint', () => {
  const scope = (profileId: string, transportScope: string) => ({ bridge: {} as never, profileId, transportScope });

  it('shows the same profile’s handoff to neither another endpoint nor another account', async () => {
    act(() => setDesktopConnectionScope(scope('instance-a', 'first-transport-generation'), 'https://one.propr.example.test'));
    const first = renderPage();
    await flush();
    await postFollowup();
    first.unmount();

    act(() => setDesktopConnectionScope(scope('instance-a', 'second-transport-generation'), 'https://two.propr.example.test'));
    const otherEndpoint = renderPage();
    await flush();
    expect(banner()).toBeNull();
    otherEndpoint.unmount();

    act(() => setDesktopConnectionScope(scope('instance-a', 'third-transport-generation'), 'https://one.propr.example.test'));
    const otherAccount = renderPage('42');
    await flush();
    expect(banner()).toBeNull();
    otherAccount.unmount();
    expect(api.getTaskFollowupRuns).toHaveBeenCalledTimes(1);

    renderPage();
    await flush();
    expect(banner()).toHaveAttribute('data-phase', 'starting');
    expect(api.postTaskFollowup).toHaveBeenCalledTimes(1);
  });
});
