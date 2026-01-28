import { handleApiResponse, API_BASE_URL } from './gitfixApi';

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
  created_at: string;
  updated_at: string;
}

/**
 * Options for implementing an issue.
 */
export interface ImplementIssueOptions {
  agent_alias?: string;
  model_name?: string;
}

/**
 * Options for updating an issue.
 */
export interface UpdateIssueOptions {
  agent_alias?: string | null;
  model_name?: string | null;
  status?: PlanIssueStatus;
}

/**
 * Options for implementing all issues.
 */
export interface ImplementAllIssuesOptions {
  agent_alias?: string;
  model_name?: string;
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
 * Response from implement all issues endpoint.
 */
export interface ImplementAllIssuesResponse {
  success: boolean;
  message: string;
  implemented: number;
  results?: Array<{
    issueNumber: number;
    success: boolean;
    error?: string;
  }>;
}

/**
 * Fetches all plan issues for a draft.
 */
export const getPlanIssues = async (draftId: string): Promise<PlanIssue[]> => {
  const response = await fetch(`${API_BASE_URL}/api/planner/drafts/${draftId}/issues`, {
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

  const response = await fetch(url, {
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
  const response = await fetch(
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
  const response = await fetch(
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
 * Triggers implementation for all pending issues in a draft.
 * Optionally sets agent/model for all issues before implementation.
 */
export const implementAllIssues = async (
  draftId: string,
  options?: ImplementAllIssuesOptions
): Promise<ImplementAllIssuesResponse> => {
  const response = await fetch(
    `${API_BASE_URL}/api/planner/drafts/${draftId}/issues/implement-all`,
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
 * Status display configuration for UI.
 */
export const STATUS_CONFIG: Record<PlanIssueStatus, {
  label: string;
  color: string;
  bgColor: string;
  borderColor: string;
  isActive: boolean;
}> = {
  pending: {
    label: 'Pending',
    color: 'text-gray-600',
    bgColor: 'bg-gray-100',
    borderColor: 'border-gray-200',
    isActive: false
  },
  processing: {
    label: 'Processing',
    color: 'text-blue-700',
    bgColor: 'bg-blue-100',
    borderColor: 'border-blue-200',
    isActive: true
  },
  under_review: {
    label: 'Under Review',
    color: 'text-purple-700',
    bgColor: 'bg-purple-100',
    borderColor: 'border-purple-200',
    isActive: false
  },
  in_refinement: {
    label: 'In Refinement',
    color: 'text-amber-700',
    bgColor: 'bg-amber-100',
    borderColor: 'border-amber-200',
    isActive: false
  },
  refinement_processing: {
    label: 'Processing Feedback',
    color: 'text-orange-700',
    bgColor: 'bg-orange-100',
    borderColor: 'border-orange-200',
    isActive: true
  },
  merged: {
    label: 'Merged',
    color: 'text-green-700',
    bgColor: 'bg-green-100',
    borderColor: 'border-green-200',
    isActive: false
  },
  closed: {
    label: 'Closed',
    color: 'text-red-700',
    bgColor: 'bg-red-100',
    borderColor: 'border-red-200',
    isActive: false
  }
};
