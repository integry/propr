import { API_BASE_URL, apiFetch, handleApiResponse } from './apiClient';

/**
 * Status enum for plan issues.
 */
export type PlanIssueStatus =
  | 'pending'
  | 'processing'
  | 'under_review'
  | 'in_refinement'
  | 'refinement_processing'
  | 'merged'
  | 'closed';

/**
 * Represents a plan issue record.
 */
export interface PlanIssue {
  id: number;
  draft_id: string;
  repository: string;
  issue_number: number;
  pr_number: number | null;
  status: PlanIssueStatus;
  agent_alias: string | null;
  model_name: string | null;
  followup_count: number;
  task_id: string | null;
  run_ultrafix?: boolean | null;
  ultrafix_goal?: number | null;
  ultrafix_max_cycles?: number | null;
  created_at: string;
  updated_at: string;
}

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
  agent_alias?: string;
  model_name?: string;
  /** Multiple agent:model combinations for parallel implementation. */
  models?: AgentModelPair[];
  /** Whether to create an Epic PR to collect all issue PRs */
  useEpic?: boolean;
  /** Whether to auto-merge individual PRs into the Epic PR */
  autoMerge?: boolean;
}

/**
 * Options for updating an issue.
 */
export interface UpdateIssueOptions {
  agent_alias?: string | null;
  model_name?: string | null;
  status?: PlanIssueStatus;
  run_ultrafix?: boolean | null;
  ultrafix_goal?: number | null;
  ultrafix_max_cycles?: number | null;
}

/**
 * Options for fetching paginated plan issues.
 */
export interface GetPlanIssuesOptions {
  page?: number;
  limit?: number;
  status?: PlanIssueStatus;
}

/**
 * Paginated response for plan issues.
 */
export interface PaginatedPlanIssuesResponse {
  issues: PlanIssue[];
  total: number;
  page: number;
  limit: number;
  hasMore: boolean;
}

/**
 * Response from implement issue endpoint.
 */
export interface ImplementIssueResponse {
  success: boolean;
  message: string;
}

/**
 * Fetches all plan issues for a draft.
 */
export const getPlanIssues = async (draftId: string): Promise<PlanIssue[]> => {
  const response = await apiFetch(`${API_BASE_URL}/api/planner/drafts/${draftId}/issues`, {
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};

/**
 * Fetches plan issues for a draft with pagination support.
 */
export const getPlanIssuesPaginated = async (
  draftId: string,
  options: GetPlanIssuesOptions = {}
): Promise<PaginatedPlanIssuesResponse> => {
  const params = new URLSearchParams();
  if (options.page !== undefined) params.set('page', options.page.toString());
  if (options.limit !== undefined) params.set('limit', options.limit.toString());
  if (options.status) params.set('status', options.status);

  const queryString = params.toString();
  const url = `${API_BASE_URL}/api/planner/drafts/${draftId}/issues${queryString ? `?${queryString}` : ''}`;

  const response = await apiFetch(url, {
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};

/**
 * Triggers implementation for a single issue by adding the AI processing label.
 */
export const implementIssue = async (
  draftId: string,
  issueNumber: number,
  options?: ImplementIssueOptions
): Promise<ImplementIssueResponse> => {
  const response = await apiFetch(
    `${API_BASE_URL}/api/planner/drafts/${draftId}/issues/${issueNumber}/implement`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(options || {}),
      credentials: 'include'
    }
  );
  await handleApiResponse(response);
  return response.json();
};

/**
 * Updates a plan issue's agent/model configuration or status.
 */
export const updatePlanIssue = async (
  draftId: string,
  issueNumber: number,
  options: UpdateIssueOptions
): Promise<PlanIssue> => {
  const response = await apiFetch(
    `${API_BASE_URL}/api/planner/drafts/${draftId}/issues/${issueNumber}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(options),
      credentials: 'include'
    }
  );
  await handleApiResponse(response);
  return response.json();
};

/**
 * Status display configuration for the execution matrix.
 * Quiet slate for queued/finished states, teal for running work, amber when the user's attention is needed.
 */
export const STATUS_CONFIG: Record<PlanIssueStatus, {
  label: string;
  color: string;
  bgColor: string;
  borderColor: string;
  dotColor: string;
  isActive: boolean;
}> = {
  pending: {
    label: 'Pending',
    color: 'text-slate-600',
    bgColor: 'bg-white',
    borderColor: 'border-slate-200',
    dotColor: 'bg-slate-300',
    isActive: false
  },
  processing: {
    label: 'Running',
    color: 'text-teal-700',
    bgColor: 'bg-teal-50',
    borderColor: 'border-teal-200',
    dotColor: 'bg-teal-500',
    isActive: true
  },
  under_review: {
    label: 'In Review',
    color: 'text-amber-700',
    bgColor: 'bg-amber-50',
    borderColor: 'border-amber-200',
    dotColor: 'bg-amber-500',
    isActive: false
  },
  in_refinement: {
    label: 'Refining',
    color: 'text-amber-700',
    bgColor: 'bg-amber-50',
    borderColor: 'border-amber-200',
    dotColor: 'bg-amber-500',
    isActive: false
  },
  refinement_processing: {
    label: 'Running',
    color: 'text-teal-700',
    bgColor: 'bg-teal-50',
    borderColor: 'border-teal-200',
    dotColor: 'bg-teal-500',
    isActive: true
  },
  merged: {
    label: 'Completed',
    color: 'text-slate-500',
    bgColor: 'bg-slate-50',
    borderColor: 'border-slate-200',
    dotColor: 'bg-slate-400',
    isActive: false
  },
  closed: {
    label: 'Closed',
    color: 'text-slate-500',
    bgColor: 'bg-slate-50',
    borderColor: 'border-slate-200',
    dotColor: 'bg-slate-300',
    isActive: false
  }
};
