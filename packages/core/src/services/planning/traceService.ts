/**
 * Generation trace tracking for the planning service.
 */

import { db } from '../../db/connection.js';
import type { GenerationTrace } from './planningTypes.js';
import type { DraftUpdateGenerationTrace, StepStatus } from '@propr/shared';
import { getEventPublisher } from '../../utils/eventPublisher.js';

type ParsedGenerationTrace = GenerationTrace & Pick<DraftUpdateGenerationTrace, 'error' | 'failedAt'>;

function sanitizeDraftUpdateStepData(data: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
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
  const published = await eventPublisher.publishDraftUpdate({
    draftId,
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
