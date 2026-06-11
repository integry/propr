/**
 * Implementation API
 *
 * Functions for interacting with the ProPR backend implementation endpoints.
 * These functions provide a typed interface to trigger issue implementations
 * and poll task status.
 */

import { ApiClient, createApiClient } from "./index.js";

/**
 * Represents a single agent:model combination for multi-agent assignment.
 */
export interface AgentModelPair {
  agent_alias: string;
  model_name: string;
}

/**
 * Options for implementing an issue.
 */
export interface ImplementIssueOptions {
  /**
   * The agent alias to use for implementation.
   */
  agent_alias?: string;

  /**
   * The model name to use for implementation.
   */
  model_name?: string;

  /**
   * Multiple agent:model combinations for parallel implementation.
   */
  models?: AgentModelPair[];

  /**
   * Whether to create an Epic PR to collect all issue PRs.
   */
  useEpic?: boolean;

  /**
   * Whether to auto-merge individual PRs into the Epic PR.
   */
  autoMerge?: boolean;
}

/**
 * Response from implement issue endpoint.
 */
export interface ImplementIssueResponse {
  /**
   * Whether the implementation request was successful.
   */
  success: boolean;

  /**
   * A message describing the result.
   */
  message: string;

  /**
   * The task ID for polling status (if available).
   */
  taskId?: string;

  /**
   * Whether auto-merge was enabled for this issue implementation.
   */
  autoMergeEnabled?: boolean;

  /**
   * The epic label name if an epic was created.
   */
  epicLabel?: string | null;
}

/**
 * Task state values.
 */
export type TaskState =
  | "pending"
  | "queued"
  | "processing"
  | "claude_execution"
  | "post_processing"
  | "completed"
  | "failed"
  | "cancelled";

/**
 * Token usage information for an execution.
 */
export interface TokenUsage {
  input_tokens: number | null;
  output_tokens: number | null;
  cache_creation_input_tokens: number | null;
  cache_read_input_tokens: number | null;
}

/**
 * Metadata for a history entry.
 */
export interface TaskHistoryMetadata {
  sessionId?: string;
  conversationId?: string;
  model?: string;
  duration?: number;
  success?: boolean;
  conversationTurns?: number;
  tokenUsage?: TokenUsage;
  error?: string;
  pullRequest?: {
    number: number;
    url: string;
  };
  [key: string]: unknown;
}

/**
 * A single entry in the task history.
 */
export interface TaskHistoryEntry {
  /**
   * The state of the task at this point.
   */
  state: string;

  /**
   * The timestamp when this state was recorded.
   */
  timestamp: string;

  /**
   * Optional reason (typically for failures).
   */
  reason?: string;

  /**
   * Optional message describing the state.
   */
  message?: string;

  /**
   * Path to the prompt for this execution.
   */
  promptPath?: string;

  /**
   * Path to the logs for this execution.
   */
  logsPath?: string;

  /**
   * Additional metadata for this history entry.
   */
  metadata?: TaskHistoryMetadata;
}

/**
 * Information about a task.
 */
export interface TaskInfo {
  /**
   * Repository owner.
   */
  repoOwner: string;

  /**
   * Repository name.
   */
  repoName: string;

  /**
   * Issue or PR number.
   */
  number: number;

  /**
   * Type of task (issue or pr-comment).
   */
  type: "issue" | "pr-comment";

  /**
   * Task title.
   */
  title?: string | null;

  /**
   * Task subtitle.
   */
  subtitle?: string | null;

  /**
   * Model name used.
   */
  modelName?: string;

  /**
   * Correlation ID for tracking.
   */
  correlationId?: string;

  /**
   * Original issue number (for PR tasks).
   */
  issueNumber?: number;
}

/**
 * Response from getTaskStatus endpoint.
 */
export interface TaskStatusResponse {
  /**
   * The task ID.
   */
  taskId: string;

  /**
   * History of state transitions.
   */
  history: TaskHistoryEntry[];

  /**
   * Information about the task.
   */
  taskInfo: TaskInfo | null;
}

/**
 * Parsed task status with convenience fields.
 */
export interface TaskStatus {
  /**
   * The task ID.
   */
  taskId: string;

  /**
   * Current state of the task.
   */
  currentState: TaskState | string;

  /**
   * Whether the task is still in progress.
   */
  isInProgress: boolean;

  /**
   * Whether the task completed successfully.
   */
  isCompleted: boolean;

  /**
   * Whether the task failed.
   */
  isFailed: boolean;

  /**
   * Failure reason if the task failed.
   */
  failureReason?: string;

  /**
   * Full history of state transitions.
   */
  history: TaskHistoryEntry[];

  /**
   * Information about the task.
   */
  taskInfo: TaskInfo | null;

  /**
   * PR number if one was created.
   */
  prNumber?: number;

  /**
   * PR URL if one was created.
   */
  prUrl?: string;
}

/**
 * Triggers implementation for a specific issue/task.
 *
 * This function calls the backend endpoint to start implementing an issue
 * that was created as part of a plan. The backend identifies issues using
 * the combination of draft ID and issue number.
 *
 * @param draftId - The unique identifier of the plan draft containing the issue.
 * @param issueNumber - The GitHub issue number to implement.
 * @param options - Optional configuration for the implementation.
 * @param client - Optional ApiClient instance. If not provided, one will be created.
 * @returns A promise resolving to the implementation response containing task ID for polling.
 *
 * @example
 * ```typescript
 * // Implement a single issue with default settings
 * const result = await implementIssue("draft-123", 1);
 * console.log(result.message);
 * if (result.taskId) {
 *   // Poll for status using the task ID
 *   const status = await getTaskStatus(result.taskId);
 * }
 *
 * // Implement with a specific model
 * const result = await implementIssue("draft-123", 1, {
 *   agent_alias: "claude-code",
 *   model_name: "claude-sonnet-4-20250514"
 * });
 *
 * // Implement with Epic PR and auto-merge
 * const result = await implementIssue("draft-123", 1, {
 *   useEpic: true,
 *   autoMerge: true
 * });
 * ```
 */
export async function implementIssue(
  draftId: string,
  issueNumber: number,
  options: ImplementIssueOptions = {},
  client?: ApiClient
): Promise<ImplementIssueResponse> {
  const apiClient = client ?? (await createApiClient());

  const body: Record<string, unknown> = {};

  if (options.agent_alias !== undefined) {
    body.agent_alias = options.agent_alias;
  }
  if (options.model_name !== undefined) {
    body.model_name = options.model_name;
  }
  if (options.models !== undefined) {
    body.models = options.models;
  }
  if (options.useEpic !== undefined) {
    body.useEpic = options.useEpic;
  }
  if (options.autoMerge !== undefined) {
    body.autoMerge = options.autoMerge;
  }

  const endpoint = `/api/planner/drafts/${encodeURIComponent(draftId)}/issues/${encodeURIComponent(String(issueNumber))}/implement`;

  const response = await apiClient.post<ImplementIssueResponse>(endpoint, {
    body,
  });

  return response.data;
}

/**
 * Fetches the status of an executing background task.
 *
 * This function retrieves the current state and history of a task,
 * allowing the CLI to poll for progress and completion.
 *
 * @param taskId - The unique identifier of the task to check.
 * @param client - Optional ApiClient instance. If not provided, one will be created.
 * @returns A promise resolving to the parsed task status with convenience fields.
 *
 * @example
 * ```typescript
 * // Get the status of a task
 * const status = await getTaskStatus("task-abc123");
 * console.log(`Current state: ${status.currentState}`);
 *
 * if (status.isCompleted) {
 *   console.log("Task completed successfully!");
 *   if (status.prNumber) {
 *     console.log(`PR created: #${status.prNumber}`);
 *   }
 * } else if (status.isFailed) {
 *   console.log(`Task failed: ${status.failureReason}`);
 * } else if (status.isInProgress) {
 *   console.log("Task is still running...");
 * }
 * ```
 */
export async function getTaskStatus(
  taskId: string,
  client?: ApiClient
): Promise<TaskStatus> {
  const apiClient = client ?? (await createApiClient());

  const endpoint = `/api/task/${encodeURIComponent(taskId)}/history`;

  const response = await apiClient.get<TaskStatusResponse>(endpoint);

  return parseTaskStatus(response.data);
}

/**
 * Parses the raw task status response into a more convenient format.
 *
 * @param response - The raw task status response from the API.
 * @returns A parsed TaskStatus with convenience fields.
 */
function parseTaskStatus(response: TaskStatusResponse): TaskStatus {
  const { taskId, history, taskInfo } = response;

  // Get the latest state from history
  const latestEntry = history.length > 0 ? history[history.length - 1] : null;
  const currentState = latestEntry?.state?.toLowerCase() || "pending";

  // Determine status flags
  const completedStates = ["completed", "failed", "cancelled"];
  const inProgressStates = ["pending", "queued", "processing", "claude_execution", "post_processing"];

  const isCompleted = currentState === "completed";
  const isFailed = currentState === "failed" || currentState === "cancelled";
  const isInProgress = !completedStates.includes(currentState) && inProgressStates.includes(currentState);

  // Extract failure reason
  let failureReason: string | undefined;
  if (isFailed) {
    failureReason = latestEntry?.reason || latestEntry?.message || latestEntry?.metadata?.error as string | undefined;
  }

  // Extract PR information from history
  let prNumber: number | undefined;
  let prUrl: string | undefined;

  for (const entry of history) {
    if (entry.metadata?.pullRequest) {
      prNumber = entry.metadata.pullRequest.number;
      prUrl = entry.metadata.pullRequest.url;
      break;
    }
  }

  return {
    taskId,
    currentState: currentState as TaskState,
    isInProgress,
    isCompleted,
    isFailed,
    failureReason,
    history,
    taskInfo,
    prNumber,
    prUrl,
  };
}
