import { handleApiResponse, API_BASE_URL } from './proprApi';

// Re-export all types for backward compatibility
export * from './plannerTypes';

import type {
  PlannerDraft, PlannerAttachment, ContextStats, PlanGenerationOptions,
  CreateDraftOptions, PreviewOptions, PreviewResult, DraftWithPlan,
  PlanTask, ChatMessage, RefineResponse, FinalizeResponse,
  PaginatedDraftsResponse, GetDraftsOptions, RepositoryInfo,
  ValidateContextRepositoryResponse, ReviseDraftResponse, PauseResumeResponse
} from './plannerTypes';

export const createDraft = async (repository: string, prompt: string, options?: CreateDraftOptions): Promise<PlannerDraft> => {
  const response = await fetch(`${API_BASE_URL}/api/planner/drafts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repository, prompt, todoIds: options?.todoIds }),
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};

export const getDraft = async (id: string): Promise<PlannerDraft> => {
  const response = await fetch(`${API_BASE_URL}/api/planner/drafts/${id}`, { credentials: 'include' });
  await handleApiResponse(response);
  return response.json();
};

export const getContextStats = async (draftId: string, config: { level: string }): Promise<ContextStats> => {
  const response = await fetch(`${API_BASE_URL}/api/planner/context/stats`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ draftId, ...config }),
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
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

export const generatePlan = async (draftId: string, options?: PlanGenerationOptions): Promise<void> => {
  const response = await fetch(`${API_BASE_URL}/api/planner/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ draftId, ...options }),
    credentials: 'include'
  });
  await handleApiResponse(response);
};

export const previewContext = async (options: PreviewOptions, signal?: AbortSignal): Promise<PreviewResult> => {
  const response = await fetch(`${API_BASE_URL}/api/planner/preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options),
    credentials: 'include',
    signal
  });
  await handleApiResponse(response);
  return response.json();
};

export const getDraftWithPlan = async (id: string): Promise<DraftWithPlan> => {
  const response = await fetch(`${API_BASE_URL}/api/planner/drafts/${id}`, { credentials: 'include' });
  await handleApiResponse(response);
  return response.json();
};

export const updateDraft = async (draftId: string, data: { plan_json?: PlanTask[]; chat_history?: ChatMessage[]; initial_prompt?: string; name?: string }): Promise<void> => {
  const response = await fetch(`${API_BASE_URL}/api/planner/drafts/${draftId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
    credentials: 'include'
  });
  await handleApiResponse(response);
};

export const refinePlan = async (draftId: string, currentPlan: PlanTask[], instruction: string, signal?: AbortSignal): Promise<RefineResponse> => {
  const response = await fetch(`${API_BASE_URL}/api/planner/refine`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ draftId, plan: currentPlan, instruction }),
    credentials: 'include',
    signal
  });
  await handleApiResponse(response);
  return response.json();
};

export const finalizePlan = async (draftId: string): Promise<FinalizeResponse> => {
  const response = await fetch(`${API_BASE_URL}/api/planner/finalize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ draftId }),
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};

export const getDrafts = async (options: GetDraftsOptions = {}): Promise<PaginatedDraftsResponse> => {
  const params = new URLSearchParams();
  if (options.page !== undefined) params.append('page', options.page.toString());
  if (options.limit !== undefined) params.append('limit', options.limit.toString());
  if (options.repository && options.repository !== 'all') params.append('repository', options.repository);
  if (options.search && options.search.trim()) params.append('search', options.search.trim());
  if (options.status && options.status !== 'all') params.append('status', options.status);
  if (options.excludeStatuses) params.append('excludeStatuses', options.excludeStatuses);
  const queryString = params.toString();
  const url = queryString ? `${API_BASE_URL}/api/planner/drafts?${queryString}` : `${API_BASE_URL}/api/planner/drafts`;
  const response = await fetch(url, { credentials: 'include' });
  await handleApiResponse(response);
  return response.json();
};

export const deleteDraft = async (draftId: string): Promise<void> => {
  const response = await fetch(`${API_BASE_URL}/api/planner/drafts/${draftId}`, {
    method: 'DELETE',
    credentials: 'include'
  });
  await handleApiResponse(response);
};

export const resetDraftToSetup = async (draftId: string): Promise<PlannerDraft> => {
  const response = await fetch(`${API_BASE_URL}/api/planner/drafts/${draftId}/reset-to-setup`, {
    method: 'POST',
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};

export const getRepositoryInfo = async (draftId: string): Promise<RepositoryInfo> => {
  const response = await fetch(`${API_BASE_URL}/api/planner/drafts/${draftId}/repository-info`, { credentials: 'include' });
  await handleApiResponse(response);
  return response.json();
};

export const getAttachmentUrl = (draftId: string, attachmentId: string): string => {
  return `${API_BASE_URL}/api/planner/drafts/${draftId}/attachments/${attachmentId}`;
};

export const downloadContext = async (options: PreviewOptions): Promise<Blob> => {
  const response = await fetch(`${API_BASE_URL}/api/planner/preview/context`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options),
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.blob();
};

export const validateContextRepository = async (repository: string, branch?: string): Promise<ValidateContextRepositoryResponse> => {
  const response = await fetch(`${API_BASE_URL}/api/planner/validate-context-repository`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repository, branch }),
    credentials: 'include'
  });
  const data = await response.json();
  return data;
};

export const abortGeneration = async (draftId: string): Promise<void> => {
  const response = await fetch(`${API_BASE_URL}/api/planner/abort`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ draftId }),
    credentials: 'include'
  });
  await handleApiResponse(response);
};

export const abortRefinement = async (draftId: string): Promise<void> => {
  const response = await fetch(`${API_BASE_URL}/api/planner/abort-refinement`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ draftId }),
    credentials: 'include'
  });
  await handleApiResponse(response);
};

export const reviseDraft = async (draftId: string): Promise<ReviseDraftResponse> => {
  const response = await fetch(`${API_BASE_URL}/api/planner/drafts/${draftId}/revise`, {
    method: 'POST',
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};

export const pauseDraft = async (draftId: string): Promise<PauseResumeResponse> => {
  const response = await fetch(`${API_BASE_URL}/api/planner/drafts/${draftId}/pause`, {
    method: 'POST',
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};

export const resumeDraft = async (draftId: string): Promise<PauseResumeResponse> => {
  const response = await fetch(`${API_BASE_URL}/api/planner/drafts/${draftId}/resume`, {
    method: 'POST',
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};
