/**
 * Plan Management API
 *
 * Functions for interacting with the ProPR backend plan endpoints.
 * These functions provide a typed interface to list, create, and fetch plans.
 */

import { ApiClient, createApiClient, ApiResponse } from "./index.js";

/**
 * Plan status values.
 */
export type PlanStatus =
  | "draft"
  | "review"
  | "generating"
  | "refining"
  | "executed"
  | "approved"
  | "merged"
  | "pr_created"
  | "failed";

/**
 * Issue summary for a plan, showing counts by status.
 */
export interface PlanIssueSummary {
  total: number;
  pending: number;
  implementing: number;
  completed: number;
  failed: number;
}

/**
 * Plan summary returned when listing plans.
 */
export interface PlanSummary {
  draft_id: string;
  name: string;
  repository: string;
  status: PlanStatus;
  initial_prompt: string | null;
  created_at: string;
  updated_at: string;
  issue_summary?: PlanIssueSummary;
}

/**
 * Context configuration for a plan.
 */
export interface PlanContextConfig {
  [key: string]: unknown;
}

/**
 * Attachment in a plan.
 */
export interface PlanAttachment {
  id: string;
  filename: string;
  contentType: string;
  size: number;
}

/**
 * Chat message in plan history.
 */
export interface PlanChatMessage {
  role: "user" | "assistant";
  content: string;
  timestamp?: string;
}

/**
 * Full plan details returned when fetching a single plan.
 */
export interface Plan {
  draft_id: string;
  user_id: string;
  repository: string;
  name: string;
  task_title?: string;
  initial_prompt: string | null;
  plan_json: unknown[];
  context_config: PlanContextConfig;
  status: PlanStatus;
  created_at: string;
  updated_at: string;
  attachments: PlanAttachment[];
  generation_trace: Record<string, unknown>;
  chat_history: PlanChatMessage[];
  generated_context: string | null;
}

/**
 * Response when listing plans.
 */
export interface ListPlansResponse {
  drafts: PlanSummary[];
  total: number;
  page: number;
  limit: number;
  hasMore: boolean;
}

/**
 * Options for listing plans.
 */
export interface ListPlansOptions {
  /**
   * Page number (1-indexed). Defaults to 1.
   */
  page?: number;

  /**
   * Number of items per page (max 100). Defaults to 10.
   */
  limit?: number;

  /**
   * Search term to filter by name or prompt.
   */
  search?: string;

  /**
   * Filter by status.
   */
  status?: PlanStatus | "all";

  /**
   * Comma-separated list of statuses to exclude.
   */
  excludeStatuses?: string;
}

/**
 * Options for creating a plan.
 */
export interface CreatePlanOptions {
  /**
   * Initial context configuration.
   */
  contextConfig?: PlanContextConfig;

  /**
   * Additional options for plan creation.
   */
  [key: string]: unknown;
}

/**
 * Fetches plans for a specific repository.
 *
 * @param project - The repository identifier (e.g., "owner/repo").
 * @param options - Optional filtering and pagination options.
 * @param client - Optional ApiClient instance. If not provided, one will be created.
 * @returns A promise resolving to the list of plans with pagination info.
 *
 * @example
 * ```typescript
 * const result = await listPlans("owner/repo");
 * console.log(`Found ${result.total} plans`);
 * for (const plan of result.drafts) {
 *   console.log(`- ${plan.name} (${plan.status})`);
 * }
 * ```
 */
export async function listPlans(
  project: string,
  options: ListPlansOptions = {},
  client?: ApiClient
): Promise<ListPlansResponse> {
  const apiClient = client ?? (await createApiClient());

  const params: Record<string, string | number | boolean | undefined> = {
    repository: project,
    page: options.page,
    limit: options.limit,
    search: options.search,
    status: options.status,
    excludeStatuses: options.excludeStatuses,
  };

  const response = await apiClient.get<ListPlansResponse>("/api/planner/drafts", {
    params,
  });

  return response.data;
}

/**
 * Submits a new plan generation request.
 *
 * @param project - The repository identifier (e.g., "owner/repo").
 * @param prompt - The initial prompt describing the plan.
 * @param options - Optional additional options for plan creation.
 * @param client - Optional ApiClient instance. If not provided, one will be created.
 * @returns A promise resolving to the created plan.
 *
 * @example
 * ```typescript
 * const plan = await createPlan("owner/repo", "Add user authentication feature");
 * console.log(`Created plan: ${plan.draft_id}`);
 * ```
 */
export async function createPlan(
  project: string,
  prompt: string,
  options: CreatePlanOptions = {},
  client?: ApiClient
): Promise<Plan> {
  const apiClient = client ?? (await createApiClient());

  const body = {
    repository: project,
    prompt,
    ...options,
  };

  const response = await apiClient.post<Plan>("/api/planner/drafts", {
    body,
  });

  return response.data;
}

/**
 * Fetches details of a specific plan.
 *
 * @param planId - The unique identifier of the plan (draft_id).
 * @param client - Optional ApiClient instance. If not provided, one will be created.
 * @returns A promise resolving to the plan details.
 *
 * @example
 * ```typescript
 * const plan = await getPlan("abc123-uuid");
 * console.log(`Plan status: ${plan.status}`);
 * console.log(`Plan items: ${plan.plan_json.length}`);
 * ```
 */
export async function getPlan(
  planId: string,
  client?: ApiClient
): Promise<Plan> {
  const apiClient = client ?? (await createApiClient());

  const response = await apiClient.get<Plan>(`/api/planner/drafts/${encodeURIComponent(planId)}`);

  return response.data;
}

/**
 * Deletes a specific plan.
 *
 * @param planId - The unique identifier of the plan (draft_id).
 * @param client - Optional ApiClient instance. If not provided, one will be created.
 * @returns A promise that resolves when the plan is deleted.
 *
 * @example
 * ```typescript
 * await deletePlan("abc123-uuid");
 * console.log("Plan deleted successfully");
 * ```
 */
export async function deletePlan(
  planId: string,
  client?: ApiClient
): Promise<void> {
  const apiClient = client ?? (await createApiClient());

  await apiClient.delete(`/api/planner/drafts/${encodeURIComponent(planId)}`);
}

/**
 * Response from abort plan operations.
 */
export interface AbortPlanResponse {
  success: boolean;
  message: string;
}

/**
 * Aborts an ongoing plan generation.
 *
 * @param planId - The unique identifier of the plan (draft_id).
 * @param client - Optional ApiClient instance. If not provided, one will be created.
 * @returns A promise resolving to the abort response.
 *
 * @example
 * ```typescript
 * const result = await abortPlan("abc123-uuid");
 * console.log(result.message); // "Generation aborted"
 * ```
 */
export async function abortPlan(
  planId: string,
  client?: ApiClient
): Promise<AbortPlanResponse> {
  const apiClient = client ?? (await createApiClient());

  const response = await apiClient.post<AbortPlanResponse>("/api/planner/abort", {
    body: { draftId: planId },
  });

  return response.data;
}

/**
 * Response from finalizing a plan.
 */
export interface FinalizePlanResponse {
  success: boolean;
  alreadyExecuted?: boolean;
  issuesCreated: number;
  results?: Array<{ issueNumber: number; title: string }>;
}

/**
 * Finalizes a plan by creating GitHub issues from its plan items.
 *
 * @param draftId - The unique identifier of the plan draft.
 * @param client - Optional ApiClient instance. If not provided, one will be created.
 * @returns A promise resolving to the finalization response.
 */
export async function finalizePlan(
  draftId: string,
  client?: ApiClient
): Promise<FinalizePlanResponse> {
  const apiClient = client ?? (await createApiClient());

  const response = await apiClient.post<FinalizePlanResponse>(
    "/api/planner/finalize",
    { body: { draftId } }
  );

  return response.data;
}

/**
 * Options for triggering plan generation.
 */
export interface GeneratePlanOptions {
  baseBranch?: string;
  granularity?: string;
  contextLevel?: string;
  compress?: boolean;
  generationModel?: string;
}

/**
 * Triggers plan generation for an existing draft.
 *
 * @param draftId - The unique identifier of the plan draft.
 * @param options - Optional generation configuration.
 * @param client - Optional ApiClient instance. If not provided, one will be created.
 * @returns A promise resolving to the generation response.
 */
export async function generatePlan(
  draftId: string,
  options: GeneratePlanOptions = {},
  client?: ApiClient
): Promise<{ success: boolean; message?: string }> {
  const apiClient = client ?? (await createApiClient());

  const body: Record<string, unknown> = { draftId, ...options };

  const response = await apiClient.post<{ success: boolean; message?: string }>(
    "/api/planner/generate",
    { body }
  );

  return response.data;
}

/**
 * A plan issue record from the backend.
 */
export interface PlanIssue {
  id: number;
  draft_id: string;
  repository: string;
  issue_number: number;
  pr_number: number | null;
  status: string;
  agent_alias: string | null;
  model_name: string | null;
  task_id: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Lists issues associated with a plan.
 *
 * @param planId - The unique identifier of the plan (draft_id).
 * @param client - Optional ApiClient instance. If not provided, one will be created.
 * @returns A promise resolving to the list of plan issues.
 */
export async function listPlanIssues(
  planId: string,
  client?: ApiClient
): Promise<PlanIssue[]> {
  const apiClient = client ?? (await createApiClient());

  const response = await apiClient.get<PlanIssue[]>(
    `/api/planner/drafts/${encodeURIComponent(planId)}/issues`
  );

  return response.data;
}
