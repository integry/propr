/**
 * Task Management API
 *
 * Client wrapper for the /api/tasks backend routes.
 * Provides methods to list, get, stop, and delete tasks.
 */
import { API_BASE_URL, apiFetch, handleApiResponse } from './proprApi';

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Possible task statuses.
 */
export type TaskStatus =
  | 'pending'
  | 'queued'
  | 'processing'
  | 'claude_execution'
  | 'post_processing'
  | 'completed'
  | 'failed'
  | 'cancelled';

/**
 * Plan issue status associated with a task.
 */
export type PlanIssueStatus =
  | 'pending'
  | 'processing'
  | 'under_review'
  | 'in_refinement'
  | 'refinement_processing'
  | 'merged'
  | 'closed'
  | null;

/**
 * Represents a task in the system.
 */
export interface Task {
  /** Unique task identifier */
  id: string;
  /** Legacy alias for id */
  issueId: string;
  /** Full repository name (owner/repo) */
  repository: string;
  /** Repository owner */
  repositoryOwner: string | null;
  /** Repository name */
  repositoryName: string | null;
  /** GitHub issue number */
  issueNumber: number;
  /** Associated PR number if created */
  prNumber: number | null;
  /** Linked issue number (for PR tasks) */
  linkedIssueNumber: number | null;
  /** Task title from issue/PR */
  title: string | null;
  /** Task subtitle/description */
  subtitle: string | null;
  /** Current task status */
  status: TaskStatus;
  /** ISO timestamp when task was created */
  createdAt: string;
  /** ISO timestamp when task completed (null if not completed) */
  completedAt: string | null;
  /** ISO timestamp when task started processing (null if not started) */
  processedAt: string | null;
  /** Reason for failure (null if not failed) */
  failedReason: string | null;
  /** Progress percentage (0-100) */
  progress: number;
  /** Number of processing attempts */
  attemptsMade: number;
  /** Model name used for processing */
  modelName: string | null;
  /** Model alias */
  model: string | null;
  /** LLM provider/agent alias */
  llmProvider: string | null;
  /** Status of associated plan issue */
  planIssueStatus: PlanIssueStatus;
  /** Implementation critique score (0-100 scale) */
  critiqueScore: number | null;
}

/**
 * Token usage statistics for a task execution.
 */
export interface TokenUsage {
  input_tokens: number | null;
  output_tokens: number | null;
  cache_creation_input_tokens: number | null;
  cache_read_input_tokens: number | null;
}

/**
 * Metadata for a task history entry.
 */
export interface TaskHistoryMetadata {
  sessionId?: string;
  conversationId?: string;
  model?: string;
  duration?: number;
  success?: boolean;
  conversationTurns?: number;
  tokenUsage?: TokenUsage;
  containerId?: string;
  containerName?: string;
  pullRequest?: {
    number: number;
    url: string;
  };
  error?: string;
  commandMode?: 'default' | 'review' | 'fix';
  consumedReviewCommentIds?: number[];
  [key: string]: unknown;
}

/**
 * A single entry in a task's execution history.
 */
export interface TaskHistoryEntry {
  /** State at this point in history */
  state: string;
  /** ISO timestamp of state change */
  timestamp: string;
  /** Human-readable message */
  message?: string;
  /** Reason for state change */
  reason?: string;
  /** Path to fetch the prompt used */
  promptPath?: string;
  /** Path to fetch execution logs */
  logsPath?: string;
  /** Additional metadata for this state */
  metadata?: TaskHistoryMetadata;
}

/**
 * Information about a task retrieved with history.
 */
export interface TaskInfo {
  repoOwner: string;
  repoName: string;
  number: number;
  type: 'issue' | 'pr-comment';
  correlationId?: string;
  title: string | null;
  subtitle: string | null;
  modelName: string | null;
  issueNumber?: number;
  comments?: unknown[];
  commandMode?: 'default' | 'review' | 'fix';
}

/**
 * Complete task details including history.
 */
export interface TaskDetails {
  taskId: string;
  history: TaskHistoryEntry[];
  taskInfo: TaskInfo | null;
}

/**
 * File change information.
 */
export interface FileChange {
  filename: string;
  status: 'added' | 'modified' | 'removed' | 'renamed';
  additions: number;
  deletions: number;
  patch?: string;
}

/**
 * Options for listing tasks.
 */
export interface ListTasksOptions {
  /** Filter by repository (full name like owner/repo) */
  project?: string;
  /** Filter by task status */
  status?: TaskStatus | 'all';
  /** Maximum number of tasks to return */
  limit?: number;
  /** Number of tasks to skip for pagination */
  offset?: number;
  /** Search query to filter tasks */
  search?: string;
  /** Filter to only include tasks that need review (completed or failed) */
  forReview?: boolean;
  /** Exclude tasks where plan_issue_status is 'merged' */
  excludeMerged?: boolean;
}

/**
 * Response from listing tasks.
 */
export interface ListTasksResponse {
  tasks: Task[];
  total: number;
  offset: number;
  limit: number;
}

/**
 * Response from stopping a task.
 */
export interface StopTaskResponse {
  success: boolean;
  message: string;
  taskId: string;
  containerStopped: boolean;
  containerId?: string;
}

/**
 * Response from deleting a task.
 */
export interface DeleteTaskResponse {
  success: boolean;
  error?: string;
  message?: string;
  currentState?: string;
}

// ============================================================================
// API Functions
// ============================================================================

/**
 * Fetches a paginated list of tasks.
 *
 * @param options - Options for filtering and pagination
 * @returns Promise resolving to the list of tasks with pagination info
 *
 * @example
 * ```typescript
 * // Get all tasks
 * const result = await listTasks();
 *
 * // Get failed tasks for a specific repository
 * const result = await listTasks({
 *   project: 'owner/repo',
 *   status: 'failed',
 *   limit: 10
 * });
 * ```
 */
export const listTasks = async (options: ListTasksOptions = {}): Promise<ListTasksResponse> => {
  const params = new URLSearchParams();

  // Map 'project' to 'repository' for backend compatibility
  if (options.project) {
    params.set('repository', options.project);
  } else {
    params.set('repository', 'all');
  }

  params.set('status', options.status || 'all');
  params.set('limit', (options.limit ?? 50).toString());
  params.set('offset', (options.offset ?? 0).toString());

  if (options.search) {
    params.set('search', options.search);
  }
  if (options.forReview) {
    params.set('forReview', 'true');
  }
  if (options.excludeMerged) {
    params.set('excludeMerged', 'true');
  }

  const response = await apiFetch(`${API_BASE_URL}/api/tasks?${params.toString()}`, {
    method: 'GET',
    credentials: 'include'
  });

  await handleApiResponse(response);
  return response.json();
};

/**
 * Fetches complete task details including execution history and file changes.
 *
 * @param taskId - The unique identifier of the task
 * @returns Promise resolving to complete task details
 *
 * @example
 * ```typescript
 * const details = await getTask('task-123');
 * console.log(details.history); // Execution history entries
 * console.log(details.taskInfo); // Task metadata
 * ```
 */
export const getTask = async (taskId: string): Promise<TaskDetails> => {
  const response = await apiFetch(`${API_BASE_URL}/api/task/${encodeURIComponent(taskId)}/history`, {
    method: 'GET',
    credentials: 'include'
  });

  await handleApiResponse(response);
  return response.json();
};

/**
 * Aborts a running task's Docker container.
 *
 * This will attempt to stop the Docker container running the task execution.
 * If the container is found, it will be terminated. Otherwise, an abort signal
 * will be sent for the worker to pick up.
 *
 * @param taskId - The unique identifier of the task to stop
 * @returns Promise resolving to the stop result
 *
 * @example
 * ```typescript
 * const result = await stopTask('task-123');
 * if (result.containerStopped) {
 *   console.log('Container terminated immediately');
 * } else {
 *   console.log('Abort signal sent, task will stop shortly');
 * }
 * ```
 */
export const stopTask = async (taskId: string): Promise<StopTaskResponse> => {
  const response = await apiFetch(`${API_BASE_URL}/api/task/${encodeURIComponent(taskId)}/stop`, {
    method: 'POST',
    credentials: 'include'
  });

  await handleApiResponse(response);
  return response.json();
};

/**
 * Removes a task from the database.
 *
 * This will delete the task and all associated records including:
 * - Task history entries
 * - LLM execution records
 * - Execution details
 *
 * Note: Tasks in active states (pending, queued, processing, claude_execution,
 * post_processing) cannot be deleted unless force=true is specified.
 *
 * @param taskId - The unique identifier of the task to delete
 * @param force - If true, forcefully delete even if task is in active state
 * @returns Promise that resolves when deletion is complete
 * @throws Error if task is in active state and force is not true
 *
 * @example
 * ```typescript
 * // Delete a completed/failed task
 * await deleteTask('task-123');
 *
 * // Force delete an active task
 * await deleteTask('task-123', true);
 * ```
 */
export const deleteTask = async (taskId: string, force?: boolean): Promise<void> => {
  const url = force
    ? `${API_BASE_URL}/api/tasks/${encodeURIComponent(taskId)}?force=true`
    : `${API_BASE_URL}/api/tasks/${encodeURIComponent(taskId)}`;

  const response = await apiFetch(url, {
    method: 'DELETE',
    credentials: 'include'
  });

  // 204 No Content indicates successful deletion
  if (response.status === 204) {
    return;
  }

  // 400 indicates the task cannot be deleted (active state)
  if (response.status === 400) {
    const data: DeleteTaskResponse = await response.json();
    throw new Error(data.message || data.error || 'Cannot delete task in active state');
  }

  await handleApiResponse(response);
};

/**
 * Fetches live execution details for an active task.
 *
 * @param taskId - The unique identifier of the task
 * @returns Promise resolving to live execution details
 */
export const getTaskLiveDetails = async (taskId: string): Promise<unknown> => {
  const response = await apiFetch(`${API_BASE_URL}/api/task/${encodeURIComponent(taskId)}/live-details`, {
    method: 'GET',
    credentials: 'include'
  });

  await handleApiResponse(response);
  return response.json();
};

/**
 * Fetches analysis report for a task.
 *
 * @param taskId - The unique identifier of the task
 * @returns Promise resolving to task analysis
 */
export const getTaskAnalysis = async (taskId: string): Promise<{
  analysis: unknown | null;
  message?: string;
}> => {
  const response = await apiFetch(`${API_BASE_URL}/api/task/${encodeURIComponent(taskId)}/analysis`, {
    method: 'GET',
    credentials: 'include'
  });

  // 202 indicates analysis is still pending
  if (response.status === 202) {
    return { analysis: null, message: 'Analysis pending...' };
  }

  await handleApiResponse(response);
  return response.json();
};
