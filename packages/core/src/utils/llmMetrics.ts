import { Redis } from 'ioredis';
import logger from './logger.js';
import { db } from '../db/connection.js';
import { analysisQueue } from '../queue/taskQueue.js';
import { getOpenRouterId } from '../config/modelAliases.js';
import { getModelPricing } from '../services/pricingService.js';
import type {
    RedisConnectionOptions, ClaudeResult, IssueRef, RecordMetricsOptions, ModelPricing,
    ExtractedMetrics, AggregatedMetrics, CostCheckMetrics, PersistMetrics,
    ConversationDetailParams, ConversationDetail, ConversationStep, MessageContent,
    LLMMetricsSummary, ModelMetrics, DailyMetric, HighCostAlert, LLMMetricsSummaryResult, LLMMetricsData,
    TokenUsage, ExecutionType
} from './llmMetrics.types.js';

const REDIS_HOST: string = process.env.REDIS_HOST ?? '127.0.0.1';
const REDIS_PORT: number = parseInt(process.env.REDIS_PORT ?? '6379', 10);

const connectionOptions: RedisConnectionOptions = {
    host: REDIS_HOST,
    port: REDIS_PORT,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
};

function extractMetricsFromClaudeResult(claudeResult: ClaudeResult | null): ExtractedMetrics {
    const model = claudeResult?.model ?? process.env.CLAUDE_MODEL ?? 'unknown';
    const success = claudeResult?.success ?? false;
    const executionTimeMs = claudeResult?.executionTime ?? 0;
    const executionTimeSec = Math.round(executionTimeMs / 1000);
    const numTurns = claudeResult?.finalResult?.num_turns ?? 0;
    const sessionId = claudeResult?.sessionId ?? 'unknown';
    const conversationId = claudeResult?.conversationId ?? null;
    return { model, success, executionTimeMs, executionTimeSec, numTurns, sessionId, conversationId };
}

interface CumulativeTokenUsage {
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
    totalInputWithCache: number;  // input + cache_creation + cache_read (for cost calc and display)
}

function calculateTokens(conversationLog: ConversationStep[] | undefined): CumulativeTokenUsage {
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheCreationTokens = 0;
    let cacheReadTokens = 0;

    if (conversationLog && Array.isArray(conversationLog)) {
        conversationLog.forEach(step => {
            const usage = step.message?.usage;
            if (usage) {
                inputTokens += usage.input_tokens ?? 0;
                outputTokens += usage.output_tokens ?? 0;
                cacheCreationTokens += usage.cache_creation_input_tokens ?? 0;
                cacheReadTokens += usage.cache_read_input_tokens ?? 0;
            }
        });
    }

    return {
        inputTokens,
        outputTokens,
        cacheCreationTokens,
        cacheReadTokens,
        totalInputWithCache: inputTokens + cacheCreationTokens + cacheReadTokens
    };
}

async function calculateCost(model: string, conversationLogTokens: CumulativeTokenUsage, claudeResult: ClaudeResult | null): Promise<number> {
    let calculatedCostUsd = 0;
    const openRouterId = getOpenRouterId(model);
    const pricing = await getModelPricing(openRouterId) as ModelPricing | null;

    // Use cumulative totals from conversation log (includes cache tokens for input)
    const inputTokens = conversationLogTokens.totalInputWithCache;
    const outputTokens = conversationLogTokens.outputTokens;

    logger.info({ model, openRouterId, pricingFound: !!pricing, pricing, inputTokens, outputTokens }, 'Cost calculation: looking up pricing');

    if (pricing && (inputTokens > 0 || outputTokens > 0)) {
        calculatedCostUsd = (inputTokens * pricing.prompt) + (outputTokens * pricing.completion);
        logger.info({ model, openRouterId, pricing, inputTokens, outputTokens, calculatedCostUsd }, 'Calculated dynamic cost from OpenRouter pricing');
    } else if (!pricing) {
        logger.warn({ model, openRouterId }, 'No pricing found for model - cost will be 0 or fallback');
    } else {
        logger.warn({ model, inputTokens, outputTokens }, 'No token data available - cost will be 0 or fallback');
    }
    return calculatedCostUsd > 0 ? calculatedCostUsd : (claudeResult?.finalResult?.cost_usd ?? claudeResult?.finalResult?.total_cost_usd ?? 0);
}

async function updateAggregatedMetrics(metricsRedis: InstanceType<typeof Redis>, metrics: AggregatedMetrics): Promise<void> {
    const { model, success, costUsd, numTurns, executionTimeMs, dateKey } = metrics;
    const successKey = success ? 'successful' : 'failed';
    await metricsRedis.incr(`llm:metrics:total:${successKey}`);
    await metricsRedis.incr(`llm:metrics:daily:${dateKey}:${successKey}`);
    await metricsRedis.incr(`llm:metrics:model:${model}:${successKey}`);

    const currentTotalCost = parseFloat(await metricsRedis.get('llm:metrics:total:costUsd') ?? '0');
    await metricsRedis.set('llm:metrics:total:costUsd', (currentTotalCost + costUsd).toFixed(4));
    const currentDailyCost = parseFloat(await metricsRedis.get(`llm:metrics:daily:${dateKey}:costUsd`) ?? '0');
    await metricsRedis.set(`llm:metrics:daily:${dateKey}:costUsd`, (currentDailyCost + costUsd).toFixed(4));
    const currentModelCost = parseFloat(await metricsRedis.get(`llm:metrics:model:${model}:costUsd`) ?? '0');
    await metricsRedis.set(`llm:metrics:model:${model}:costUsd`, (currentModelCost + costUsd).toFixed(4));

    const currentTotalTurns = parseInt(await metricsRedis.get('llm:metrics:total:turns') ?? '0');
    await metricsRedis.set('llm:metrics:total:turns', currentTotalTurns + numTurns);
    const currentModelTurns = parseInt(await metricsRedis.get(`llm:metrics:model:${model}:turns`) ?? '0');
    await metricsRedis.set(`llm:metrics:model:${model}:turns`, currentModelTurns + numTurns);

    const currentTotalTime = parseInt(await metricsRedis.get('llm:metrics:total:executionTimeMs') ?? '0');
    await metricsRedis.set('llm:metrics:total:executionTimeMs', currentTotalTime + executionTimeMs);
    const currentModelTime = parseInt(await metricsRedis.get(`llm:metrics:model:${model}:executionTimeMs`) ?? '0');
    await metricsRedis.set(`llm:metrics:model:${model}:executionTimeMs`, currentModelTime + executionTimeMs);

    await metricsRedis.sadd('llm:metrics:models:used', model);
}

async function checkCostThreshold(metricsRedis: InstanceType<typeof Redis>, metrics: CostCheckMetrics, issueRef: IssueRef): Promise<void> {
    const { timestamp, correlationId, costUsd, model, numTurns } = metrics;
    const costThreshold = parseFloat(process.env.LLM_COST_THRESHOLD_USD ?? '10.00');
    if (costUsd > costThreshold) {
        const alertEntry: HighCostAlert = {
            timestamp, correlationId, issueNumber: issueRef.number,
            repository: `${issueRef.repoOwner}/${issueRef.repoName}`,
            costUsd, threshold: costThreshold, model, numTurns
        };
        await metricsRedis.lpush('llm:metrics:alerts:highcost', JSON.stringify(alertEntry));
        await metricsRedis.ltrim('llm:metrics:alerts:highcost', 0, 99);
        logger.warn({ ...alertEntry, message: 'LLM cost exceeded threshold' });
    }
}

function extractToolUsage(messageContent: MessageContent[] | undefined): { toolName: string | null; toolInput: unknown | null; toolUseId: string | null } {
    if (!messageContent || !Array.isArray(messageContent)) return { toolName: null, toolInput: null, toolUseId: null };
    const toolUse = messageContent.find(block => block.type === 'tool_use');
    if (!toolUse) return { toolName: null, toolInput: null, toolUseId: null };
    return { toolName: toolUse.name ?? null, toolInput: toolUse.input ?? null, toolUseId: toolUse.id ?? null };
}

function calculateMessageCost(messageTokens: number, totalTokens: number, costUsd: number): number | null {
    return totalTokens > 0 && costUsd > 0 ? (messageTokens / totalTokens) * costUsd : null;
}

function calculateDurationMs(step: ConversationStep, index: number, conversationLog: ConversationStep[]): number | null {
    if (index <= 0 || !step.timestamp || !conversationLog[index - 1].timestamp) return null;
    return new Date(step.timestamp).getTime() - new Date(conversationLog[index - 1].timestamp!).getTime();
}

function buildConversationDetail(params: ConversationDetailParams): ConversationDetail {
    const { step, index, executionId, conversationLog, totalTokens, costUsd } = params;
    const { toolName, toolInput, toolUseId } = extractToolUsage(step.message?.content);
    const messageTokens = (step.message?.usage?.input_tokens ?? 0) + (step.message?.usage?.output_tokens ?? 0);
    return {
        execution_id: executionId, sequence_number: index,
        event_timestamp: step.timestamp ?? new Date().toISOString(),
        event_type: step.type ?? 'unknown',
        content: step.message ? JSON.stringify(step.message) : null,
        duration_ms: calculateDurationMs(step, index, conversationLog),
        token_count_input: step.message?.usage?.input_tokens ?? null,
        token_count_output: step.message?.usage?.output_tokens ?? null,
        cost_usd: calculateMessageCost(messageTokens, totalTokens, costUsd),
        is_error: step.isError ?? false, tool_name: toolName,
        tool_input: toolInput ? JSON.stringify(toolInput) : null,
        tool_use_id: toolUseId, metadata: step.metadata ? JSON.stringify(step.metadata) : null
    };
}

interface ProcessConversationLogParams {
    claudeResult: ClaudeResult;
    executionId: string;
    costUsd: number;
    correlationId?: string;
    taskId?: string | null;
}

async function processConversationLog(params: ProcessConversationLogParams): Promise<void> {
    const { claudeResult, executionId, costUsd, correlationId, taskId } = params;
    if (!claudeResult.conversationLog || !Array.isArray(claudeResult.conversationLog)) return;

    if (claudeResult.conversationLog.length > 0) {
        logger.debug({
            correlationId, taskId,
            sampleKeys: Object.keys(claudeResult.conversationLog[0]),
            sampleItem: JSON.stringify(claudeResult.conversationLog[0]).substring(0, 200)
        }, 'ConversationLog sample structure');
    }

    let totalTokens = 0;
    claudeResult.conversationLog.forEach((step) => {
        totalTokens += (step.message?.usage?.input_tokens ?? 0) + (step.message?.usage?.output_tokens ?? 0);
    });

    const detailsArray = claudeResult.conversationLog.map((step, index) =>
        buildConversationDetail({ step, index, executionId, conversationLog: claudeResult.conversationLog!, totalTokens, costUsd })
    );

    if (detailsArray.length > 0) {
        logger.info({
            correlationId, taskId,
            sampleDetail: {
                sequence: detailsArray[0].sequence_number, type: detailsArray[0].event_type,
                hasContent: !!detailsArray[0].content, contentPreview: detailsArray[0].content?.substring(0, 100),
                inputTokens: detailsArray[0].token_count_input, outputTokens: detailsArray[0].token_count_output,
                toolName: detailsArray[0].tool_name
            }
        }, 'DEBUG: Sample detail before insert');
        await db('llm_execution_details').insert(detailsArray);
    }
}

async function enqueueAnalysisTask(
    taskId: string,
    executionId: string,
    sessionId: string,
    correlationId?: string
): Promise<void> {
    try {
        await analysisQueue.add('analyzeExecution', {
            taskId,
            executionId,
            sessionId: sessionId || 'unknown',
            correlationId: correlationId || 'unknown'
        }, {
            jobId: `analysis-${executionId}`,
            removeOnComplete: true,
            removeOnFail: true,
            delay: 10000
        });
        logger.debug({ correlationId, taskId, executionId }, 'Enqueued task for execution analysis (with 10s delay)');
    } catch (queueError) {
        logger.error({ error: (queueError as Error).message, correlationId, taskId }, 'Failed to enqueue task for analysis');
    }
}

async function persistToDatabase(claudeResult: ClaudeResult, taskId: string | null, metrics: PersistMetrics, correlationId?: string): Promise<void> {
    if (!taskId) return;
    const { sessionId, conversationId, executionTimeMs, model, success, numTurns, costUsd, tokenUsage, executionType } = metrics;
    try {
        const executionData = {
            task_id: taskId, session_id: sessionId, conversation_id: conversationId,
            start_time: new Date(Date.now() - executionTimeMs).toISOString(),
            end_time: new Date().toISOString(), duration_ms: executionTimeMs,
            model_name: model, success: success, num_turns: numTurns, cost_usd: costUsd,
            error_message: !success ? (claudeResult?.error ?? 'Unknown error') : null,
            prompt_length: null, output_length: null,
            input_tokens: tokenUsage?.input_tokens ?? null,
            output_tokens: tokenUsage?.output_tokens ?? null,
            cache_creation_input_tokens: tokenUsage?.cache_creation_input_tokens ?? null,
            cache_read_input_tokens: tokenUsage?.cache_read_input_tokens ?? null,
            execution_type: executionType ?? 'implementation'
        };
        const [insertedExecution] = await db('llm_executions').insert(executionData).returning('execution_id');
        const executionId = (insertedExecution as { execution_id: string }).execution_id;

        await processConversationLog({ claudeResult, executionId, costUsd, correlationId, taskId });
        logger.debug({ correlationId, taskId, executionId }, 'LLM metrics persisted to database');
        await enqueueAnalysisTask(taskId, executionId, sessionId, correlationId);
    } catch (error) {
        logger.error({ error: (error as Error).message, stack: (error as Error).stack, correlationId, taskId }, 'Failed to persist LLM metrics to database');
    }
}

async function storeMetricsToRedis(metricsRedis: InstanceType<typeof Redis>, llmMetrics: LLMMetricsData, correlationId?: string): Promise<void> {
    const llmMetricsKey = `llm:metrics:${correlationId}`;
    await metricsRedis.setex(llmMetricsKey, 30 * 24 * 3600, JSON.stringify(llmMetrics));
}

async function storeTimeSeriesEntry(metricsRedis: InstanceType<typeof Redis>, entry: Record<string, unknown>): Promise<void> {
    await metricsRedis.lpush('llm:metrics:timeseries', JSON.stringify(entry));
    await metricsRedis.ltrim('llm:metrics:timeseries', 0, 999);
}

function logConversationDebug(claudeResult: ClaudeResult | null, correlationId?: string, taskId?: string | null): void {
    if (claudeResult?.conversationLog && claudeResult.conversationLog.length > 0) {
        logger.info({
            correlationId, taskId, conversationLogLength: claudeResult.conversationLog.length,
            firstItemKeys: Object.keys(claudeResult.conversationLog[0]),
            firstItemSample: JSON.stringify(claudeResult.conversationLog[0]).substring(0, 300)
        }, 'DEBUG: ConversationLog structure');
    }
}

/**
 * Records LLM metrics for a completed Claude execution
 * @param claudeResult - Result from Claude execution
 * @param issueRef - Issue reference
 * @param options - Additional options including jobType, correlationId, taskId, and executionType
 */
export async function recordLLMMetrics(claudeResult: ClaudeResult | null, issueRef: IssueRef, options: RecordMetricsOptions = {}): Promise<void> {
    const { jobType = 'issue', correlationId, taskId = null, executionType = 'implementation' } = options;
    const metricsRedis = new Redis(connectionOptions);
    logger.info({
        correlationId, taskId, hasClaudeResult: !!claudeResult,
        hasConversationLog: !!claudeResult?.conversationLog,
        conversationLogType: Array.isArray(claudeResult?.conversationLog) ? 'array' : typeof claudeResult?.conversationLog,
        conversationLogLength: claudeResult?.conversationLog?.length ?? 0
    }, 'DEBUG: recordLLMMetrics called');

    try {
        const timestamp = new Date().toISOString();
        const dateKey = timestamp.split('T')[0];
        const extracted = extractMetricsFromClaudeResult(claudeResult);
        const { model, success, executionTimeMs, executionTimeSec, numTurns, sessionId, conversationId } = extracted;
        const cumulativeTokens = calculateTokens(claudeResult?.conversationLog);
        const costUsd = await calculateCost(model, cumulativeTokens, claudeResult);
        const repository = `${issueRef.repoOwner}/${issueRef.repoName}`;

        const llmMetrics: LLMMetricsData = {
            correlationId, timestamp, issueNumber: issueRef.number, repository, jobType,
            model, success, executionTimeMs, executionTimeSec, numTurns, costUsd,
            sessionId, conversationId, error: claudeResult?.error ?? null,
            failureReason: !success ? (claudeResult?.error ?? 'unknown') : null
        };
        await storeMetricsToRedis(metricsRedis, llmMetrics, correlationId);
        await updateAggregatedMetrics(metricsRedis, { model, success, costUsd, numTurns, executionTimeMs, dateKey });
        await storeTimeSeriesEntry(metricsRedis, { timestamp, correlationId, model, success, costUsd, executionTimeSec, numTurns, repository });
        await checkCostThreshold(metricsRedis, { timestamp, correlationId, costUsd, model, numTurns }, issueRef);

        logger.info({ correlationId, issueNumber: issueRef.number, model, success, costUsd, executionTimeSec, numTurns }, 'LLM metrics recorded');
        logConversationDebug(claudeResult, correlationId, taskId);
        if (claudeResult) {
            // Build cumulative token usage from conversation log (same as PR comment)
            const cumulativeTokenUsage: TokenUsage = {
                input_tokens: cumulativeTokens.totalInputWithCache,
                output_tokens: cumulativeTokens.outputTokens,
                cache_creation_input_tokens: cumulativeTokens.cacheCreationTokens,
                cache_read_input_tokens: cumulativeTokens.cacheReadTokens
            };
            await persistToDatabase(claudeResult, taskId, { sessionId, conversationId, executionTimeMs, model, success, numTurns, costUsd, tokenUsage: cumulativeTokenUsage, executionType }, correlationId);
        }
    } catch (error) {
        logger.error({ error: (error as Error).message, stack: (error as Error).stack, correlationId }, 'Failed to record LLM metrics');
    } finally {
        await metricsRedis.quit();
    }
}

async function getTotalMetrics(metricsRedis: InstanceType<typeof Redis>): Promise<LLMMetricsSummary> {
    const totalSuccessful = parseInt(await metricsRedis.get('llm:metrics:total:successful') ?? '0');
    const totalFailed = parseInt(await metricsRedis.get('llm:metrics:total:failed') ?? '0');
    const totalCostUsd = parseFloat(await metricsRedis.get('llm:metrics:total:costUsd') ?? '0');
    const totalTurns = parseInt(await metricsRedis.get('llm:metrics:total:turns') ?? '0');
    const totalExecutionTimeMs = parseInt(await metricsRedis.get('llm:metrics:total:executionTimeMs') ?? '0');
    const totalRequests = totalSuccessful + totalFailed;
    return {
        totalRequests, totalSuccessful, totalFailed,
        successRate: totalRequests > 0 ? totalSuccessful / totalRequests : 0,
        totalCostUsd, avgCostPerRequest: totalRequests > 0 ? totalCostUsd / totalRequests : 0,
        totalTurns, avgTurnsPerRequest: totalRequests > 0 ? totalTurns / totalRequests : 0,
        avgExecutionTimeSec: totalRequests > 0 ? (totalExecutionTimeMs / totalRequests) / 1000 : 0
    };
}

async function getModelMetrics(metricsRedis: InstanceType<typeof Redis>): Promise<Record<string, ModelMetrics>> {
    const modelsUsed = await metricsRedis.smembers('llm:metrics:models:used');
    const modelMetrics: Record<string, ModelMetrics> = {};
    for (const model of modelsUsed) {
        const modelSuccessful = parseInt(await metricsRedis.get(`llm:metrics:model:${model}:successful`) ?? '0');
        const modelFailed = parseInt(await metricsRedis.get(`llm:metrics:model:${model}:failed`) ?? '0');
        const modelCostUsd = parseFloat(await metricsRedis.get(`llm:metrics:model:${model}:costUsd`) ?? '0');
        const modelTurns = parseInt(await metricsRedis.get(`llm:metrics:model:${model}:turns`) ?? '0');
        const modelExecutionTimeMs = parseInt(await metricsRedis.get(`llm:metrics:model:${model}:executionTimeMs`) ?? '0');
        const modelTotal = modelSuccessful + modelFailed;
        modelMetrics[model] = {
            totalRequests: modelTotal, successful: modelSuccessful, failed: modelFailed,
            successRate: modelTotal > 0 ? modelSuccessful / modelTotal : 0,
            totalCostUsd: modelCostUsd, avgCostPerRequest: modelTotal > 0 ? modelCostUsd / modelTotal : 0,
            totalTurns: modelTurns, avgTurnsPerRequest: modelTotal > 0 ? modelTurns / modelTotal : 0,
            avgExecutionTimeSec: modelTotal > 0 ? (modelExecutionTimeMs / modelTotal) / 1000 : 0
        };
    }
    return modelMetrics;
}

async function getDailyMetrics(metricsRedis: InstanceType<typeof Redis>): Promise<DailyMetric[]> {
    const dailyMetrics: DailyMetric[] = [];
    const today = new Date();
    for (let i = 0; i < 7; i++) {
        const date = new Date(today);
        date.setDate(date.getDate() - i);
        const dateKey = date.toISOString().split('T')[0];
        const daySuccessful = parseInt(await metricsRedis.get(`llm:metrics:daily:${dateKey}:successful`) ?? '0');
        const dayFailed = parseInt(await metricsRedis.get(`llm:metrics:daily:${dateKey}:failed`) ?? '0');
        const dayCostUsd = parseFloat(await metricsRedis.get(`llm:metrics:daily:${dateKey}:costUsd`) ?? '0');
        dailyMetrics.push({ date: dateKey, successful: daySuccessful, failed: dayFailed, total: daySuccessful + dayFailed, costUsd: dayCostUsd });
    }
    return dailyMetrics;
}

async function getHighCostAlerts(metricsRedis: InstanceType<typeof Redis>): Promise<HighCostAlert[]> {
    const highCostAlerts = await metricsRedis.lrange('llm:metrics:alerts:highcost', 0, 9);
    return highCostAlerts.map((alert: string) => {
        try { return JSON.parse(alert) as HighCostAlert; } catch { return null; }
    }).filter((alert: HighCostAlert | null): alert is HighCostAlert => alert !== null);
}

export async function getLLMMetricsSummary(): Promise<LLMMetricsSummaryResult> {
    const metricsRedis = new Redis(connectionOptions);
    try {
        const summary = await getTotalMetrics(metricsRedis);
        const modelBreakdown = await getModelMetrics(metricsRedis);
        const dailyMetrics = await getDailyMetrics(metricsRedis);
        const recentHighCostAlerts = await getHighCostAlerts(metricsRedis);
        return { summary, modelBreakdown, dailyMetrics, recentHighCostAlerts, lastUpdated: new Date().toISOString() };
    } catch (error) {
        logger.error({ error: (error as Error).message, stack: (error as Error).stack }, 'Failed to retrieve LLM metrics summary');
        throw error;
    } finally {
        await metricsRedis.quit();
    }
}

export async function getLLMMetricsByCorrelationId(correlationId: string): Promise<LLMMetricsData | null> {
    const metricsRedis = new Redis(connectionOptions);
    try {
        const metricsKey = `llm:metrics:${correlationId}`;
        const metricsData = await metricsRedis.get(metricsKey);
        if (metricsData) {
            return JSON.parse(metricsData) as LLMMetricsData;
        }
        return null;
    } catch (error) {
        logger.error({ error: (error as Error).message, correlationId }, 'Failed to retrieve LLM metrics by correlation ID');
        return null;
    } finally {
        await metricsRedis.quit();
    }
}
