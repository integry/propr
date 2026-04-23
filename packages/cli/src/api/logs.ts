/**
 * LLM Logs API
 *
 * Functions for interacting with the ProPR backend LLM logs endpoints.
 * These functions provide a typed interface to list and filter LLM execution logs.
 */

import { ApiClient, createApiClient } from "./index.js";

/**
 * An LLM log entry from the API.
 */
export interface LlmLogEntry {
  /**
   * The log entry ID.
   */
  logId: number;

  /**
   * The type of execution (e.g., "plan", "implement", "review").
   */
  executionType: string;

  /**
   * The model name used for the execution.
   */
  modelName: string | null;

  /**
   * When the execution started.
   */
  startTime: string | null;

  /**
   * When the execution ended.
   */
  endTime: string | null;

  /**
   * Duration of the execution in milliseconds.
   */
  durationMs: number | null;

  /**
   * Whether the execution was successful.
   */
  success: boolean;

  /**
   * Number of input tokens used.
   */
  inputTokens: number | null;

  /**
   * Number of output tokens generated.
   */
  outputTokens: number | null;

  /**
   * Cache creation input tokens.
   */
  cacheCreationInputTokens: number | null;

  /**
   * Cache read input tokens.
   */
  cacheReadInputTokens: number | null;

  /**
   * Cost in USD for the execution.
   */
  costUsd: number | null;

  /**
   * Error message if the execution failed.
   */
  errorMessage: string | null;

  /**
   * Session ID for the execution.
   */
  sessionId: string | null;

  /**
   * Correlation ID for tracking related operations.
   */
  correlationId: string | null;

  /**
   * Draft ID if associated with a plan.
   */
  draftId: string | null;

  /**
   * Repository in owner/name format.
   */
  repository: string | null;

  /**
   * Agent alias that performed the execution.
   */
  agentAlias: string | null;

  /**
   * Additional metadata for the execution.
   */
  metadata: Record<string, unknown> | null;

  /**
   * Work type discriminator: 'task', 'plan', or 'repository'.
   */
  workType: 'task' | 'plan' | 'repository' | null;

  /**
   * Internal task ID (e.g., BullMQ job id).
   */
  taskId: string | null;

  /**
   * GitHub issue number for the task.
   */
  taskNumber: number | null;

  /**
   * GitHub PR number for PR follow-up work.
   */
  prNumber: number | null;

  /**
   * Plan/draft ID that owns this call.
   */
  planDraftId: string | null;

  /**
   * Specific plan-issue row within a draft.
   */
  planIssueId: number | null;

  /**
   * Repository in owner/repo format for work context.
   */
  workRepository: string | null;
}

/**
 * Pagination information for log results.
 */
export interface LlmLogsPagination {
  /**
   * Current page number.
   */
  page: number;

  /**
   * Number of items per page.
   */
  limit: number;

  /**
   * Total number of log entries.
   */
  total: number;

  /**
   * Total number of pages.
   */
  totalPages: number;

  /**
   * Whether there is a next page.
   */
  hasNextPage: boolean;

  /**
   * Whether there is a previous page.
   */
  hasPreviousPage: boolean;
}

/**
 * Response from the list LLM logs endpoint.
 */
export interface ListLlmLogsResponse {
  /**
   * Array of LLM log entries.
   */
  logs: LlmLogEntry[];

  /**
   * Pagination information.
   */
  pagination: LlmLogsPagination;
}

/**
 * Options for listing LLM logs.
 */
export interface ListLlmLogsOptions {
  /**
   * Page number (1-indexed).
   */
  page?: number;

  /**
   * Maximum number of logs to return per page.
   */
  limit?: number;

  /**
   * Filter by execution type.
   */
  executionType?: string;

  /**
   * Filter by model name.
   */
  model?: string;

  /**
   * Filter by success status.
   */
  success?: boolean;

  /**
   * Filter by draft ID.
   */
  draftId?: string;

  /**
   * Filter by agent alias.
   */
  agentAlias?: string;

  /**
   * Filter by work type ('task', 'plan', or 'repository').
   */
  workType?: string;
}

/**
 * Lists LLM logs from the backend with optional filtering.
 *
 * @param options - Optional filtering and pagination options.
 * @param client - Optional ApiClient instance. If not provided, one will be created.
 * @returns A promise resolving to the list of logs with pagination info.
 *
 * @example
 * ```typescript
 * // List all logs
 * const result = await listLlmLogs();
 * console.log(`Found ${result.pagination.total} logs`);
 *
 * // List logs for a specific model
 * const result = await listLlmLogs({ model: "claude-3-opus" });
 *
 * // List logs with pagination
 * const result = await listLlmLogs({ page: 2, limit: 20 });
 * ```
 */
export async function listLlmLogs(
  options: ListLlmLogsOptions = {},
  client?: ApiClient
): Promise<ListLlmLogsResponse> {
  const apiClient = client ?? (await createApiClient());

  const params: Record<string, string> = {};

  if (options.page !== undefined) {
    params.page = String(options.page);
  }
  if (options.limit !== undefined) {
    params.limit = String(options.limit);
  }
  if (options.executionType !== undefined) {
    params.execution_type = options.executionType;
  }
  if (options.model !== undefined) {
    params.model = options.model;
  }
  if (options.success !== undefined) {
    params.success = options.success ? "true" : "false";
  }
  if (options.draftId !== undefined) {
    params.draft_id = options.draftId;
  }
  if (options.agentAlias !== undefined) {
    params.agent_alias = options.agentAlias;
  }
  if (options.workType !== undefined) {
    params.work_type = options.workType;
  }

  const response = await apiClient.get<ListLlmLogsResponse>("/api/llm-logs", {
    params,
  });

  return response.data;
}
