/**
 * Utility functions for planner helpers.
 */

import { Knex } from 'knex';
import { generatePlan, getEventPublisher, parseGenerationTrace } from '@propr/core';
import type { StepStatus, DraftUpdateGenerationTrace } from '@propr/shared';
import type { GenerateRequestBody, BackgroundGenerationOptions } from './types.js';
import { VALID_GRANULARITIES } from './validation.js';

export async function updateDraftContextConfig(
  db: Knex,
  draftId: string,
  draft: Record<string, unknown>,
  body: GenerateRequestBody
): Promise<void> {
  const { baseBranch, granularity, contextLevel, compress, contextRepositories, generationModel, excludedFiles } = body;
  const hasUpdates = baseBranch || granularity || contextLevel !== undefined ||
                     compress !== undefined || contextRepositories !== undefined || generationModel !== undefined || excludedFiles !== undefined;
  if (!hasUpdates) return;

  // Parse context_config if it's a JSON string (stored as text in SQLite)
  let existingConfig: Record<string, unknown> = {};
  if (draft.context_config) {
    try {
      existingConfig = typeof draft.context_config === 'string'
        ? JSON.parse(draft.context_config)
        : (draft.context_config as Record<string, unknown>);
    } catch {
      existingConfig = {};
    }
  }
  const updatedConfig = {
    ...existingConfig,
    ...(baseBranch && { baseBranch }),
    ...(granularity && VALID_GRANULARITIES.includes(granularity as typeof VALID_GRANULARITIES[number]) && { granularity }),
    ...(contextLevel !== undefined && { contextLevel }),
    ...(compress !== undefined && { compress }),
    ...(contextRepositories !== undefined && { contextRepositories }),
    ...(generationModel !== undefined && { generationModel }),
    ...(excludedFiles !== undefined && { excludedFiles })
  };
  await db('task_drafts').where({ draft_id: draftId }).update({
    context_config: JSON.stringify(updatedConfig),
    updated_at: db.fn.now()
  });
}

export function runBackgroundGeneration(options: BackgroundGenerationOptions): void {
  const { db, draftId, worktreePath, authToken, correlationId } = options;
  generatePlan({ draftId, worktreePath, githubToken: authToken, correlationId })
    .then(() => {
      console.log(`[generate] Plan generation completed for draft ${draftId}`);
    })
    .catch(async (error) => {
      console.error(`[generate] Plan generation failed for draft ${draftId}:`, error);
      try {
        // Get current trace to preserve any completed steps
        const draft = await db('task_drafts').where({ draft_id: draftId }).first();
        const existingTrace = parseGenerationTrace(draft?.generation_trace);

        // Mark any non-completed steps as failed and add error info
        const updatedSteps = existingTrace.steps.map((step) =>
          step.status === 'pending' || step.status === 'in_progress' ? { ...step, status: 'failed' as const } : step
        );

        const failedTrace: DraftUpdateGenerationTrace = {
          steps: updatedSteps,
          error: error instanceof Error ? error.message : 'Plan generation failed',
          failedAt: new Date().toISOString()
        };

        await db('task_drafts').where({ draft_id: draftId }).update({
          status: 'failed',
          generation_trace: JSON.stringify(failedTrace),
          updated_at: db.fn.now()
        });

        // Emit failure event so the UI can transition without polling
        const eventPublisher = getEventPublisher();
        const published = await eventPublisher.publishDraftUpdate({
          draftId,
          step: 'complete',
          status: 'failed',
          draftStatus: 'failed',
          generationTrace: failedTrace
        });
        if (!published) {
          console.warn(`[generate] Failed to publish failure event for draft ${draftId} — client will resync via safety-net poll`);
        }
      } catch (dbError) {
        console.error(`[generate] Failed to update draft status after error:`, dbError);
      }
    });
}

/**
 * Score and sort drafts based on search relevance
 */
export function scoreDraftsBySearch<T extends { name?: string; initial_prompt?: string; updated_at?: string }>(
  drafts: T[],
  searchWords: string[],
  exactPhrase: string
): Omit<T, '_searchScore'>[] {
  const scoredDrafts = drafts.map((draft) => {
    const nameLC = (draft.name || '').toLowerCase(), promptLC = (draft.initial_prompt || '').toLowerCase();
    let score = 0;
    if (nameLC.includes(exactPhrase)) score += 100;
    if (promptLC.includes(exactPhrase)) score += 80;
    const allWordsMatchName = searchWords.every(w => nameLC.includes(w.toLowerCase()));
    const allWordsMatchPrompt = searchWords.every(w => promptLC.includes(w.toLowerCase()));
    if (allWordsMatchName && !nameLC.includes(exactPhrase)) score += 50;
    if (allWordsMatchPrompt && !promptLC.includes(exactPhrase)) score += 40;
    const wordsMatchingName = searchWords.filter(w => nameLC.includes(w.toLowerCase())).length;
    const wordsMatchingPrompt = searchWords.filter(w => promptLC.includes(w.toLowerCase())).length;
    score += wordsMatchingName * 10;
    score += wordsMatchingPrompt * 5;
    return { ...draft, _searchScore: score };
  });

  scoredDrafts.sort((a, b) => {
    if (b._searchScore !== a._searchScore) return b._searchScore - a._searchScore;
    return new Date(b.updated_at || 0).getTime() - new Date(a.updated_at || 0).getTime();
  });

  return scoredDrafts.map((d) => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { _searchScore, ...rest } = d;
    return rest as Omit<T, '_searchScore'>;
  });
}

/**
 * Build issue summaries from plan issues
 */
export async function buildIssueSummaries(
  db: Knex,
  draftIds: string[]
): Promise<Record<string, { total: number; pending: number; processing: number; merged: number; closed: number }>> {
  const issues = await db('plan_issues')
    .whereIn('draft_id', draftIds)
    .select('draft_id', 'status');

  const summaryMap: Record<string, { total: number; pending: number; processing: number; merged: number; closed: number }> = {};
  for (const issue of issues as Array<{ draft_id: string; status: string }>) {
    if (!summaryMap[issue.draft_id]) {
      summaryMap[issue.draft_id] = { total: 0, pending: 0, processing: 0, merged: 0, closed: 0 };
    }
    summaryMap[issue.draft_id].total++;
    if (issue.status === 'pending') summaryMap[issue.draft_id].pending++;
    else if (issue.status === 'processing' || issue.status === 'under_review' || issue.status === 'in_refinement' || issue.status === 'refinement_processing') summaryMap[issue.draft_id].processing++;
    else if (issue.status === 'merged') summaryMap[issue.draft_id].merged++;
    else if (issue.status === 'closed') summaryMap[issue.draft_id].closed++;
  }
  return summaryMap;
}

/**
 * Parse JSON fields in a draft object
 */
export function parseDraftJsonFields(draft: Record<string, unknown>): Record<string, unknown> & { task_title?: string } {
  const parsedDraft: Record<string, unknown> & { task_title?: string } = { ...draft };
  if (typeof parsedDraft.plan_json === 'string') {
    try { parsedDraft.plan_json = JSON.parse(parsedDraft.plan_json); } catch { parsedDraft.plan_json = []; }
  }
  if (typeof parsedDraft.chat_history === 'string') {
    try { parsedDraft.chat_history = JSON.parse(parsedDraft.chat_history); } catch { parsedDraft.chat_history = []; }
  }
  if (typeof parsedDraft.context_config === 'string') {
    try { parsedDraft.context_config = JSON.parse(parsedDraft.context_config); } catch { parsedDraft.context_config = {}; }
  }
  if (typeof parsedDraft.attachments === 'string') {
    try { parsedDraft.attachments = JSON.parse(parsedDraft.attachments); } catch { parsedDraft.attachments = []; }
  }
  if (typeof parsedDraft.generation_trace === 'string') {
    try { parsedDraft.generation_trace = JSON.parse(parsedDraft.generation_trace); } catch { parsedDraft.generation_trace = null; }
  }
  if (typeof parsedDraft.refinement_result === 'string') {
    try { parsedDraft.refinement_result = JSON.parse(parsedDraft.refinement_result); } catch { parsedDraft.refinement_result = null; }
  }
  parsedDraft.task_title = draft.name as string | undefined;
  return parsedDraft;
}
