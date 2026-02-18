import { handleApiResponse, API_BASE_URL } from './gitfixApi';

export interface GenerationStepData {
  keywords?: string[];
  files?: Array<{ path: string; reason: string; score: number }>;
  includedFiles?: string[];
  tokenCount?: number;
  /** Estimated duration in milliseconds for this step */
  estimatedDuration?: number;
  /** ISO timestamp when this step started */
  startedAt?: string;
  /** Whether the estimate is based on historical data */
  isHistoricalEstimate?: boolean;
  /** Number of historical samples used for estimation */
  sampleCount?: number;
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
  initial_prompt: string;
  status: 'draft' | 'review' | 'generating' | 'refining' | 'approved' | 'executed' | 'pr_created' | 'merged';
  attachments: PlannerAttachment[];
  created_at: string;
  generation_trace?: GenerationTrace;
}

export interface PlannerAttachment {
  id: string;
  originalName: string;
  tokenEstimate: number;
  type?: 'image' | 'text';
  mimeType?: string;
}

export interface ContextStats {
  tokenCount: number;
  costEstimate: number;
  smartFiles: number;
}

export type Granularity = 'single' | 'balanced' | 'granular';

/**
 * Configuration for an additional context repository.
 * These repositories provide examples and documentation only - no code changes will be made to them.
 */
export interface ContextRepository {
  /** Repository identifier in format "owner/repo" */
  repository: string;
  /** Optional branch, defaults to the repository's default branch */
  branch?: string;
  /** Optional description of what this repository provides (e.g., "UI component examples") */
  description?: string;
}

/**
 * Metadata about granularity enforcement actions applied during plan generation
 */
export interface GranularityEnforcementMetadata {
  /** Whether enforcement was applied (tasks were merged) */
  enforced: boolean;
  /** The granularity setting that was used */
  granularity: Granularity;
  /** Original task count before enforcement */
  originalTaskCount: number;
  /** Final task count after enforcement */
  finalTaskCount: number;
  /** Human-readable message about the enforcement action */
  message?: string;
}

export interface SmartFileSelection {
  path: string;
  reason: string;
  source: 'manual' | 'auto';
  score?: number;
}

export interface PreviewStats {
  totalTokens: number;
  costEstimate: number;
  contextLength: number;
  fileCount: number;
  maxTokens?: number;
  /** Name of the model used for context limits (e.g., "Claude Sonnet 4.5") */
  modelName?: string;
  /** Full context window size of the model in tokens (e.g., 200000, 1000000) */
  modelMaxContextTokens?: number;
}

export interface PreviewResult {
  success: boolean;
  stats: PreviewStats;
  smartSelection: SmartFileSelection[];
  warnings: string[];
}

export interface PreviewOptions {
  draftId: string;
  prompt: string;
  baseBranch: string;
  granularity: Granularity;
  contextLevel?: number;
  compress?: boolean;
  files?: string[];
  /** Model to use for plan generation (determines context limits) */
  generationModel?: string;
}

export interface PlanGenerationOptions {
  baseBranch?: string;
  granularity?: Granularity;
  contextLevel?: number;
  compress?: boolean;
  contextRepositories?: ContextRepository[];
  /** Model to use for plan generation (e.g., 'opus', 'claude:claude-opus-4-5-20251101') */
  generationModel?: string;
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

export interface PlanTask {
  id: string;
  title: string;
  body: string;
  implementation: string;
  notes?: string;
  attachments?: PlannerAttachment[];
  issue_number?: number;
  issue_url?: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

/**
 * Context configuration stored with the draft, including granularity enforcement info
 */
export interface DraftContextConfig {
  baseBranch?: string;
  granularity?: Granularity;
  contextLevel?: number;
  compress?: boolean;
  manualFiles?: string[];
  autoFiles?: string[];
  /** Additional repositories to include as reference context only (no code changes) */
  contextRepositories?: ContextRepository[];
  /** Granularity enforcement metadata (populated after plan generation) */
  granularityEnforcement?: GranularityEnforcementMetadata;
  /** Model to use for plan generation (e.g., 'opus', 'claude:claude-opus-4-5-20251101') */
  generationModel?: string;
}

export interface RefinementResult {
  /** Status of the refinement: 'in_progress' during processing, 'completed' when done */
  status?: 'in_progress' | 'completed';
  action?: 'modified' | 'answered' | 'both';
  summary?: string;
  timestamp?: string;
  /** ISO timestamp when refinement started */
  startedAt?: string;
  /** Estimated duration in milliseconds */
  estimatedDuration?: number;
  /** Whether the estimate is based on historical data */
  isHistoricalEstimate?: boolean;
  /** Number of historical samples used for estimation */
  sampleCount?: number;
}

export interface DraftWithPlan extends PlannerDraft {
  plan_json: PlanTask[];
  chat_history?: ChatMessage[];
  context_config?: DraftContextConfig;
  refinement_result?: RefinementResult;
  // These fields are dynamically added by the backend
  task_title?: string;
  title?: string;
  name?: string;
}

export const getDraftWithPlan = async (id: string): Promise<DraftWithPlan> => {
  const response = await fetch(`${API_BASE_URL}/api/planner/drafts/${id}`, {
    credentials: 'include'
  });
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

export interface RefineResponse {
  plan: PlanTask[];
  message: string;
}

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

export interface FinalizeResponse {
  success: boolean;
  issuesCreated: number;
  alreadyExecuted?: boolean;
}

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

export interface IssueSummary {
  total: number;
  pending: number;
  processing: number;
  merged: number;
  closed: number;
}

export interface DraftListItem {
  draft_id: string;
  repository: string;
  name?: string;
  initial_prompt: string;
  status: 'draft' | 'review' | 'executed' | 'generating' | 'refining' | 'approved' | 'pr_created' | 'merged';
  updated_at: string;
  created_at: string;
  issue_summary?: IssueSummary | null;
}

export interface GetDraftsOptions {
  page?: number;
  limit?: number;
  repository?: string;
  search?: string;
  status?: string;
  /** Comma-separated list of statuses to exclude (e.g., 'merged,executed') */
  excludeStatuses?: string;
}

export interface PaginatedDraftsResponse {
  drafts: DraftListItem[];
  total: number;
  page: number;
  limit: number;
  hasMore: boolean;
}

export const getDrafts = async (options: GetDraftsOptions = {}): Promise<PaginatedDraftsResponse> => {
  const params = new URLSearchParams();
  if (options.page !== undefined) params.append('page', options.page.toString());
  if (options.limit !== undefined) params.append('limit', options.limit.toString());
  if (options.repository && options.repository !== 'all') params.append('repository', options.repository);
  if (options.search && options.search.trim()) params.append('search', options.search.trim());
  if (options.status && options.status !== 'all') params.append('status', options.status);
  if (options.excludeStatuses) params.append('excludeStatuses', options.excludeStatuses);

  const queryString = params.toString();
  const url = queryString
    ? `${API_BASE_URL}/api/planner/drafts?${queryString}`
    : `${API_BASE_URL}/api/planner/drafts`;

  const response = await fetch(url, {
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

export interface RepositoryInfo {
  defaultBranch: string;
  branches: string[];
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
