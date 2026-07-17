import { createApiClient } from './client.js';

export type AgentRuntimeBuildStatus = 'disabled' | 'pending' | 'building' | 'ready' | 'failed';

export interface AgentRuntimePackageState {
  installationId: string;
  packages: string[];
  activePackages: string[];
  status: AgentRuntimeBuildStatus;
  buildId?: string;
  images: Record<string, { baseImage: string; baseImageId: string; image: string; packageManager: 'apt'; builtAt: string }>;
  error?: string;
  buildLog?: string;
  updatedAt: string;
}

export async function getAgentRuntimePackages(): Promise<AgentRuntimePackageState> {
  const client = await createApiClient();
  return (await client.get<AgentRuntimePackageState>('/api/agent-runtime/packages')).data;
}

export async function updateAgentRuntimePackages(packages: string[]): Promise<AgentRuntimePackageState> {
  const client = await createApiClient();
  return (await client.put<AgentRuntimePackageState>('/api/agent-runtime/packages', { body: { packages } })).data;
}

export async function applyAgentRuntimePackages(): Promise<AgentRuntimePackageState> {
  const client = await createApiClient();
  return (await client.post<AgentRuntimePackageState>('/api/agent-runtime/packages/apply')).data;
}
