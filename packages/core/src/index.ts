export { default as logger, generateCorrelationId, createCorrelatedLogger } from './utils/logger.js';
export { handleError, withErrorHandling, safeAsync, makeIdempotent, categorizeError, ErrorCategories } from './utils/errorHandler.js';
export type { ErrorCategory, ErrorDetails, ErrorHandlerOptions, IssueRef as ErrorIssueRef } from './utils/errorHandler.js';
export { withRetry, retryConfigs } from './utils/retryHandler.js';
export * from './utils/constants.js';
export { recordLLMMetrics, getLLMMetricsSummary, getLLMMetricsByCorrelationId } from './utils/llmMetrics.js';
export type { LLMMetricsSummary, LLMMetricsData, RecordMetricsOptions, ClaudeResult as LLMClaudeResult, IssueRef as LLMIssueRef, ModelPricing, ExtractedMetrics, AggregatedMetrics, CostCheckMetrics, PersistMetrics, ConversationDetail, LLMMetricsSummaryResult, ModelMetrics, DailyMetric, HighCostAlert, ConversationStep } from './utils/llmMetrics.types.js';
export { WorkerStateManager, getStateManager, closeStateManager, TaskStates } from './utils/workerStateManager.js';
export type { TaskState, IssueRef, HistoryEntry, LastError, ClaudeResultSummary, PRResult, TaskStateData, UpdateMetadata, TaskResult, ResumableTaskInfo, WorkerStateManagerOptions } from './utils/workerStateManager.types.js';
export { validatePRCreation, generateEnhancedClaudePrompt, validateRepositoryInfo } from './utils/prValidation.js';
export type { PRValidationResult, PRInfo, ValidatePRCreationOptions, CurrentIssueData, GenerateEnhancedClaudePromptOptions, RepoData, RepoValidationResult } from './utils/prValidation.js';
export { IdempotentGitHubOps, IdempotentGitOps } from './utils/idempotentOps.js';
export { estimateTokens, countTokens, getUsageStats } from './utils/tokenCalculation.js';
export { formatResetTime, addModelSpecificDelay } from './utils/scheduling.js';
export { filterCommentByAuthor, checkCommentTrigger } from './utils/commentFilters.js';
export { ensureGitRepository } from './utils/git/gitValidation.js';
export { safeRemoveLabel, safeAddLabel, safeUpdateLabels } from './utils/github/labelOperations.js';
export type { LabelContext, UpdateResults } from './utils/github/labelOperations.js';
export { createLogFiles, generateCompletionComment } from './utils/github/logFiles.js';

export { getGitHubInstallationToken, getAuthenticatedOctokit } from './auth/githubAuth.js';
export type { PaginatedOctokitInstance } from './auth/githubAuth.js';

export * from './config/configManager.js';
export { resolveModelAlias, getDefaultModel, getModelShortName, MODEL_ALIASES, MODEL_SHORT_NAMES, DEFAULT_MODEL_ALIAS, resolveLlmLabel } from './config/modelAliases.js';
export type { LlmLabelResolution } from './config/modelAliases.js';
export { CLAUDE_MODELS, CODEX_MODELS, GEMINI_MODELS, ALL_MODELS, AGENT_MODELS, MODEL_INFO_MAP, AGENT_DEFAULTS, typeBadgeColors } from './config/modelDefinitions.js';
export type { AgentType as ModelAgentType, ModelInfo } from './config/modelDefinitions.js';
export { getEffectiveTokenLimit, DEFAULT_CONTEXT_LEVEL } from './config/modelLimits.js';
export type { ContextLevel } from './config/modelLimits.js';

export { db, closeConnection, createKnexConfigForMigrations, runMigrations } from './db/connection.js';

export { getRepoConfigKey, detectDefaultBranch, listRepositoryBranchConfigurations } from './git/branchConfig.js';
export type { BranchConfiguration } from './git/branchConfig.js';
export { commitChanges } from './git/commitOperations.js';
export type { CommitResult } from './git/commitOperations.js';
export { setupAuthenticatedRemote, ensureBranchAndPush, pushBranch } from './git/repoBranching.js';
export { ensureRepoCloned, createWorktreeForIssue, getRepoUrl } from './git/repoManager.js';
export type { WorktreeResult, WorktreeInfo } from './git/repoManager.js';
export { cleanupExistingBranch, createWorktreeFromExistingBranch } from './git/worktreeCreation.js';
export { cleanupWorktree, cleanupExpiredWorktrees, setupWorktreePermissions, addToSafeDirectories, verifyWorktreeCreation, setupWorktreeRemote, getWorktreePath } from './git/worktreeOperations.js';

export {
    issueQueue,
    analysisQueue,
    indexingQueue,
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
    JobData,
    JobResult,
    ClaudeResult,
    ClaudeResult as QueueClaudeResult,
    AiMetrics,
    WorkerCreateOptions,
    ProcessorFunction,
    UnprocessedComment
} from './queue/taskQueue.js';

export { processWebhookEvent, initializeWebhookHandler } from './webhook/webhookHandler.js';
export type { WebhookEventType, DetectedIssue, IssueProcessor, CommentProcessor, CommentDeletedHandler, CommentEditedHandler, WebhookHandlerOptions } from './webhook/webhookHandler.js';
export { handleCommentDeleted, handleCommentEdited, processCommentEvent } from './webhook/commentEventHandler.js';
export type { CommentPayload, CommentEventConfig, CommentEventType } from './webhook/commentEventHandler.js';
export { extractLlmFromKeywords, stripKeywordsFromBody, buildCodeContext, isReviewComment, extractLlmFromLabels } from './webhook/commentEventHelpers.js';

export { getExecutionAnalysis } from './services/analysisService.js';
export { getModelPricing } from './services/pricingService.js';
export { generateContext, SecurityException } from './services/contextService.js';
export type { ContextGenerationOptions, ContextGenerationResult, SuspiciousFile } from './services/contextService.js';
export { findRelevantFiles } from './services/relevanceService.js';
export type { RelevantFile, RelevanceResult, RelevanceOptions } from './services/relevanceService.js';
export { generatePlan, refinePlan, generateContextPreview, checkoutBranch, PlanningFailedError, BranchNotFoundError, buildFullContext } from './services/taskPlanningService.js';
export type { GeneratePlanOptions, RefinePlanOptions, GenerateContextPreviewOptions, PreviewResult, PreviewStats, SmartFileSelection, TaskDraftConfig, Granularity } from './services/taskPlanningService.js';
export { executeDraft } from './services/taskExecutionService.js';
export type { IssueLink, ExecutionResult } from './services/taskExecutionService.js';
export { AttachmentService } from './services/attachmentService.js';
export type { Attachment, MulterFile } from './services/attachmentService.js';
export { PLANNER_SYSTEM_PROMPT, GRANULARITY_INSTRUCTIONS, getPlannerPrompt, REFINER_SYSTEM_PROMPT } from './claude/prompts/plannerPrompts.js';
export type { Plan, PlanItem } from './claude/prompts/plannerPrompts.js';
export { parseLlmJson, JsonParseError } from './utils/jsonUtils.js';
export { extractKeywords } from './services/relevance/keywordExtractor.js';
export { mineGitHistory, mineGitHistoryWithLLM, getCommitHistory, formatCommitLog } from './services/relevance/gitMiner.js';
export type { FileScore as GitFileScore, CommitInfo, SemanticMinerFile, SemanticMinerResponse, SemanticMiningOptions } from './services/relevance/gitMiner.js';
export { scorePaths } from './services/relevance/pathScorer.js';
export { indexRepo, getFileSummary, getDirectorySummary, getRepositorySummaries, clearRepositorySummaries, updateRepositoryStatus } from './services/relevance/summaryMiner.js';
export type { FileSummary, DirectorySummary, GitFileInfo, IndexingOptions } from './services/relevance/summaryMiner.js';
export { DEFAULT_INSTRUCTIONS } from './services/relevance/summaryMinerHelpers.js';

export {
    executeClaudeCode,
    generateTaskSummary,
    buildClaudeDockerImage,
    generateTaskImportPrompt,
    runLightweightLLMAnalysis,
    UsageLimitError
} from './claude/claudeService.js';
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
export { executeDockerCommand } from './claude/docker/dockerExecutor.js';
export { generateExecutionAnalysisPrompt, generateClaudePrompt } from './claude/prompts/promptGenerator.js';
export type { IssueLabel, IssueUser, IssueComment, ExecutionAnalysisResult } from './claude/prompts/promptGenerator.js';

// Codex helpers exports
export { buildCodexPrompt, parseCodexStreamOutput, storeCodexPromptInRedis } from './codex/codexHelpers.js';
export type { BuildCodexPromptOptions, CodexEvent, CodexOutput, StoreCodexPromptOptions } from './codex/codexHelpers.js';

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
export { GeminiAgent } from './agents/impl/GeminiAgent.js';
export type {
    Agent,
    AgentConfig,
    AgentTaskOptions,
    AgentExecutionResult,
    AgentType
} from './agents/types.js';
export { CONTAINER_CONFIG_PATHS } from './agents/types.js';
export { DEFAULT_CONFIG_PATHS, resolveConfigPath, getDefaultConfigPath } from './config/configManager.js';
