/**
 * Generation trace tracking for the planning service.
 */

import { db } from '../../db/connection.js';
import type { GenerationTrace } from './planningTypes.js';
import type { DraftUpdateGenerationTrace, StepStatus } from '@propr/shared';
import { getEventPublisher } from '../../utils/eventPublisher.js';

type ParsedGenerationTrace = GenerationTrace & Pick<DraftUpdateGenerationTrace, 'error' | 'failedAt'> & { runId?: string };

export function sanitizeDraftUpdateStepData(data: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!data) {
    return undefined;
  }

  const sanitizedEntries = Object.entries(data).filter(([, value]) => (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ));

  if (sanitizedEntries.length === 0) {
    return undefined;
  }

  return Object.fromEntries(sanitizedEntries);
}

export function parseGenerationTrace(raw: unknown): ParsedGenerationTrace {
  let parsed: ParsedGenerationTrace | undefined;
  if (raw) {
    try {
      parsed = typeof raw === 'string' ? JSON.parse(raw) : (raw as ParsedGenerationTrace);
    } catch { /* ignore parse errors */ }
  }

  return {
    steps: Array.isArray(parsed?.steps) ? parsed.steps : [],
    ...(typeof parsed?.runId === 'string' ? { runId: parsed.runId } : {}),
    ...(typeof parsed?.error === 'string' ? { error: parsed.error } : {}),
    ...(typeof parsed?.failedAt === 'string' ? { failedAt: parsed.failedAt } : {})
  };
}

export function buildDraftUpdateTraceSnapshot(trace: ParsedGenerationTrace): DraftUpdateGenerationTrace {
  return {
    steps: trace.steps.map((step) => {
      const { data, ...rest } = step;
      const sanitizedData = sanitizeDraftUpdateStepData(data);
      return {
        ...rest,
        ...(sanitizedData ? { data: sanitizedData } : {})
      };
    }),
    ...(typeof trace.runId === 'string' ? { runId: trace.runId } : {}),
    ...(typeof trace.error === 'string' ? { error: trace.error } : {}),
    ...(typeof trace.failedAt === 'string' ? { failedAt: trace.failedAt } : {})
  };
}

/**
 * Update the generation trace for a draft with step status and data.
 * Returns the updated trace so callers can use it without re-reading from DB.
 */
interface UpdateTraceOptions {
  draftId: string;
  step: string;
  status: StepStatus;
  data?: Record<string, unknown>;
  expectedRunId?: string;
}

async function updateTraceWithOptions(options: UpdateTraceOptions): Promise<GenerationTrace> {
  const { draftId, step, status, data, expectedRunId } = options;
  if (!db) return { steps: [] };

  const draft = await db('task_drafts')
    .where({ draft_id: draftId })
    .select('generation_trace', 'status')
    .first();

  const trace = parseGenerationTrace(draft?.generation_trace);
  if (expectedRunId && (draft?.status !== 'generating' || trace.runId !== expectedRunId)) {
    throw new Error(`Planner generation run ${expectedRunId} is no longer active`);
  }

  const existingStepIndex = trace.steps.findIndex((s) => s.name === step);
  if (existingStepIndex >= 0) {
    trace.steps[existingStepIndex] = { ...trace.steps[existingStepIndex], status, data: { ...trace.steps[existingStepIndex].data, ...data } };
  } else {
    trace.steps.push({ name: step, status, data });
  }

  let updateQuery = db('task_drafts').where({ draft_id: draftId });
  if (expectedRunId) {
    updateQuery = updateQuery.where({ status: 'generating' });
    updateQuery = draft.generation_trace == null
      ? updateQuery.whereNull('generation_trace')
      : updateQuery.where('generation_trace', draft.generation_trace);
  }
  const updatedRows = await updateQuery.update({
      generation_trace: JSON.stringify(trace),
      updated_at: db.fn.now()
  });
  if (expectedRunId && Number(updatedRows) !== 1) {
    throw new Error(`Planner generation run ${expectedRunId} is no longer active`);
  }

  // Publish WebSocket event for real-time updates (fire-and-forget)
  const eventPublisher = getEventPublisher();
  const published = await eventPublisher.publishDraftUpdate({
    draftId,
    ...(expectedRunId ? { runId: expectedRunId } : {}),
    step,
    status,
    data: sanitizeDraftUpdateStepData(data),
    draftStatus: 'generating',
    generationTrace: buildDraftUpdateTraceSnapshot(trace)
  });
  if (!published) {
    console.warn(`[trace] Failed to publish progress event for draft ${draftId}, step ${step} — client will resync via fallback polling`);
  }

  return trace;
}

export function updateTrace(
  draftId: string,
  step: string,
  status: StepStatus,
  data?: Record<string, unknown>,
): Promise<GenerationTrace> {
  return updateTraceWithOptions({ draftId, step, status, data });
}

export function updateTraceForRun(
  draftId: string,
  step: string,
  status: StepStatus,
  options: { expectedRunId: string; data?: Record<string, unknown> },
): Promise<GenerationTrace> {
  const { expectedRunId, data } = options;
  return updateTraceWithOptions({ draftId, step, status, data, expectedRunId });
}
