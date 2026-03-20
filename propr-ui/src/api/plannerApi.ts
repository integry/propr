import { handleApiResponse, API_BASE_URL } from './proprApi';

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
  status: 'draft' | 'review' | 'generating' | 'refining' | 'approved' | 'executed' | 'pr_created' | 'merged' | 'failed';
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

/** Configuration for an additional context repository (examples/docs only, no code changes) */
export interface ContextRepository {
  repository: string;
  branch?: string;
  description?: string;
}

/** Metadata about granularity enforcement actions applied during plan generation */
export interface GranularityEnforcementMetadata {
  enforced: boolean;
  granularity: Granularity;
  originalTaskCount: number;
  finalTaskCount: number;
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
  /** Additional repositories to include as reference context */
  contextRepositories?: ContextRepository[];
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

export interface CreateDraftOptions {
  /** Optional array of to-do IDs to link to the draft */
  todoIds?: string[];
}

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

// Re-export attachment functions from plannerDraftActionsApi
export { uploadAttachment, removeAttachment } from './plannerDraftActionsApi';

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

/** Context configuration stored with the draft */
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
  // Pause/resume state for plan execution
  paused?: boolean;
  paused_at?: string | null;
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
  status: 'draft' | 'review' | 'executed' | 'generating' | 'refining' | 'approved' | 'pr_created' | 'merged' | 'failed';
  updated_at: string;
  created_at: string;
  issue_summary?: IssueSummary | null;
  paused?: boolean;
  paused_at?: string | null;
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

// Re-export draft action functions from plannerDraftActionsApi
export { deleteDraft, resetDraftToSetup, getRepositoryInfo, getAttachmentUrl } from './plannerDraftActionsApi';
export type { RepositoryInfo } from './plannerDraftActionsApi';

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

// Re-export validation and action functions from plannerDraftActionsApi
export {
  validateContextRepository,
  abortGeneration,
  abortRefinement,
  reviseDraft,
  pauseDraft,
  resumeDraft
} from './plannerDraftActionsApi';
export type {
  ValidateContextRepositoryResponse,
  ReviseDraftResponse,
  PauseResumeResponse
} from './plannerDraftActionsApi';
