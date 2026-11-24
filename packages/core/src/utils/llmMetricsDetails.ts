/**
 * Stores an execution's conversation details in `llm_execution_details`.
 *
 * SQLite caps a multi-row insert: knex compiles it to a compound SELECT (500
 * terms at most) and the bound variables are capped too, so one insert of every
 * event fails for a long run. The details are therefore inserted in ordered
 * batches, and a row already stored under its (execution_id, sequence_number)
 * is skipped, so a retry after a partial failure stores only what is missing.
 */

import logger from './logger.js';
import { db } from '../db/connection.js';
import type { ConversationDetail } from './llmMetrics.types.js';

/** 100 rows of 14 columns stays far below both SQLite limits. */
const DETAIL_INSERT_BATCH_SIZE = 100;
const DETAIL_PERSIST_ATTEMPTS = 3;

export async function insertConversationDetails(details: ConversationDetail[], batchSize = DETAIL_INSERT_BATCH_SIZE): Promise<void> {
    for (let start = 0; start < details.length; start += batchSize) {
        await db('llm_execution_details').insert(details.slice(start, start + batchSize)).onConflict(['execution_id', 'sequence_number']).ignore();
    }
}

interface DetailContext { correlationId?: string; taskId?: string | null; executionId: number | string; }

async function insertDetailsWithRetry(details: ConversationDetail[], context: DetailContext): Promise<void> {
    for (let attempt = 1; ; attempt++) {
        try {
            await insertConversationDetails(details);
            return;
        } catch (error) {
            if (attempt >= DETAIL_PERSIST_ATTEMPTS) throw error;
            logger.warn({ ...context, attempt, error: (error as Error).message }, 'Retrying conversation detail insert; already stored rows are skipped');
        }
    }
}

/** Stores the details, retrying failed batches; throws when they cannot all be stored. */
export async function persistConversationDetails(details: ConversationDetail[], context: DetailContext): Promise<void> {
    if (details.length === 0) return;
    const [first] = details;
    logger.info({
        correlationId: context.correlationId, taskId: context.taskId,
        sampleDetail: {
            sequence: first.sequence_number, type: first.event_type,
            hasContent: !!first.content, contentPreview: first.content?.substring(0, 100),
            inputTokens: first.token_count_input, outputTokens: first.token_count_output,
            toolName: first.tool_name
        }
    }, 'DEBUG: Sample detail before insert');
    await insertDetailsWithRetry(details, context);
}
