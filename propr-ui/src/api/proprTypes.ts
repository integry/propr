import type { ReasoningLevel } from '@propr/shared';

export interface SystemAgentStatus {
  id: string;
  type: 'claude' | 'codex' | 'antigravity' | 'vibe' | string;
  alias: string;
  status: string;
}

export interface SystemStatus {
  daemon: string;
  workers: { id: number; status: string }[];
  redis: string;
  githubAuth: string;
  claudeAuth: string;
  indexing: string;
  // Human-readable name of the configured GitHub event intake path
  // (e.g. "ProPR Connect", "Polling", "Direct Webhook").
  githubEventIntake: string;
  // UI status string for the active intake path (e.g. "Connected", "Active",
  // "Disconnected", "Unknown").
  githubEventIntakeStatus: string;
  agents: SystemAgentStatus[];
  warnings?: SystemWarning[];
}

export interface SystemWarning {
  type: string;
  message: string;
}

export interface StatusResponse {
  version?: string;
  apiCompatibility?: string;
  uiCompatibility?: string;
  daemon: string;
  workerCount?: number;
  redis: string;
  githubAuth: string;
  claudeAuth: string;
  indexing?: string;
  // Raw intake mode/status from the backend. Optional so responses from older
  // backends that predate these fields still map cleanly.
  githubEventIntake?: string;
  githubEventIntakeStatus?: string;
  agents?: SystemAgentStatus[];
  warnings?: SystemWarning[];
}

export interface TaskAnalysisResponse {
  analysis: unknown | null;
  message?: string;
}

export interface QueueStats {
  active: number;
  waiting: number;
  completed: number;
  failed: number;
  delayed: number;
  paused: number;
}

export interface GeneratingPlansResponse {
  count: number;
}

export interface GetTasksOptions {
  status?: string;
  limit?: number;
  offset?: number;
  repository?: string;
  search?: string;
  forReview?: boolean;
  excludeMerged?: boolean;
}

export interface MonitoredRepo {
  id: string;
  name: string;
  enabled: boolean;
  alias?: string;
  baseBranch?: string;
  starred?: boolean;
  hidden?: boolean;
}

export interface RepoConfigResponse {
  repos_to_monitor: MonitoredRepo[];
}

export interface RepoBranchesResponse {
  branches: string[];
  defaultBranch: string;
}

export interface StopExecutionResponse {
  success: boolean;
  containerStopped: boolean;
  containerId?: string;
  message?: string;
}

export interface DeleteTaskResponse {
  error?: string;
  message?: string;
  currentState?: string;
}

export interface AgentConfig {
  id: string;
  type: 'claude' | 'codex' | 'antigravity' | 'opencode' | 'vibe';
  alias: string;
  enabled: boolean;
  dockerImage: string;
  configPath: string;
  supportedModels: string[];
  defaultModel?: string;
  envVars?: Record<string, string>;
  modelCustomLabels?: Record<string, string>;
  modelReasoningLevels?: Record<string, ReasoningLevel>;
}

export interface SystemSettings {
  default_agent_alias?: string;
  worker_concurrency?: string | number;
  github_user_whitelist?: string[];
  analysis_model_fast?: string;
  planner_context_model?: string;
  planner_generation_model?: string;
  auto_followup_score_threshold?: number;
  auto_resolve_merge_conflicts?: boolean;
  model_reasoning_level?: string;
  pr_review_model?: string;
  pr_review_prompt?: string;
  ultrafix_rating_goal?: number;
  ultrafix_max_cycles?: number;
  ultrafix_pause_seconds?: number;
  invalid_settings?: Record<string, unknown>;
}

export interface RevertParams {
  repo: string;
  pr: string;
  commit: string;
  commentId: string;
  owner: string;
}

export interface CommitInfo {
  sha: string;
  shortSha: string;
  message: string;
  author: string;
  date: string | null;
}

export interface RevertPreviewResponse {
  branch: string;
  baseBranch: string;
  targetCommit: { sha: string; shortSha: string };
  newHead: CommitInfo | null;
  commitsToRemove: CommitInfo[];
  remainingCommits: CommitInfo[];
  willRevertToBase: boolean;
}

export interface SummarizationSettings {
  enabled: boolean;
  agent_alias: string;
  fallback_agent_alias?: string;
  custom_prompt?: string;
  default_prompt?: string;
  runtime?: {
    primary_quota_failures: number;
    warning?: {
      mode: string;
      message: string;
      recorded_at: string;
    };
    cooldowns: Record<string, {
      repository: string;
      branch: string;
      until: string;
      reason: string;
    }>;
  };
}

export interface TriggerReindexAllResponse {
  success: boolean;
  repositoriesQueued: number;
  repositoriesSkippedCooldown?: number;
  repositoriesSkippedAlreadyQueued?: number;
  repositoriesFailedClone?: number;
  ignoreCooldown?: boolean;
}

export interface PostFollowupResponse {
  success: boolean;
  message: string;
}

export interface UserRepoPreference {
  starred?: boolean;
  hidden?: boolean;
}

export interface UserRepoPreferences {
  [repoName: string]: UserRepoPreference;
}
