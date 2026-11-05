import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import TaskDetails from './index';
import { AuthProvider } from '../../contexts/AuthContext';
import type { CurrentUser, FollowupRunsResponse, PostFollowupResponse } from '../../api/proprTypes';
import { API_BASE_URL, setDesktopConnectionScope } from '../../api/apiClient';
import type { DesktopNativeCommandDelivery, DesktopProfile as StoredProfile } from '../../../../apps/desktop/src/shared/contract';
import { DesktopExperience } from '../../desktop/DesktopExperience';
import { createElectronDesktopAdapters } from '../../desktop/electronAdapters';
import { bridgeFixture, storedProfile } from '../../desktop/electronAdapters.test-fixture';
import { getRendererProfileStateGeneration } from '../../desktop/rendererProfileState';
import { SOURCE, USER_ID, accepted, banner, deferred, handoffKeys, poll, postFollowup, runsOf } from './index.followupHandoffReconnect.testSupport';

const api = vi.hoisted(() => ({
  postTaskFollowup: vi.fn<(taskId: string, body: string) => Promise<PostFollowupResponse>>(),
  getTaskFollowupRuns: vi.fn<(taskId: string, commentId: number, options?: { signal?: AbortSignal }) => Promise<FollowupRunsResponse>>(),
}));

vi.mock('../../api/proprApi', async importOriginal => ({ ...await importOriginal<typeof import('../../api/proprApi')>(), ...api }));
vi.mock('./hooks', () => ({
  useTaskData: () => ({
    loading: false, error: null,
    history: [{ id: 1, status: 'failed', timestamp: '2026-10-17T12:00:00Z', metadata: {} }],
    taskInfo: { title: 'Implement the export', repoOwner: 'acme', repoName: 'widgets', type: 'issue', number: 32,
      followupTarget: { taskId: 'failed-issue-run', repository: 'acme/widgets', kind: 'issue', number: 32 } },
    liveDetails: { todos: [], events: [] },
    usageMetricRecords: [], previewMedia: [],
    stoppingExecution: false, stopFailed: false, deletingTask: false,
    handleStopExecution: vi.fn(), handleDeleteTask: vi.fn(),
  }),
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
vi.mock('./ActionBar', () => ({
  default: ({ onFollowUp }: { onFollowUp?: () => void }) => (onFollowUp ? <button type="button" onClick={onFollowUp}>Follow Up</button> : null),
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
vi.mock('./LeftPaneBody', () => ({ default: () => null }));
vi.mock('./TaskVisualPreviews', () => ({ default: () => null }));

const EPOCH_A = 'AAAAAAAAAAAAAAAAAAAAAA';
const EPOCH_B = 'BBBBBBBBBBBBBBBBBBBBBB';
const secondProfile: StoredProfile = { ...storedProfile, id: 'profile-2', label: 'Second server', apiBaseUrl: 'https://second.example.test' };
const initialBaseUrl = API_BASE_URL;

/**
 * The actual consumer: DesktopExperience over the real Electron adapters, with
 * TaskDetails as its connected view. Only main's IPC bridge is mocked: probing
 * issues a ticket, and activation commits the profile as main's active one and
 * returns a new transport each time with the profile's current credential epoch.
 */
async function renderDesktop() {
  const fixture = bridgeFixture();
  await fixture.bridge.profiles.save(secondProfile);
  await fixture.bridge.profiles.setActive(storedProfile.id);
  const epochs = new Map<string, string>();
  let transports = 0;
  const activate = vi.fn(async (ticket: string) => {
    const profileId = ticket.slice('ticket-'.length);
    await fixture.bridge.profiles.setActive(profileId);
    return { status: 'ready' as const, profileId, transportScope: `transport${++transports}`, identityEpoch: epochs.get(profileId) ?? EPOCH_A };
  });
  fixture.bridge.connection.probe = async profile => ({ status: 'ready', version: '0.8.15', activationTicket: `ticket-${profile.id}` });
  fixture.bridge.connection.activate = activate;
  let command: ((delivery: DesktopNativeCommandDelivery) => void) | undefined;
  fixture.bridge.app.onNativeCommand = listener => { command = listener; return () => { command = undefined; }; };
  const user = { id: USER_ID, login: `user-${USER_ID}`, permissions: [] } as unknown as CurrentUser;
  render(
    <AuthProvider user={user}>
      <MemoryRouter initialEntries={[`/tasks/${SOURCE}`]}>
        <DesktopExperience adapters={createElectronDesktopAdapters(fixture.bridge)}>
          <Routes><Route path="/tasks/:taskId" element={<TaskDetails taskId={SOURCE} />} /></Routes>
        </DesktopExperience>
      </MemoryRouter>
    </AuthProvider>,
  );
  await settle();
  expect(activate).toHaveBeenCalledTimes(1);
  expect(screen.getAllByRole('button', { name: 'Follow Up' }).length).toBeGreaterThan(0);
  const manage = () => act(() => command!({ command: 'manage-instances', connectionScope: null }));
  return { activate, epochs, manage };
}

async function settle() {
  for (let round = 0; round < 20; round += 1) await act(async () => {});
}

/** The ordinary reconnect shortcut, as the connected window receives it. */
async function reconnect() {
  fireEvent.keyDown(document, { key: 'R', ctrlKey: true, shiftKey: true });
  await settle();
}

// Only handoff writes fail, as with full storage; the desktop's own clearing still succeeds.
const refuseHandoffWrites = () => {
  const original = Storage.prototype.setItem;
  return vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
    if (key.startsWith('propr.followupHandoff.v1')) throw new Error('QuotaExceededError');
    original.call(this, key, value);
  });
};

/** A saved profile's Connect entry in the instance manager. */
const connectButton = (label: string) => screen.getAllByRole('button', { name: new RegExp(label) })
  .find(button => button.classList.contains('desktop-profile-connect'))!;

interface StorageMode {
  name: string;
  constrain(): { mockRestore(): void } | undefined;
  receipts: number;
}
const storageModes: StorageMode[] = [
  { name: 'stored in session storage', constrain: () => undefined, receipts: 1 },
  { name: 'held in page memory because storage refused it', constrain: refuseHandoffWrites, receipts: 0 },
];

const viewNewRun = () => within(banner()!).getByRole('link', { name: /View new run/ });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  sessionStorage.clear();
  localStorage.clear();
  api.postTaskFollowup.mockResolvedValue(accepted);
  api.getTaskFollowupRuns.mockResolvedValue(runsOf([]));
});

afterEach(() => {
  setDesktopConnectionScope(null, initialBaseUrl);
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe.each(storageModes)('an accepted follow-up $name survives the Desktop reconnect of the same identity', ({ constrain: constrainStorage, receipts }) => {
  it('keeps the starting banner and continues the read-only lookup without posting again', async () => {
    const storage = constrainStorage();
    const desktop = await renderDesktop();
    await postFollowup();
    expect(banner()).toHaveAttribute('data-phase', 'starting');
    expect(handoffKeys()).toHaveLength(receipts);
    const generation = getRendererProfileStateGeneration();

    api.getTaskFollowupRuns.mockClear();
    await reconnect();
    expect(desktop.activate).toHaveBeenCalledTimes(2);
    expect(getRendererProfileStateGeneration()).toBe(generation);
    expect(handoffKeys()).toHaveLength(receipts);
    expect(banner()).toHaveAttribute('data-phase', 'starting');
    expect(api.getTaskFollowupRuns).toHaveBeenCalledWith(SOURCE, 500, expect.anything());

    api.getTaskFollowupRuns.mockResolvedValue(runsOf([{ taskId: 'fresh-run', status: 'processing' }]));
    await poll();
    expect(viewNewRun()).toHaveAttribute('href', '/tasks/fresh-run');
    expect(api.postTaskFollowup).toHaveBeenCalledTimes(1);
    storage?.mockRestore();
  });

  it('keeps the View new run link of a finished run without looking it up again', async () => {
    const storage = constrainStorage();
    const desktop = await renderDesktop();
    api.getTaskFollowupRuns.mockResolvedValue(runsOf([{ taskId: 'fresh-run', status: 'completed' }]));
    await postFollowup();
    await settle();
    expect(viewNewRun()).toHaveAttribute('href', '/tasks/fresh-run');

    api.getTaskFollowupRuns.mockClear();
    await reconnect();
    expect(desktop.activate).toHaveBeenCalledTimes(2);
    expect(viewNewRun()).toHaveAttribute('href', '/tasks/fresh-run');
    expect(handoffKeys()).toHaveLength(receipts);
    expect(api.getTaskFollowupRuns).not.toHaveBeenCalled();
    expect(api.postTaskFollowup).toHaveBeenCalledTimes(1);
    storage?.mockRestore();
  });

  it('keeps it when the same profile is reconnected from the instance manager', async () => {
    const storage = constrainStorage();
    const desktop = await renderDesktop();
    await postFollowup();
    expect(banner()).toHaveAttribute('data-phase', 'starting');

    api.getTaskFollowupRuns.mockClear();
    await desktop.manage();
    await act(async () => { fireEvent.click(connectButton('Team server')); });
    await settle();
    expect(desktop.activate).toHaveBeenCalledTimes(2);
    expect(banner()).toHaveAttribute('data-phase', 'starting');
    expect(api.postTaskFollowup).toHaveBeenCalledTimes(1);
    storage?.mockRestore();
  });
});

describe('the Desktop reconnect fences responses from the connection it replaced', () => {
  it('does not adopt an acceptance that lands after the reconnect', async () => {
    await renderDesktop();
    const pending = deferred<PostFollowupResponse>();
    api.postTaskFollowup.mockReturnValue(pending.promise);
    await postFollowup();
    await reconnect();
    await act(async () => { pending.resolve(accepted); });
    await poll();
    expect(banner()).toBeNull();
    expect(handoffKeys()).toHaveLength(0);
    expect(api.getTaskFollowupRuns).not.toHaveBeenCalled();
  });

  it('ignores a lookup sent before the reconnect and follows the new one', async () => {
    await renderDesktop();
    const late = deferred<FollowupRunsResponse>();
    api.getTaskFollowupRuns.mockReturnValueOnce(late.promise);
    await postFollowup();
    await reconnect();
    await act(async () => { late.resolve(runsOf([{ taskId: 'stale-run', status: 'completed' }])); });
    expect(banner()).toHaveAttribute('data-phase', 'starting');

    api.getTaskFollowupRuns.mockResolvedValue(runsOf([{ taskId: 'fresh-run', status: 'processing' }]));
    await poll();
    expect(viewNewRun()).toHaveAttribute('href', '/tasks/fresh-run');
    expect(api.postTaskFollowup).toHaveBeenCalledTimes(1);
  });
});

describe.each(storageModes)('an accepted follow-up $name does not outlive a replaced identity', ({ constrain: constrainStorage }) => {
  const expectGone = async () => {
    expect(banner()).toBeNull();
    await poll();
    expect(banner()).toBeNull();
    expect(handoffKeys()).toHaveLength(0);
    expect(api.getTaskFollowupRuns).not.toHaveBeenCalled();
    expect(api.postTaskFollowup).toHaveBeenCalledTimes(1);
  };

  it('is dropped when the reconnect finds the same profile with a replaced credential', async () => {
    const storage = constrainStorage();
    const desktop = await renderDesktop();
    await postFollowup();
    expect(banner()).toHaveAttribute('data-phase', 'starting');

    api.getTaskFollowupRuns.mockClear();
    desktop.epochs.set(storedProfile.id, EPOCH_B);
    await reconnect();
    expect(desktop.activate).toHaveBeenCalledTimes(2);
    await expectGone();
    storage?.mockRestore();
  });

  it('is dropped on a switch to another profile and stays gone on switching back to the same identity', async () => {
    const storage = constrainStorage();
    const desktop = await renderDesktop();
    await postFollowup();
    expect(banner()).toHaveAttribute('data-phase', 'starting');

    api.getTaskFollowupRuns.mockClear();
    await desktop.manage();
    await act(async () => { fireEvent.click(connectButton('Second server')); });
    await settle();
    expect(desktop.activate).toHaveBeenLastCalledWith('ticket-profile-2');
    expect(banner()).toBeNull();

    await desktop.manage();
    await act(async () => { fireEvent.click(connectButton('Team server')); });
    await settle();
    expect(desktop.activate).toHaveBeenLastCalledWith('ticket-profile-1');
    await expectGone();
    storage?.mockRestore();
  });

  it('is dropped when the profile is moved to another endpoint', async () => {
    const storage = constrainStorage();
    const desktop = await renderDesktop();
    await postFollowup();
    expect(banner()).toHaveAttribute('data-phase', 'starting');

    api.getTaskFollowupRuns.mockClear();
    await desktop.manage();
    fireEvent.click(screen.getByRole('button', { name: 'Edit Team server' }));
    fireEvent.change(screen.getByLabelText('Instance URL'), { target: { value: 'https://moved.example.test' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save changes' })); });
    await settle();
    expect(desktop.activate).toHaveBeenCalledTimes(2);
    await expectGone();
    storage?.mockRestore();
  });
});
