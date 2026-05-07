export interface SystemStatus {
  daemon: string;
  workers: { id: number; status: string }[];
  redis: string;
  githubAuth: string;
  claudeAuth: string;
}

export interface StatusResponse {
  daemon: string;
  workerCount?: number;
  redis: string;
  githubAuth: string;
  claudeAuth: string;
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
  type: 'claude' | 'codex' | 'gemini';
  alias: string;
  enabled: boolean;
  dockerImage: string;
  configPath: string;
  supportedModels: string[];
  defaultModel?: string;
  envVars?: Record<string, string>;
  modelCustomLabels?: Record<string, string>;
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
  pr_review_model?: string;
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
  custom_prompt?: string;
  default_prompt?: string;
}

export interface TriggerReindexAllResponse {
  success: boolean;
  repositoriesQueued: number;
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
