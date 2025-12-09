import { handleApiResponse, API_BASE_URL } from './gitfixApi';

export interface GenerationStepData {
  keywords?: string[];
  files?: Array<{ path: string; reason: string; score: number }>;
  includedFiles?: string[];
  tokenCount?: number;
}

export interface GenerationStep {
  name: 'relevance' | 'context' | 'llm';
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  data?: GenerationStepData;
}

export interface GenerationTrace {
  steps: GenerationStep[];
}

export interface PlannerDraft {
  draft_id: string;
  repository: string;
  prompt: string;
  status: 'draft' | 'review' | 'generating';
  attachments: PlannerAttachment[];
  created_at: string;
  generation_trace?: GenerationTrace;
}

export interface PlannerAttachment {
  id: string;
  originalName: string;
  tokenEstimate: number;
}

export interface ContextStats {
  tokenCount: number;
  costEstimate: number;
  smartFiles: number;
}

export const createDraft = async (repository: string, prompt: string): Promise<PlannerDraft> => {
  const response = await fetch(`${API_BASE_URL}/api/planner/drafts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repository, prompt }),
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};

export const getDraft = async (id: string): Promise<PlannerDraft> => {
  const response = await fetch(`${API_BASE_URL}/api/planner/drafts/${id}`, {
    credentials: 'include'
  });
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

export const generatePlan = async (draftId: string): Promise<void> => {
  const response = await fetch(`${API_BASE_URL}/api/planner/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ draftId }),
    credentials: 'include'
  });
  await handleApiResponse(response);
};

export interface PlanTask {
  id: string;
  title: string;
  body: string;
  files: string[];
}

export interface DraftWithPlan extends PlannerDraft {
  plan_json: PlanTask[];
}

export const getDraftWithPlan = async (id: string): Promise<DraftWithPlan> => {
  const response = await fetch(`${API_BASE_URL}/api/planner/drafts/${id}`, {
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};

export const updateDraft = async (draftId: string, data: { plan_json: PlanTask[] }): Promise<void> => {
  const response = await fetch(`${API_BASE_URL}/api/planner/drafts/${draftId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
    credentials: 'include'
  });
  await handleApiResponse(response);
};

export interface RefineResponse {
  plan: PlanTask[];
  message: string;
}

export const refinePlan = async (draftId: string, currentPlan: PlanTask[], instruction: string): Promise<RefineResponse> => {
  const response = await fetch(`${API_BASE_URL}/api/planner/refine`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ draftId, plan: currentPlan, instruction }),
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};

export const finalizePlan = async (draftId: string): Promise<{ issuesCreated: number }> => {
  const response = await fetch(`${API_BASE_URL}/api/planner/finalize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ draftId }),
    credentials: 'include'
  });
  await handleApiResponse(response);
  return response.json();
};

export interface DraftListItem {
  draft_id: string;
  repository: string;
  name?: string;
  initial_prompt: string;
  status: 'draft' | 'review' | 'executed' | 'generating';
  updated_at: string;
  created_at: string;
}

export const getDrafts = async (): Promise<DraftListItem[]> => {
  const response = await fetch(`${API_BASE_URL}/api/planner/drafts`, {
    credentials: 'include'
  });
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
