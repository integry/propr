import { API_BASE_URL, apiFetch, handleApiResponse } from './apiClient';
import type {
  InstanceMember,
  InstanceMembersResponse,
  InstanceRole,
  InstanceRoleAuditEntry
} from './proprTypes';

export const getInstanceMembers = async (): Promise<InstanceMembersResponse> => {
  const response = await apiFetch(`${API_BASE_URL}/api/admin/members`, { credentials: 'include' });
  await handleApiResponse(response);
  return response.json();
};

export const getInstanceRoleAudit = async (limit = 25): Promise<InstanceRoleAuditEntry[]> => {
  const response = await apiFetch(
    `${API_BASE_URL}/api/admin/role-audit?limit=${encodeURIComponent(limit)}`,
    { credentials: 'include' }
  );
  await handleApiResponse(response);
  return (await response.json()).entries;
};

export const claimBootstrapAdmin = async (): Promise<InstanceMember> => {
  const response = await apiFetch(`${API_BASE_URL}/api/admin/members/claim`, {
    method: 'POST',
    credentials: 'include'
  });
  await handleApiResponse(response);
  return (await response.json()).member;
};

export const addInstanceMember = async (username: string, role: InstanceRole): Promise<InstanceMember> => {
  const response = await apiFetch(`${API_BASE_URL}/api/admin/members`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, role }),
    credentials: 'include'
  });
  await handleApiResponse(response);
  return (await response.json()).member;
};

export const updateInstanceMemberRole = async (
  githubUserId: string,
  role: InstanceRole
): Promise<InstanceMember> => {
  const response = await apiFetch(`${API_BASE_URL}/api/admin/members/${encodeURIComponent(githubUserId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role }),
    credentials: 'include'
  });
  await handleApiResponse(response);
  return (await response.json()).member;
};

export const removeInstanceMember = async (githubUserId: string): Promise<void> => {
  const response = await apiFetch(`${API_BASE_URL}/api/admin/members/${encodeURIComponent(githubUserId)}`, {
    method: 'DELETE',
    credentials: 'include'
  });
  await handleApiResponse(response);
};
