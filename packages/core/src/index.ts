export { default as logger, generateCorrelationId, createCorrelatedLogger } from './utils/logger.js';
export { handleError, withErrorHandling, safeAsync, makeIdempotent, categorizeError, ErrorCategories } from './utils/errorHandler.js';
export type { ErrorCategory, ErrorDetails, ErrorHandlerOptions, IssueRef as ErrorIssueRef } from './utils/errorHandler.js';
export { withRetry, retryConfigs, calculateDelay } from './utils/retryHandler.js';
export type { RetryConfig, RetryOptions } from './utils/retryHandler.js';
export * from './utils/constants.js';
export { recordLLMMetrics, getLLMMetricsSummary, getLLMMetricsByCorrelationId } from './utils/llmMetrics.js';
export { persistLlmLog, createLlmLogFromAnalysis, createLlmLogFromAgentExecution, buildTaskWorkRef, buildAnalysisWorkRef, WORK_TYPES } from './utils/llmLogger.js';
export type { LlmLogEntry, WorkReference, WorkType } from './utils/llmLogger.js';
export type { LLMMetricsSummary, LLMMetricsData, RecordMetricsOptions, ClaudeResult as LLMClaudeResult, IssueRef as LLMIssueRef, ModelPricing, ExtractedMetrics, AggregatedMetrics, CostCheckMetrics, PersistMetrics, ConversationDetail, LLMMetricsSummaryResult, ModelMetrics, DailyMetric, HighCostAlert, ConversationStep, TokenUsage, ExecutionType } from './utils/llmMetrics.types.js';
export { WorkerStateManager, getStateManager, closeStateManager, TaskStates } from './utils/workerStateManager.js';
export { getEventPublisher, closeEventPublisher, EventPublisher } from './utils/eventPublisher.js';
export type { TaskState, IssueRef, HistoryEntry, LastError, ClaudeResultSummary, PRResult, TaskStateData, UpdateMetadata, TaskResult, ResumableTaskInfo, WorkerStateManagerOptions } from './utils/workerStateManager.types.js';
export { validatePRCreation, generateEnhancedClaudePrompt, validateRepositoryInfo } from './utils/prValidation.js';
export type { PRValidationResult, PRInfo, ValidatePRCreationOptions, CurrentIssueData, GenerateEnhancedClaudePromptOptions, RepoData, RepoValidationResult } from './utils/prValidation.js';
export { IdempotentGitHubOps, IdempotentGitOps } from './utils/idempotentOps.js';
export { estimateTokens, countTokens, getUsageStats, getDetailedUsageStats, getCachePricingMultipliers, calculateCostWithCachePricing } from './utils/tokenCalculation.js';
export type { DetailedUsageStats, CachePricingMultipliers } from './utils/tokenCalculation.js';
export { formatResetTime, addModelSpecificDelay, parseResetTimeFromMessage, calculateNextRoundHourPlus2Minutes, formatRetryTime, hoursUntil } from './utils/scheduling.js';
export { filterCommentByAuthor, checkCommentTrigger, checkCommentIgnore } from './utils/commentFilters.js';
export { ensureGitRepository } from './utils/git/gitValidation.js';
export { safeRemoveLabel, safeAddLabel, safeUpdateLabels } from './utils/github/labelOperations.js';
export type { LabelContext, UpdateResults } from './utils/github/labelOperations.js';
export { createLogFiles, generateCompletionComment, redactSecrets } from './utils/github/logFiles.js';
export { formatSubscriptionUsage } from './utils/github/formatSubscriptionUsage.js';
export type { SubscriptionUsageRecord, SubscriptionUsageMetrics } from './utils/github/formatSubscriptionUsage.js';

export { getGitHubInstallationToken, getAuthenticatedOctokit } from './auth/githubAuth.js';
export type { PaginatedOctokitInstance } from './auth/githubAuth.js';
export { buildAuthPayload, generateAuthToken, verifyAuthToken, AUTH_TOKEN_MAX_AGE_MS, AUTH_TOKEN_MAX_CLOCK_SKEW_MS } from './auth/systemTaskAuth.js';

export * from './config/configManager.js';
// Note: loadUltrafixRatingGoal, loadUltrafixMaxCycles, loadUltrafixPauseSeconds, loadPrReviewModel
// are re-exported via configManager.ts (which re-exports from configManagerUltrafix.ts).
// Do NOT add explicit re-exports here — they would conflict with the wildcard export above.
export {
    createPlanIssue,
    getPlanIssuesByDraft,
    getPlanIssuesByDraftPaginated,
    getPlanIssue,
    updatePlanIssue,
    incrementFollowupCount,
    findPlanIssueByRepoAndNumber,
    findPlanIssueByRepoAndPR,
    updatePlanIssueStatus,
    updatePlanIssueTaskId,
    linkPRToPlanIssue,
    updatePlanIssueByPR,
    batchUpdatePlanIssueConfig,
    deletePlanIssue,
    PlanIssueStatus
} from './config/planIssueManager.js';
export type {
    PlanIssue,
    CreatePlanIssueInput,
    UpdatePlanIssueInput,
    GetPlanIssuesOptions,
    PaginatedPlanIssuesResult
} from './config/planIssueManager.js';
export { resolvePlanIssueDefaultSelection } from './config/planIssueDefaults.js';
export type { PlanIssueDefaultSelection } from './config/planIssueDefaultSelection.js';
export { getPlanIssueDefaultSelection } from './config/planIssueDefaultSelection.js';
export type { PlanIssueSelectionAgent } from './config/planIssueDefaultSelection.js';
export { resolveModelAlias, getDefaultModel, getPreferredModelForAgent, getModelShortName, getModelName, MODEL_ALIASES, MODEL_SHORT_NAMES, resolveLlmLabel, getOpenRouterId, resolveCustomLabel, getAllCustomLabels, findMatchingModel, resolveReviewModels, ReviewModelResolutionError, NoDefaultModelConfiguredError } from './config/modelAliases.js';
export type { LlmLabelResolution, ReviewAssignment } from './config/modelAliases.js';
export { CLAUDE_MODELS, CODEX_MODELS, ANTIGRAVITY_MODELS, OPENCODE_MODELS, VIBE_MODELS, ALL_MODELS, AGENT_MODELS, AGENT_DISPLAY, AGENT_DISPLAY_ORDER, MODEL_INFO_MAP, AGENT_DEFAULTS, typeBadgeColors } from './config/modelDefinitions.js';
export type { AgentType as ModelAgentType, AgentDisplayInfo, ModelInfo } from './config/modelDefinitions.js';
export { getEffectiveTokenLimit, getModelHardLimit, DEFAULT_CONTEXT_LEVEL, MIN_CONTEXT_LEVEL, MAX_CONTEXT_LEVEL, EFFECTIVE_MAX_RATIO, MODEL_LIMITS } from './config/modelLimits.js';
export type { ContextLevel } from './config/modelLimits.js';

export { db, closeConnection, createKnexConfigForMigrations, runMigrations } from './db/connection.js';

export { getRepoConfigKey, detectDefaultBranch, listRepositoryBranchConfigurations } from './git/branchConfig.js';
export type { BranchConfiguration } from './git/branchConfig.js';
export { commitChanges } from './git/commitOperations.js';
export type { CommitResult } from './git/commitOperations.js';
export { setupAuthenticatedRemote, ensureBranchAndPush, pushBranch } from './git/repoBranching.js';
export { ensureRepoCloned, createWorktreeForIssue, getRepoUrl, fetchLatestChanges } from './git/repoManager.js';
export type { WorktreeResult, WorktreeInfo, FetchLatestChangesOptions, FetchLatestChangesResult } from './git/repoManager.js';
export { cleanupExistingBranch, createWorktreeFromExistingBranch } from './git/worktreeCreation.js';
export { cleanupWorktree, cleanupExpiredWorktrees, safePruneWorktrees, setupWorktreePermissions, addToSafeDirectories, verifyWorktreeCreation, setupWorktreeRemote, getWorktreePath } from './git/worktreeOperations.js';
export { isGitCorruptionError, GIT_CORRUPTION_PATTERNS, getCorruptionPatternStrings } from './git/gitCorruption.js';
export { mergeBaseIntoBranch } from './git/mergeOperations.js';
export type { MergeOutcome, MergeResult } from './git/mergeOperations.js';

export {
    issueQueue,
    analysisQueue,
    indexingQueue,
    getIssueQueue,
    getAnalysisQueue,
    getIndexingQueue,
    GITHUB_ISSUE_QUEUE_NAME,
    ANALYSIS_QUEUE_NAME,
    INDEXING_QUEUE_NAME,
    COMMENT_BATCH_DELAY_MS,
    createWorker,
    shutdownQueue
} from './queue/taskQueue.js';
export type {
    IssueJobData,
    CommentJobData,
    TaskImportJobData,
    AnalysisJobData,
    SystemTaskJobData,
    IndexingJobData,
    MergeConflictJobData,
    JobData,
    JobResult,
    ClaudeResult,
    ClaudeResult as QueueClaudeResult,
    AiMetrics,
    WorkerCreateOptions,
    ProcessorFunction,
    UnprocessedComment,
    SystemAction,
    AutoResolveContext
} from './queue/taskQueue.js';

export { areAllChecksPassing, buildRedisRuntimeConfig, closeUltrafixStateRedis, getCurrentPRHead, getCheckRunsStatus } from './webhook/checkRunHelpers.js';
export type { CheckRunsStatus } from './webhook/checkRunHelpers.js';
export { handleCheckRunEvent, handleStatusEvent, reevaluatePRAutoMerge, setUltrafixCheckRunHook, type StatusEventPayload } from './webhook/checkRunHandler.js';
export { processWebhookEvent, initializeWebhookHandler, SUPPORTED_WEBHOOK_EVENTS } from './webhook/webhookHandler.js';
export type { WebhookEventType, DetectedIssue, IssueProcessor, CommentProcessor, CommentDeletedHandler, CommentEditedHandler, CheckRunProcessor, WebhookHandlerOptions } from './webhook/webhookHandler.js';
export { handleCommentDeleted, handleCommentEdited, processCommentEvent, setUltrafixDeps } from './webhook/commentEventHandler.js';
export type { CommentPayload, CommentEventConfig, CommentEventType, UltrafixDeps } from './webhook/commentEventHandler.js';
export { extractLlmFromKeywords, stripKeywordsFromBody, buildCodeContext, isReviewComment, extractLlmFromLabels } from './webhook/commentEventHelpers.js';
export { parseSlashCommand, buildCommandMeta } from './webhook/slashCommandParser.js';
export type { ParsedSlashCommand, SlashCommandName, CommandMeta, ReviewCommandMeta, FixCommandMeta, MergeCommandMeta, UltrafixCommandMeta } from './webhook/slashCommandParser.js';
export { handlePullRequestConflictDetection, handlePushConflictDetection, handleMergeCommand } from './webhook/mergeConflictDetector.js';
export type { ConflictDetectionOutcome, ConflictDetectionResult, HandleMergeCommandOptions } from './webhook/mergeConflictDetector.js';
export {
    determinePRStatusUpdate,
    isTerminalStatus,
    isInProgressStatus,
    TERMINAL_STATUSES
} from './webhook/statusMachine.js';
export type { PlanIssueStatus as StatusMachinePlanIssueStatus } from './webhook/statusMachine.js';

export { getExecutionAnalysis } from './services/analysisService.js';
export { getModelPricing } from './services/pricingService.js';
export { getWorktreeChanges, storeFileChanges, getStoredFileChanges, clearFileChanges, updateFileChangesFromWorktree, getCommitChanges, isValidCommitHash } from './services/worktreeMonitorService.js';
export type { FileChange, FileChangesData } from './services/worktreeMonitorService.js';
export { generateContext, generateAdditionalContext, SecurityException } from './services/context/index.js';
export type { ContextGenerationOptions, ContextGenerationResult, SuspiciousFile, AdditionalContextOptions, AdditionalContextResult } from './services/context/index.js';
export { findRelevantFiles } from './services/relevanceService.js';
export type { RelevantFile, RelevanceResult, RelevanceOptions } from './services/relevanceService.js';
export { generatePlan, refinePlan, generateContextPreview, checkoutBranch, PlanningFailedError, BranchNotFoundError, buildFullContext } from './services/taskPlanningService.js';
export type { GeneratePlanOptions, RefinePlanOptions, RefinePlanResult, RefinePlanEstimation, GenerateContextPreviewOptions, PreviewResult, PreviewStats, SmartFileSelection, TaskDraftConfig, Granularity } from './services/taskPlanningService.js';
export { parseExistingContextConfig } from './services/planning/previewUtils.js';
export { pauseDraft, resumeDraft, isDraftPaused, getDraftPauseState } from './services/taskPlanning/draftPauseResume.js';
export type { PauseResumeResult } from './services/taskPlanning/draftPauseResume.js';
export { estimateLlmDuration, estimateUsagePercent } from './utils/llmEstimation.js';
export type { EstimationResult, EstimationOptions } from './utils/llmEstimation.js';
export type { Base64Image, ContextRepository } from './services/planning/planningTypes.js';
export { parseGenerationTrace, buildDraftUpdateTraceSnapshot, sanitizeDraftUpdateStepData } from './services/planning/traceService.js';
export { executeDraft, ensureEpicPR, generateEpicBranchName, isEpicBranch, EPIC_BRANCH_PATTERN } from './services/taskExecutionService.js';
export type { IssueLink, ExecutionResult, EpicPRResult, EnsureEpicPROptions } from './services/taskExecutionService.js';
export { AttachmentService } from './services/attachmentService.js';
export type { Attachment, MulterFile } from './services/attachmentService.js';
export { PLANNER_SYSTEM_PROMPT, GRANULARITY_INSTRUCTIONS, getPlannerPrompt, REFINER_SYSTEM_PROMPT } from './claude/prompts/plannerPrompts.js';
export type { Plan, PlanItem, RefinementResponse } from './claude/prompts/plannerPrompts.js';
export { parseLlmJson, JsonParseError } from './utils/jsonUtils.js';
export { extractKeywords } from './services/relevance/keywordExtractor.js';
export { mineGitHistory, mineGitHistoryWithLLM, getCommitHistory, formatCommitLog } from './services/relevance/gitMiner.js';
export type { FileScore as GitFileScore, CommitInfo, SemanticMinerFile, SemanticMinerResponse, SemanticMiningOptions } from './services/relevance/gitMiner.js';
export { scorePaths } from './services/relevance/pathScorer.js';
export { indexRepo, getFileSummary, getDirectorySummary, getRepositorySummaries, clearRepositorySummaries, updateRepositoryStatus } from './services/relevance/summaryMiner.js';
export type { FileSummary, DirectorySummary, GitFileInfo, IndexingOptions } from './services/relevance/summaryMiner.js';
export { DEFAULT_INSTRUCTIONS } from './services/relevance/summaryMinerHelpers.js';
export { buildSummaryContext } from './services/relevance/contextBuilder.js';
export type { ContextBuildOptions, SmartContextResult } from './services/relevance/contextBuilder.js';
export {
  requestIndexingCancellation,
  isIndexingCancelled,
  clearIndexingCancellation,
  IndexingCancelledError,
  initIndexingProgress,
  updateIndexingProgress,
  setTotalBatches,
  getIndexingProgress,
  clearIndexingProgress,
  startDirectoryPhase,
  updateDirectoryProgress,
  publishProgress,
  publishIndexingStatus
} from './services/relevance/indexingCancellation.js';
export type { IndexingProgress } from './services/relevance/indexingCancellation.js';

export {
    executeClaudeCode,
    generateTaskSummary,
    buildClaudeDockerImage,
    generateTaskImportPrompt,
    runLightweightLLMAnalysis,
    UsageLimitError
} from './claude/claudeService.js';
export { AGENT_TYPES, AGENT_IMAGE_NAMES, VERSIONED_AGENT_IMAGE_NAMES, DEFAULT_AGENT_DOCKER_IMAGES, validateAgentType } from './agents/constants.js';
export type { AgentTypeValidationResult } from './agents/constants.js';
export type {
    ExecuteClaudeCodeOptions,
    ClaudeCodeResponse,
    GenerateTaskSummaryOptions,
    RunLightweightLLMAnalysisOptions,
    IssueRef as ClaudeIssueRef,
    IssueDetails
} from './claude/claudeService.js';
export {
    verifyWorktreeStructure,
    verifyWorktreePostExecution,
    setWorktreeOwnership,
    buildDockerArgs,
    parseStreamJsonOutput,
    storePromptInRedis,
    buildClaudePrompt
} from './claude/claudeHelpers.js';
export type { ClaudeOutput, ConversationLogEntry, ClaudeOutputResult, BuildClaudePromptOptions, DockerArgsParams, StorePromptOptions } from './claude/claudeHelpers.js';
export { executeDockerCommand, stopDockerContainer, ExecutionAbortedError, ensureVersionedAgentImage } from './claude/docker/dockerExecutor.js';
export { cleanupUnusedAgentImages, listAgentImages } from './claude/docker/dockerImageManager.js';
export type { VersionedImageBuildResult } from './claude/docker/dockerExecutor.js';
export { generateExecutionAnalysisPrompt, generateClaudePrompt } from './claude/prompts/promptGenerator.js';
export type { IssueLabel, IssueUser, IssueComment, ExecutionAnalysisResult, GenerateClaudePromptOptions } from './claude/prompts/promptGenerator.js';

// Codex helpers exports
export { buildCodexPrompt, parseCodexStreamOutput, storeCodexPromptInRedis } from './codex/codexHelpers.js';
export type { BuildCodexPromptOptions, CodexEvent, CodexOutput, StoreCodexPromptOptions } from './codex/codexHelpers.js';
export { parseAntigravityJsonl, filterAntigravityAnalysisEvents } from './agents/impl/utils/antigravityOutputParser.js';

export {
    getReposFromEnv,
    getRepos,
    getAiPrimaryTag,
    getPrimaryProcessingLabels,
    getUserWhitelist,
    getBotUsername,
    detectBotUsername,
    loadReposFromConfig,
    loadSettingsFromConfig,
    loadAiPrimaryTagFromConfig,
    loadPrimaryProcessingLabelsFromConfig,
    loadAllConfigs,
    reloadConfigs
} from './daemon/configLoader.js';
export { processDetectedIssue, fetchIssuesForRepo } from './daemon/issueDetection.js';

// Agent abstraction exports
export { AgentRegistry, getAgentRegistry } from './agents/AgentRegistry.js';
export { ClaudeAgent } from './agents/impl/ClaudeAgent.js';
export { CodexAgent } from './agents/impl/CodexAgent.js';
export { AntigravityAgent } from './agents/impl/AntigravityAgent.js';
export { OpenCodeAgent } from './agents/impl/OpenCodeAgent.js';
export { buildOpenCodeDockerArgs, buildOpenCodePrompt, hasOpenCodeTokenUsage, isOpenCodeJsonlEvent, normalizeOpenCodeCliModelName, normalizeOpenCodeUsage, parseOpenCodeJsonl, parseOpenCodeStreamOutput, toOpenCodeExternalModelId, toProprOpenCodeExternalModelId, toProprOpenCodeModelId } from './agents/impl/openCodeUtils.js';
export { shortHash, buildDynamicLlmLabel, MAX_GITHUB_LABEL_LENGTH } from '@propr/shared';
export { normalizeOpenCodeTimestamp } from './agents/impl/openCodeTimestamp.js';
export type { BuildOpenCodePromptOptions, OpenCodeDockerArgsParams, OpenCodeEvent, ParsedOpenCodeOutput } from './agents/impl/openCodeUtils.js';
export { VibeAgent, parseVibeConversationLog, parseVibeOutput } from './agents/impl/VibeAgent.js';
export type {
    Agent,
    AgentConfig,
    AgentTaskOptions,
    AgentExecutionResult,
    AgentType,
    TokenUsage as AgentTokenUsage,
    AnalysisResult,
    AnalyzeOptions
} from './agents/types.js';
export { CONTAINER_CONFIG_PATHS } from './agents/types.js';
export { DEFAULT_CONFIG_PATHS, resolveConfigPath, getDefaultConfigPath, loadAgents, migrateAgentConfigs } from './config/configManager.js';

// Agent version management
export * from './agents/version/index.js';

// Repository chat message persistence
export {
    getMessagesForRepository,
    saveMessage,
    deleteMessage,
    clearMessagesForRepository
} from './services/repoChatMessages.js';
export type { ChatMessage, ChatMessageRecord, SaveMessageParams } from './services/repoChatMessages.js';

// Re-export event definitions from shared package for convenience
export {
    TASK_UPDATE,
    DRAFT_UPDATE,
    PLAN_STEP_UPDATE,
    INDEXING_UPDATE,
    REDIS_CHANNELS
} from '@propr/shared';
export type {
    TaskUpdatePayload,
    DraftUpdatePayload,
    PlanStepUpdatePayload,
    IndexingUpdatePayload,
    EventPayload
} from '@propr/shared';

// Repository to-do management
export {
    getCategoriesForRepository,
    createCategory,
    updateCategory,
    deleteCategory,
    batchReorderCategories,
    getTodosForRepository,
    getTodo,
    createTodo,
    updateTodo,
    deleteTodo,
    batchReorderTodos,
    linkTodosToDraft,
    completeTodosForDraft,
    getTodosForDraft
} from './services/repoTodosService.js';
export type {
    RepoTodoCategoryRecord,
    RepoTodoRecord,
    RepoTodoCategory,
    RepoTodo,
    CreateCategoryParams,
    UpdateCategoryParams,
    CreateTodoParams,
    UpdateTodoParams,
    BatchReorderItem
} from './services/repoTodosService.js';

// Repository migration (rename/move detection)
export {
    detectRepositoryRename,
    migrateRepositoryReferences,
    checkAndMigrateRepository,
    detectRenameFromResponse,
    scheduleRepositoryRenameCheck
} from './services/repositoryMigrationService.js';
export type {
    RepositoryRenameResult,
    MigrationResult
} from './services/repositoryMigrationService.js';
