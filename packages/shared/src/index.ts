// Export all model definitions
export {
  type AgentType,
  type AgentDisplayInfo,
  AGENT_TYPES,
  type ModelInfo,
  CLAUDE_MODELS,
  CODEX_MODELS,
  ANTIGRAVITY_MODELS,
  OPENCODE_MODELS,
  VIBE_MODELS,
  ALL_MODELS,
  AGENT_MODELS,
  AGENT_DISPLAY,
  AGENT_DISPLAY_ORDER,
  MODEL_INFO_MAP,
  MODEL_SHORT_NAMES,
  AGENT_DEFAULTS,
  typeBadgeColors,
} from './modelDefinitions.js';

// Export event definitions for real-time updates
export {
  TASK_UPDATE,
  DRAFT_UPDATE,
  PLAN_STEP_UPDATE,
  INDEXING_UPDATE,
  TASK_LIVE_UPDATE,
  QUEUE_STATS_UPDATE,
  REDIS_CHANNELS,
  type TaskUpdatePayload,
  type DraftUpdatePayload,
  type PlanStepUpdatePayload,
  type IndexingPhase,
  type IndexingUpdatePayload,
  type TaskLiveUpdatePayload,
  type QueueStatsUpdatePayload,
  type ConversationEvent,
  type TodoItem,
  type TokenUsageInfo,
  type QueueStatsData,
  type CommandMode,
  type EventPayload,
  type DraftStatus,
  type StepStatus,
  type DraftUpdateGenerationTrace,
} from './events.js';

// Export usage configuration and metrics types
export {
  type AgentTankConfig,
  type UsageSnapshot,
  type UsageMetricRecord,
  type UsageMetrics,
} from './usageTypes.js';

export { DEMO_MODE_READ_ONLY_CODE, parseTruthyEnvValue } from './demoMode.js';

// Export user whitelist helpers
export {
  getGithubUserWhitelist,
  isGithubUserWhitelisted,
} from './userWhitelist.js';

// Export relay URL validation
export { validateRelayUrl } from './validateRelayUrl.js';

// Export the hosted propr-routing service default URLs (one source of truth for
// the webhook.propr.dev host shared by the CLI, the daemon dialer, and the
// boot/check prerequisite validators)
export {
  DEFAULT_PROPR_ROUTING_URL,
  DEFAULT_PROPR_GH_RELAY_URL,
  DEFAULT_PROPR_UI_ORIGIN,
  PROPR_UI_PROXY_SUFFIX,
  DEFAULT_CLOUDFLARED_IMAGE,
  proprInstanceProxyUrl,
  isValidProprInstanceId,
} from './proprServiceUrls.js';

// Export routing URL validation (shared by intake prerequisites and the daemon
// routing service so the boot/CLI checks and the dialer agree on one policy)
export { validateRoutingUrl } from './validateRoutingUrl.js';

// Export GitHub auth mode inference (shared by backend boot and `propr check`)
export {
  type GithubAuthMode,
  type GithubAuthModeEnv,
  type GithubAuthModeResult,
  resolveGithubAuthMode,
} from './githubAuthMode.js';

// Export GitHub event intake mode resolution (auth mode and event delivery
// mode evolve independently; replaces the legacy ENABLE_GITHUB_WEBHOOKS boolean)
export {
  type GithubEventIntakeMode,
  type GithubEventIntakeModeEnv,
  type GithubEventIntakeModeResult,
  GITHUB_EVENT_INTAKE_MODES,
  DEFAULT_GITHUB_EVENT_INTAKE_MODE,
  resolveGithubEventIntakeMode,
} from './githubEventIntakeMode.js';

// Export mode-specific GitHub intake prerequisite validation (shared by backend
// boot and `propr check` so the two agree on what each intake mode requires)
export {
  type IntakeModePrerequisitesEnv,
  type IntakeModePrerequisitesResult,
  validateIntakeModePrerequisites,
} from './intakeModePrerequisites.js';

// Export shared Redis status keys (one source of truth for cross-process status
// keys so the daemon publisher, API status route, and CLI cannot drift)
export { ROUTING_STATUS_REDIS_KEY } from './statusKeys.js';

export { shortHash, buildDynamicLlmLabel, MAX_GITHUB_LABEL_LENGTH } from './labelUtils.js';

// Export the default review guidance (the overridable part of the /review prompt)
export { DEFAULT_REVIEW_GUIDANCE } from './reviewPrompt.js';
