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
  /** Files manually excluded from context by the user */
  excludedFiles?: string[];
}

export interface PlanGenerationOptions {
  baseBranch?: string;
  granularity?: Granularity;
  contextLevel?: number;
  compress?: boolean;
  contextRepositories?: ContextRepository[];
  /** Model to use for plan generation (e.g., 'opus', 'claude:claude-opus-4-5-20251101') */
  generationModel?: string;
  /** Files manually excluded from context by the user */
  excludedFiles?: string[];
}

export interface CreateDraftOptions {
  /** Optional array of to-do IDs to link to the draft */
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
  /** Files manually excluded from context by the user */
  excludedFiles?: string[];
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

export interface RepositoryInfo {
  defaultBranch: string;
  branches: string[];
}
