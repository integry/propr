/**
 * Keeps `recordLLMMetrics` to one record per agent execution.
 *
 * A job records an agent's result as soon as the run returns, and its failure
 * handler records the same result again when a later step throws. Each result
 * carries an execution id; the first record claims it, and any later record
 * of that id is skipped, so the execution keeps one `llm_executions` row and
 * the Redis `llm:metrics:*` counters count it once.
 */

import type { Redis } from 'ioredis';
import logger from './logger.js';
import type { ClaudeResult } from './llmMetrics.types.js';

/** How long an execution id stays claimed: as long as its per-correlation metrics are kept. */
const RECORDED_EXECUTION_TTL_SECONDS = 30 * 24 * 3600;
/** Ids this process recorded, oldest first; a bounded backstop for the Redis claim. */
const recordedInProcess = new Set<string>();
const RECORDED_IN_PROCESS_LIMIT = 10_000;

export const recordedExecutionKey = (executionId: string): string => `llm:metrics:recorded:${executionId}`;

/** The metrics key's id: the job's correlation, or for an execution recorded outside a job, its own id. */
export function metricsCorrelationId(claudeResult: ClaudeResult | null, correlationId: string | undefined): string | undefined {
    return correlationId ?? claudeResult?.executionId;
}

/**
 * Claims an execution id for recording, in every worker at once (Redis
 * `SET NX`). False when the id was already recorded. A result without an id
 * cannot be matched and is always recorded.
 */
export async function claimExecution(
    metricsRedis: Pick<InstanceType<typeof Redis>, 'set'>, claudeResult: ClaudeResult | null,
    context: { correlationId?: string; taskId?: string | null } = {},
): Promise<boolean> {
    const executionId = claudeResult?.executionId;
    if (!executionId) return true;
    // SET NX answers null when another call already claimed the id.
    const claimed = recordedInProcess.has(executionId)
        ? null
        : await metricsRedis.set(recordedExecutionKey(executionId), '1', 'EX', RECORDED_EXECUTION_TTL_SECONDS, 'NX');
    if (claimed === null) {
        logger.info({ ...context, executionId }, 'LLM metrics already recorded for this execution; skipping');
        return false;
    }
    recordedInProcess.add(executionId);
    if (recordedInProcess.size > RECORDED_IN_PROCESS_LIMIT) {
        recordedInProcess.delete(recordedInProcess.values().next().value as string);
    }
    return true;
}
