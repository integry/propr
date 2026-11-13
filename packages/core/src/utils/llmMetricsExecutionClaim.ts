/**
 * Keeps `recordLLMMetrics` to one record per agent execution.
 *
 * A job records an agent's result as soon as the run returns, and its failure
 * handler records the same result again when a later step throws. Each result
 * carries an execution id, and recording it has two stages, each claimed
 * separately: the Redis `llm:metrics:*` counters, and the `llm_executions`
 * row. A later record of the id skips a stage that is already claimed, so the
 * execution keeps one row and the counters count it once.
 *
 * A claim is released when its stage verifiably wrote nothing: the counters
 * failed before any was incremented, or the row was never inserted. A later
 * record of the same result can then complete that stage. A stage that wrote
 * part of its work keeps its claim, so nothing is counted or inserted twice.
 */

import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { Knex } from 'knex';
import logger from './logger.js';
import type { ClaudeResult } from './llmMetrics.types.js';

/** How long an execution id stays claimed: as long as its per-correlation metrics are kept. */
const RECORDED_EXECUTION_TTL_SECONDS = 30 * 24 * 3600;
/** Stage keys this process holds, oldest first; a bounded backstop for the Redis claim. */
const claimedInProcess = new Set<string>();
const CLAIMED_IN_PROCESS_LIMIT = 10_000;

/** Deletes a claim only while it still holds this claimant's token. */
const RELEASE_SCRIPT = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

export type RecordingStage = 'counters' | 'row';

export const recordedExecutionKey = (executionId: string): string => `llm:metrics:recorded:${executionId}`;
export const persistedExecutionKey = (executionId: string): string => `llm:metrics:persisted:${executionId}`;
const stageKey = (stage: RecordingStage, executionId: string): string =>
    stage === 'counters' ? recordedExecutionKey(executionId) : persistedExecutionKey(executionId);

/** A held stage claim; `key` is null for a result without an id, which cannot be matched. */
export interface StageClaim { key: string | null; token: string; executionId?: string; }

type ClaimRedis = Pick<InstanceType<typeof Redis>, 'set' | 'eval'>;

/** The metrics key's id: the job's correlation, or for an execution recorded outside a job, its own id. */
export function metricsCorrelationId(claudeResult: ClaudeResult | null, correlationId: string | undefined): string | undefined {
    return correlationId ?? claudeResult?.executionId;
}

/**
 * Claims one recording stage of an execution, in every worker at once (Redis
 * `SET NX`). Null when that stage is already claimed. A result without an id
 * is always recorded.
 */
export async function claimExecutionStage(
    metricsRedis: ClaimRedis, claudeResult: ClaudeResult | null, stage: RecordingStage,
    context: { correlationId?: string; taskId?: string | null } = {},
): Promise<StageClaim | null> {
    const executionId = claudeResult?.executionId;
    const token = randomUUID();
    if (!executionId) return { key: null, token };
    const key = stageKey(stage, executionId);
    // SET NX answers null when another call already claimed the stage.
    const claimed = claimedInProcess.has(key)
        ? null
        : await metricsRedis.set(key, token, 'EX', RECORDED_EXECUTION_TTL_SECONDS, 'NX');
    if (claimed === null) {
        logger.info({ ...context, executionId, stage }, 'LLM metrics stage already recorded for this execution; skipping');
        return null;
    }
    claimedInProcess.add(key);
    if (claimedInProcess.size > CLAIMED_IN_PROCESS_LIMIT) {
        claimedInProcess.delete(claimedInProcess.values().next().value as string);
    }
    return { key, token, executionId };
}

/**
 * Gives up a stage claim whose stage wrote nothing, so a later record of the
 * execution can complete it. Never throws: a release that cannot reach Redis
 * leaves the stage claimed, which loses the stage but never doubles it.
 */
export async function releaseExecutionStage(
    metricsRedis: ClaimRedis, claim: StageClaim, context: { correlationId?: string; taskId?: string | null } = {},
): Promise<void> {
    if (!claim.key) return;
    claimedInProcess.delete(claim.key);
    try {
        await metricsRedis.eval(RELEASE_SCRIPT, 1, claim.key, claim.token);
        logger.info({ ...context, executionId: claim.executionId, key: claim.key }, 'Released LLM metrics claim after a failed write');
    } catch (error) {
        logger.error({ ...context, executionId: claim.executionId, key: claim.key, error: (error as Error).message },
            'Failed to release LLM metrics claim; this execution stage stays claimed');
    }
}

/**
 * Whether an `llm_executions` insert failed because a row with the same
 * execution id already exists: the database's own record that this execution
 * was persisted, which holds after every Redis and in-process claim is gone.
 */
export function isDuplicateExecutionRow(error: unknown): boolean {
    const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown };
    const unique = code === 'SQLITE_CONSTRAINT_UNIQUE' || code === '23505' || (typeof message === 'string' && /unique/i.test(message));
    return unique && typeof message === 'string' && message.includes('execution_uuid');
}

/** The execution's row already exists: an earlier record of the same result wrote it. */
export const ALREADY_PERSISTED = 'already_persisted' as const;

/**
 * Inserts the execution's `llm_executions` row under its execution id and
 * returns the row id; `already_persisted` when the id already has a row, so the
 * caller keeps its claim and writes nothing more.
 */
export async function insertExecutionRow(
    database: Knex, row: Record<string, unknown>, executionId: string | undefined, context: { correlationId?: string; taskId?: string | null },
): Promise<string | typeof ALREADY_PERSISTED> {
    try {
        // Unique: the database keeps one row per execution once every claim has expired.
        const [inserted] = await database('llm_executions').insert({ ...row, execution_uuid: executionId ?? null }).returning('execution_id');
        return (inserted as { execution_id: string }).execution_id;
    } catch (error) {
        if (!isDuplicateExecutionRow(error)) throw error;
        logger.info({ ...context, executionId }, 'LLM execution row already persisted for this execution; skipping');
        return ALREADY_PERSISTED;
    }
}
