import { handleApiResponse, API_BASE_URL } from './proprApi';
import type { PlannerDraft } from './plannerTypes';

export interface ReviseDraftResponse {
  success: boolean;
  message: string;
  previousStatus: string;
  issuesDetached: number;
}

/**
 * Revise a draft plan - moves it from any active/completed status back to review,
 * detaching existing issues but preserving plan data and chat history.
 * This allows the user to iterate on a plan even after execution.
 */
export const reviseDraft = async (draftId: string): Promise<ReviseDraftResponse> => {
  const response = await fetch(`${API_BASE_URL}/api/planner/drafts/${draftId}/revise`, {
    method: 'POST',
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};

export interface PauseResumeResponse {
  paused: boolean;
  pausedAt: string | null;
}

/**
 * Pause plan execution. When paused, the current task continues to completion
 * but the next pending issue won't be automatically triggered.
 */
export const pauseDraft = async (draftId: string): Promise<PauseResumeResponse> => {
  const response = await fetch(`${API_BASE_URL}/api/planner/drafts/${draftId}/pause`, {
    method: 'POST',
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};

/**
 * Resume plan execution. After resuming, pending issues can be triggered again.
 */
export const resumeDraft = async (draftId: string): Promise<PauseResumeResponse> => {
  const response = await fetch(`${API_BASE_URL}/api/planner/drafts/${draftId}/resume`, {
    method: 'POST',
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};

/**
 * Reset a draft from 'review' status back to 'draft' status.
 * This allows the user to return to the setup wizard and modify their configuration.
 * The plan_json is cleared but context_config (settings) are preserved.
 */
export const resetDraftToSetup = async (draftId: string): Promise<PlannerDraft> => {
  const response = await fetch(`${API_BASE_URL}/api/planner/drafts/${draftId}/reset-to-setup`, {
    method: 'POST',
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};

/**
 * Abort an in-progress plan generation.
 * Sets an abort signal in Redis and resets the draft status to 'draft'.
 */
export const abortGeneration = async (draftId: string): Promise<void> => {
  const response = await fetch(`${API_BASE_URL}/api/planner/abort`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ draftId }),
    credentials: 'include'
  });
  await handleApiResponse(response);
};

/**
 * Abort an in-progress plan refinement.
 * Sets an abort signal in Redis and resets the draft status to 'review'.
 */
export const abortRefinement = async (draftId: string): Promise<void> => {
  const response = await fetch(`${API_BASE_URL}/api/planner/abort-refinement`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ draftId }),
    credentials: 'include'
  });
  await handleApiResponse(response);
};

/**
 * Response from validating a context repository
 */
export interface ValidateContextRepositoryResponse {
  /** Whether the repository is valid and accessible */
  valid: boolean;
  /** The repository identifier that was validated */
  repository: string;
  /** Default branch of the repository (if valid) */
  defaultBranch?: string;
  /** Description of the repository (if available) */
  description?: string;
  /** Error message if validation failed */
  error?: string;
}

/**
 * Validate that a context repository exists and is accessible.
 * Use this before adding a repository to the context repositories list.
 */
export const validateContextRepository = async (
  repository: string,
  branch?: string
): Promise<ValidateContextRepositoryResponse> => {
  const response = await fetch(`${API_BASE_URL}/api/planner/validate-context-repository`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repository, branch }),
    credentials: 'include'
  });
  // Don't use handleApiResponse here since we want to return the error details
  const data = await response.json();
  return data;
};
