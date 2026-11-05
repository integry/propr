import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import AccessManagementPage from './AccessManagementPage';
import { AuthProvider } from '../contexts/AuthContext';
import {
  addInstanceMember,
  claimBootstrapAdmin,
  getInstanceMembers,
  getInstanceRoleAudit,
  removeInstanceMember,
  updateInstanceMemberRole
} from '../api/instanceMembersApi';
import {
  addToTriggerWhitelist,
  getTriggerWhitelist,
  removeFromTriggerWhitelist
} from '../api/triggerWhitelistApi';
import type { CurrentUser, InstanceMember } from '../api/proprTypes';

vi.mock('../api/instanceMembersApi', () => ({
  addInstanceMember: vi.fn(),
  claimBootstrapAdmin: vi.fn(),
  getInstanceMembers: vi.fn(),
  getInstanceRoleAudit: vi.fn(),
  removeInstanceMember: vi.fn(),
  updateInstanceMemberRole: vi.fn()
}));

vi.mock('../api/triggerWhitelistApi', async importOriginal => ({
  ...await importOriginal<typeof import('../api/triggerWhitelistApi')>(),
  addToTriggerWhitelist: vi.fn(),
  getTriggerWhitelist: vi.fn(),
  removeFromTriggerWhitelist: vi.fn()
}));

const developer: InstanceMember = {
  githubUserId: '200',
  githubUsername: 'developer',
  role: 'member',
  source: 'local',
  createdByUserId: '100',
  createdAt: '2026-07-30T00:00:00.000Z',
  updatedAt: '2026-07-30T00:00:00.000Z'
};

const admin: CurrentUser = {
  id: '100',
  login: 'owner',
  username: 'owner',
  displayName: 'Owner',
  email: null,
  avatarUrl: null,
  role: 'admin',
  permissions: [
    'instance.manage_agents',
    'instance.manage_members',
    'instance.manage_runtime',
    'instance.manage_settings'
  ],
  authorizationSource: 'local'
};

const mockGetMembers = vi.mocked(getInstanceMembers);
const mockGetRoleAudit = vi.mocked(getInstanceRoleAudit);
const mockAddMember = vi.mocked(addInstanceMember);
const mockClaimBootstrapAdmin = vi.mocked(claimBootstrapAdmin);
const mockGetWhitelist = vi.mocked(getTriggerWhitelist);
const mockAddToWhitelist = vi.mocked(addToTriggerWhitelist);
const mockRemoveFromWhitelist = vi.mocked(removeFromTriggerWhitelist);

describe('AccessManagementPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetAllMocks();
    mockGetMembers.mockResolvedValue({
      bootstrapAdmins: [],
      members: [{
        githubUserId: '100',
        githubUsername: 'owner',
        role: 'admin',
        source: 'local',
        createdByUserId: '100',
        createdAt: '2026-07-30T00:00:00.000Z',
        updatedAt: '2026-07-30T00:00:00.000Z'
      }]
    });
    mockGetRoleAudit.mockResolvedValue([]);
    vi.mocked(updateInstanceMemberRole).mockResolvedValue({
      githubUserId: '100',
      githubUsername: 'owner',
      role: 'admin',
      source: 'local',
      createdByUserId: '100',
      createdAt: '2026-07-30T00:00:00.000Z',
      updatedAt: '2026-07-30T00:00:00.000Z'
    });
    vi.mocked(removeInstanceMember).mockResolvedValue();
    mockGetWhitelist.mockResolvedValue([]);
  });

  const renderPage = () => render(
    <AuthProvider user={admin}>
      <AccessManagementPage />
    </AuthProvider>
  );

  const addDeveloper = async () => {
    mockAddMember.mockResolvedValue(developer);
    renderPage();
    expect(await screen.findByText('@owner')).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText('GitHub username'), { target: { value: 'developer' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add user' }));
    await waitFor(() => expect(mockAddMember).toHaveBeenCalledWith('developer', 'member'));
  };

  const removeDeveloper = async () => {
    mockGetMembers.mockResolvedValue({ bootstrapAdmins: [], members: [developer] });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Remove developer' }));
    await waitFor(() => expect(removeInstanceMember).toHaveBeenCalledWith('200'));
    expect(window.confirm).toHaveBeenCalledWith('Remove the instance role assigned to @developer?');
  };

  it('loads assignments and adds a GitHub user', async () => {
    mockAddMember.mockResolvedValue({
      githubUserId: '200',
      githubUsername: 'developer',
      role: 'member',
      source: 'local',
      createdByUserId: '100',
      createdAt: '2026-07-30T00:00:00.000Z',
      updatedAt: '2026-07-30T00:00:00.000Z'
    });
    render(
      <AuthProvider user={admin}>
        <AccessManagementPage />
      </AuthProvider>
    );

    expect(await screen.findByText('@owner')).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText('GitHub username'), { target: { value: 'developer' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add user' }));

    await waitFor(() => {
      expect(mockAddMember).toHaveBeenCalledWith('developer', 'member');
      expect(mockGetMembers).toHaveBeenCalledTimes(2);
      expect(mockGetRoleAudit).toHaveBeenCalledTimes(2);
    });
  });

  it('lets an environment administrator store a durable numeric-ID role', async () => {
    const refreshUser = vi.fn().mockResolvedValue(undefined);
    mockGetMembers
      .mockResolvedValueOnce({ bootstrapAdmins: ['owner'], members: [] })
      .mockResolvedValueOnce({
        bootstrapAdmins: ['owner'],
        members: [{
          githubUserId: '100',
          githubUsername: 'owner',
          role: 'admin',
          source: 'local',
          createdByUserId: '100',
          createdAt: '2026-07-30T00:00:00.000Z',
          updatedAt: '2026-07-30T00:00:00.000Z'
        }]
      });
    mockClaimBootstrapAdmin.mockResolvedValue({
      githubUserId: '100',
      githubUsername: 'owner',
      role: 'admin',
      source: 'local',
      createdByUserId: '100',
      createdAt: '2026-07-30T00:00:00.000Z',
      updatedAt: '2026-07-30T00:00:00.000Z'
    });

    render(
      <AuthProvider user={{ ...admin, authorizationSource: 'bootstrap' }} refreshUser={refreshUser}>
        <AccessManagementPage />
      </AuthProvider>
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Store my administrator role' }));

    await waitFor(() => {
      expect(mockClaimBootstrapAdmin).toHaveBeenCalledTimes(1);
      expect(refreshUser).toHaveBeenCalledTimes(1);
      expect(mockGetMembers).toHaveBeenCalledTimes(2);
      expect(mockGetRoleAudit).toHaveBeenCalledTimes(2);
    });
  });

  it('surfaces recent role audit entries', async () => {
    mockGetRoleAudit.mockResolvedValue([{
      id: 1,
      actorGithubUserId: '100',
      actorGithubUsername: 'owner',
      targetGithubUserId: '200',
      targetGithubUsername: 'developer',
      action: 'role_changed',
      previousRole: 'member',
      newRole: 'admin',
      createdAt: '2026-07-30T00:00:00.000Z'
    }]);

    render(
      <AuthProvider user={admin}>
        <AccessManagementPage />
      </AuthProvider>
    );

    expect(await screen.findByText(/changed member to admin for/)).toBeInTheDocument();
    expect(screen.getByText('@developer')).toBeInTheDocument();
  });

  it('offers to add a newly added user to the trigger whitelist', async () => {
    mockGetWhitelist.mockResolvedValue(['owner']);
    mockAddToWhitelist.mockResolvedValue(['owner', 'developer']);
    await addDeveloper();

    expect(await screen.findByText(/@developer is not on the trigger whitelist/)).toBeInTheDocument();
    expect(mockAddToWhitelist).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Add to trigger whitelist' }));

    await waitFor(() => expect(mockAddToWhitelist).toHaveBeenCalledWith('developer'));
    await waitFor(() => expect(screen.queryByText(/is not on the trigger whitelist/)).not.toBeInTheDocument());
  });

  it('leaves the trigger whitelist unchanged when the add offer is declined', async () => {
    mockGetWhitelist.mockResolvedValue(['owner']);
    await addDeveloper();

    fireEvent.click(await screen.findByRole('button', { name: 'Not now' }));

    expect(screen.queryByText(/is not on the trigger whitelist/)).not.toBeInTheDocument();
    expect(mockAddToWhitelist).not.toHaveBeenCalled();
  });

  it('offers an addition when only a case-distinct entry is listed, since triggers match exactly', async () => {
    mockGetWhitelist.mockResolvedValue(['owner', 'Developer']);
    mockAddToWhitelist.mockResolvedValue(['owner', 'Developer', 'developer']);
    await addDeveloper();

    expect(await screen.findByText(/@developer is not on the trigger whitelist/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add to trigger whitelist' }));
    await waitFor(() => expect(mockAddToWhitelist).toHaveBeenCalledWith('developer'));
  });

  it('does not offer a whitelist addition when the user is already listed', async () => {
    mockGetWhitelist.mockResolvedValue(['owner', 'developer']);
    await addDeveloper();
    await waitFor(() => expect(mockGetWhitelist).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('button', { name: 'Add to trigger whitelist' })).not.toBeInTheDocument();
  });

  it('does not offer to restrict an empty (open) trigger whitelist', async () => {
    await addDeveloper();
    await waitFor(() => expect(mockGetWhitelist).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('button', { name: 'Add to trigger whitelist' })).not.toBeInTheDocument();
  });

  it('offers to remove a removed user from the trigger whitelist', async () => {
    mockGetWhitelist.mockResolvedValue(['owner', 'developer']);
    mockRemoveFromWhitelist.mockResolvedValue(['owner']);
    await removeDeveloper();

    expect(await screen.findByText(/@developer is still on the trigger whitelist/)).toBeInTheDocument();
    expect(mockRemoveFromWhitelist).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Remove from trigger whitelist' }));

    await waitFor(() => expect(mockRemoveFromWhitelist).toHaveBeenCalledWith('developer'));
    await waitFor(() => expect(screen.queryByText(/is still on the trigger whitelist/)).not.toBeInTheDocument());
  });

  it('does not offer a removal that would empty the trigger whitelist', async () => {
    mockGetWhitelist.mockResolvedValue(['developer']);
    await removeDeveloper();
    await waitFor(() => expect(mockGetWhitelist).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('button', { name: 'Remove from trigger whitelist' })).not.toBeInTheDocument();
  });

  it('treats a case-distinct whitelist entry as not listed for status and removal', async () => {
    mockGetWhitelist.mockResolvedValue(['owner', 'Developer']);
    await removeDeveloper();
    await waitFor(() => expect(mockGetWhitelist).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('button', { name: 'Remove from trigger whitelist' })).not.toBeInTheDocument();
  });

  it('marks only exactly listed users as on the trigger whitelist', async () => {
    mockGetMembers.mockResolvedValue({ bootstrapAdmins: [], members: [developer] });
    mockGetWhitelist.mockResolvedValue(['owner', 'Developer']);
    renderPage();
    expect(await screen.findByText('@developer')).toBeInTheDocument();
    await waitFor(() => expect(mockGetWhitelist).toHaveBeenCalled());
    expect(screen.queryByText(/on trigger whitelist/)).not.toBeInTheDocument();

    mockGetWhitelist.mockResolvedValue(['owner', 'developer']);
    cleanup();
    renderPage();
    expect(await screen.findByText(/on trigger whitelist/)).toBeInTheDocument();
  });

  it('surfaces trigger whitelist update failures', async () => {
    mockGetWhitelist.mockResolvedValue(['owner', 'developer']);
    mockRemoveFromWhitelist.mockRejectedValue(new Error('Configuration changed. Read it again and retry with a new operation key.'));
    await removeDeveloper();

    fireEvent.click(await screen.findByRole('button', { name: 'Remove from trigger whitelist' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Configuration changed');
  });
  it('explains direct assignments without exposing internal source names', async () => {
    renderPage();
    expect(await screen.findByText(/Assigned in this instance/)).toBeInTheDocument();
    expect(screen.getByText(/Roles assigned directly to users/)).toBeInTheDocument();
    expect(screen.queryByText(/source: local/)).not.toBeInTheDocument();
  });

  it('disables role changes while checking trigger access and until the offer is resolved', async () => {
    let resolveWhitelist!: (value: string[]) => void;
    mockGetWhitelist.mockResolvedValueOnce(['owner']).mockImplementationOnce(
      () => new Promise(resolve => { resolveWhitelist = resolve; })
    );
    await addDeveloper();
    await waitFor(() => expect(mockGetWhitelist).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('button', { name: 'Remove owner' })).toBeDisabled();
    await act(async () => resolveWhitelist(['owner']));
    expect(await screen.findByRole('button', { name: 'Add to trigger whitelist' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Remove owner' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(screen.getByRole('button', { name: 'Remove owner' })).toBeEnabled();
  });

  it('explains a failed trigger access check after a successful role change', async () => {
    mockGetWhitelist.mockRejectedValue(new Error('Settings unavailable'));
    await addDeveloper();
    expect(await screen.findByRole('status')).toHaveTextContent('Instance role updated. Trigger access could not be checked');
    expect(mockAddToWhitelist).not.toHaveBeenCalled();
  });

  it('explains that removing a role does not revoke open trigger access', async () => {
    await removeDeveloper();
    expect(await screen.findByRole('status')).toHaveTextContent('every GitHub user can still trigger ProPR');
    expect(mockRemoveFromWhitelist).not.toHaveBeenCalled();
  });

  it.each([[['developer']], [['developer', 'developer']]])(
    'explains why the final listed user cannot be removed (%j)',
    async (whitelist) => {
      mockGetWhitelist.mockResolvedValue(whitelist);
      await removeDeveloper();
      expect(await screen.findByRole('status')).toHaveTextContent('@developer still has trigger access');
      expect(screen.getByRole('status')).toHaveTextContent('would allow every GitHub user');
      expect(screen.queryByRole('button', { name: 'Remove from trigger whitelist' })).not.toBeInTheDocument();
    }
  );

  it('does not offer trigger changes when adding the instance role fails', async () => {
    mockAddMember.mockRejectedValue(new Error('Cannot assign role'));
    mockGetWhitelist.mockResolvedValue(['owner']);
    renderPage();
    await screen.findByText('@owner');
    fireEvent.change(screen.getByPlaceholderText('GitHub username'), { target: { value: 'developer' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add user' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Cannot assign role');
    expect(mockGetWhitelist).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Add to trigger whitelist' })).not.toBeInTheDocument();
  });

  it('leaves trigger access unchanged when the removal offer is declined', async () => {
    mockGetWhitelist.mockResolvedValue(['owner', 'developer']);
    await removeDeveloper();
    fireEvent.click(await screen.findByRole('button', { name: 'Not now' }));
    expect(mockRemoveFromWhitelist).not.toHaveBeenCalled();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

});
