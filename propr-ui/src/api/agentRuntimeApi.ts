import { API_BASE_URL, apiFetch, handleApiResponse } from './proprApi';

export type AgentRuntimeBuildStatus = 'disabled' | 'pending' | 'building' | 'ready' | 'failed';

export interface AgentRuntimePackageState {
  packages: string[];
  activePackages: string[];
  status: AgentRuntimeBuildStatus;
  buildId?: string;
  images: Record<string, { baseImage: string; baseImageId: string; image: string; builtAt: string }>;
  error?: string;
  buildLog?: string;
  updatedAt: string;
}

export async function getAgentRuntimePackageState(): Promise<AgentRuntimePackageState> {
  const response = await apiFetch(`${API_BASE_URL}/api/agent-runtime/packages`, { credentials: 'include' });
  await handleApiResponse(response);
  return response.json();
}

export async function updateAgentRuntimePackageState(packages: string[]): Promise<AgentRuntimePackageState> {
  const response = await apiFetch(`${API_BASE_URL}/api/agent-runtime/packages`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ packages }),
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
}
