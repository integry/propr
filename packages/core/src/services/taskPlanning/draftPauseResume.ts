/**
 * Draft pause/resume management.
 * Allows pausing plan execution so the next task doesn't start until resumed.
 */

import { db } from '../../db/connection.js';
import logger from '../../utils/logger.js';

export interface PauseResumeResult {
  success: boolean;
  paused: boolean;
  pausedAt: string | null;
  error?: string;
}

/**
 * Pauses a draft's execution. When paused, the next pending issue
 * will not be automatically triggered after the current one completes.
 *
 * @param draftId - The ID of the draft to pause
 * @returns Result indicating success and current pause state
 */
export async function pauseDraft(draftId: string): Promise<PauseResumeResult> {
  if (!db) {
    logger.warn({ draftId }, 'Database not available, cannot pause draft');
    return { success: false, paused: false, pausedAt: null, error: 'Database not available' };
  }

  try {
    const draft = await db('task_drafts')
      .where({ draft_id: draftId })
      .select('status', 'paused')
      .first();

    if (!draft) {
      return { success: false, paused: false, pausedAt: null, error: 'Draft not found' };
    }

    // Only allow pausing drafts that are in an executable state
    const executableStatuses = ['executed', 'pr_created'];
    if (!executableStatuses.includes(draft.status)) {
      return {
        success: false,
        paused: draft.paused || false,
        pausedAt: null,
        error: `Cannot pause draft with status '${draft.status}'. Only executed or pr_created drafts can be paused.`
      };
    }

    if (draft.paused) {
      // Already paused
      const existingDraft = await db('task_drafts')
        .where({ draft_id: draftId })
        .select('paused_at')
        .first();
      return { success: true, paused: true, pausedAt: existingDraft?.paused_at || null };
    }

    const pausedAt = new Date().toISOString();
    await db('task_drafts')
      .where({ draft_id: draftId })
      .update({
        paused: true,
        paused_at: pausedAt,
        updated_at: db.fn.now()
      });

    logger.info({ draftId, pausedAt }, 'Draft execution paused');
    return { success: true, paused: true, pausedAt };
  } catch (error) {
    const err = error as Error;
    logger.error({ draftId, error: err.message }, 'Failed to pause draft');
    return { success: false, paused: false, pausedAt: null, error: err.message };
  }
}

/**
 * Resumes a paused draft's execution. After resuming, the next pending
 * issue can be triggered.
 *
 * @param draftId - The ID of the draft to resume
 * @returns Result indicating success and current pause state
 */
export async function resumeDraft(draftId: string): Promise<PauseResumeResult> {
  if (!db) {
    logger.warn({ draftId }, 'Database not available, cannot resume draft');
    return { success: false, paused: true, pausedAt: null, error: 'Database not available' };
  }

  try {
    const draft = await db('task_drafts')
      .where({ draft_id: draftId })
      .select('paused', 'paused_at')
      .first();

    if (!draft) {
      return { success: false, paused: false, pausedAt: null, error: 'Draft not found' };
    }

    if (!draft.paused) {
      // Already not paused
      return { success: true, paused: false, pausedAt: null };
    }

    await db('task_drafts')
      .where({ draft_id: draftId })
      .update({
        paused: false,
        paused_at: null,
        updated_at: db.fn.now()
      });

    logger.info({ draftId, previousPausedAt: draft.paused_at }, 'Draft execution resumed');
    return { success: true, paused: false, pausedAt: null };
  } catch (error) {
    const err = error as Error;
    logger.error({ draftId, error: err.message }, 'Failed to resume draft');
    return { success: false, paused: true, pausedAt: null, error: err.message };
  }
}

/**
 * Checks if a draft is currently paused.
 *
 * @param draftId - The ID of the draft to check
 * @returns True if the draft is paused, false otherwise
 */
export async function isDraftPaused(draftId: string): Promise<boolean> {
  if (!db) {
    logger.warn({ draftId }, 'Database not available, cannot check draft pause state');
    return false;
  }

  try {
    const draft = await db('task_drafts')
      .where({ draft_id: draftId })
      .select('paused')
      .first();

    return draft?.paused || false;
  } catch (error) {
    const err = error as Error;
    logger.error({ draftId, error: err.message }, 'Failed to check draft pause state');
    return false;
  }
}

/**
 * Gets the pause state of a draft including the paused_at timestamp.
 *
 * @param draftId - The ID of the draft to check
 * @returns Object with paused state and timestamp
 */
export async function getDraftPauseState(draftId: string): Promise<{ paused: boolean; pausedAt: string | null }> {
  if (!db) {
    return { paused: false, pausedAt: null };
  }

  try {
    const draft = await db('task_drafts')
      .where({ draft_id: draftId })
      .select('paused', 'paused_at')
      .first();

    return {
      paused: draft?.paused || false,
      pausedAt: draft?.paused_at || null
    };
  } catch (error) {
    const err = error as Error;
    logger.error({ draftId, error: err.message }, 'Failed to get draft pause state');
    return { paused: false, pausedAt: null };
  }
}
