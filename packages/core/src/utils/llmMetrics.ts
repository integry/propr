import { Redis } from 'ioredis';
import logger from './logger.js';
import { db } from '../db/connection.js';
import { getAnalysisQueue } from '../queue/taskQueue.js';
import { getOpenRouterId } from '../config/modelAliases.js';
import { getModelPricing } from '../services/pricingService.js';
import { getCachePricingMultipliers } from './tokenCalculation.js';
import type { RedisConnectionOptions, ClaudeResult, IssueRef, RecordMetricsOptions, ModelPricing, ExtractedMetrics, AggregatedMetrics, CostCheckMetrics, PersistMetrics, ConversationDetailParams, ConversationDetail, ConversationStep, MessageContent, LLMMetricsSummary, ModelMetrics, DailyMetric, HighCostAlert, LLMMetricsSummaryResult, LLMMetricsData, TokenUsage } from './llmMetrics.types.js';

const REDIS_HOST: string = process.env.REDIS_HOST ?? '127.0.0.1';
const REDIS_PORT: number = parseInt(process.env.REDIS_PORT ?? '6379', 10);

const connectionOptions: RedisConnectionOptions = { host: REDIS_HOST, port: REDIS_PORT, maxRetriesPerRequest: null, enableReadyCheck: false };

function extractMetricsFromClaudeResult(claudeResult: ClaudeResult | null): ExtractedMetrics {
    const model = claudeResult?.model ?? process.env.CLAUDE_MODEL ?? 'unknown';
    const executionTimeMs = claudeResult?.executionTime ?? 0;
    return { model, success: claudeResult?.success ?? false, executionTimeMs, executionTimeSec: Math.round(executionTimeMs / 1000),
        numTurns: claudeResult?.finalResult?.num_turns ?? 0, sessionId: claudeResult?.sessionId ?? 'unknown',
        conversationId: claudeResult?.conversationId ?? null };
}

interface CumulativeTokenUsage {
    inputTokens: number; outputTokens: number; cacheCreationTokens: number; cacheReadTokens: number;
    totalInputWithCache: number;  // input + cache_creation + cache_read (for cost calc and display)
}
interface GenericConversationStep {
    message?: ConversationStep['message'] | string; timestamp?: string; type?: string; isError?: boolean; metadata?: Record<string, unknown>;
    role?: string; content?: string; tool?: string; params?: unknown; result?: string; usage?: TokenUsage;
    item?: { type?: string; text?: string; command?: string; aggregated_output?: string; exit_code?: number | null; items?: Array<{ text?: string; completed?: boolean }> };
}
function calculateTokens(conversationLog: ConversationStep[] | undefined, reportedTokenUsage?: TokenUsage): CumulativeTokenUsage {
    let aggrInput = 0, aggrOutput = 0, aggrCacheCreate = 0, aggrCacheRead = 0;
    if (conversationLog && Array.isArray(conversationLog)) {
        const seenIds = new Set<string>(); // Deduplicate by message ID (per Claude docs, same ID = same usage)
        conversationLog.forEach(step => {
            const message = step.message as { id?: string; usage?: TokenUsage } | undefined;
            // Check both message?.usage and root-level step.usage (Claude CLI stores usage in either location)
            const usage = message?.usage || (step as { usage?: TokenUsage }).usage;
            if (usage) {
                const msgId = message?.id;
                if (msgId && seenIds.has(msgId)) return;
                if (msgId) seenIds.add(msgId);
                aggrInput += usage.input_tokens ?? 0; aggrOutput += usage.output_tokens ?? 0;
                aggrCacheCreate += usage.cache_creation_input_tokens ?? 0; aggrCacheRead += usage.cache_read_input_tokens ?? 0;
            }
        });
    }
    const rptInput = reportedTokenUsage?.input_tokens ?? 0, rptOutput = reportedTokenUsage?.output_tokens ?? 0;
    const rptCacheCreate = reportedTokenUsage?.cache_creation_input_tokens ?? 0, rptCacheRead = reportedTokenUsage?.cache_read_input_tokens ?? 0;
    const aggrTotal = aggrInput + aggrOutput + aggrCacheCreate + aggrCacheRead;
    const rptTotal = rptInput + rptOutput + rptCacheCreate + rptCacheRead;
    const useAggr = aggrTotal > rptTotal; // Use whichever is higher to avoid undercounting
    const [inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens] = useAggr
        ? [aggrInput, aggrOutput, aggrCacheCreate, aggrCacheRead] : [rptInput, rptOutput, rptCacheCreate, rptCacheRead];
    return { inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens, totalInputWithCache: inputTokens + cacheCreationTokens + cacheReadTokens };
}

async function calculateCost(model: string, tokens: CumulativeTokenUsage, claudeResult: ClaudeResult | null): Promise<number> {
    const openRouterId = getOpenRouterId(model);
    const pricing = await getModelPricing(openRouterId) as ModelPricing | null;
    const { inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens } = tokens;
    const { cacheReadMultiplier, cacheCreationMultiplier } = getCachePricingMultipliers(model);
    logger.info({ model, openRouterId, pricingFound: !!pricing, pricing, inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens,
        cacheReadMultiplier, cacheCreationMultiplier }, 'Cost calculation: looking up pricing');
    const hasTokens = inputTokens > 0 || outputTokens > 0 || cacheCreationTokens > 0 || cacheReadTokens > 0;
    let calculatedCostUsd = 0;
    if (pricing && hasTokens) {
        const inputCost = inputTokens * pricing.prompt, outputCost = outputTokens * pricing.completion;
        const cacheCreationCost = cacheCreationTokens * pricing.prompt * cacheCreationMultiplier;
        const cacheReadCost = cacheReadTokens * pricing.prompt * cacheReadMultiplier;
        calculatedCostUsd = inputCost + cacheCreationCost + cacheReadCost + outputCost;
        logger.info({ model, openRouterId, calculatedCostUsd, breakdown: { inputCost, cacheCreationCost, cacheReadCost, outputCost } },
            'Calculated dynamic cost with cache pricing');
    } else if (!pricing) { logger.warn({ model, openRouterId }, 'No pricing found for model - cost will be 0 or fallback'); }
    else { logger.warn({ model, inputTokens, outputTokens }, 'No token data available - cost will be 0 or fallback'); }
    return calculatedCostUsd > 0 ? calculatedCostUsd : (claudeResult?.finalResult?.cost_usd ?? claudeResult?.finalResult?.total_cost_usd ?? 0);
}

async function updateAggregatedMetrics(metricsRedis: InstanceType<typeof Redis>, metrics: AggregatedMetrics): Promise<void> {
    const { model, success, costUsd, numTurns, executionTimeMs, dateKey } = metrics;
    const successKey = success ? 'successful' : 'failed';
    const incrAndAdd = async (key: string, val: number, isFloat = false) => {
        const cur = isFloat ? parseFloat(await metricsRedis.get(key) ?? '0') : parseInt(await metricsRedis.get(key) ?? '0');
        await metricsRedis.set(key, isFloat ? (cur + val).toFixed(4) : String(cur + val));
    };
    await Promise.all([
        metricsRedis.incr(`llm:metrics:total:${successKey}`), metricsRedis.incr(`llm:metrics:daily:${dateKey}:${successKey}`),
        metricsRedis.incr(`llm:metrics:model:${model}:${successKey}`), metricsRedis.sadd('llm:metrics:models:used', model)
    ]);
    await Promise.all([
        incrAndAdd('llm:metrics:total:costUsd', costUsd, true), incrAndAdd(`llm:metrics:daily:${dateKey}:costUsd`, costUsd, true),
        incrAndAdd(`llm:metrics:model:${model}:costUsd`, costUsd, true), incrAndAdd('llm:metrics:total:turns', numTurns),
        incrAndAdd(`llm:metrics:model:${model}:turns`, numTurns), incrAndAdd('llm:metrics:total:executionTimeMs', executionTimeMs),
        incrAndAdd(`llm:metrics:model:${model}:executionTimeMs`, executionTimeMs)
    ]);
}

async function checkCostThreshold(metricsRedis: InstanceType<typeof Redis>, metrics: CostCheckMetrics, issueRef: IssueRef): Promise<void> {
    const { timestamp, correlationId, costUsd, model, numTurns } = metrics;
    const costThreshold = parseFloat(process.env.LLM_COST_THRESHOLD_USD ?? '10.00');
    if (costUsd > costThreshold) {
        const alertEntry: HighCostAlert = { timestamp, correlationId, issueNumber: issueRef.number,
            repository: `${issueRef.repoOwner}/${issueRef.repoName}`, costUsd, threshold: costThreshold, model, numTurns };
        await metricsRedis.lpush('llm:metrics:alerts:highcost', JSON.stringify(alertEntry));
        await metricsRedis.ltrim('llm:metrics:alerts:highcost', 0, 99);
        logger.warn({ ...alertEntry, message: 'LLM cost exceeded threshold' });
    }
}

function extractToolUsage(content: MessageContent[] | undefined): { toolName: string | null; toolInput: unknown | null; toolUseId: string | null } {
    const toolUse = content?.find(b => b.type === 'tool_use');
    return toolUse ? { toolName: toolUse.name ?? null, toolInput: toolUse.input ?? null, toolUseId: toolUse.id ?? null }
        : { toolName: null, toolInput: null, toolUseId: null };
}

function buildPayload(content: string | null, isError = false, toolName: string | null = null, toolInput: unknown | null = null): { content: string | null; toolName: string | null; toolInput: unknown | null; toolUseId: string | null; isError: boolean } { return { content, toolName, toolInput, toolUseId: null, isError }; }
function getCommandExecutionPayload(step: GenericConversationStep) { return buildPayload(step.item?.aggregated_output ?? JSON.stringify(step), step.item?.exit_code != null && step.item.exit_code !== 0, 'command_execution', step.item?.command ? { command: step.item.command } : null); }
function getReasoningPayload(step: GenericConversationStep) { return buildPayload(step.item?.text ?? null); }
function getFallbackPayload(step: GenericConversationStep) { return buildPayload(JSON.stringify(step), step.isError ?? false); }

function getGenericStepPayload(step: GenericConversationStep): {
    content: string | null;
    toolName: string | null;
    toolInput: unknown | null;
    toolUseId: string | null;
    isError: boolean;
} {
    if (step.message) return buildPayload(JSON.stringify(step.message), step.isError ?? false);
    if (step.type === 'message' && step.role === 'assistant') return buildPayload(step.content ?? JSON.stringify(step));
    if (step.type === 'tool_use') return buildPayload(JSON.stringify(step), false, step.tool ?? null, step.params ?? null);
    if (step.type === 'error') return buildPayload(step.message ?? step.result ?? JSON.stringify(step), true);
    if (step.item?.type === 'command_execution') return getCommandExecutionPayload(step);
    if ((step.item?.type === 'reasoning' || step.item?.type === 'agent_message') && step.item.text) return getReasoningPayload(step);
    return getFallbackPayload(step);
}
function calculateMessageCost(messageTokens: number, totalTokens: number, costUsd: number): number | null { return totalTokens > 0 && costUsd > 0 ? (messageTokens / totalTokens) * costUsd : null; }
function calculateDurationMs(step: ConversationStep, index: number, conversationLog: ConversationStep[]): number | null { return index <= 0 || !step.timestamp || !conversationLog[index - 1].timestamp ? null : new Date(step.timestamp).getTime() - new Date(conversationLog[index - 1].timestamp!).getTime(); }
function getStepTokenUsage(step: ConversationStep, genericStep: GenericConversationStep) { return { inputTokens: step.message?.usage?.input_tokens ?? genericStep.usage?.input_tokens ?? null, outputTokens: step.message?.usage?.output_tokens ?? genericStep.usage?.output_tokens ?? null }; }
function getStepContent(step: ConversationStep, hasClaudeMessage: boolean, genericPayload: ReturnType<typeof getGenericStepPayload> | null): string | null { return hasClaudeMessage ? JSON.stringify(step.message) : genericPayload?.content ?? null; }
function getStepMetadata(step: ConversationStep, hasClaudeMessage: boolean): string | null { return hasClaudeMessage ? (step.metadata ? JSON.stringify(step.metadata) : null) : JSON.stringify(step); }

function buildConversationDetail(params: ConversationDetailParams): ConversationDetail {
    const { step, index, executionId, conversationLog, totalTokens, costUsd } = params;
    const genericStep = step as GenericConversationStep;
    const hasClaudeMessage = !!step.message;
    const { toolName, toolInput, toolUseId } = hasClaudeMessage
        ? extractToolUsage(step.message?.content)
        : getGenericStepPayload(genericStep);
    const { inputTokens, outputTokens } = getStepTokenUsage(step, genericStep);
    const messageTokens = (inputTokens ?? 0) + (outputTokens ?? 0);
    const genericPayload = hasClaudeMessage ? null : getGenericStepPayload(genericStep);
    return {
        execution_id: executionId, sequence_number: index,
        event_timestamp: step.timestamp ?? new Date().toISOString(),
        event_type: step.type ?? 'unknown',
        content: getStepContent(step, hasClaudeMessage, genericPayload),
        duration_ms: calculateDurationMs(step, index, conversationLog),
        token_count_input: inputTokens,
        token_count_output: outputTokens,
        cost_usd: calculateMessageCost(messageTokens, totalTokens, costUsd),
        is_error: hasClaudeMessage ? (step.isError ?? false) : (genericPayload?.isError ?? false), tool_name: toolName,
        tool_input: toolInput ? JSON.stringify(toolInput) : null,
        tool_use_id: toolUseId,
        metadata: getStepMetadata(step, hasClaudeMessage)
    };
}
interface ProcessConversationLogParams { claudeResult: ClaudeResult; executionId: string; costUsd: number; correlationId?: string; taskId?: string | null; }

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
/**
 * Whether a recorded execution should trigger a post-execution "task analysis".
 *
 * Only real implementation runs (issue / pr-comments-batch / merge-conflict)
 * produce a commit/diff worth analyzing, and they are recorded with no explicit
 * executionType — so allow undefined/null or 'implementation'. Every other type
 * is excluded by default.
 *
 * This is the anti-recursion guard: the analysis itself runs claude and records
 * its own execution with executionType 'task-analysis'. If that re-enqueued an
 * analysis, it would analyze-the-analysis forever (the analysis-processor loop
 * that wedged production). An allowlist means any future executionType is
 * excluded by default and cannot re-introduce the recursion.
 */
export function shouldEnqueueExecutionAnalysis(executionType?: string | null): boolean {
    return executionType == null || executionType === 'implementation';
}

async function enqueueAnalysisTask(taskId: string, executionId: string, sessionId: string, correlationId?: string): Promise<void> {
    try {
        const queue = await getAnalysisQueue();
        await queue.add('analyzeExecution', {
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
async function persistToDatabase(claudeResult: ClaudeResult, taskId: string | null, metrics: PersistMetrics): Promise<void> {
    const { sessionId, conversationId, executionTimeMs, model, success, numTurns, costUsd, tokenUsage, correlationId, executionType } = metrics;

    // Check if taskId exists in tasks table (drafts won't exist)
    // Use null for task_id if it doesn't exist (FK allows null now)
    let effectiveTaskId: string | null = null;
    if (taskId) {
        const taskExists = await db('tasks').where({ task_id: taskId }).first();
        effectiveTaskId = taskExists ? taskId : null;
    }

    try {
        const executionData = {
            task_id: effectiveTaskId, session_id: sessionId, conversation_id: conversationId,
            start_time: new Date(Date.now() - executionTimeMs).toISOString(),
            end_time: new Date().toISOString(), duration_ms: executionTimeMs,
            model_name: model, success: success, num_turns: numTurns, cost_usd: costUsd,
            error_message: !success ? (claudeResult?.error ?? 'Unknown error') : null,
            prompt_length: null, output_length: null,
            input_tokens: tokenUsage?.input_tokens ?? null,
            output_tokens: tokenUsage?.output_tokens ?? null,
            cache_creation_input_tokens: tokenUsage?.cache_creation_input_tokens ?? null,
            cache_read_input_tokens: tokenUsage?.cache_read_input_tokens ?? null
        };
        const [insertedExecution] = await db('llm_executions').insert(executionData).returning('execution_id');
        const executionId = (insertedExecution as { execution_id: string }).execution_id;

        await processConversationLog({ claudeResult, executionId, costUsd, correlationId, taskId: effectiveTaskId });
        logger.debug({ correlationId, taskId: effectiveTaskId, executionId }, 'LLM metrics persisted to database');

        // Only enqueue post-execution analysis for real implementation runs — the
        // only ones that produce a commit/diff worth analyzing. Implementation
        // executions (issue / pr-comments-batch / merge-conflict) are recorded with
        // no explicit executionType, so allow undefined or 'implementation'.
        //
        // Excluding everything else is CRITICAL, not just cosmetic: the analysis
        // itself runs claude (executeClaudeAnalysis) which records its own execution
        // with executionType 'task-analysis'. Under the old `!== 'pr-review'` gate
        // that re-enqueued another analysis → analyze-the-analysis forever, an
        // infinite recursion in the analysis-processor queue (execution IDs climbing
        // every ~80s) that wedged production. Reviews/chat/planning/summaries/titles
        // produce no commit and shouldn't be analyzed either.
        if (effectiveTaskId && shouldEnqueueExecutionAnalysis(executionType)) {
            await enqueueAnalysisTask(effectiveTaskId, executionId, sessionId, correlationId);
        } else {
            logger.debug({ correlationId, taskId: effectiveTaskId, executionId, executionType }, 'Skipping analysis queue (non-implementation execution)');
        }
    } catch (error) {
        logger.error({ error: (error as Error).message, stack: (error as Error).stack, correlationId, taskId }, 'Failed to persist LLM metrics to database');
    }
}
async function storeMetricsToRedis(metricsRedis: InstanceType<typeof Redis>, llmMetrics: LLMMetricsData, correlationId?: string): Promise<void> { await metricsRedis.setex(`llm:metrics:${correlationId}`, 30 * 24 * 3600, JSON.stringify(llmMetrics)); }
async function storeTimeSeriesEntry(metricsRedis: InstanceType<typeof Redis>, entry: Record<string, unknown>): Promise<void> { await metricsRedis.lpush('llm:metrics:timeseries', JSON.stringify(entry)); await metricsRedis.ltrim('llm:metrics:timeseries', 0, 999); }
function logConversationDebug(claudeResult: ClaudeResult | null, correlationId?: string, taskId?: string | null): void {
    if (claudeResult?.conversationLog && claudeResult.conversationLog.length > 0) {
        logger.info({
            correlationId, taskId, conversationLogLength: claudeResult.conversationLog.length,
            firstItemKeys: Object.keys(claudeResult.conversationLog[0]),
            firstItemSample: JSON.stringify(claudeResult.conversationLog[0]).substring(0, 300)
        }, 'DEBUG: ConversationLog structure');
    }
}
export async function recordLLMMetrics(claudeResult: ClaudeResult | null, issueRef: IssueRef, options: RecordMetricsOptions = {}): Promise<void> {
    const { jobType = 'issue', correlationId, taskId = null, executionType } = options;
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
        const cumulativeTokens = calculateTokens(claudeResult?.conversationLog, claudeResult?.tokenUsage);
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
            await persistToDatabase(claudeResult, taskId, { sessionId, conversationId, executionTimeMs, model, success, numTurns, costUsd, tokenUsage: cumulativeTokenUsage, correlationId, executionType });
        }
    } catch (error) {
        logger.error({ error: (error as Error).message, stack: (error as Error).stack, correlationId }, 'Failed to record LLM metrics');
    } finally {
        await metricsRedis.quit();
    }
}
async function getTotalMetrics(metricsRedis: InstanceType<typeof Redis>): Promise<LLMMetricsSummary> {
    const [totalSuccessful, totalFailed, totalCostUsd, totalTurns, totalExecutionTimeMs] = await Promise.all([
        metricsRedis.get('llm:metrics:total:successful').then(v => parseInt(v ?? '0')),
        metricsRedis.get('llm:metrics:total:failed').then(v => parseInt(v ?? '0')),
        metricsRedis.get('llm:metrics:total:costUsd').then(v => parseFloat(v ?? '0')),
        metricsRedis.get('llm:metrics:total:turns').then(v => parseInt(v ?? '0')),
        metricsRedis.get('llm:metrics:total:executionTimeMs').then(v => parseInt(v ?? '0'))
    ]);
    const totalRequests = totalSuccessful + totalFailed;
    const avg = (val: number) => totalRequests > 0 ? val / totalRequests : 0;
    return { totalRequests, totalSuccessful, totalFailed, successRate: avg(totalSuccessful), totalCostUsd,
        avgCostPerRequest: avg(totalCostUsd), totalTurns, avgTurnsPerRequest: avg(totalTurns),
        avgExecutionTimeSec: avg(totalExecutionTimeMs) / 1000 };
}
async function getModelMetrics(metricsRedis: InstanceType<typeof Redis>): Promise<Record<string, ModelMetrics>> {
    const modelsUsed = await metricsRedis.smembers('llm:metrics:models:used');
    const entries = await Promise.all(modelsUsed.map(async (model) => {
        const [successful, failed, costUsd, turns, execTimeMs] = await Promise.all([
            metricsRedis.get(`llm:metrics:model:${model}:successful`).then(v => parseInt(v ?? '0')),
            metricsRedis.get(`llm:metrics:model:${model}:failed`).then(v => parseInt(v ?? '0')),
            metricsRedis.get(`llm:metrics:model:${model}:costUsd`).then(v => parseFloat(v ?? '0')),
            metricsRedis.get(`llm:metrics:model:${model}:turns`).then(v => parseInt(v ?? '0')),
            metricsRedis.get(`llm:metrics:model:${model}:executionTimeMs`).then(v => parseInt(v ?? '0'))
        ]);
        const total = successful + failed;
        const avg = (val: number) => total > 0 ? val / total : 0;
        return [model, { totalRequests: total, successful, failed, successRate: avg(successful), totalCostUsd: costUsd,
            avgCostPerRequest: avg(costUsd), totalTurns: turns, avgTurnsPerRequest: avg(turns),
            avgExecutionTimeSec: avg(execTimeMs) / 1000 }] as const;
    }));
    return Object.fromEntries(entries);
}
async function getDailyMetrics(metricsRedis: InstanceType<typeof Redis>): Promise<DailyMetric[]> {
    const today = new Date();
    const dateKeys = Array.from({ length: 7 }, (_, i) => {
        const d = new Date(today); d.setDate(d.getDate() - i); return d.toISOString().split('T')[0];
    });
    return Promise.all(dateKeys.map(async (dateKey) => {
        const [successful, failed, costUsd] = await Promise.all([
            metricsRedis.get(`llm:metrics:daily:${dateKey}:successful`).then(v => parseInt(v ?? '0')),
            metricsRedis.get(`llm:metrics:daily:${dateKey}:failed`).then(v => parseInt(v ?? '0')),
            metricsRedis.get(`llm:metrics:daily:${dateKey}:costUsd`).then(v => parseFloat(v ?? '0'))
        ]);
        return { date: dateKey, successful, failed, total: successful + failed, costUsd };
    }));
}
async function getHighCostAlerts(metricsRedis: InstanceType<typeof Redis>): Promise<HighCostAlert[]> {
    return (await metricsRedis.lrange('llm:metrics:alerts:highcost', 0, 9))
        .map((a: string) => { try { return JSON.parse(a) as HighCostAlert; } catch { return null; } })
        .filter((a): a is HighCostAlert => a !== null);
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
        const data = await metricsRedis.get(`llm:metrics:${correlationId}`);
        return data ? JSON.parse(data) as LLMMetricsData : null;
    } catch (error) {
        logger.error({ error: (error as Error).message, correlationId }, 'Failed to retrieve LLM metrics by correlation ID');
        return null;
    } finally { await metricsRedis.quit(); }
}
