import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AuthProvider } from '../../contexts/AuthContext';
import type { CurrentUser } from '../../api/proprTypes';
import MaintenanceSection from './MaintenanceSection';
import * as api from '../../api/followupHandoffsApi';

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
const view = (user = admin) => <AuthProvider user={user}><MaintenanceSection /></AuthProvider>;

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.listFollowupHandoffs).mockResolvedValue([held]);
});
afterEach(cleanup);

describe('MaintenanceSection', () => {
  it('renders nothing for members and for admins without the runtime permission', () => {
    render(view({ ...admin, role: 'member' }));
    expect(screen.queryByText('Maintenance')).not.toBeInTheDocument();
    cleanup();
    render(view({ ...admin, permissions: ['instance.manage_settings'] }));
    expect(screen.queryByText('Maintenance')).not.toBeInTheDocument();
    expect(api.listFollowupHandoffs).not.toHaveBeenCalled();
  });

  it('lists held follow-ups with the reason, the branch and the next action', async () => {
    render(view());
    expect(await screen.findByRole('link', { name: 'integry/propr#3423' })).toHaveAttribute('href', 'https://github.com/integry/propr/pull/3423');
    expect(screen.getByText(/comes from a fork/)).toBeInTheDocument();
    expect(screen.getByText('labels-fix')).toBeInTheDocument();
    expect(screen.getByText(/Held for an operator/)).toBeInTheDocument();
    expect(screen.getByText(/Next: repair the reported condition/)).toBeInTheDocument();
  });

  it('shows the empty state when nothing is tracked', async () => {
    vi.mocked(api.listFollowupHandoffs).mockResolvedValue([]);
    render(view());
    expect(await screen.findByText('No follow-up handoffs are tracked.')).toBeInTheDocument();
  });

  it('releases a hold without force by default and reports the refusal reason', async () => {
    vi.mocked(api.releaseFollowupHandoff).mockRejectedValueOnce(new api.FollowupHandoffRefusedError('The retained worktree still holds unpublished work. Release with force to detach it anyway; the commits stay reachable.', 'worktree_holds_unpublished_work'));
    render(view());
    const item = (await screen.findByRole('link', { name: 'integry/propr#3423' })).closest('li')!;
    fireEvent.click(within(item).getByRole('button', { name: 'Release' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('still holds unpublished work');
    expect(api.releaseFollowupHandoff).toHaveBeenCalledWith('integry/propr', 3423, { force: false });
  });

  it('forces a release only after the checkbox is ticked, then refreshes the list', async () => {
    vi.mocked(api.releaseFollowupHandoff).mockResolvedValue({ released: true });
    vi.mocked(api.listFollowupHandoffs).mockResolvedValueOnce([held]).mockResolvedValueOnce([]);
    render(view());
    const item = (await screen.findByRole('link', { name: 'integry/propr#3423' })).closest('li')!;
    fireEvent.click(within(item).getByRole('checkbox'));
    fireEvent.click(within(item).getByRole('button', { name: 'Release anyway' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Released integry/propr#3423');
    expect(api.releaseFollowupHandoff).toHaveBeenCalledWith('integry/propr', 3423, { force: true });
    expect(await screen.findByText('No follow-up handoffs are tracked.')).toBeInTheDocument();
  });

  it('resumes a hold and summarizes the recovery pass', async () => {
    vi.mocked(api.resumeFollowupHandoff).mockResolvedValue({
      summary: { inspected: 1, published: 1, noChanges: 0, settled: 0, cleanupPending: 0, skippedLiveAgent: 0, failedClosed: 0, awaitingOperator: 0, lockedByOtherWriter: 0, errors: 0 },
      status: null,
    });
    render(view());
    const item = (await screen.findByRole('link', { name: 'integry/propr#3423' })).closest('li')!;
    fireEvent.click(within(item).getByRole('button', { name: 'Resume' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Resumed integry/propr#3423: 1 published, 0 settled, 0 still held.');
    expect(api.resumeFollowupHandoff).toHaveBeenCalledWith('integry/propr', 3423);
  });
});
