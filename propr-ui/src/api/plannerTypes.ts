export interface GenerationStepData {
  keywords?: string[];
  files?: Array<{ path: string; reason: string; score: number }>;
  includedFiles?: string[];
  tokenCount?: number;
  estimatedDuration?: number;
  startedAt?: string;
  isHistoricalEstimate?: boolean;
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

export interface PlannerAttachment {
  id: string;
  originalName: string;
  tokenEstimate: number;
  type?: 'image' | 'text';
  mimeType?: string;
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

export interface ContextStats {
  tokenCount: number;
  costEstimate: number;
  smartFiles: number;
}

export type Granularity = 'single' | 'balanced' | 'granular';

export interface ContextRepository {
  repository: string;
  branch?: string;
  description?: string;
}

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
  source: 'manual' | 'auto' | 'context-repo';
  /** Repository name for context-repo files (e.g., "owner/repo") */
  repository?: string;
  score?: number;
}

export interface PreviewStats {
  totalTokens: number;
  costEstimate: number;
  contextLength: number;
  fileCount: number;
  maxTokens?: number;
  modelName?: string;
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
  generationModel?: string;
  contextRepositories?: ContextRepository[];
  /** Files manually excluded from context by the user */
  excludedFiles?: string[];
}

export interface PlanGenerationOptions {
  baseBranch?: string;
  granularity?: Granularity;
  contextLevel?: number;
  compress?: boolean;
  contextRepositories?: ContextRepository[];
  generationModel?: string;
  /** Files manually excluded from context by the user */
  excludedFiles?: string[];
}

export interface CreateDraftOptions {
  todoIds?: string[];
}

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

export interface DraftContextConfig {
  baseBranch?: string;
  granularity?: Granularity;
  contextLevel?: number;
  compress?: boolean;
  manualFiles?: string[];
  autoFiles?: string[];
  contextRepositories?: ContextRepository[];
  granularityEnforcement?: GranularityEnforcementMetadata;
  generationModel?: string;
  /** Files manually excluded from context by the user */
  excludedFiles?: string[];
}

export interface RefinementResult {
  status?: 'in_progress' | 'completed';
  action?: 'modified' | 'answered' | 'both';
  summary?: string;
  timestamp?: string;
  startedAt?: string;
  estimatedDuration?: number;
  isHistoricalEstimate?: boolean;
  sampleCount?: number;
}

export interface DraftWithPlan extends PlannerDraft {
  plan_json: PlanTask[];
  chat_history?: ChatMessage[];
  context_config?: DraftContextConfig;
  refinement_result?: RefinementResult;
  task_title?: string;
  title?: string;
  name?: string;
  paused?: boolean;
  paused_at?: string | null;
}

export interface RefineResponse {
  plan: PlanTask[];
  message: string;
}

export interface FinalizeResponse {
  success: boolean;
  issuesCreated: number;
  alreadyExecuted?: boolean;
}

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
  excludeStatuses?: string;
}

export interface PaginatedDraftsResponse {
  drafts: DraftListItem[];
  total: number;
  page: number;
  limit: number;
  hasMore: boolean;
}

export interface RepositoryInfo {
  defaultBranch: string;
  branches: string[];
}
