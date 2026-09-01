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

export { MIN_SESSION_SECRET_LENGTH, validateSessionSecret } from './sessionSecret.js';

export {
  canonicalProprHttpUrlOrigin,
  isProprLoopbackHostname,
  normalizeProprApiOrigin,
  PROPR_API_ORIGIN_PARITY_CASES,
  type NormalizeProprApiOriginOptions,
} from './apiOrigin.js';

export {
  DESKTOP_REVOCATION_BINDING_HEADER,
  DESKTOP_TOKEN_REVOCATION_ENDPOINT,
  DESKTOP_TOKEN_REVOCATION_SCHEMA,
  DESKTOP_TOKEN_REVOCATION_VERSION,
  DESKTOP_TOKEN_TERMINAL_CODES,
  type DesktopTokenTerminalCode,
  type DesktopTokenTerminalRevocation,
} from './desktopTokenRevocation.js';

export {
  INSTANCE_PERMISSIONS,
  type AuthenticatedInstanceUser,
  type InstanceAuthorizationSource,
  type InstanceMember,
  type InstanceMemberSource,
  type InstanceMembersResponse,
  type InstancePermission,
  type InstanceRole,
  type InstanceRoleAuditEntry,
} from './instanceAuthorization.js';

export {
  type InstanceCatalogAgent,
  type InstanceCatalogRepository,
  type InstanceCatalogResponse,
} from './instanceCatalog.js';

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
  DESKTOP_RENDERER_ORIGIN,
  DESKTOP_TRANSPORT_SCOPE_HEADER,
  DESKTOP_TRANSPORT_SCOPE_QUERY,
  PROPR_UI_PROXY_SUFFIX,
  PROPR_UI_PROXY_LABEL_PREFIX,
  MAX_PROPR_API_BASE_URL_LENGTH,
  DEFAULT_CLOUDFLARED_IMAGE,
  proprInstanceProxyUrl,
  canonicalProprProxySelector,
  canonicalProprProxyUrl,
  isValidProprInstanceId,
  parseProprConnectEndpoint,
  isCanonicalProprConnectHostname,
  isProprConnectReservedHostAttempt,
  type ProprConnectEndpoint,
  isProprProxyUrl,
  proprTunnelEndpoints,
} from './proprServiceUrls.js';

export {
  normalizeDesktopPairingApprovalUrl,
  type DesktopPairingApprovalUrlInput,
} from './desktopPairing.js';

export {
  PROPR_CONNECT_DISCOVERY_SCHEMA_VERSION,
  PROPR_CONNECT_DISCOVERY_MAX_BYTES,
  PUBLIC_INSTANCE_IDENTITY_SCHEMA_VERSION,
  PUBLIC_INSTANCE_IDENTITY_FILENAME,
  isPublicInstanceIdentity,
  parseProprDesktopDiscovery,
  parsePublicInstanceIdentityDocument,
  type PublicInstanceIdentityDocument,
  type ProprDesktopDiscovery,
} from './connectDiscovery.js';

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

// Export the timestamp contract used at every account-status trust boundary.
export { isAccountStatusTimestamp } from './accountStatusTimestamp.js';

export {
  PROPR_VERSION,
  PROPR_API_COMPATIBILITY,
  PROPR_UI_COMPATIBILITY,
  PROPR_UI_SUPPORTED_API_COMPATIBILITY,
  getProprCompatibilityMetadata,
  evaluateProprApiCompatibility,
  type ProprCompatibilityMetadata,
  type ProprDesktopAuthenticationCapabilities,
  type ProprApiCompatibilityInput,
  type ProprApiCompatibilityResult,
} from './proprCompatibility.js';

export {
  shortHash,
  buildDynamicLlmLabel,
  buildAgentModelLlmLabel,
  MAX_GITHUB_LABEL_LENGTH,
} from './labelUtils.js';

// Export the default review guidance (the overridable part of the /review prompt)
export { DEFAULT_REVIEW_GUIDANCE } from './reviewPrompt.js';

// Export the owner/repo slug parser shared by the CLI and API
export { parseProjectSlug } from './projectSlug.js';

export { normalizeWorkEvidenceCommentIds } from './workEvidence.js';

// Export the task lifecycle vocabulary shared by the API and CLI. This keeps
// active-task workflows aligned with the states returned by the server.
export {
  TASK_LIFECYCLE_STATES,
  ACTIVE_TASK_LIFECYCLE_STATES,
  type TaskLifecycleState,
} from './taskLifecycle.js';

export {
  AGENT_LOGIN_DESCRIPTORS,
  LOGINABLE_AGENT_TYPES,
  MANAGED_AGENT_CREDENTIALS_PREFIX,
  getAgentLoginDescriptor,
  getManagedAgentConfigPath,
  getManagedAgentConfigRelativePath,
  isAgentLoginSupported,
  isManagedAgentConfigPath,
  type AgentLoginDescriptor,
  type LoginableAgentType,
} from './agentLogin.js';

export {
  REASONING_LEVELS,
  CODEX_REASONING_LEVELS,
  CLAUDE_REASONING_LEVELS,
  getReasoningLevelsForAgentType,
  isReasoningLevelSupportedByAgentType,
  isReasoningLevel,
  normalizeModelReasoningLevel,
  isReasoningLevelLabel,
  parseReasoningLevelFromLabels,
  type ReasoningLevel,
  type ModelReasoningLevel,
  type ReasoningLevelLabel,
} from './reasoningLevels.js';

// Export the durable notification contract shared by backend and UI clients.
export {
  NOTIFICATION_KINDS,
  NOTIFICATION_SEVERITIES,
  NOTIFICATION_EVENT_ACTIONS,
  NOTIFICATION_ACTION_TYPES,
  MAX_CANONICAL_TIMESTAMP_EPOCH_MS,
  WEB_PUSH_ENDPOINT_HOSTS,
  WEB_PUSH_ENDPOINT_HOST_SUFFIXES,
  NOTIFICATION_PAYLOAD_LIMITS,
  DEFAULT_NOTIFICATION_PREFERENCE_CHANNELS,
  DEFAULT_NOTIFICATION_QUIET_HOURS,
  PUSH_DELIVERY_STATUSES,
  PUSH_DELIVERY_ATTEMPT_STATUSES,
  NOTIFICATION_SOURCE_ACTIVITY_TYPES,
  NOTIFICATION_SOURCE_ACTIVITY_STATUSES,
  normalizeISO8601Timestamp,
  parseISO8601Timestamp,
  parseNotificationTarget,
  parseNotificationAction,
  parseNotificationEventActions,
  parseNotificationEvent,
  parseNotification,
  parseNotificationUserState,
  parseNotificationPreferenceChannels,
  parseNotificationPreference,
  parseNotificationPreferences,
  parseIanaTimezone,
  parseQuietHour,
  parseNotificationQuietHours,
  parseNotificationPreferencesUpdate,
  parsePushSubscriptionEndpoint,
  parsePushSubscriptionInput,
  parsePushSubscription,
  parsePushDeliveryJob,
  parsePushDeliveryAttempt,
  parseNotificationSourceActivity,
  parseNotificationListResponse,
  parseNotificationUnreadCountResponse,
  parseNotificationStateResponse,
  parseNotificationPreferencesResponse,
  parseNotificationCapabilitiesResponse,
  parsePushSubscriptionEnrollmentResponse,
  parsePushSubscriptionsResponse,
  iso8601TimestampSchema,
  notificationTargetSchema,
  notificationActionSchema,
  notificationEventActionsSchema,
  notificationEventSchema,
  notificationSchema,
  notificationUserStateSchema,
  notificationPreferenceChannelsSchema,
  notificationPreferenceSchema,
  notificationPreferencesSchema,
  notificationQuietHoursSchema,
  notificationPreferencesUpdateSchema,
  pushSubscriptionInputSchema,
  pushSubscriptionSchema,
  pushDeliveryJobSchema,
  pushDeliveryAttemptSchema,
  notificationSourceActivitySchema,
  notificationListResponseSchema,
  notificationUnreadCountResponseSchema,
  notificationStateResponseSchema,
  notificationPreferencesResponseSchema,
  notificationCapabilitiesResponseSchema,
  pushSubscriptionEnrollmentResponseSchema,
  pushSubscriptionsResponseSchema,
  type ISO8601Timestamp,
  type Iso8601Timestamp,
  type JsonPrimitive,
  type JsonValue,
  type JsonObject,
  type NotificationKind,
  type NotificationSeverity,
  type NotificationEventAction,
  type PlanNotificationTarget,
  type TaskNotificationTarget,
  type ReviewNotificationTarget,
  type PullRequestNotificationTarget,
  type IndexingNotificationTarget,
  type SystemFailureNotificationTarget,
  type NotificationTarget,
  type NotificationTargetFor,
  type NotificationActionType,
  type NavigateNotificationAction,
  type ExternalLinkNotificationAction,
  type NotificationAction,
  type NotificationEvent,
  type NotificationUserState,
  type Notification,
  type NotificationPreferenceChannels,
  type NotificationPreference,
  type NotificationPreferences,
  type NotificationQuietHours,
  type NotificationPreferencePatch,
  type NotificationPreferencesPatch,
  type NotificationPreferencesUpdate,
  type PushSubscriptionKeys,
  type PushSubscriptionInput,
  type PushSubscriptionValidationOptions,
  type WebPushSubscription,
  type PushSubscription,
  type PushDeliveryJobStatus,
  type PushDeliveryStatus,
  type PendingPushDeliveryJob,
  type ProcessingPushDeliveryJob,
  type RetryablePushDeliveryJob,
  type TerminalPushDeliveryJob,
  type PushDeliveryJob,
  type PushDeliveryAttemptStatus,
  type DeliveredPushDeliveryAttempt,
  type RetryablePushDeliveryAttempt,
  type FailedPushDeliveryAttempt,
  type PushDeliveryAttempt,
  type NotificationSourceActivityType,
  type NotificationSourceActivityStatus,
  type TaskNotificationSourceActivity,
  type IndexingNotificationSourceActivity,
  type NotificationSourceActivity,
  type NotificationListResponse,
  type NotificationUnreadCountResponse,
  type NotificationStateResponse,
  type NotificationPreferencesResponse,
  type NotificationPushCapability,
  type NotificationCapabilitiesResponse,
  type PushSubscriptionEnrollmentResponse,
  type PushSubscriptionsResponse,
  type RuntimeSchema,
} from './notifications.js';
