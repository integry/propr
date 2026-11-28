import { API_BASE_URL, apiFetch, handleApiResponse } from './apiClient';

export type AgentRuntimeBuildStatus = 'disabled' | 'pending' | 'building' | 'ready' | 'failed';

/** One runtime in use: the list it applies now, where it installs from, and its own status. */
export interface AgentRuntimePackageRuntimeState {
  runtime: string;
  label: string;
  status: AgentRuntimeBuildStatus;
  activePackages: string[];
  /** "derived Docker image", or the apt base a remote runtime installs from (e.g. "Ubuntu 26.04 LTS (resolute)"). */
  source: string;
  error?: string;
  warning?: string;
}

export interface AgentRuntimePackageState {
  installationId: string;
  packages: string[];
  activePackages: string[];
  status: AgentRuntimeBuildStatus;
  buildId?: string;
  images: Record<string, {
    baseImage: string;
    baseImageId: string;
    image: string;
    packageManager: 'apt';
    builtAt: string;
  }>;
  error?: string;
  buildLog?: string;
  /** Set when remote runtimes (Sprites, Fly Machines) install the packages instead of a Docker image build. */
  appliedBy?: string;
  canManage?: boolean;
  /** Each runtime in use with its own state; remote runtimes keep the last list their own check accepted. */
  runtimes?: AgentRuntimePackageRuntimeState[];
  updatedAt: string;
  /** Returned by a save that could not check availability ("could not verify availability: ..."); the list was saved. */
  warnings?: string[];
}

export interface AgentRuntimePackageSource {
  packageManager: 'apt';
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
  errors?: string[];
  error?: string;
  availability?: Array<{ package: string; available: boolean; unavailableOn: string[] }>;
  sources?: AgentRuntimePackageSource[];
  /** The package index could not be fetched: the list passes unverified. */
  warnings?: string[];
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
