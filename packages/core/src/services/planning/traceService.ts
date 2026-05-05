/**
 * Generation trace tracking for the planning service.
 */

import { db } from '../../db/connection.js';
import type { GenerationTrace } from './planningTypes.js';
import type { DraftUpdateGenerationTrace, StepStatus } from '@propr/shared';
import { getEventPublisher } from '../../utils/eventPublisher.js';

type ParsedGenerationTrace = GenerationTrace & Pick<DraftUpdateGenerationTrace, 'error' | 'failedAt'>;

export function parseGenerationTrace(raw: unknown): ParsedGenerationTrace {
  let parsed: ParsedGenerationTrace | undefined;
  if (raw) {
    try {
      parsed = typeof raw === 'string' ? JSON.parse(raw) : (raw as ParsedGenerationTrace);
    } catch { /* ignore parse errors */ }
  }

  return {
    steps: Array.isArray(parsed?.steps) ? parsed.steps : [],
    ...(typeof parsed?.error === 'string' ? { error: parsed.error } : {}),
    ...(typeof parsed?.failedAt === 'string' ? { failedAt: parsed.failedAt } : {})
  };
}

function buildDraftUpdateTraceSnapshot(trace: ParsedGenerationTrace): DraftUpdateGenerationTrace {
  return {
    steps: trace.steps.map((step) => {
      if (!step.data || !Array.isArray(step.data.includedFiles)) {
        return step;
      }

      const restData = { ...step.data };
      delete restData.includedFiles;
      return {
        ...step,
        ...(Object.keys(restData).length > 0 ? { data: restData } : {})
      };
    }),
    ...(typeof trace.error === 'string' ? { error: trace.error } : {}),
    ...(typeof trace.failedAt === 'string' ? { failedAt: trace.failedAt } : {})
  };
}

/**
 * Update the generation trace for a draft with step status and data.
 * Returns the updated trace so callers can use it without re-reading from DB.
 */
export async function updateTrace(
  draftId: string,
  step: string,
  status: StepStatus,
  data?: Record<string, unknown>
): Promise<GenerationTrace> {
  if (!db) return { steps: [] };

  const draft = await db('task_drafts')
    .where({ draft_id: draftId })
    .select('generation_trace')
    .first();

  const trace = parseGenerationTrace(draft?.generation_trace);

  const existingStepIndex = trace.steps.findIndex((s) => s.name === step);
  if (existingStepIndex >= 0) {
    trace.steps[existingStepIndex] = { ...trace.steps[existingStepIndex], status, data: { ...trace.steps[existingStepIndex].data, ...data } };
  } else {
    trace.steps.push({ name: step, status, data });
  }

  await db('task_drafts')
    .where({ draft_id: draftId })
    .update({
      generation_trace: JSON.stringify(trace),
      updated_at: db.fn.now()
    });

  // Publish WebSocket event for real-time updates (fire-and-forget)
  const eventPublisher = getEventPublisher();
  await eventPublisher.publishDraftUpdate({
    draftId,
    step,
    status,
    data,
    draftStatus: 'generating',
    generationTrace: buildDraftUpdateTraceSnapshot(trace)
  });

  return trace;
}
