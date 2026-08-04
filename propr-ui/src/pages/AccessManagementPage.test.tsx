import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
import type { CurrentUser } from '../api/proprTypes';

vi.mock('../api/instanceMembersApi', () => ({
  addInstanceMember: vi.fn(),
  claimBootstrapAdmin: vi.fn(),
  getInstanceMembers: vi.fn(),
  getInstanceRoleAudit: vi.fn(),
  removeInstanceMember: vi.fn(),
  updateInstanceMemberRole: vi.fn()
}));

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

describe('AccessManagementPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
  });

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

});
