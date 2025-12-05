import Redis from 'ioredis';
import logger from './logger.js';
import { db, isEnabled as isDbEnabled } from '../db/postgres.js';
import { analysisQueue } from '../queue/taskQueue.js';
import { getOpenRouterId } from '../config/modelAliases.js';
import { getModelPricing } from '../services/pricingService.js';

// Redis configuration
const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379', 10);

const connectionOptions = {
    host: REDIS_HOST,
    port: REDIS_PORT,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
};

function extractMetricsFromClaudeResult(claudeResult) {
    const model = claudeResult?.model || process.env.CLAUDE_MODEL || 'unknown';
    const success = claudeResult?.success || false;
    const executionTimeMs = claudeResult?.executionTime || 0;
    const executionTimeSec = Math.round(executionTimeMs / 1000);
    const numTurns = claudeResult?.finalResult?.num_turns || 0;
    const sessionId = claudeResult?.sessionId || 'unknown';
    const conversationId = claudeResult?.conversationId || null;
    return { model, success, executionTimeMs, executionTimeSec, numTurns, sessionId, conversationId };
}

function calculateTokens(conversationLog) {
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    if (conversationLog && Array.isArray(conversationLog)) {
        conversationLog.forEach(step => {
            totalInputTokens += step.message?.usage?.input_tokens || 0;
            totalOutputTokens += step.message?.usage?.output_tokens || 0;
        });
    }
    return { totalInputTokens, totalOutputTokens };
}

async function calculateCost(model, totalInputTokens, totalOutputTokens, claudeResult) {
    let calculatedCostUsd = 0;
    const openRouterId = getOpenRouterId(model);
    const pricing = await getModelPricing(openRouterId);
    if (pricing) {
        calculatedCostUsd = (totalInputTokens * pricing.prompt) + (totalOutputTokens * pricing.completion);
        logger.debug({ model, openRouterId, pricing, totalInputTokens, totalOutputTokens, calculatedCostUsd }, 'Calculated dynamic cost from OpenRouter pricing');
    }
    return calculatedCostUsd > 0 ? calculatedCostUsd : (claudeResult?.finalResult?.cost_usd || claudeResult?.finalResult?.total_cost_usd || 0);
}

async function updateAggregatedMetrics(metricsRedis, metrics) {
    const { model, success, costUsd, numTurns, executionTimeMs, dateKey } = metrics;
    const successKey = success ? 'successful' : 'failed';
    await metricsRedis.incr(`llm:metrics:total:${successKey}`);
    await metricsRedis.incr(`llm:metrics:daily:${dateKey}:${successKey}`);
    await metricsRedis.incr(`llm:metrics:model:${model}:${successKey}`);

    const currentTotalCost = parseFloat(await metricsRedis.get('llm:metrics:total:costUsd') || '0');
    await metricsRedis.set('llm:metrics:total:costUsd', (currentTotalCost + costUsd).toFixed(4));
    const currentDailyCost = parseFloat(await metricsRedis.get(`llm:metrics:daily:${dateKey}:costUsd`) || '0');
    await metricsRedis.set(`llm:metrics:daily:${dateKey}:costUsd`, (currentDailyCost + costUsd).toFixed(4));
    const currentModelCost = parseFloat(await metricsRedis.get(`llm:metrics:model:${model}:costUsd`) || '0');
    await metricsRedis.set(`llm:metrics:model:${model}:costUsd`, (currentModelCost + costUsd).toFixed(4));

    const currentTotalTurns = parseInt(await metricsRedis.get('llm:metrics:total:turns') || '0');
    await metricsRedis.set('llm:metrics:total:turns', currentTotalTurns + numTurns);
    const currentModelTurns = parseInt(await metricsRedis.get(`llm:metrics:model:${model}:turns`) || '0');
    await metricsRedis.set(`llm:metrics:model:${model}:turns`, currentModelTurns + numTurns);

    const currentTotalTime = parseInt(await metricsRedis.get('llm:metrics:total:executionTimeMs') || '0');
    await metricsRedis.set('llm:metrics:total:executionTimeMs', currentTotalTime + executionTimeMs);
    const currentModelTime = parseInt(await metricsRedis.get(`llm:metrics:model:${model}:executionTimeMs`) || '0');
    await metricsRedis.set(`llm:metrics:model:${model}:executionTimeMs`, currentModelTime + executionTimeMs);

    await metricsRedis.sadd('llm:metrics:models:used', model);
}

async function checkCostThreshold(metricsRedis, metrics, issueRef) {
    const { timestamp, correlationId, costUsd, model, numTurns } = metrics;
    const costThreshold = parseFloat(process.env.LLM_COST_THRESHOLD_USD || '10.00');
    if (costUsd > costThreshold) {
        const alertEntry = {
            timestamp,
            correlationId,
            issueNumber: issueRef.number,
            repository: `${issueRef.repoOwner}/${issueRef.repoName}`,
            costUsd,
            threshold: costThreshold,
            model,
            numTurns
        };
        await metricsRedis.lpush('llm:metrics:alerts:highcost', JSON.stringify(alertEntry));
        await metricsRedis.ltrim('llm:metrics:alerts:highcost', 0, 99);
        logger.warn({ ...alertEntry, message: 'LLM cost exceeded threshold' });
    }
}

function extractToolUsage(messageContent) {
    if (!messageContent || !Array.isArray(messageContent)) return { toolName: null, toolInput: null, toolUseId: null };
    const toolUse = messageContent.find(block => block.type === 'tool_use');
    if (!toolUse) return { toolName: null, toolInput: null, toolUseId: null };
    return { toolName: toolUse.name, toolInput: toolUse.input, toolUseId: toolUse.id };
}

function calculateMessageCost(messageTokens, totalTokens, costUsd) {
    return totalTokens > 0 && costUsd > 0 ? (messageTokens / totalTokens) * costUsd : null;
}

function calculateDurationMs(step, index, conversationLog) {
    if (index <= 0 || !step.timestamp || !conversationLog[index - 1].timestamp) return null;
    return new Date(step.timestamp).getTime() - new Date(conversationLog[index - 1].timestamp).getTime();
}

function buildConversationDetail(params) {
    const { step, index, executionId, conversationLog, totalTokens, costUsd } = params;
    const { toolName, toolInput, toolUseId } = extractToolUsage(step.message?.content);
    const messageTokens = (step.message?.usage?.input_tokens || 0) + (step.message?.usage?.output_tokens || 0);
    return {
        execution_id: executionId,
        sequence_number: index,
        event_timestamp: step.timestamp || new Date().toISOString(),
        event_type: step.type || 'unknown',
        content: step.message ? JSON.stringify(step.message) : null,
        duration_ms: calculateDurationMs(step, index, conversationLog),
        token_count_input: step.message?.usage?.input_tokens || null,
        token_count_output: step.message?.usage?.output_tokens || null,
        cost_usd: calculateMessageCost(messageTokens, totalTokens, costUsd),
        is_error: step.isError || false,
        tool_name: toolName,
        tool_input: toolInput ? JSON.stringify(toolInput) : null,
        tool_use_id: toolUseId,
        metadata: step.metadata ? JSON.stringify(step.metadata) : null
    };
}

async function persistToDatabase(claudeResult, taskId, metrics, correlationId) {
    if (!isDbEnabled || !db || !taskId) return;
    const { sessionId, conversationId, executionTimeMs, model, success, numTurns, costUsd } = metrics;
    try {
        const executionData = {
            task_id: taskId,
            session_id: sessionId,
            conversation_id: conversationId,
            start_time: new Date(Date.now() - executionTimeMs).toISOString(),
            end_time: new Date().toISOString(),
            duration_ms: executionTimeMs,
            model_name: model,
            success: success,
            num_turns: numTurns,
            cost_usd: costUsd,
            error_message: !success ? (claudeResult?.error || 'Unknown error') : null,
            prompt_length: null,
            output_length: null
        };
        const [insertedExecution] = await db('llm_executions').insert(executionData).returning('execution_id');
        const executionId = insertedExecution.execution_id;

        if (claudeResult.conversationLog && Array.isArray(claudeResult.conversationLog)) {
            if (claudeResult.conversationLog.length > 0) {
                logger.debug({
                    correlationId,
                    taskId,
                    sampleKeys: Object.keys(claudeResult.conversationLog[0]),
                    sampleItem: JSON.stringify(claudeResult.conversationLog[0]).substring(0, 200)
                }, 'ConversationLog sample structure');
            }
            let totalTokens = 0;
            claudeResult.conversationLog.forEach((step) => {
                totalTokens += (step.message?.usage?.input_tokens || 0) + (step.message?.usage?.output_tokens || 0);
            });
            const detailsArray = claudeResult.conversationLog.map((step, index) =>
                buildConversationDetail({ step, index, executionId, conversationLog: claudeResult.conversationLog, totalTokens, costUsd })
            );
            if (detailsArray.length > 0) {
                logger.info({
                    correlationId,
                    taskId,
                    sampleDetail: {
                        sequence: detailsArray[0].sequence_number,
                        type: detailsArray[0].event_type,
                        hasContent: !!detailsArray[0].content,
                        contentPreview: detailsArray[0].content?.substring(0, 100),
                        inputTokens: detailsArray[0].token_count_input,
                        outputTokens: detailsArray[0].token_count_output,
                        toolName: detailsArray[0].tool_name
                    }
                }, 'DEBUG: Sample detail before insert');
                await db('llm_execution_details').insert(detailsArray);
            }
        }
        logger.debug({ correlationId, taskId, executionId }, 'LLM metrics persisted to database');
        try {
            await analysisQueue.add('analyzeExecution', {
                taskId,
                executionId,
                sessionId,
                correlationId,
            }, {
                jobId: `analysis-${executionId}`,
                removeOnComplete: true,
                removeOnFail: true,
                delay: 10000,
            });
            logger.debug({ correlationId, taskId, executionId }, 'Enqueued task for execution analysis (with 10s delay)');
        } catch (queueError) {
            logger.error({ error: queueError.message, correlationId, taskId }, 'Failed to enqueue task for analysis');
        }
    } catch (error) {
        logger.error({ error: error.message, stack: error.stack, correlationId, taskId }, 'Failed to persist LLM metrics to database');
    }
}

/**
 * Records LLM metrics for a completed Claude execution
 * @param {Object} claudeResult - Result from Claude execution
 * @param {Object} issueRef - Issue reference
 * @param {string} jobType - Type of job (issue or pr_comment)
 * @param {string} correlationId - Correlation ID for tracking
 * @param {string} taskId - Task identifier for database persistence
 */
export async function recordLLMMetrics(claudeResult, issueRef, options = {}) {
    const { jobType = 'issue', correlationId, taskId = null } = options;
    const metricsRedis = new Redis(connectionOptions);
    logger.info({
        correlationId,
        taskId,
        hasClaudeResult: !!claudeResult,
        hasConversationLog: !!claudeResult?.conversationLog,
        conversationLogType: Array.isArray(claudeResult?.conversationLog) ? 'array' : typeof claudeResult?.conversationLog,
        conversationLogLength: claudeResult?.conversationLog?.length || 0
    }, 'DEBUG: recordLLMMetrics called');

    try {
        const timestamp = new Date().toISOString();
        const dateKey = timestamp.split('T')[0];
        const extracted = extractMetricsFromClaudeResult(claudeResult);
        const { model, success, executionTimeMs, executionTimeSec, numTurns, sessionId, conversationId } = extracted;
        const { totalInputTokens, totalOutputTokens } = calculateTokens(claudeResult?.conversationLog);
        const costUsd = await calculateCost(model, totalInputTokens, totalOutputTokens, claudeResult);

        const llmMetricsKey = `llm:metrics:${correlationId}`;
        const llmMetrics = {
            correlationId, timestamp, issueNumber: issueRef.number,
            repository: `${issueRef.repoOwner}/${issueRef.repoName}`, jobType,
            model, success, executionTimeMs, executionTimeSec, numTurns, costUsd,
            sessionId, conversationId,
            error: claudeResult?.error || null,
            failureReason: !success ? (claudeResult?.error || 'unknown') : null
        };
        await metricsRedis.setex(llmMetricsKey, 30 * 24 * 3600, JSON.stringify(llmMetrics));

        await updateAggregatedMetrics(metricsRedis, { model, success, costUsd, numTurns, executionTimeMs, dateKey });

        const timeSeriesEntry = { timestamp, correlationId, model, success, costUsd, executionTimeSec, numTurns, repository: `${issueRef.repoOwner}/${issueRef.repoName}` };
        await metricsRedis.lpush('llm:metrics:timeseries', JSON.stringify(timeSeriesEntry));
        await metricsRedis.ltrim('llm:metrics:timeseries', 0, 999);

        await checkCostThreshold(metricsRedis, { timestamp, correlationId, costUsd, model, numTurns }, issueRef);

        logger.info({ correlationId, issueNumber: issueRef.number, model, success, costUsd, executionTimeSec, numTurns }, 'LLM metrics recorded');
        if (claudeResult.conversationLog && claudeResult.conversationLog.length > 0) {
            logger.info({
                correlationId, taskId,
                conversationLogLength: claudeResult.conversationLog.length,
                firstItemKeys: Object.keys(claudeResult.conversationLog[0]),
                firstItemSample: JSON.stringify(claudeResult.conversationLog[0]).substring(0, 300)
            }, 'DEBUG: ConversationLog structure');
        }
        await persistToDatabase(claudeResult, taskId, { sessionId, conversationId, executionTimeMs, model, success, numTurns, costUsd }, correlationId);
    } catch (error) {
        logger.error({
            error: error.message,
            stack: error.stack,
            correlationId
        }, 'Failed to record LLM metrics');
    } finally {
        await metricsRedis.quit();
    }
}

async function getTotalMetrics(metricsRedis) {
    const totalSuccessful = parseInt(await metricsRedis.get('llm:metrics:total:successful') || '0');
    const totalFailed = parseInt(await metricsRedis.get('llm:metrics:total:failed') || '0');
    const totalCostUsd = parseFloat(await metricsRedis.get('llm:metrics:total:costUsd') || '0');
    const totalTurns = parseInt(await metricsRedis.get('llm:metrics:total:turns') || '0');
    const totalExecutionTimeMs = parseInt(await metricsRedis.get('llm:metrics:total:executionTimeMs') || '0');
    const totalRequests = totalSuccessful + totalFailed;
    return {
        totalRequests,
        totalSuccessful,
        totalFailed,
        successRate: totalRequests > 0 ? totalSuccessful / totalRequests : 0,
        totalCostUsd,
        avgCostPerRequest: totalRequests > 0 ? totalCostUsd / totalRequests : 0,
        totalTurns,
        avgTurnsPerRequest: totalRequests > 0 ? totalTurns / totalRequests : 0,
        avgExecutionTimeSec: totalRequests > 0 ? (totalExecutionTimeMs / totalRequests) / 1000 : 0
    };
}

async function getModelMetrics(metricsRedis) {
    const modelsUsed = await metricsRedis.sMembers('llm:metrics:models:used');
    const modelMetrics = {};
    for (const model of modelsUsed) {
        const modelSuccessful = parseInt(await metricsRedis.get(`llm:metrics:model:${model}:successful`) || '0');
        const modelFailed = parseInt(await metricsRedis.get(`llm:metrics:model:${model}:failed`) || '0');
        const modelCostUsd = parseFloat(await metricsRedis.get(`llm:metrics:model:${model}:costUsd`) || '0');
        const modelTurns = parseInt(await metricsRedis.get(`llm:metrics:model:${model}:turns`) || '0');
        const modelExecutionTimeMs = parseInt(await metricsRedis.get(`llm:metrics:model:${model}:executionTimeMs`) || '0');
        const modelTotal = modelSuccessful + modelFailed;
        modelMetrics[model] = {
            totalRequests: modelTotal,
            successful: modelSuccessful,
            failed: modelFailed,
            successRate: modelTotal > 0 ? modelSuccessful / modelTotal : 0,
            totalCostUsd: modelCostUsd,
            avgCostPerRequest: modelTotal > 0 ? modelCostUsd / modelTotal : 0,
            totalTurns: modelTurns,
            avgTurnsPerRequest: modelTotal > 0 ? modelTurns / modelTotal : 0,
            avgExecutionTimeSec: modelTotal > 0 ? (modelExecutionTimeMs / modelTotal) / 1000 : 0
        };
    }
    return modelMetrics;
}

async function getDailyMetrics(metricsRedis) {
    const dailyMetrics = [];
    const today = new Date();
    for (let i = 0; i < 7; i++) {
        const date = new Date(today);
        date.setDate(date.getDate() - i);
        const dateKey = date.toISOString().split('T')[0];
        const daySuccessful = parseInt(await metricsRedis.get(`llm:metrics:daily:${dateKey}:successful`) || '0');
        const dayFailed = parseInt(await metricsRedis.get(`llm:metrics:daily:${dateKey}:failed`) || '0');
        const dayCostUsd = parseFloat(await metricsRedis.get(`llm:metrics:daily:${dateKey}:costUsd`) || '0');
        dailyMetrics.push({ date: dateKey, successful: daySuccessful, failed: dayFailed, total: daySuccessful + dayFailed, costUsd: dayCostUsd });
    }
    return dailyMetrics;
}

async function getHighCostAlerts(metricsRedis) {
    const highCostAlerts = await metricsRedis.lRange('llm:metrics:alerts:highcost', 0, 9);
    return highCostAlerts.map(alert => {
        try { return JSON.parse(alert); } catch { return null; }
    }).filter(Boolean);
}

/**
 * Retrieves LLM metrics summary
 * @returns {Promise<Object>} LLM metrics summary
 */
export async function getLLMMetricsSummary() {
    const metricsRedis = new Redis(connectionOptions);

    try {
        const summary = await getTotalMetrics(metricsRedis);
        const modelBreakdown = await getModelMetrics(metricsRedis);
        const dailyMetrics = await getDailyMetrics(metricsRedis);
        const recentHighCostAlerts = await getHighCostAlerts(metricsRedis);

        return { summary, modelBreakdown, dailyMetrics, recentHighCostAlerts, lastUpdated: new Date().toISOString() };

    } catch (error) {
        logger.error({
            error: error.message,
            stack: error.stack
        }, 'Failed to retrieve LLM metrics summary');
        throw error;
    } finally {
        await metricsRedis.quit();
    }
}

/**
 * Retrieves detailed LLM metrics for a specific correlation ID
 * @param {string} correlationId - Correlation ID
 * @returns {Promise<Object|null>} Detailed LLM metrics or null
 */
export async function getLLMMetricsByCorrelationId(correlationId) {
    const metricsRedis = new Redis(connectionOptions);

    try {
        const metricsKey = `llm:metrics:${correlationId}`;
        const metricsData = await metricsRedis.get(metricsKey);

        if (metricsData) {
            return JSON.parse(metricsData);
        }

        return null;
    } catch (error) {
        logger.error({
            error: error.message,
            correlationId
        }, 'Failed to retrieve LLM metrics by correlation ID');
        return null;
    } finally {
        await metricsRedis.quit();
    }
}