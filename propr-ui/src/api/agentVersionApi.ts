/**
 * API client for agent CLI version management.
 */

import { API_BASE_URL, apiFetch, handleApiResponse } from './proprApi';

export type AgentType = 'claude' | 'codex' | 'gemini' | 'opencode';
export type CliVersionType = 'default' | 'tag' | 'specific' | 'custom';

export interface AvailableTag {
  tag: string;
  version: string;
}

export interface RecentVersion {
  version: string;
  publishedAt: string;
}

export interface AvailableVersionsResponse {
  agentType: AgentType;
  packageName: string;
  defaultVersion: string;
  availableTags: AvailableTag[];
  recentVersions: RecentVersion[];
}

export interface BuildImageResponse {
  success: boolean;
  imageTag: string;
  cliVersion: string;
  contentHash: string;
  error?: string;
}

export interface CleanupResponse {
  success: boolean;
  deletedCount: number;
  versionsKept: string[];
}

export interface ImageInfo {
  tag: string;
  fullName: string;
}

export interface ListImagesResponse {
  agentType: AgentType;
  images: ImageInfo[];
}

export interface ResolveVersionResponse {
  agentType: AgentType;
  versionType: CliVersionType;
  versionSpec: string | null;
  resolved: string;
}

export interface ImageTagResponse {
  agentType: AgentType;
  versionType: CliVersionType;
  versionSpec: string | null;
  resolvedVersion: string;
  contentHash: string;
  imageTag: string;
}

/**
 * Fetches available versions for an agent type.
 * Returns npm tags with resolved versions and recent specific versions.
 */
export async function getAgentVersions(agentType: AgentType): Promise<AvailableVersionsResponse> {
  const response = await apiFetch(
    `${API_BASE_URL}/api/agents/versions/${agentType}`,
    { credentials: 'include' }
  );
  await handleApiResponse(response);
  return response.json();
}

/**
 * Triggers a Docker image build for a specific agent.
 */
export async function buildAgentImage(
  agentId: string,
  options?: { cliVersionType?: CliVersionType; cliVersion?: string }
): Promise<BuildImageResponse> {
  const response = await apiFetch(
    `${API_BASE_URL}/api/agents/${agentId}/build-image`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(options || {}),
      credentials: 'include'
    }
  );
  await handleApiResponse(response);
  return response.json();
}

/**
 * Triggers cleanup of unused Docker images for an agent type.
 */
export async function cleanupAgentImages(agentType: AgentType): Promise<CleanupResponse> {
  const response = await apiFetch(
    `${API_BASE_URL}/api/agents/${agentType}/images/cleanup`,
    {
      method: 'DELETE',
      credentials: 'include'
    }
  );
  await handleApiResponse(response);
  return response.json();
}

/**
 * Lists all Docker images for an agent type.
 */
export async function listAgentImages(agentType: AgentType): Promise<ListImagesResponse> {
  const response = await apiFetch(
    `${API_BASE_URL}/api/agents/${agentType}/images`,
    { credentials: 'include' }
  );
  await handleApiResponse(response);
  return response.json();
}

/**
 * Resolves a version specification to an actual semver version.
 */
export async function resolveAgentVersion(
  agentType: AgentType,
  versionType: CliVersionType,
  versionSpec?: string
): Promise<ResolveVersionResponse> {
  const response = await apiFetch(
    `${API_BASE_URL}/api/agents/resolve-version`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentType, versionType, versionSpec }),
      credentials: 'include'
    }
  );
  await handleApiResponse(response);
  return response.json();
}

/**
 * Gets the Docker image tag for a version configuration.
 */
export async function getAgentImageTag(
  agentType: AgentType,
  versionType?: CliVersionType,
  versionSpec?: string
): Promise<ImageTagResponse> {
  const params = new URLSearchParams();
  if (versionType) params.append('versionType', versionType);
  if (versionSpec) params.append('versionSpec', versionSpec);

  const url = `${API_BASE_URL}/api/agents/${agentType}/image-tag${params.toString() ? '?' + params.toString() : ''}`;
  const response = await apiFetch(url, { credentials: 'include' });
  await handleApiResponse(response);
  return response.json();
}
