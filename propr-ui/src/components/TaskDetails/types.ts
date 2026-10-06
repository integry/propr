import type { LiveOutputPosition, PublishedVisualPreview } from '@propr/shared';

export interface TokenUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

/** A task's estimated spend against its run spend cap, from the task history API. */
export interface TaskBudget {
  spentUsd: number;
  /** null when the run is uncapped. */
  capUsd: number | null;
  /** Spend as a share of the cap; null when uncapped. */
  percent: number | null;
  source: 'override' | 'workflow' | 'instance_default' | null;
  /** The run was stopped at its cap. */
  exceeded: boolean;
}

export interface UsageMetricRecord {
  agent: string;
  metricKey: string;
  metricValue: number;
}

export interface UsageMetrics {
  preCall?: Record<string, unknown>;
  postCall?: Record<string, unknown>;
  delta?: Record<string, unknown>;
  timestamp?: string;
  agent?: string;
}

export type PushRejectionClass = 'push_protection' | 'ruleset_or_branch_protection' | 'non_fast_forward' | 'auth' | 'network' | 'unknown';

/** Which salvage rung kept the commits of a rejected push (`retry` means the push succeeded). */
export interface PushSalvageEvent {
  rung: 'retry' | 'rescue_ref' | 'bundle' | 'worktree' | 'none';
  classification: PushRejectionClass;
  summary: string;
  rescueRef?: string;
  bundlePath?: string;
  worktreePath?: string;
  recoveryInstruction?: string;
  unblockUrls?: string[];
}

/** Stored on the FAILED entry of a task whose final push was rejected. */
export interface PushFailure {
  diagnosis: { classification: PushRejectionClass; summary: string; unblockUrls: string[]; excerpt?: string };
  rung: 'rescue_ref' | 'bundle' | 'worktree' | 'none';
  branchName: string;
  repository: string;
  rescueRef?: string;
  bundlePath?: string;
  worktreePath?: string;
  recoveryInstruction: string;
}

export interface HistoryItemMetadata {
  repositoryWorkflow?: { path: string; baseBranch: string; revision: string; fileRevision: string; maxParallelTasks: number; timeoutMs: number };
  /** Admission refusals so far for a task waiting on repository workflow capacity. */
  repositoryWorkflowDeferrals?: number;
  /** ISO timestamp of the next admission attempt. */
  repositoryWorkflowRetryAt?: string;
  terminalReason?: string;
  /** `budget.exceeded`: the run was stopped at its spend cap. */
  event?: string;
  budget?: { capUsd: number; spentUsd: number; priorSpentUsd?: number; percent?: number; source?: 'override' | 'workflow' | 'instance_default' };
  pushFailure?: PushFailure;
  pushSalvage?: PushSalvageEvent;
  model?: string;
  pr?: { url?: string; number?: number };
  pullRequest?: { url?: string; number?: number };
  description?: string;
  commitResult?: { commitHash?: string; commitMessage?: string };
  tokenUsage?: TokenUsage;
  commandMode?: 'default' | 'review' | 'fix' | 'switch' | 'use' | 'ultrafix';
  consumedReviewCommentIds?: number[];
  /** Legacy entries store `true`; current entries store the 1-based cycle number. */
  ultrafixCycle?: boolean | number;
  ultrafixGoal?: number;
  ultrafixCycleCount?: number;
  ultrafixMaxCycles?: number;
  ultrafixScore?: number;
  ultrafixNextAction?: string;
  ultrafixStopReason?: string;
  ultrafixOutcome?: 'goal_reached' | 'cycles_exhausted' | 'stopped' | 'failed';
  syntheticRouting?: {
    virtualAgentAlias?: string;
    virtualModel?: string;
    physicalAgentAlias?: string;
    physicalModel?: string;
    memberId?: string;
    callId?: string;
    attemptNumber?: number;
    selectionReason?: string;
    requiredTokens?: number;
  };
}

export interface HistoryItem {
  state?: string;
  timestamp?: string;
  promptPath?: string;
  logsPath?: string;
  reason?: string;
  metadata?: HistoryItemMetadata;
}

export interface TaskInfo {
  title?: string;
  subtitle?: string;
  type?: string;
  number?: number;
  issueNumber?: number;
  repoOwner?: string;
  repoName?: string;
  modelName?: string;
  model?: string;
  llmProvider?: string;
  commandMode?: 'default' | 'review' | 'fix' | 'switch' | 'use' | 'ultrafix';
  /** Normalized by the API: `true` whenever any history entry belongs to an ultrafix cycle. */
  ultrafixCycle?: boolean;
  previewMedia?: PublishedVisualPreview[];
  /** Set when a schedule created the task. */
  scheduleId?: string | null;
  /** The schedule's name; null once the schedule is deleted. */
  scheduleName?: string | null;
}

export interface PromptData {
  prompt?: string;
  error?: string;
  sessionId?: string;
  model?: string;
  timestamp?: string;
  isRetry?: boolean;
  issueRef?: {
    repoOwner?: string;
    repoName?: string;
    number?: number;
  };
}

export interface LogFileInfo {
  name: string;
  path: string;
  size: number;
  type: string;
}

export interface LogFilesData {
  sessionId?: string | null;
  logFiles?: LogFileInfo[] | null;
  error?: string | null;
  files?: Record<string, string> | null;
}

export interface SelectedLogFileData {
  name: string;
  content: string | object;
  isJson: boolean;
}

export interface TodoItem {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export interface LiveEvent {
  // `user_input` is produced only by the goal timeline merge; provider streams never emit it.
  type: 'thought' | 'tool_use' | 'tool_result' | 'user_input';
  content?: string;
  timestamp?: string;
  toolName?: string;
  input?: Record<string, unknown> & { file_path?: string; command?: string };
  id?: string;
  toolUseId?: string;
  result?: unknown;
  isError?: boolean;
  isSubagentSummary?: boolean;
  /** Delivery state of a `user_input` event. */
  inputState?: 'pending' | 'delivered' | 'undeliverable';
  /** Number of files sent alongside a `user_input` message. */
  attachmentCount?: number;
}

export interface LiveDetails {
  events: LiveEvent[];
  todos: TodoItem[];
  currentTask: string | null;
  tokenUsage?: TokenUsage | null;
  /** Raw terminal events of this execution not held here; readable events are never left out. */
  omittedEventCount?: number;
  /** The server discarded earlier output of this execution; neither `events` nor `omittedEventCount` accounts for it. */
  historyTruncated?: boolean;
  /** Where in the live output log this state was read (see `LiveOutputPosition`). */
  liveOutputPosition?: LiveOutputPosition;
}
