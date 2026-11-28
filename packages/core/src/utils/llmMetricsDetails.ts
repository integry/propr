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

interface DetailContext { correlationId?: string; taskId?: string | null; executionId?: number | string; }

async function insertBatchWithRetry(batch: ConversationDetail[], context: DetailContext): Promise<void> {
    for (let attempt = 1; ; attempt++) {
        try {
            await db('llm_execution_details').insert(batch).onConflict(['execution_id', 'sequence_number']).ignore();
            return;
        } catch (error) {
            if (attempt >= DETAIL_PERSIST_ATTEMPTS) throw error;
            logger.warn({ ...context, attempt, firstSequence: batch[0].sequence_number, error: (error as Error).message }, 'Retrying conversation detail batch insert');
        }
    }
}

/** Inserts the details in order, batch by batch; each batch gets its own retry budget. */
export async function insertConversationDetails(details: ConversationDetail[], context: DetailContext = {}): Promise<void> {
    for (let start = 0; start < details.length; start += DETAIL_INSERT_BATCH_SIZE) {
        await insertBatchWithRetry(details.slice(start, start + DETAIL_INSERT_BATCH_SIZE), context);
    }
}

/** Stores the details; throws when a batch still fails after its retries. */
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
    await insertConversationDetails(details, context);
}
