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

export type AgentRuntimeVerificationStatus = 'healthy' | 'unhealthy' | 'disabled';

export interface AgentRuntimeVerificationIssue {
  code: string;
  message: string;
  package?: string;
  expected?: string;
  actual?: string;
}

export interface AgentRuntimePackageCheck {
  package: string;
  name: string;
  installed: boolean;
  expectedVersion?: string;
  actualVersion?: string;
  healthy: boolean;
}

export interface AgentRuntimeImageVerification {
  baseImage: string;
  currentBaseImageId?: string;
  recordedBaseImageId?: string;
  expectedImage?: string;
  recordedImage?: string;
  resolvedImage: string;
  finalUser?: string;
  expectedFinalUser?: string;
  labels?: Record<string, string>;
  packages: AgentRuntimePackageCheck[];
  issues: AgentRuntimeVerificationIssue[];
  healthy: boolean;
}

export interface AgentRuntimePackageVerificationResult {
  status: AgentRuntimeVerificationStatus;
  healthy: boolean;
  disabled: boolean;
  checkedAt: string;
  desiredPackages: string[];
  activePackages: string[];
  desiredActiveDrift: boolean;
  configurationValid: boolean;
  configurationErrors: string[];
  issues: AgentRuntimeVerificationIssue[];
  images: AgentRuntimeImageVerification[];
  remediation?: string;
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

export async function verifyAgentRuntimePackages(): Promise<AgentRuntimePackageVerificationResult> {
  const client = await createApiClient();
  return (await client.post<AgentRuntimePackageVerificationResult>('/api/agent-runtime/packages/verify')).data;
}
