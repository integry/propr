import { act, render, screen, fireEvent, cleanup, within, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AuthProvider } from '../../contexts/AuthContext';
import type { CurrentUser } from '../../api/proprTypes';
import MaintenanceSection from './MaintenanceSection';
import * as api from '../../api/followupHandoffsApi';
import { maintenanceSections } from './settingsDataSections';
import { SettingsSectionVisibleContext } from './settingsSectionVisibility';
import { nextStep, phaseLabel, reasonLabel, statusLabel } from './heldFollowupText';

vi.mock('../../api/followupHandoffsApi', async importOriginal => ({
  ...await importOriginal<typeof import('../../api/followupHandoffsApi')>(),
  listFollowupHandoffs: vi.fn(),
  releaseFollowupHandoff: vi.fn(),
  resumeFollowupHandoff: vi.fn(),
}));

const admin = { id: 'admin', username: 'admin', role: 'admin', permissions: ['instance.manage_runtime', 'instance.manage_settings'] } as CurrentUser;
const held: api.FollowupHandoffStatus = {
  repository: 'integry/propr', pullRequest: 3423, taskId: 'pr-comments-batch-integry-propr-3423', predecessorTaskIds: [], successorTaskId: null,
  phase: 'agent_running', status: 'awaiting_operator', statusReason: 'fork_publication_unsupported', settlement: null, operatorAuthorized: false,
  liveness: 'not_checked', branchName: 'labels-fix', commitHash: null, completionCommentUrl: null,
  nextAction: 'repair the reported condition, then resume to re-arm recovery, or release to stop tracking it',
  retainedWorktreePath: '/tmp/git-processor/worktrees/bharveyos/propr/pr-3423-followup', updatedAt: Date.UTC(2026, 10, 7, 22, 58),
};
const released: api.FollowupHandoffStatus = {
  ...held, pullRequest: 265, taskId: 'pr-comments-batch-integry-propr-265', phase: 'agent_exited', status: 'released',
  statusReason: 'auto_released_stale_hold', nextAction: 'none',
};
const cancelled: api.FollowupHandoffStatus = {
  ...held, pullRequest: 3500, taskId: 'pr-comments-batch-integry-propr-3500', phase: 'committed', statusReason: 'cancelled_by_user',
  commitHash: '0123456789abcdef', nextAction: 'resume --authorize-cancelled to publish the cancelled work, or release to stop tracking it',
};
const summary = { inspected: 1, published: 1, noChanges: 0, settled: 0, cleanupPending: 0, skippedLiveAgent: 0, failedClosed: 0, awaitingOperator: 0, lockedByOtherWriter: 0, errors: 0 };
const view = (user = admin, visible = true) => (
  <MemoryRouter>
    <SettingsSectionVisibleContext.Provider value={visible}>
      <AuthProvider user={user}><MaintenanceSection /></AuthProvider>
    </SettingsSectionVisibleContext.Provider>
  </MemoryRouter>
);
const row = async (name: string) => (await screen.findByRole('link', { name })).closest('li')!;
const confirmRelease = () => fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Release' }));

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.listFollowupHandoffs).mockResolvedValue([held]);
});
afterEach(cleanup);

describe('MaintenanceSection', () => {
  it('renders nothing for members and for admins without the runtime permission', () => {
    render(view({ ...admin, role: 'member' }));
    expect(screen.queryByText('Held follow-ups')).not.toBeInTheDocument();
    cleanup();
    render(view({ ...admin, permissions: ['instance.manage_settings'] }));
    expect(screen.queryByText('Held follow-ups')).not.toBeInTheDocument();
    expect(api.listFollowupHandoffs).not.toHaveBeenCalled();
  });

  it('is headed by what it holds, not by the Maintenance category it sits in', async () => {
    render(view());
    expect(screen.getByRole('region', { name: 'Held follow-ups' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Maintenance' })).toBeNull();
    expect(screen.getByText('Follow-ups that stopped before their work reached the pull request.')).toBeInTheDocument();
    await screen.findByRole('link', { name: 'integry/propr#3423' });
  });

  it('comes first under Maintenance, only for administrators who may manage the runtime', () => {
    const sections = maintenanceSections(admin);
    expect(sections.map(section => [section.id, section.category])).toEqual([
      ['maintenance', 'maintenance'],
      ['instance-storage', 'maintenance'],
    ]);
    expect(sections[0].searchText).toMatch(/held follow-ups/);
    expect(maintenanceSections({ ...admin, permissions: ['instance.manage_settings'] }).map(section => section.id)).toEqual(['instance-storage']);
    // A viewer who can use neither section gets none, so the category drops out of the list.
    expect(maintenanceSections({ ...admin, role: 'member' })).toEqual([]);
    expect(maintenanceSections(null)).toEqual([]);
  });

  it('asks for held follow-ups only once the section is shown', async () => {
    const { rerender } = render(view(admin, false));
    expect(api.listFollowupHandoffs).not.toHaveBeenCalled();
    rerender(view(admin, true));
    await screen.findByRole('link', { name: 'integry/propr#3423' });
    expect(api.listFollowupHandoffs).toHaveBeenCalledTimes(1);
  });

  it('draws the first read with the list skeleton and offers no Refresh button', async () => {
    let resolve!: (value: api.FollowupHandoffStatus[]) => void;
    vi.mocked(api.listFollowupHandoffs).mockReturnValue(new Promise(done => { resolve = done; }));
    render(view());
    expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByText(/Loading…/, { selector: 'p' })).toBeNull();
    resolve([held]);
    await screen.findByRole('link', { name: 'integry/propr#3423' });
    expect(screen.queryByRole('button', { name: 'Refresh' })).toBeNull();
  });

  it('lists a held follow-up in plain words, linking the task and hiding the worktree path', async () => {
    render(view());
    const item = await row('integry/propr#3423');
    expect(within(item).getByRole('link', { name: 'integry/propr#3423' })).toHaveAttribute('href', 'https://github.com/integry/propr/pull/3423');
    expect(item).toHaveTextContent('Held · Agent running');
    expect(item).toHaveTextContent(/comes from a fork/);
    expect(within(item).getByText('labels-fix')).toBeInTheDocument();
    expect(item).toHaveTextContent('Fix the problem above, then resume it, or release it.');
    expect(within(item).getByRole('link', { name: held.taskId })).toHaveAttribute('href', `/tasks/${held.taskId}`);
    expect(item).not.toHaveTextContent('/tmp/git-processor');
    expect(item).not.toHaveTextContent(/Next:|agent_running|awaiting_operator/);
    expect(within(item).getByRole('time')).toHaveAttribute('title', expect.not.stringMatching(/\d+\/\d+\/\d{4}/));
  });

  it('hides released follow-ups behind a collapsed, read-only Show released control', async () => {
    vi.mocked(api.listFollowupHandoffs).mockResolvedValue([released, held]);
    render(view());
    await screen.findByRole('link', { name: 'integry/propr#3423' });
    expect(within(screen.getByRole('list', { name: 'Held follow-ups' })).getAllByRole('listitem')).toHaveLength(1);
    const toggle = screen.getByText('Show released (1)');
    const details = toggle.closest('details')!;
    expect(details).not.toHaveAttribute('open');
    fireEvent.click(toggle);
    const item = within(details).getByRole('listitem');
    expect(item).toHaveTextContent('Released automatically (stale).');
    expect(within(item).queryByRole('button')).toBeNull();
    expect(within(item).queryByRole('checkbox')).toBeNull();
  });

  it('shows the empty state when nothing is held', async () => {
    vi.mocked(api.listFollowupHandoffs).mockResolvedValue([released]);
    render(view());
    expect(await screen.findByText('No held follow-ups.')).toBeInTheDocument();
    expect(screen.getByText('Show released (1)')).toBeInTheDocument();
  });

  it('asks before releasing, releases without force by default and reports the refusal plainly', async () => {
    vi.mocked(api.releaseFollowupHandoff).mockRejectedValueOnce(new api.FollowupHandoffRefusedError('This follow-up still has unpublished work. Tick the box to release it anyway; the commits are kept.', 'worktree_holds_unpublished_work'));
    render(view());
    const item = await row('integry/propr#3423');
    fireEvent.click(within(item).getByRole('button', { name: 'Release' }));
    expect(api.releaseFollowupHandoff).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.releaseFollowupHandoff).not.toHaveBeenCalled();
    fireEvent.click(within(item).getByRole('button', { name: 'Release' }));
    confirmRelease();
    expect(await screen.findByRole('alert')).toHaveTextContent('This follow-up still has unpublished work. Tick the box to release it anyway; the commits are kept.');
    expect(api.releaseFollowupHandoff).toHaveBeenCalledWith('integry/propr', 3423, { force: false });
  });

  it('forces a release only after its box is ticked, then refreshes the list', async () => {
    vi.mocked(api.releaseFollowupHandoff).mockResolvedValue({ released: true });
    vi.mocked(api.listFollowupHandoffs).mockResolvedValueOnce([held]).mockResolvedValueOnce([]);
    render(view());
    const item = await row('integry/propr#3423');
    fireEvent.click(within(item).getByRole('checkbox', { name: 'Also release if it has unpublished work' }));
    fireEvent.click(within(item).getByRole('button', { name: 'Release' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('Any unpublished commits stay on the branch.');
    confirmRelease();
    expect(await screen.findByText(/Released integry\/propr#3423/)).toBeInTheDocument();
    expect(api.releaseFollowupHandoff).toHaveBeenCalledWith('integry/propr', 3423, { force: true });
    expect(await screen.findByText('No held follow-ups.')).toBeInTheDocument();
  });

  describe('when a later attempt replaces the one a release was decided for', () => {
    const later: api.FollowupHandoffStatus = { ...held, taskId: 'pr-comments-batch-integry-propr-3423-b', commitHash: 'fedcba9876543210' };
    beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); });
    afterEach(() => { vi.useRealTimers(); });
    const poll = () => vi.advanceTimersByTimeAsync(60_000);

    it('drops a ticked force choice, so Release on the later attempt is not forced', async () => {
      vi.mocked(api.releaseFollowupHandoff).mockResolvedValue({ released: true });
      vi.mocked(api.listFollowupHandoffs).mockResolvedValueOnce([held]).mockResolvedValue([later]);
      render(view());
      fireEvent.click(within(await row('integry/propr#3423')).getByRole('checkbox', { name: 'Also release if it has unpublished work' }));
      await poll();
      const item = await row(later.taskId);
      await waitFor(() => expect(within(item).getByRole('checkbox', { name: 'Also release if it has unpublished work' })).not.toBeChecked());
      fireEvent.click(within(item).getByRole('button', { name: 'Release' }));
      expect(screen.getByRole('dialog')).not.toHaveTextContent('Any unpublished commits stay on the branch.');
      confirmRelease();
      await screen.findByText(/Released integry\/propr#3423/);
      expect(api.releaseFollowupHandoff).toHaveBeenCalledTimes(1);
      expect(api.releaseFollowupHandoff).toHaveBeenCalledWith('integry/propr', 3423, { force: false });
    });

    it.each([
      ['replaced by a later attempt', [later]],
      ['released', [{ ...held, status: 'released', statusReason: 'auto_released_stale_hold', nextAction: 'none' }]],
      ['gone from the list', []],
    ])('withdraws an open Release confirmation once its attempt is %s', async (_case, read) => {
      vi.mocked(api.listFollowupHandoffs).mockResolvedValueOnce([held]).mockResolvedValue(read as api.FollowupHandoffStatus[]);
      render(view());
      const item = await row('integry/propr#3423');
      fireEvent.click(within(item).getByRole('checkbox', { name: 'Also release if it has unpublished work' }));
      fireEvent.click(within(item).getByRole('button', { name: 'Release' }));
      expect(screen.getByRole('dialog')).toHaveTextContent('Any unpublished commits stay on the branch.');
      await poll();
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(await screen.findByRole('alert')).toHaveTextContent('integry/propr#3423 changed while you were deciding. Nothing was released');
      expect(api.releaseFollowupHandoff).not.toHaveBeenCalled();
    });

    it('keeps an open Release confirmation while its attempt is still the open one', async () => {
      vi.mocked(api.releaseFollowupHandoff).mockResolvedValue({ released: true });
      vi.mocked(api.listFollowupHandoffs).mockResolvedValue([held]);
      render(view());
      const item = await row('integry/propr#3423');
      fireEvent.click(within(item).getByRole('checkbox', { name: 'Also release if it has unpublished work' }));
      fireEvent.click(within(item).getByRole('button', { name: 'Release' }));
      await poll();
      await waitFor(() => expect(api.listFollowupHandoffs).toHaveBeenCalledTimes(2));
      confirmRelease();
      await screen.findByText(/Released integry\/propr#3423/);
      expect(api.releaseFollowupHandoff).toHaveBeenCalledWith('integry/propr', 3423, { force: true });
    });
  });

  it('resumes a hold and says what happened', async () => {
    vi.mocked(api.resumeFollowupHandoff).mockResolvedValue({ summary, status: null });
    render(view());
    const item = await row('integry/propr#3423');
    expect(within(item).queryByRole('checkbox', { name: 'Publish the cancelled work' })).toBeNull();
    fireEvent.click(within(item).getByRole('button', { name: 'Resume' }));
    expect(await screen.findByText('Resumed integry/propr#3423. Its work is published.')).toBeInTheDocument();
    expect(api.resumeFollowupHandoff).toHaveBeenCalledWith('integry/propr', 3423);
  });

  it('publishes cancelled work only when its box is ticked', async () => {
    vi.mocked(api.listFollowupHandoffs).mockResolvedValue([cancelled]);
    vi.mocked(api.resumeFollowupHandoff)
      .mockRejectedValueOnce(new api.FollowupHandoffRefusedError('This work was cancelled. Tick “Publish the cancelled work” to resume it.', 'requires_cancellation_authorization'))
      .mockResolvedValueOnce({ summary, status: null });
    render(view());
    const item = await row('integry/propr#3500');
    expect(item).toHaveTextContent('The work was cancelled before it was published.');
    expect(item).toHaveTextContent('Tick “Publish the cancelled work” and resume to publish it, or release it.');
    expect(item).not.toHaveTextContent('--authorize-cancelled');
    fireEvent.click(within(item).getByRole('button', { name: 'Resume' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This work was cancelled.');
    expect(api.resumeFollowupHandoff).toHaveBeenLastCalledWith('integry/propr', 3500);
    await waitFor(() => expect(within(item).getByRole('button', { name: 'Resume' })).toBeEnabled());
    fireEvent.click(within(item).getByRole('checkbox', { name: 'Publish the cancelled work' }));
    fireEvent.click(within(item).getByRole('button', { name: 'Resume' }));
    expect(await screen.findByText('Resumed integry/propr#3500. Its work is published.')).toBeInTheDocument();
    expect(api.resumeFollowupHandoff).toHaveBeenLastCalledWith('integry/propr', 3500, { authorizeCancelled: true, taskId: cancelled.taskId });
  });

  const superseded = () => new api.FollowupHandoffRefusedError('This follow-up changed in the meantime. Check the list and try again.', 'superseded');
  it.each([
    ['the re-read shows the replacement', [{ ...cancelled, taskId: 'pr-comments-batch-integry-propr-3500-b' }]],
    ['the re-read fails', new Error('offline')],
  ])('names the ticked attempt and asks again when the server says a newer one replaced it (%s)', async (_case, reread) => {
    const lists = vi.mocked(api.listFollowupHandoffs).mockResolvedValueOnce([cancelled]);
    if (reread instanceof Error) lists.mockRejectedValue(reread); else lists.mockResolvedValue(reread);
    vi.mocked(api.resumeFollowupHandoff).mockRejectedValueOnce(superseded()).mockResolvedValue({ summary, status: null });
    render(view());
    fireEvent.click(within(await row('integry/propr#3500')).getByRole('checkbox', { name: 'Publish the cancelled work' }));
    fireEvent.click(within(await row('integry/propr#3500')).getByRole('button', { name: 'Resume' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This follow-up changed in the meantime.');
    expect(api.resumeFollowupHandoff).toHaveBeenCalledWith('integry/propr', 3500, { authorizeCancelled: true, taskId: cancelled.taskId });
    await waitFor(() => expect(within(screen.getByRole('list', { name: 'Held follow-ups' })).getByRole('button', { name: 'Resume' })).toBeEnabled());
    const item = await row('integry/propr#3500');
    expect(within(item).getByRole('checkbox', { name: 'Publish the cancelled work' })).not.toBeChecked();
    fireEvent.click(within(item).getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(api.resumeFollowupHandoff).toHaveBeenLastCalledWith('integry/propr', 3500));
  });

  it.each([
    ['is released and a later attempt is held', [[held], [held, { ...cancelled, taskId: 'pr-comments-batch-integry-propr-3500-b' }]]],
    ['is replaced by a later attempt in one read', [[held, { ...cancelled, taskId: 'pr-comments-batch-integry-propr-3500-b' }]]],
    ['leaves the list and comes back', [[held], [held, cancelled]]],
  ])('does not carry a ticked publish choice over when its attempt %s', async (_case, reads) => {
    const lists = vi.mocked(api.listFollowupHandoffs).mockResolvedValueOnce([held, cancelled]);
    for (const read of reads) lists.mockResolvedValueOnce(read as api.FollowupHandoffStatus[]);
    vi.mocked(api.releaseFollowupHandoff).mockRejectedValue(new api.FollowupHandoffRefusedError('Refused.', 'worktree_holds_unpublished_work'));
    vi.mocked(api.resumeFollowupHandoff).mockResolvedValue({ summary, status: null });
    render(view());
    fireEvent.click(within(await row('integry/propr#3500')).getByRole('checkbox', { name: 'Publish the cancelled work' }));
    // Each refused release of the other row re-reads the list without touching the choice itself.
    for (let read = 1; read <= reads.length; read++) {
      fireEvent.click(within(await row('integry/propr#3423')).getByRole('button', { name: 'Release' }));
      confirmRelease();
      await waitFor(() => expect(api.listFollowupHandoffs).toHaveBeenCalledTimes(read + 1));
      await waitFor(() => expect(within(screen.getByRole('list', { name: 'Held follow-ups' })).getAllByRole('button', { name: 'Resume' })[0]).toBeEnabled());
    }
    const item = await row('integry/propr#3500');
    expect(within(item).getByRole('checkbox', { name: 'Publish the cancelled work' })).not.toBeChecked();
    fireEvent.click(within(item).getByRole('button', { name: 'Resume' }));
    await screen.findByText(/Resumed integry\/propr#3500/);
    expect(api.resumeFollowupHandoff).toHaveBeenCalledWith('integry/propr', 3500);
    expect(api.resumeFollowupHandoff).not.toHaveBeenCalledWith('integry/propr', 3500, expect.objectContaining({ authorizeCancelled: true }));
  });

  it('keeps a ticked publish choice while the same attempt stays held', async () => {
    vi.mocked(api.listFollowupHandoffs).mockResolvedValue([held, cancelled]);
    vi.mocked(api.releaseFollowupHandoff).mockRejectedValue(new api.FollowupHandoffRefusedError('Refused.', 'worktree_holds_unpublished_work'));
    vi.mocked(api.resumeFollowupHandoff).mockResolvedValue({ summary, status: null });
    render(view());
    fireEvent.click(within(await row('integry/propr#3500')).getByRole('checkbox', { name: 'Publish the cancelled work' }));
    fireEvent.click(within(await row('integry/propr#3423')).getByRole('button', { name: 'Release' }));
    confirmRelease();
    await waitFor(() => expect(api.listFollowupHandoffs).toHaveBeenCalledTimes(2));
    const item = await row('integry/propr#3500');
    await waitFor(() => expect(within(item).getByRole('button', { name: 'Resume' })).toBeEnabled());
    expect(within(item).getByRole('checkbox', { name: 'Publish the cancelled work' })).toBeChecked();
    fireEvent.click(within(item).getByRole('button', { name: 'Resume' }));
    await screen.findByText(/Resumed integry\/propr#3500/);
    expect(api.resumeFollowupHandoff).toHaveBeenCalledWith('integry/propr', 3500, { authorizeCancelled: true, taskId: cancelled.taskId });
  });

  describe('when an older read answers after a newer one', () => {
    beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); });
    afterEach(() => { vi.useRealTimers(); });
    const deferred = () => {
      let resolve!: (value: api.FollowupHandoffStatus[]) => void;
      const promise = new Promise<api.FollowupHandoffStatus[]>(done => { resolve = done; });
      return { promise, resolve };
    };
    // Answer the held read, then let its handler and any re-render run to completion.
    const settle = (answer: () => void) => act(async () => { answer(); await vi.advanceTimersByTimeAsync(50); });

    it('does not bring back a released attempt from a poll that started before Release', async () => {
      const stalePoll = deferred();
      vi.mocked(api.releaseFollowupHandoff).mockResolvedValue({ released: true });
      vi.mocked(api.listFollowupHandoffs)
        .mockResolvedValueOnce([held])
        .mockReturnValueOnce(stalePoll.promise)
        .mockResolvedValue([{ ...held, status: 'released', statusReason: 'auto_released_stale_hold', nextAction: 'none' }]);
      render(view());
      const item = await row('integry/propr#3423');
      await vi.advanceTimersByTimeAsync(60_000);
      expect(api.listFollowupHandoffs).toHaveBeenCalledTimes(2);
      // Background reads leave Release usable while the poll is still out.
      fireEvent.click(within(item).getByRole('button', { name: 'Release' }));
      confirmRelease();
      await screen.findByText(/Released integry\/propr#3423/);
      expect(await screen.findByText('No held follow-ups.')).toBeInTheDocument();
      expect(api.listFollowupHandoffs).toHaveBeenCalledTimes(3);
      await settle(() => stalePoll.resolve([held]));
      expect(screen.getByText('No held follow-ups.')).toBeInTheDocument();
      expect(screen.queryByRole('list', { name: 'Held follow-ups' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Release' })).toBeNull();
      expect(api.releaseFollowupHandoff).toHaveBeenCalledTimes(1);
    });

    it('does not let a read from before a category switch replace the attempt a newer read shows', async () => {
      const laterCancelled = { ...cancelled, taskId: 'pr-comments-batch-integry-propr-3500-b' };
      const stalePoll = deferred();
      vi.mocked(api.resumeFollowupHandoff).mockResolvedValue({ summary, status: null });
      vi.mocked(api.listFollowupHandoffs)
        .mockResolvedValueOnce([cancelled])
        .mockReturnValueOnce(stalePoll.promise)
        .mockResolvedValue([laterCancelled]);
      const { rerender } = render(view());
      await row(cancelled.taskId);
      await vi.advanceTimersByTimeAsync(60_000);
      // Switch to another category and back while the poll is still out.
      rerender(view(admin, false));
      rerender(view(admin, true));
      const item = await row(laterCancelled.taskId);
      expect(api.listFollowupHandoffs).toHaveBeenCalledTimes(3);
      await settle(() => stalePoll.resolve([cancelled]));
      expect(screen.queryByRole('link', { name: cancelled.taskId })).toBeNull();
      expect(within(item).getByRole('link', { name: laterCancelled.taskId })).toBeInTheDocument();
      // The publish choice offered is for the attempt the server holds, not the obsolete one.
      expect(within(item).getByRole('checkbox', { name: 'Publish the cancelled work' })).not.toBeChecked();
      fireEvent.click(within(item).getByRole('button', { name: 'Resume' }));
      await screen.findByText(/Resumed integry\/propr#3500/);
      expect(api.resumeFollowupHandoff).toHaveBeenCalledWith('integry/propr', 3500);
    });

    it('does not show a first-read error from a read a newer one replaced', async () => {
      const staleFirst = deferred();
      const newerFirst = deferred();
      vi.mocked(api.listFollowupHandoffs).mockReturnValueOnce(staleFirst.promise).mockReturnValueOnce(newerFirst.promise);
      const { rerender } = render(view());
      rerender(view(admin, false));
      rerender(view(admin, true));
      expect(api.listFollowupHandoffs).toHaveBeenCalledTimes(2);
      await settle(() => staleFirst.resolve(Promise.reject(new Error('Old failure.')) as never));
      expect(screen.queryByText('Old failure.')).toBeNull();
      expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true');
      newerFirst.resolve([held]);
      await row('integry/propr#3423');
      expect(screen.queryByRole('alert')).toBeNull();
    });
  });

  it('keeps the last rows when a background read fails', async () => {
    vi.mocked(api.resumeFollowupHandoff).mockResolvedValue({ summary, status: null });
    vi.mocked(api.listFollowupHandoffs).mockResolvedValueOnce([held]).mockRejectedValueOnce(new Error('Too many requests. Try again in a minute.'));
    render(view());
    const item = await row('integry/propr#3423');
    fireEvent.click(within(item).getByRole('button', { name: 'Resume' }));
    await screen.findByText(/Resumed integry\/propr#3423/);
    await waitFor(() => expect(api.listFollowupHandoffs).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('link', { name: 'integry/propr#3423' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('held follow-up labels', () => {
  it('labels statuses and phases', () => {
    expect(['awaiting_operator', 'active', 'released'].map(statusLabel)).toEqual(['Held', 'In recovery', 'Released']);
    expect(['agent_running', 'agent_exited', 'committed', 'pushed', 'comment_published', 'cleanup_pending'].map(phaseLabel))
      .toEqual(['Agent running', 'Agent finished', 'Committed', 'Pushed', 'Comment posted', 'Cleaning up']);
    expect(phaseLabel('some_new_phase')).toBe('Some new phase');
  });

  it('labels release reasons', () => {
    const reason = (statusReason: string) => reasonLabel({ ...released, statusReason });
    expect(reason('released_by_operator')).toBe('Released by an administrator.');
    expect(reason('released_by_operator_force')).toBe('Released by an administrator; unpublished commits kept.');
    expect(reason('auto_released_stale_hold')).toBe('Released automatically (stale).');
    expect(reason('released_pr_closed')).toBe('Pull request closed.');
    expect(reasonLabel({ ...held, status: 'active', statusReason: null })).toBe('Recovery is in progress.');
  });

  it('turns the server next action into a short step, or nothing', () => {
    expect(nextStep(released)).toBeNull();
    expect(nextStep({ ...held, status: 'active', nextAction: 'automatic recovery will resume the missing publication phase' })).toBeNull();
    expect(nextStep({ ...held, status: 'active', phase: 'cleanup_pending', nextAction: 'publication is complete; automatic recovery retries the branch release' })).toBeNull();
    expect(nextStep({ ...held, status: 'active', nextAction: 'wait for the live agent container to exit' })).toBe('Wait for its agent to finish.');
    expect(nextStep(cancelled)).not.toMatch(/--|resume --/);
  });
});
