import { API_BASE_URL, apiFetch, handleApiResponse } from './apiClient';
import type { PlanTask } from './plannerTypes';

export type PlanRevisionCause = 'generation' | 'refinement' | 'manual_edit' | 'restore' | 'rename' | 'unknown';

/** An earlier plan version or rename event, with the cause that created it. */
export interface PlanRevisionSummary {
  revision_id: number;
  draft_revision: number;
  status_before: string | null;
  status_after: string | null;
  cause: PlanRevisionCause;
  nameBefore: string | null;
  nameAfter: string | null;
  currentCause: PlanRevisionCause;
  replaced_at: string;
  issue_count: number;
  titles: string[];
}

export interface PlanRevision extends PlanRevisionSummary {
  plan: PlanTask[];
}

export interface RestorePlanRevisionResponse {
  success: boolean;
  plan_json: PlanTask[];
  status: string;
  mcp_revision: number;
}

export const listPlanRevisions = async (draftId: string): Promise<PlanRevisionSummary[]> => {
  const response = await apiFetch(`${API_BASE_URL}/api/planner/drafts/${draftId}/revisions`, { credentials: 'include' });
  await handleApiResponse(response);
  return (await response.json()).revisions;
};

export const getPlanRevision = async (draftId: string, revisionId: number): Promise<PlanRevision> => {
  const response = await apiFetch(`${API_BASE_URL}/api/planner/drafts/${draftId}/revisions/${revisionId}`, { credentials: 'include' });
  await handleApiResponse(response);
  return response.json();
};

/** Makes an earlier plan current again. The plan it replaces is kept in the history. */
export const restorePlanRevision = async (draftId: string, revisionId: number): Promise<RestorePlanRevisionResponse> => {
  const response = await apiFetch(`${API_BASE_URL}/api/planner/drafts/${draftId}/revisions/${revisionId}/restore`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};
