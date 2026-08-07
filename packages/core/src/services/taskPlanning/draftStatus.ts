/**
 * Draft status management.
 */

import { db } from '../../db/connection.js';
import logger from '../../utils/logger.js';
import { completeTodosForDraft } from '../repoTodosService.js';

/**
 * Checks plan issue statuses and updates the draft status accordingly.
 * - If all issues are merged, sets draft status to 'merged'
 * - If any issue has an active PR (under_review, in_refinement, refinement_processing), sets to 'pr_created'
 * - Otherwise reverts to 'executed' (Issues Created)
 *
 * @param draftId - The ID of the draft to check and update
 */
export async function checkAndUpdateDraftStatus(draftId: string): Promise<void> {
  if (!db) {
    logger.warn({ draftId }, 'Database not available, cannot check draft status');
    return;
  }

  try {
    // Get all plan issues for this draft
    const planIssues = await db('plan_issues')
      .where({ draft_id: draftId })
      .select('status');

    if (planIssues.length === 0) {
      logger.debug({ draftId }, 'No plan issues found for draft, skipping status check');
      return;
    }

    // Check if all issues are merged
    const allMerged = planIssues.every(issue => issue.status === 'merged');

    // Check if any issue has an active PR (under_review, in_refinement, or refinement_processing)
    const activePrStatuses = ['under_review', 'in_refinement', 'refinement_processing'];
    const hasActivePr = planIssues.some(issue => activePrStatuses.includes(issue.status));

    // Get current draft status
    const draft = await db('task_drafts')
      .where({ draft_id: draftId })
      .select('status')
      .first();

    if (!draft) {
      logger.warn({ draftId }, 'Draft not found, cannot update status');
      return;
    }

    // Determine the new status based on issue statuses
    let newStatus: string | null = null;

    if (allMerged && draft.status !== 'merged') {
      // All issues merged - set to merged
      newStatus = 'merged';
    } else if (!allMerged && hasActivePr && draft.status !== 'pr_created') {
      // Has active PRs but not all merged - set to pr_created
      newStatus = 'pr_created';
    } else if (!allMerged && !hasActivePr && (draft.status === 'merged' || draft.status === 'pr_created')) {
      // No active PRs and not all merged - revert to executed (Issues Created)
      newStatus = 'executed';
    }

    if (newStatus) {
      await db('task_drafts')
        .where({ draft_id: draftId })
        .update({
          status: newStatus,
          updated_at: db.fn.now()
        });

      logger.info(
        { draftId, oldStatus: draft.status, newStatus, totalIssues: planIssues.length, allMerged, hasActivePr },
        'Updated draft status based on plan issue statuses'
      );

      // When a draft is merged, automatically complete all linked to-dos
      if (newStatus === 'merged') {
        try {
          const completedCount = await completeTodosForDraft(draftId);
          if (completedCount > 0) {
            logger.info(
              { draftId, completedCount },
              'Automatically completed linked to-dos for merged draft'
            );
          }
        } catch (todoError) {
          // Log but don't fail the status update if todo completion fails
          logger.error(
            { draftId, error: (todoError as Error).message },
            'Failed to complete linked to-dos for merged draft'
          );
        }
      }
    }
  } catch (error) {
    const err = error as Error;
    logger.error({ draftId, error: err.message }, 'Failed to check and update draft status');
  }
}
