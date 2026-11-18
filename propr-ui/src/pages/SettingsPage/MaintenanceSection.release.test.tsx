import { render, screen, fireEvent, cleanup, within, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AuthProvider } from '../../contexts/AuthContext';
import type { CurrentUser } from '../../api/proprTypes';
import MaintenanceSection from './MaintenanceSection';
import * as api from '../../api/followupHandoffsApi';
import { SettingsSectionVisibleContext } from './settingsSectionVisibility';

/**
 * Release consent names the attempt it was confirmed for. The browser only knows
 * the attempts it has read, so a replacement on the server that no read has
 * shown yet must be caught by the server from the attempt id in the request.
 */

vi.mock('../../api/followupHandoffsApi', async importOriginal => ({
  ...await importOriginal<typeof import('../../api/followupHandoffsApi')>(),
  listFollowupHandoffs: vi.fn(),
  releaseFollowupHandoff: vi.fn(),
  resumeFollowupHandoff: vi.fn(),
}));

const admin = { id: 'admin', username: 'admin', role: 'admin', permissions: ['instance.manage_runtime', 'instance.manage_settings'] } as CurrentUser;
const held: api.FollowupHandoffStatus = {
  repository: 'integry/propr', pullRequest: 3423, taskId: 'pr-comments-batch-integry-propr-3423', predecessorTaskIds: [], successorTaskId: null,
  phase: 'agent_exited', status: 'awaiting_operator', statusReason: 'worktree_missing', settlement: null, operatorAuthorized: false,
  liveness: 'not_checked', branchName: 'labels-fix', commitHash: '0123456789abcdef', completionCommentUrl: null,
  nextAction: 'repair the reported condition, then resume to re-arm recovery, or release to stop tracking it',
  retainedWorktreePath: '/tmp/wt', updatedAt: Date.UTC(2026, 10, 7, 22, 58),
};
const forceBox = { name: 'Also release if it has unpublished work' };

beforeEach(() => { vi.resetAllMocks(); });
afterEach(cleanup);

describe('MaintenanceSection release of a replaced attempt', () => {
  it('names the confirmed attempt, so a replacement this browser never read is refused', async () => {
    // B replaces A on the server while the dialog is open; no read shows it, not even the one after the action.
    vi.mocked(api.listFollowupHandoffs).mockResolvedValueOnce([held]).mockRejectedValue(new Error('offline'));
    vi.mocked(api.releaseFollowupHandoff).mockRejectedValueOnce(new api.FollowupHandoffRefusedError('Changed.', 'superseded'));
    render(
      <MemoryRouter>
        <SettingsSectionVisibleContext.Provider value={true}>
          <AuthProvider user={admin}><MaintenanceSection /></AuthProvider>
        </SettingsSectionVisibleContext.Provider>
      </MemoryRouter>,
    );
    const item = (await screen.findByRole('link', { name: 'integry/propr#3423' })).closest('li')!;
    fireEvent.click(within(item).getByRole('checkbox', forceBox));
    fireEvent.click(within(item).getByRole('button', { name: 'Release' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Release' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('integry/propr#3423 changed while you were deciding. Nothing was released');
    expect(api.releaseFollowupHandoff).toHaveBeenCalledExactlyOnceWith('integry/propr', 3423, { force: true, taskId: held.taskId });
    await waitFor(() => expect(within(item).getByRole('button', { name: 'Release' })).toBeEnabled());
    // The rows still show A, but its consent is gone: the administrator has to tick the box again.
    expect(within(item).getByRole('checkbox', forceBox)).not.toBeChecked();
  });
});
