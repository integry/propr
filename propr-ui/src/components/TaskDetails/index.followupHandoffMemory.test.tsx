import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, within } from '@testing-library/react';
import type { FollowupRunsResponse, PostFollowupResponse } from '../../api/proprTypes';
import { API_BASE_URL, setDesktopConnectionScope } from '../../api/apiClient';
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

describe('without session storage the handoff lasts as long as the page', () => {
  it('keeps the request in memory on the mounted view when storage refuses it', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('QuotaExceededError'); });
    try {
      renderPage();
      await flush();
      await postFollowup();
      expect(handoffKeys()).toHaveLength(0);
      expect(banner()).toHaveAttribute('data-phase', 'starting');

      api.getTaskFollowupRuns.mockResolvedValue(runsOf([{ taskId: 'fresh-run', status: 'processing' }]));
      await poll();
      expect(within(banner()!).getByRole('link', { name: /View new run/ })).toHaveAttribute('href', '/tasks/fresh-run');
      expect(api.postTaskFollowup).toHaveBeenCalledTimes(1);
    } finally {
      setItem.mockRestore();
    }
  });

  // Only handoff writes fail, as with full storage; the desktop's own clearing still succeeds.
  const refuseHandoffWrites = () => {
    const original = Storage.prototype.setItem;
    return vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (key.startsWith('propr.followupHandoff.v1')) throw new Error('QuotaExceededError');
      original.call(this, key, value);
    });
  };

  it('drops a starting request held in memory when the same profile’s credentials are replaced, and never looks it up or writes it back', async () => {
    const setItem = refuseHandoffWrites();
    try {
      const desktop = desktopConnection();
      await desktop.connect('first-transport-generation');
      renderPage();
      await flush();
      await postFollowup();
      expect(handoffKeys()).toHaveLength(0);
      expect(banner()).toHaveAttribute('data-phase', 'starting');

      await desktop.disconnect();
      setItem.mockRestore();
      api.getTaskFollowupRuns.mockClear();
      api.getTaskFollowupRuns.mockResolvedValue(runsOf([{ taskId: 'fresh-run', status: 'processing' }]));
      await desktop.connect('replaced-identity-generation', storedProfile, 'BBBBBBBBBBBBBBBBBBBBBB');
      await flush();
      expect(banner()).toBeNull();

      await poll();
      expect(banner()).toBeNull();
      expect(handoffKeys()).toHaveLength(0);
      expect(api.getTaskFollowupRuns).not.toHaveBeenCalled();
      expect(api.postTaskFollowup).toHaveBeenCalledTimes(1);
    } finally {
      setItem.mockRestore();
    }
  });

  it('drops a run link held in memory when the same profile’s credentials are replaced', async () => {
    const setItem = refuseHandoffWrites();
    try {
      const desktop = desktopConnection();
      await desktop.connect('first-transport-generation');
      renderPage();
      await flush();
      api.getTaskFollowupRuns.mockResolvedValue(runsOf([{ taskId: 'fresh-run', status: 'completed' }]));
      await postFollowup();
      await flush();
      expect(handoffKeys()).toHaveLength(0);
      expect(within(banner()!).getByRole('link', { name: /View new run/ })).toHaveAttribute('href', '/tasks/fresh-run');

      await desktop.disconnect();
      await desktop.connect('replaced-identity-generation', storedProfile, 'BBBBBBBBBBBBBBBBBBBBBB');
      await flush();
      expect(banner()).toBeNull();
      expect(screen.queryByRole('link', { name: /View new run/ })).toBeNull();
      expect(handoffKeys()).toHaveLength(0);
    } finally {
      setItem.mockRestore();
    }
  });
});

describe('a request storage refused follows the identity, as a stored one does', () => {
  const REPLACED_IDENTITY = 'BBBBBBBBBBBBBBBBBBBBBB';
  // Every session storage write fails while the follow-up is accepted, as with full storage.
  async function acceptWhileStorageRefuses() {
    const desktop = desktopConnection();
    await desktop.connect('first-transport-generation');
    renderPage();
    await flush();
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('QuotaExceededError'); });
    try {
      await postFollowup();
    } finally {
      setItem.mockRestore();
    }
    expect(handoffKeys()).toHaveLength(0);
    expect(banner()).toHaveAttribute('data-phase', 'starting');
    await desktop.disconnect();
    api.getTaskFollowupRuns.mockClear();
    return desktop;
  }

  it('keeps the request on the mounted view across a renewal of the same identity and follows it without posting again', async () => {
    const desktop = await acceptWhileStorageRefuses();
    await desktop.connect('reconnected-transport-generation');
    await flush();
    expect(banner()).toHaveAttribute('data-phase', 'starting');
    expect(api.getTaskFollowupRuns).toHaveBeenCalledWith(SOURCE, 500, expect.anything());

    api.getTaskFollowupRuns.mockResolvedValue(runsOf([{ taskId: 'fresh-run', status: 'processing' }]));
    await poll();
    expect(within(banner()!).getByRole('link', { name: /View new run/ })).toHaveAttribute('href', '/tasks/fresh-run');
    expect(api.postTaskFollowup).toHaveBeenCalledTimes(1);
    expectOriginalUntouched(loadedTaskIds);
  });

  it('drops the request when the same profile’s credential is replaced', async () => {
    const desktop = await acceptWhileStorageRefuses();
    await desktop.connect('replaced-identity-generation', storedProfile, REPLACED_IDENTITY);
    await flush();
    expect(banner()).toBeNull();
    await poll();
    expect(banner()).toBeNull();
    expect(handoffKeys()).toHaveLength(0);
    expect(api.getTaskFollowupRuns).not.toHaveBeenCalled();
    expect(api.postTaskFollowup).toHaveBeenCalledTimes(1);
  });

  it('does not apply a lookup that lands after a replacement cleared the renderer but before the new connection is published', async () => {
    const desktop = desktopConnection();
    await desktop.connect('first-transport-generation');
    renderPage();
    await flush();
    await postFollowup();
    const late = deferred<FollowupRunsResponse>();
    api.getTaskFollowupRuns.mockReturnValue(late.promise);
    await poll();

    const publish = await desktop.activate('replaced-identity-generation', storedProfile, REPLACED_IDENTITY);
    await act(async () => { late.resolve(runsOf([{ taskId: 'stale-run', status: 'completed' }])); });
    expect(banner()).toBeNull();
    expect(handoffKeys()).toHaveLength(0);
    await publish();
    await flush();
    expect(banner()).toBeNull();
    expect(handoffKeys()).toHaveLength(0);
  });

  it('does not adopt an acceptance that lands after a replacement cleared the renderer but before the new connection is published', async () => {
    const desktop = desktopConnection();
    await desktop.connect('first-transport-generation');
    renderPage();
    await flush();
    const pending = deferred<PostFollowupResponse>();
    api.postTaskFollowup.mockReturnValue(pending.promise);
    fireEvent.click(screen.getAllByRole('button', { name: 'Follow Up' })[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Post Comment' }));

    const publish = await desktop.activate('replaced-identity-generation', storedProfile, REPLACED_IDENTITY);
    await act(async () => { pending.resolve(accepted); });
    await publish();
    await poll();
    expect(banner()).toBeNull();
    expect(handoffKeys()).toHaveLength(0);
    expect(api.getTaskFollowupRuns).not.toHaveBeenCalled();
  });
});

describe('a request storage refused keeps the stored retention boundary across task views', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  let clock: { mockRestore(): void } | undefined;
  afterEach(() => clock?.mockRestore());
  // Every session storage write fails while the follow-up is accepted; the view is then left.
  async function acceptAndLeave(acceptedAt: number) {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('QuotaExceededError'); });
    const now = vi.spyOn(Date, 'now').mockReturnValue(acceptedAt);
    try {
      const view = renderPage();
      await flush();
      await postFollowup();
      expect(handoffKeys()).toHaveLength(0);
      expect(banner()).toHaveAttribute('data-phase', 'starting');
      view.unmount();
    } finally {
      setItem.mockRestore();
    }
    api.getTaskFollowupRuns.mockClear();
    clock = now;
    return now;
  }

  it('restores it on returning to the task within the retention period', async () => {
    const acceptedAt = Date.UTC(2026, 9, 18, 9);
    const now = await acceptAndLeave(acceptedAt);
    now.mockReturnValue(acceptedAt + DAY_MS - 60_000);
    renderPage();
    await flush();
    expect(banner()).toHaveAttribute('data-phase', 'starting');
    expect(api.getTaskFollowupRuns).toHaveBeenCalledWith(SOURCE, 500, expect.anything());
    expect(api.postTaskFollowup).toHaveBeenCalledTimes(1);
  });

  it('forgets it once expired, showing no banner and looking nothing up', async () => {
    const acceptedAt = Date.UTC(2026, 9, 18, 9);
    const now = await acceptAndLeave(acceptedAt);
    now.mockReturnValue(acceptedAt + DAY_MS + 60_000);
    const view = renderPage();
    await flush();
    expect(banner()).toBeNull();
    await poll();
    expect(banner()).toBeNull();
    expect(api.getTaskFollowupRuns).not.toHaveBeenCalled();
    view.unmount();

    // It was removed, not merely hidden: nothing comes back even if the clock reads earlier again.
    now.mockReturnValue(acceptedAt + 60_000);
    renderPage();
    await flush();
    expect(banner()).toBeNull();
    expect(api.getTaskFollowupRuns).not.toHaveBeenCalled();
    expect(api.postTaskFollowup).toHaveBeenCalledTimes(1);
  });
});
