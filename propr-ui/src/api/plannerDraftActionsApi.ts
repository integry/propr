import { handleApiResponse, API_BASE_URL } from './proprApi';
import type { PlannerDraft, PlannerAttachment } from './plannerApi';

export interface RepositoryInfo {
  defaultBranch: string;
  branches: string[];
}

export interface ReviseDraftResponse {
  success: boolean;
  message: string;
  previousStatus: string;
  issuesDetached: number;
}

export interface PauseResumeResponse {
  paused: boolean;
  pausedAt: string | null;
}

/** Response from validating a context repository */
export interface ValidateContextRepositoryResponse {
  valid: boolean;
  repository: string;
  defaultBranch?: string;
  description?: string;
  error?: string;
}

export const getRepositoryInfo = async (draftId: string): Promise<RepositoryInfo> => {
  const response = await fetch(`${API_BASE_URL}/api/planner/drafts/${draftId}/repository-info`, {
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};

export const getAttachmentUrl = (draftId: string, attachmentId: string): string => {
  return `${API_BASE_URL}/api/planner/drafts/${draftId}/attachments/${attachmentId}`;
};

export const uploadAttachment = async (draftId: string, file: File): Promise<PlannerAttachment> => {
  const formData = new FormData();
  formData.append('file', file);
  const response = await fetch(`${API_BASE_URL}/api/planner/drafts/${draftId}/attachments`, {
    method: 'POST',
    body: formData,
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};

export const removeAttachment = async (draftId: string, attachmentId: string): Promise<void> => {
  const response = await fetch(`${API_BASE_URL}/api/planner/drafts/${draftId}/attachments/${attachmentId}`, {
    method: 'DELETE',
    credentials: 'include'
  });
  await handleApiResponse(response);
};

export const deleteDraft = async (draftId: string): Promise<void> => {
  const response = await fetch(`${API_BASE_URL}/api/planner/drafts/${draftId}`, {
    method: 'DELETE',
    credentials: 'include'
  });
  await handleApiResponse(response);
};

/** Reset a draft from 'review' back to 'draft' status for re-configuration */
export const resetDraftToSetup = async (draftId: string): Promise<PlannerDraft> => {
  const response = await fetch(`${API_BASE_URL}/api/planner/drafts/${draftId}/reset-to-setup`, {
    method: 'POST',
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};

/** Validate that a context repository exists and is accessible */
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
  const data = await response.json();
  return data;
};

/** Abort an in-progress plan generation */
export const abortGeneration = async (draftId: string): Promise<void> => {
  const response = await fetch(`${API_BASE_URL}/api/planner/abort`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ draftId }),
    credentials: 'include'
  });
  await handleApiResponse(response);
};

/** Abort an in-progress plan refinement */
export const abortRefinement = async (draftId: string): Promise<void> => {
  const response = await fetch(`${API_BASE_URL}/api/planner/abort-refinement`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ draftId }),
    credentials: 'include'
  });
  await handleApiResponse(response);
};

/** Revise a draft plan - moves it back to review, detaching existing issues */
export const reviseDraft = async (draftId: string): Promise<ReviseDraftResponse> => {
  const response = await fetch(`${API_BASE_URL}/api/planner/drafts/${draftId}/revise`, {
    method: 'POST',
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};

/** Pause plan execution - current task completes but next won't start */
export const pauseDraft = async (draftId: string): Promise<PauseResumeResponse> => {
  const response = await fetch(`${API_BASE_URL}/api/planner/drafts/${draftId}/pause`, {
    method: 'POST',
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};

/** Resume plan execution - pending issues can be triggered again */
export const resumeDraft = async (draftId: string): Promise<PauseResumeResponse> => {
  const response = await fetch(`${API_BASE_URL}/api/planner/drafts/${draftId}/resume`, {
    method: 'POST',
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};
