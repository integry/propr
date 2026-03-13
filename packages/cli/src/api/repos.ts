/**
 * Repository Configuration API
 *
 * Functions for interacting with the ProPR backend repository configuration endpoints.
 * These functions provide a typed interface to list, add, update, and remove monitored repositories.
 */

import { ApiClient, createApiClient } from "./index.js";

/**
 * A monitored repository configuration.
 */
export interface MonitoredRepo {
  /**
   * Unique identifier for the repository configuration.
   */
  id: string;

  /**
   * The full repository name in "owner/repo" format.
   */
  name: string;

  /**
   * Whether monitoring is enabled for this repository.
   */
  enabled: boolean;

  /**
   * Optional display alias for the repository.
   */
  alias?: string;

  /**
   * Optional base branch name (defaults to main/master if not specified).
   */
  baseBranch?: string;
}

/**
 * Response from the get repos endpoint.
 */
export interface GetReposResponse {
  /**
   * Array of monitored repository configurations.
   */
  repos_to_monitor: MonitoredRepo[];
}

/**
 * Options for adding a new repository.
 */
export interface AddRepoOptions {
  /**
   * Optional display alias for the repository.
   */
  alias?: string;

  /**
   * Optional base branch name.
   */
  baseBranch?: string;

  /**
   * Whether monitoring is enabled. Defaults to true.
   */
  enabled?: boolean;
}

/**
 * Options for updating a repository.
 */
export interface UpdateRepoOptions {
  /**
   * Optional new display alias.
   */
  alias?: string;

  /**
   * Optional new base branch name.
   */
  baseBranch?: string;

  /**
   * Optional new enabled state.
   */
  enabled?: boolean;
}

/**
 * Response from add/update/remove operations.
 */
export interface RepoConfigResponse {
  /**
   * Whether the operation was successful.
   */
  success: boolean;

  /**
   * Updated list of monitored repositories.
   */
  repos_to_monitor: MonitoredRepo[];
}

/**
 * Fetches the list of monitored repositories.
 *
 * @param client - Optional ApiClient instance. If not provided, one will be created.
 * @returns A promise resolving to the list of monitored repositories.
 *
 * @example
 * ```typescript
 * const result = await getRepos();
 * console.log(`Monitoring ${result.repos_to_monitor.length} repositories`);
 * for (const repo of result.repos_to_monitor) {
 *   console.log(`- ${repo.name} (${repo.enabled ? 'enabled' : 'disabled'})`);
 * }
 * ```
 */
export async function getRepos(client?: ApiClient): Promise<GetReposResponse> {
  const apiClient = client ?? (await createApiClient());

  const response = await apiClient.get<GetReposResponse>("/api/config/repos");

  return response.data;
}

/**
 * Adds a new repository to the monitored list.
 *
 * @param fullName - The full repository name in "owner/repo" format.
 * @param options - Optional configuration for the repository.
 * @param client - Optional ApiClient instance. If not provided, one will be created.
 * @returns A promise resolving to the updated repository configuration.
 *
 * @example
 * ```typescript
 * // Add a repository with default settings
 * const result = await addRepo("owner/repo");
 *
 * // Add a repository with custom settings
 * const result = await addRepo("owner/repo", {
 *   alias: "my-project",
 *   baseBranch: "develop"
 * });
 * ```
 */
export async function addRepo(
  fullName: string,
  options: AddRepoOptions = {},
  client?: ApiClient
): Promise<RepoConfigResponse> {
  const apiClient = client ?? (await createApiClient());

  // First, fetch the current list of repos
  const currentRepos = await getRepos(apiClient);

  // Check if repo already exists
  const existingRepo = currentRepos.repos_to_monitor.find(
    (r) => r.name.toLowerCase() === fullName.toLowerCase()
  );
  if (existingRepo) {
    throw new Error(`Repository "${fullName}" is already being monitored`);
  }

  // Create new repo entry
  const newRepo: MonitoredRepo = {
    id: crypto.randomUUID(),
    name: fullName,
    enabled: options.enabled ?? true,
    alias: options.alias?.trim() || undefined,
    baseBranch: options.baseBranch?.trim() || undefined,
  };

  // Add to list and save
  const updatedRepos = [...currentRepos.repos_to_monitor, newRepo];

  const response = await apiClient.post<RepoConfigResponse>("/api/config/repos", {
    body: { repos_to_monitor: updatedRepos },
  });

  return response.data;
}

/**
 * Updates an existing monitored repository.
 *
 * @param fullName - The full repository name in "owner/repo" format.
 * @param updates - The fields to update.
 * @param client - Optional ApiClient instance. If not provided, one will be created.
 * @returns A promise resolving to the updated repository configuration.
 *
 * @example
 * ```typescript
 * // Enable a repository
 * const result = await updateRepo("owner/repo", { enabled: true });
 *
 * // Update multiple fields
 * const result = await updateRepo("owner/repo", {
 *   alias: "new-alias",
 *   baseBranch: "main"
 * });
 * ```
 */
export async function updateRepo(
  fullName: string,
  updates: UpdateRepoOptions,
  client?: ApiClient
): Promise<RepoConfigResponse> {
  const apiClient = client ?? (await createApiClient());

  // Fetch current repos
  const currentRepos = await getRepos(apiClient);

  // Find the repo to update
  const repoIndex = currentRepos.repos_to_monitor.findIndex(
    (r) => r.name.toLowerCase() === fullName.toLowerCase()
  );

  if (repoIndex === -1) {
    throw new Error(`Repository "${fullName}" is not being monitored`);
  }

  // Apply updates
  const existingRepo = currentRepos.repos_to_monitor[repoIndex];
  const updatedRepo: MonitoredRepo = {
    ...existingRepo,
    ...(updates.enabled !== undefined && { enabled: updates.enabled }),
    ...(updates.alias !== undefined && { alias: updates.alias?.trim() || undefined }),
    ...(updates.baseBranch !== undefined && { baseBranch: updates.baseBranch?.trim() || undefined }),
  };

  // Replace in list
  const updatedRepos = [...currentRepos.repos_to_monitor];
  updatedRepos[repoIndex] = updatedRepo;

  const response = await apiClient.post<RepoConfigResponse>("/api/config/repos", {
    body: { repos_to_monitor: updatedRepos },
  });

  return response.data;
}

/**
 * Removes a repository from the monitored list.
 *
 * @param fullName - The full repository name in "owner/repo" format.
 * @param client - Optional ApiClient instance. If not provided, one will be created.
 * @returns A promise resolving to the updated repository configuration.
 *
 * @example
 * ```typescript
 * const result = await removeRepo("owner/repo");
 * console.log(`Now monitoring ${result.repos_to_monitor.length} repositories`);
 * ```
 */
export async function removeRepo(
  fullName: string,
  client?: ApiClient
): Promise<RepoConfigResponse> {
  const apiClient = client ?? (await createApiClient());

  // Fetch current repos
  const currentRepos = await getRepos(apiClient);

  // Find the repo to remove
  const repoIndex = currentRepos.repos_to_monitor.findIndex(
    (r) => r.name.toLowerCase() === fullName.toLowerCase()
  );

  if (repoIndex === -1) {
    throw new Error(`Repository "${fullName}" is not being monitored`);
  }

  // Remove from list
  const updatedRepos = currentRepos.repos_to_monitor.filter(
    (_, index) => index !== repoIndex
  );

  const response = await apiClient.post<RepoConfigResponse>("/api/config/repos", {
    body: { repos_to_monitor: updatedRepos },
  });

  return response.data;
}

/**
 * Repository API namespace providing all repository configuration operations.
 *
 * @example
 * ```typescript
 * import { reposApi } from "@propr/cli/api";
 *
 * // List all monitored repos
 * const { repos_to_monitor } = await reposApi.getRepos();
 *
 * // Add a new repo
 * await reposApi.addRepo("owner/repo", { alias: "my-project" });
 *
 * // Update a repo
 * await reposApi.updateRepo("owner/repo", { enabled: false });
 *
 * // Remove a repo
 * await reposApi.removeRepo("owner/repo");
 * ```
 */
export const reposApi = {
  getRepos,
  addRepo,
  updateRepo,
  removeRepo,
} as const;
