export interface Usage {
    input_tokens?: number;
    output_tokens?: number;
}

export interface TokenUsage {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
}

export interface Message {
    usage?: Usage;
    content?: MessageContent[];
}

export interface MessageContent {
    type: string;
    name?: string;
    input?: unknown;
    id?: string;
}

export interface ConversationStep {
    message?: Message;
    timestamp?: string;
    type?: string;
    isError?: boolean;
    metadata?: Record<string, unknown>;
}

export interface FinalResult {
    num_turns?: number;
    cost_usd?: number;
    total_cost_usd?: number;
}

export interface ClaudeResult {
    model?: string;
    success?: boolean;
    executionTime?: number;
    sessionId?: string | null;
    conversationId?: string | null;
    finalResult?: FinalResult | null;
    conversationLog?: ConversationStep[];
    error?: string;
    tokenUsage?: TokenUsage;
}

export interface IssueRef {
    number: number;
    repoOwner: string;
    repoName: string;
}

export interface RecordMetricsOptions {
    jobType?: string;
    correlationId?: string;
    taskId?: string | null;
}

export interface ModelPricing {
    prompt: number;
    completion: number;
}

export interface ExtractedMetrics {
    model: string;
    success: boolean;
    executionTimeMs: number;
    executionTimeSec: number;
    numTurns: number;
    sessionId: string;
    conversationId: string | null;
}

export interface AggregatedMetrics {
    model: string;
    success: boolean;
    costUsd: number;
    numTurns: number;
    executionTimeMs: number;
    dateKey: string;
}

export interface CostCheckMetrics {
    timestamp: string;
    correlationId?: string;
    costUsd: number;
    model: string;
    numTurns: number;
}

export interface PersistMetrics {
    sessionId: string;
    conversationId: string | null;
    executionTimeMs: number;
    model: string;
    success: boolean;
    numTurns: number;
    costUsd: number;
    tokenUsage?: TokenUsage;
}

export interface ConversationDetailParams {
    step: ConversationStep;
    index: number;
    executionId: string;
    conversationLog: ConversationStep[];
    totalTokens: number;
    costUsd: number;
}

export interface ConversationDetail {
    execution_id: string;
    sequence_number: number;
    event_timestamp: string;
    event_type: string;
    content: string | null;
    duration_ms: number | null;
    token_count_input: number | null;
    token_count_output: number | null;
    cost_usd: number | null;
    is_error: boolean;
    tool_name: string | null;
    tool_input: string | null;
    tool_use_id: string | null;
    metadata: string | null;
}

export interface LLMMetricsSummary {
    totalRequests: number;
    totalSuccessful: number;
    totalFailed: number;
    successRate: number;
    totalCostUsd: number;
    avgCostPerRequest: number;
    totalTurns: number;
    avgTurnsPerRequest: number;
    avgExecutionTimeSec: number;
}

export interface ModelMetrics {
    totalRequests: number;
    successful: number;
    failed: number;
    successRate: number;
    totalCostUsd: number;
    avgCostPerRequest: number;
    totalTurns: number;
    avgTurnsPerRequest: number;
    avgExecutionTimeSec: number;
}

export interface DailyMetric {
    date: string;
    successful: number;
    failed: number;
    total: number;
    costUsd: number;
}

export interface HighCostAlert {
    timestamp: string;
    correlationId?: string;
    issueNumber: number;
    repository: string;
    costUsd: number;
    threshold: number;
    model: string;
    numTurns: number;
}

export interface LLMMetricsSummaryResult {
    summary: LLMMetricsSummary;
    modelBreakdown: Record<string, ModelMetrics>;
    dailyMetrics: DailyMetric[];
    recentHighCostAlerts: HighCostAlert[];
    lastUpdated: string;
}

export interface LLMMetricsData {
    correlationId?: string;
    timestamp: string;
    issueNumber: number;
    repository: string;
    jobType: string;
    model: string;
    success: boolean;
    executionTimeMs: number;
    executionTimeSec: number;
    numTurns: number;
    costUsd: number;
    sessionId: string;
    conversationId: string | null;
    error: string | null;
    failureReason: string | null;
}

export interface RedisConnectionOptions {
    host: string;
    port: number;
    maxRetriesPerRequest: null;
    enableReadyCheck: boolean;
}
