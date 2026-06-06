/**
 * Claude agent utility modules.
 *
 * This barrel file exports all utility functions used by ClaudeAgent.
 */

export {
    aggregateTokensFromConversationLog,
    getCorrectedTokenUsage,
    ensurePromptInConversationLog
} from './tokenUtils.js';

export {
    processDockerResult,
    type ProcessedDockerResult
} from './dockerResultProcessor.js';

export {
    buildDockerArgs,
    type DockerArgsParams
} from './dockerArgsBuilder.js';

export {
    executeWithUsageTracking,
    extractMetricRecords,
    isAgentTankEnabled,
    type UsageTrackingResult,
    type UsageTrackingMetrics,
    type UsageMetricRecord
} from './usageTrackingWrapper.js';

export {
    getClaudeAnalysisText,
    type PersistLogsParams
} from './claudeOutputHelpers.js';

export {
    parseAntigravityJsonl,
    aggregateDeltaMessages,
    convertEventToClaudeFormat,
    ANTIGRAVITY_MODEL_LABELS,
    type AntigravityOutputEvent,
    type AntigravityParsedOutput,
    type AntigravityEvent,
    type AntigravityTranscriptEvent
} from './antigravityOutputParser.js';
