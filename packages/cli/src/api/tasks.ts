/**
 * Tasks API
 *
 * Functions for interacting with the ProPR backend task management endpoints.
 * These functions provide a typed interface to list, get, stop, and delete tasks.
 */

import { ApiClient, createApiClient } from "./index.js";

/**
 * A task summary returned from the list endpoint.
 */
export interface TaskSummary {
  /**
   * The task ID.
   */
  id: string;

  /**
   * The repository in owner/name format.
   */
  repository: string;

  /**
   * Repository owner.
   */
  repositoryOwner: string | null;

  /**
   * Repository name.
   */
  repositoryName: string | null;

  /**
   * Issue number associated with the task.
   */
  issueNumber: number;

  /**
   * PR number if one was created.
   */
  prNumber: number | null;

  /**
   * Linked issue number for PR tasks.
   */
  linkedIssueNumber: number | null;

  /**
   * Task title.
   */
  title: string | null;

  /**
   * Task subtitle.
   */
  subtitle: string | null;

  /**
   * Current status of the task.
   */
  status: string;

  /**
   * When the task was created.
   */
  createdAt: string;

  /**
   * When the task completed (if applicable).
   */
  completedAt: string | null;

  /**
   * When processing started (if applicable).
   */
  processedAt: string | null;

  /**
   * Failure reason if task failed.
   */
  failedReason: string | null;

  /**
   * Progress percentage (0-100).
   */
  progress: number;

  /**
   * Model name used for the task.
   */
  modelName: string | null;

  /**
   * LLM provider used.
   */
  llmProvider: string | null;

  /**
   * Plan issue status if part of a plan.
   */
  planIssueStatus: string | null;

  /**
   * Critique score from analysis.
   */
  critiqueScore: number | null;
}

/**
 * Response from the list tasks endpoint.
 */
export interface ListTasksResponse {
  /**
   * Array of task summaries.
   */
  tasks: TaskSummary[];

  /**
   * Total number of tasks matching the filters.
   */
  total: number;

  /**
   * Current offset for pagination.
   */
  offset: number;

  /**
   * Current limit for pagination.
   */
  limit: number;
}

/**
 * Options for listing tasks.
 */
export interface ListTasksOptions {
  /**
   * Filter by status (e.g., "pending", "completed", "failed", or "all").
   */
  status?: string;

  /**
   * Filter by repository in owner/name format.
   */
  repository?: string;

  /**
   * Maximum number of tasks to return.
   */
  limit?: number;

  /**
   * Offset for pagination.
   */
  offset?: number;

  /**
   * Search term for filtering tasks.
   */
  search?: string;
}

/**
 * Response from stop task endpoint.
 */
export interface StopTaskResponse {
  /**
   * Whether the stop request was successful.
   */
  success: boolean;

  /**
   * A message describing the result.
   */
  message: string;
}

/**
 * Lists tasks from the backend with optional filtering.
 *
 * @param options - Optional filtering and pagination options.
 * @param client - Optional ApiClient instance. If not provided, one will be created.
 * @returns A promise resolving to the list of tasks with pagination info.
 *
 * @example
 * ```typescript
 * // List all tasks
 * const result = await listTasks();
 * console.log(`Found ${result.total} tasks`);
 *
 * // List tasks for a specific project
 * const result = await listTasks({ repository: "owner/repo" });
 *
 * // List tasks with a specific status
 * const result = await listTasks({ status: "completed" });
 * ```
 */
export async function listTasks(
  options: ListTasksOptions = {},
  client?: ApiClient
): Promise<ListTasksResponse> {
  const apiClient = client ?? (await createApiClient());

  const params: Record<string, string> = {};

  if (options.status !== undefined) {
    params.status = options.status;
  }
  if (options.repository !== undefined) {
    params.repository = options.repository;
  }
  if (options.limit !== undefined) {
    params.limit = String(options.limit);
  }
  if (options.offset !== undefined) {
    params.offset = String(options.offset);
  }
  if (options.search !== undefined) {
    params.search = options.search;
  }

  const response = await apiClient.get<ListTasksResponse>("/api/tasks", {
    params,
  });

  return response.data;
}

/**
 * Stops a running task by cancelling it.
 *
 * This function sends a cancellation request to the backend to stop
 * a task that is currently in progress.
 *
 * @param taskId - The unique identifier of the task to stop.
 * @param client - Optional ApiClient instance. If not provided, one will be created.
 * @returns A promise resolving to the stop response.
 *
 * @example
 * ```typescript
 * // Stop a running task
 * const result = await stopTask("task-abc123");
 * if (result.success) {
 *   console.log("Task stopped successfully");
 * }
 * ```
 */
export async function stopTask(
  taskId: string,
  client?: ApiClient
): Promise<StopTaskResponse> {
  const apiClient = client ?? (await createApiClient());

  const endpoint = `/api/task/${encodeURIComponent(taskId)}/cancel`;

  const response = await apiClient.post<StopTaskResponse>(endpoint);

  return response.data;
}

/**
 * Deletes a task from the system.
 *
 * This function removes a task and its associated data from the backend.
 * By default, it will not delete tasks that are in an active state.
 * Use the force option to override this check.
 *
 * @param taskId - The unique identifier of the task to delete.
 * @param force - If true, force deletion even for active tasks.
 * @param client - Optional ApiClient instance. If not provided, one will be created.
 * @returns A promise that resolves when the task is deleted.
 *
 * @example
 * ```typescript
 * // Delete a completed task
 * await deleteTask("task-abc123");
 *
 * // Force delete an active task
 * await deleteTask("task-abc123", true);
 * ```
 */
export async function deleteTask(
  taskId: string,
  force: boolean = false,
  client?: ApiClient
): Promise<void> {
  const apiClient = client ?? (await createApiClient());

  const endpoint = `/api/task/${encodeURIComponent(taskId)}`;
  const params: Record<string, string> = {};

  if (force) {
    params.force = "true";
  }

  await apiClient.delete(endpoint, { params });
}
