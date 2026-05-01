/**
 * Generation trace tracking for the planning service.
 */

import { db } from '../../db/connection.js';
import type { GenerationTrace } from './planningTypes.js';
import { getEventPublisher } from '../../utils/eventPublisher.js';

/**
 * Update the generation trace for a draft with step status and data.
 * Returns the updated trace so callers can use it without re-reading from DB.
 */
export async function updateTrace(
  draftId: string,
  step: string,
  status: 'pending' | 'in_progress' | 'completed' | 'failed',
  data?: Record<string, unknown>
): Promise<GenerationTrace> {
  if (!db) return { steps: [] };

  const draft = await db('task_drafts')
    .where({ draft_id: draftId })
    .select('generation_trace')
    .first();

  const rawTrace = draft?.generation_trace as GenerationTrace | undefined;
  const trace: GenerationTrace = { steps: Array.isArray(rawTrace?.steps) ? rawTrace.steps : [] };

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

  // Publish WebSocket event for real-time updates (fire-and-forget pattern)
  // Use try-catch to prevent event publishing failures from breaking core functionality
  try {
    const eventPublisher = getEventPublisher();
    await eventPublisher.publishDraftUpdate({
      draftId,
      step,
      status,
      data,
      draftStatus: 'generating',
      generationTrace: trace
    });
  } catch (error) {
    // Log but don't throw - database is already updated, so clients can still
    // receive updates via fallback polling if WebSocket publishing fails
    console.warn('[traceService] Failed to publish draft update event:', (error as Error).message);
  }

  return trace;
}
