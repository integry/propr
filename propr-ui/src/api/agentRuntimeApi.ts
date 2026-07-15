import { API_BASE_URL, apiFetch, handleApiResponse } from './proprApi';

export type AgentRuntimeBuildStatus = 'disabled' | 'pending' | 'building' | 'ready' | 'failed';

export interface AgentRuntimePackageState {
  packages: string[];
  activePackages: string[];
  status: AgentRuntimeBuildStatus;
  buildId?: string;
  images: Record<string, {
    baseImage: string;
    baseImageId: string;
    image: string;
    packageManager: 'apt' | 'apk';
    builtAt: string;
  }>;
  error?: string;
  buildLog?: string;
  updatedAt: string;
}

export interface AgentRuntimePackageSource {
  packageManager: 'apt' | 'apk';
  osName: string;
  images: string[];
}

export interface AgentRuntimePackageSearchResult {
  query: string;
  suggestions: string[];
  sources: AgentRuntimePackageSource[];
}

export interface AgentRuntimePackageValidationResult {
  valid: boolean;
  packages: string[];
  errors: string[];
  availability?: Array<{ package: string; available: boolean; unavailableOn: string[] }>;
  sources?: AgentRuntimePackageSource[];
}

async function handleRuntimeResponse(response: Response): Promise<Response> {
  if (!response.ok) {
    let body: { error?: string; errors?: string[] } | null = null;
    try {
      body = await response.clone().json() as { error?: string; errors?: string[] };
    } catch { /* Fall through to the shared HTTP status error. */ }
    const message = body?.error || body?.errors?.join('; ');
    if (message) throw new Error(message);
  }
  return handleApiResponse(response);
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
  await handleRuntimeResponse(response);
  return response.json();
}

export async function searchAgentRuntimePackageCatalog(
  query: string,
  signal?: AbortSignal
): Promise<AgentRuntimePackageSearchResult> {
  const response = await apiFetch(
    `${API_BASE_URL}/api/agent-runtime/packages/search?q=${encodeURIComponent(query)}`,
    { credentials: 'include', signal }
  );
  await handleRuntimeResponse(response);
  return response.json();
}

export async function validateAgentRuntimePackageSelection(
  packages: string[]
): Promise<AgentRuntimePackageValidationResult> {
  const response = await apiFetch(`${API_BASE_URL}/api/agent-runtime/packages/validate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ packages }),
    credentials: 'include'
  });
  if (response.status === 400) return response.json();
  await handleRuntimeResponse(response);
  return response.json();
}
