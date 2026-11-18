import { render, cleanup, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AuthProvider } from '../../contexts/AuthContext';
import type { CurrentUser } from '../../api/proprTypes';
import MaintenanceSection from './MaintenanceSection';
import * as api from '../../api/followupHandoffsApi';
import { SettingsSectionVisibleContext } from './settingsSectionVisibility';
import { followupStateLabel, reasonLabel } from './heldFollowupText';

/**
 * An active follow-up whose agent is running right now is a run in progress,
 * not a recovery: the list says "Running" and links to the task. "In recovery"
 * stays for active follow-ups whose agent is gone (being recovered after a
 * failure) or could not be checked.
 */

vi.mock('../../api/followupHandoffsApi', async importOriginal => ({
  ...await importOriginal<typeof import('../../api/followupHandoffsApi')>(),
  listFollowupHandoffs: vi.fn(),
  releaseFollowupHandoff: vi.fn(),
  resumeFollowupHandoff: vi.fn(),
}));

const admin = { id: 'admin', username: 'admin', role: 'admin', permissions: ['instance.manage_runtime', 'instance.manage_settings'] } as CurrentUser;
const active: api.FollowupHandoffStatus = {
  repository: 'integry/propr', pullRequest: 3423, taskId: 'pr-comments-batch-integry-propr-3423', predecessorTaskIds: [], successorTaskId: null,
  phase: 'agent_running', status: 'active', statusReason: null, settlement: null, operatorAuthorized: false,
  liveness: 'running', branchName: 'labels-fix', commitHash: null, completionCommentUrl: null,
  nextAction: 'wait for the live agent container to exit',
  retainedWorktreePath: '/tmp/wt', updatedAt: Date.UTC(2026, 10, 7, 22, 58),
};
const recovering: api.FollowupHandoffStatus = {
  ...active, pullRequest: 3424, taskId: 'pr-comments-batch-integry-propr-3424', phase: 'committed', statusReason: 'publication_failed',
  liveness: 'stopped', nextAction: 'automatic recovery will resume the missing publication phase',
};

beforeEach(() => { vi.resetAllMocks(); });
afterEach(cleanup);

describe('follow-up state label', () => {
  it('says Running for an active follow-up whose agent is running', () => {
    expect(followupStateLabel(active)).toBe('Running');
    expect(reasonLabel(active)).toBe('Its agent is working on this request.');
  });

  it('keeps In recovery when the agent is gone or its liveness is unknown', () => {
    expect(['stopped', 'not_found', 'unavailable', 'not_checked'].map(liveness => followupStateLabel({ ...active, liveness })))
      .toEqual(['In recovery', 'In recovery', 'In recovery', 'In recovery']);
    expect(followupStateLabel(recovering)).toBe('In recovery');
    expect(reasonLabel({ ...active, liveness: 'stopped' })).toBe('Recovery is in progress.');
  });

  it('only applies to active follow-ups', () => {
    expect(followupStateLabel({ ...active, status: 'awaiting_operator' })).toBe('Held');
    expect(followupStateLabel({ ...active, status: 'released' })).toBe('Released');
  });
});

describe('MaintenanceSection running follow-ups', () => {
  it('links a running follow-up to its task and leaves recovery rows as In recovery', async () => {
    vi.mocked(api.listFollowupHandoffs).mockResolvedValue([active, recovering]);
    render(
      <MemoryRouter>
        <SettingsSectionVisibleContext.Provider value={true}>
          <AuthProvider user={admin}><MaintenanceSection /></AuthProvider>
        </SettingsSectionVisibleContext.Provider>
      </MemoryRouter>,
    );
    const running = (await screen.findByRole('link', { name: active.taskId })).closest('li')!;
    expect(within(running).getByRole('link', { name: 'Running' })).toHaveAttribute('href', `/tasks/${active.taskId}`);
    expect(within(running).queryByText(/In recovery/)).toBeNull();
    expect(within(running).getByText(/Its agent is working on this request\./)).toBeInTheDocument();
    expect(within(running).getByText('Wait for its agent to finish.')).toBeInTheDocument();

    const other = screen.getByRole('link', { name: recovering.taskId }).closest('li')!;
    expect(within(other).getByText(/In recovery · Committed/)).toBeInTheDocument();
    expect(within(other).queryByRole('link', { name: 'Running' })).toBeNull();
  });
});
