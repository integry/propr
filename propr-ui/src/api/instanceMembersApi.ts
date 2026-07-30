import { API_BASE_URL, apiFetch, handleApiResponse } from './proprApi';
import type {
  InstanceMember,
  InstanceMembersResponse,
  InstanceRole
} from './proprTypes';

async function handleInstanceMemberResponse(response: Response): Promise<void> {
  if (response.ok) return;
  if ([401, 403, 405].includes(response.status)) {
    await handleApiResponse(response);
    return;
  }
  if (response.status < 500) {
    let data: { error?: string; message?: string } | null = null;
    try { data = await response.clone().json() as { error?: string; message?: string }; } catch { /* Use the shared fallback. */ }
    const message = data?.message || data?.error;
    if (message) throw new Error(message);
  }
  await handleApiResponse(response);
}

export const getInstanceMembers = async (): Promise<InstanceMembersResponse> => {
  const response = await apiFetch(`${API_BASE_URL}/api/admin/members`, { credentials: 'include' });
  await handleInstanceMemberResponse(response);
  return response.json();
};

export const claimBootstrapAdmin = async (): Promise<InstanceMember> => {
  const response = await apiFetch(`${API_BASE_URL}/api/admin/members/claim`, {
    method: 'POST',
    credentials: 'include'
  });
  await handleInstanceMemberResponse(response);
  return (await response.json()).member;
};

export const addInstanceMember = async (username: string, role: InstanceRole): Promise<InstanceMember> => {
  const response = await apiFetch(`${API_BASE_URL}/api/admin/members`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, role }),
    credentials: 'include'
  });
  await handleInstanceMemberResponse(response);
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
  await handleInstanceMemberResponse(response);
  return (await response.json()).member;
};

export const removeInstanceMember = async (githubUserId: string): Promise<void> => {
  const response = await apiFetch(`${API_BASE_URL}/api/admin/members/${encodeURIComponent(githubUserId)}`, {
    method: 'DELETE',
    credentials: 'include'
  });
  await handleInstanceMemberResponse(response);
};
