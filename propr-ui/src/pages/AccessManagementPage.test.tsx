import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import AccessManagementPage from './AccessManagementPage';
import { AuthProvider } from '../contexts/AuthContext';
import {
  addInstanceMember,
  claimInstanceAdmin,
  getInstanceMembers,
  removeInstanceMember,
  updateInstanceMemberRole
} from '../api/instanceMembersApi';
import type { CurrentUser } from '../api/proprTypes';

vi.mock('../api/instanceMembersApi', () => ({
  addInstanceMember: vi.fn(),
  claimInstanceAdmin: vi.fn(),
  getInstanceMembers: vi.fn(),
  removeInstanceMember: vi.fn(),
  updateInstanceMemberRole: vi.fn()
}));

const admin: CurrentUser = {
  id: '100',
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
  authorizationSource: 'local',
  legacyAdminMode: false
};

const mockGetMembers = vi.mocked(getInstanceMembers);
const mockAddMember = vi.mocked(addInstanceMember);
const mockClaimAdmin = vi.mocked(claimInstanceAdmin);

describe('AccessManagementPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetMembers.mockResolvedValue({
      legacyMode: false,
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
    });
  });

  it('lets a compatibility administrator claim a durable role', async () => {
    mockGetMembers
      .mockResolvedValueOnce({ legacyMode: true, bootstrapAdmins: [], members: [] })
      .mockResolvedValueOnce({ legacyMode: false, bootstrapAdmins: [], members: [] });
    mockClaimAdmin.mockResolvedValue({
      githubUserId: '100',
      githubUsername: 'owner',
      role: 'admin',
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

    fireEvent.click(await screen.findByRole('button', { name: 'Claim administrator role' }));

    await waitFor(() => {
      expect(mockClaimAdmin).toHaveBeenCalledTimes(1);
      expect(mockGetMembers).toHaveBeenCalledTimes(2);
    });
  });
});
