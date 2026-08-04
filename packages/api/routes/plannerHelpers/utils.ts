/**
 * Utility functions for planner helpers.
 */

import { Knex } from 'knex';
import { generatePlan, getEventPublisher, parseGenerationTrace, buildDraftUpdateTraceSnapshot, runWithPlannerAbortContext } from '@propr/core';
import type { DraftUpdateGenerationTrace } from '@propr/shared';
import type { GenerateRequestBody, BackgroundGenerationOptions } from './types.js';
import { VALID_GRANULARITIES } from './validation.js';

export interface BackgroundGenerationDependencies {
  generate?: typeof generatePlan;
  getPublisher?: typeof getEventPublisher;
}

const FAILURE_PERSIST_ATTEMPTS = 3;
const RESTRICTED_PLANNER_FAILURE = 'Plan generation failed. Detailed diagnostics are available in server logs.';
const SAFE_PLANNER_FAILURE_CLASSES: Array<{ pattern: RegExp; summary: string }> = [
  { pattern: /\b(timeout|timed out|deadline)\b/i, summary: 'Plan generation timed out.' },
  { pattern: /\b(rate limit|quota|too many requests)\b/i, summary: 'The plan generation service is rate limited. Please try again later.' },
  { pattern: /\b(auth(?:entication|orization)?|unauthorized|forbidden|credential)\b/i, summary: 'Plan generation could not authenticate with a required service.' },
  { pattern: /\b(cancelled|canceled|aborted)\b/i, summary: 'Plan generation was cancelled.' },
];

export function getSafePlannerFailureMessage(error: unknown): string {
  const detail = error instanceof Error ? error.message.trim() : '';
  if (!detail) return RESTRICTED_PLANNER_FAILURE;
  return SAFE_PLANNER_FAILURE_CLASSES.find(({ pattern }) => pattern.test(detail))?.summary
    ?? RESTRICTED_PLANNER_FAILURE;
}

/** Select the request override, then the model persisted on the draft, then the global default. */
export function selectRefinementModel(
  requestedModel: string | undefined,
  contextConfig: unknown,
  configuredModel: string | undefined,
): string | undefined {
  let draftModel: string | undefined;
  if (contextConfig) {
    try {
      const config = typeof contextConfig === 'string' ? JSON.parse(contextConfig) : contextConfig;
      const model = (config as { generationModel?: unknown })?.generationModel;
      draftModel = typeof model === 'string' && model.trim() ? model : undefined;
    } catch { /* fall through to the configured model */ }
  }
  return requestedModel || draftModel || configuredModel;
}

function buildFailureTraceSnapshot(trace: DraftUpdateGenerationTrace): DraftUpdateGenerationTrace {
  return buildDraftUpdateTraceSnapshot(trace);
}

async function persistGenerationFailure(
  db: Knex,
  draftId: string,
  runId: string,
  error: unknown,
): Promise<DraftUpdateGenerationTrace | null> {
  for (let attempt = 1; attempt <= FAILURE_PERSIST_ATTEMPTS; attempt += 1) {
    const draft = await db('task_drafts').where({ draft_id: draftId }).first();
    const existingTrace = parseGenerationTrace(draft?.generation_trace);
    if (draft?.status !== 'generating' || existingTrace.runId !== runId) {
      console.log(`[generate] Generation run ${runId} is no longer active for draft ${draftId}, not saving failure`);
      return null;
    }

    const failedTrace: DraftUpdateGenerationTrace = {
      steps: existingTrace.steps.map((step) =>
        step.status === 'pending' || step.status === 'in_progress' ? { ...step, status: 'failed' as const } : step
      ),
      runId,
      error: getSafePlannerFailureMessage(error),
      failedAt: new Date().toISOString(),
    };
    let failureQuery = db('task_drafts').where({ draft_id: draftId, status: 'generating' });
    failureQuery = draft.generation_trace == null
      ? failureQuery.whereNull('generation_trace')
      : failureQuery.where('generation_trace', draft.generation_trace);
    const failedRows = await failureQuery.update({
      status: 'failed',
      generation_trace: JSON.stringify(failedTrace),
      updated_at: db.fn.now(),
    });
    if (Number(failedRows) === 1) return failedTrace;

    console.log(`[generate] Generation run ${runId} trace changed during failure persistence for draft ${draftId}; reconciling (attempt ${attempt})`);
  }

  console.error(`[generate] Could not persist failure for active generation run ${runId} after ${FAILURE_PERSIST_ATTEMPTS} attempts`);
  return null;
}

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

export async function runBackgroundGeneration(
  options: BackgroundGenerationOptions,
  dependencies: BackgroundGenerationDependencies = {},
): Promise<void> {
  const { db, draftId, worktreePath, authToken, correlationId, runId } = options;
  const executeGeneration = dependencies.generate ?? generatePlan;
  try {
    await runWithPlannerAbortContext(draftId, runId, () => (
      executeGeneration({ draftId, worktreePath, githubToken: authToken, correlationId, runId })
    ));
    console.log(`[generate] Plan generation completed for draft ${draftId}`);
  } catch (error) {
    console.error(`[generate] Plan generation failed for draft ${draftId}:`, error);
    try {
      // Re-read and retry a CAS miss when a same-run trace update won the race.
      // Abort or replacement runs still win because their status/run ID differs.
      const failedTrace = await persistGenerationFailure(db, draftId, runId, error);
      if (!failedTrace) return;

      // Emit failure event so the UI can transition without polling
      const eventPublisher = (dependencies.getPublisher ?? getEventPublisher)();
      const failureSnapshot = buildFailureTraceSnapshot(failedTrace);
      const published = await eventPublisher.publishDraftUpdate({
        draftId,
        runId,
        step: 'complete',
        status: 'failed',
        draftStatus: 'failed',
        generationTrace: failureSnapshot
      });
      if (!published) {
        console.warn(`[generate] Failed to publish failure event for draft ${draftId} — client will resync via safety-net poll`);
      }
    } catch (dbError) {
      console.error(`[generate] Failed to update draft status after error:`, dbError);
    }
  }
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
