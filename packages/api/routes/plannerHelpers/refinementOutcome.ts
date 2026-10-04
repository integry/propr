import { normalizeRefinedPlan, RefinementOutputError } from '@propr/core';
import type { Plan } from '@propr/core';

/** The fields of a refinement result that decide what is saved. */
export interface RefinementResultLike {
  action: string;
  summary: string;
  plan?: unknown;
  merged?: boolean;
  operations?: number;
}

/** The plan to persist, whether edits were merged into it, and the summary to show. */
export interface RefinementOutcome {
  plan: Plan;
  merged: boolean;
  summary: string;
}

/**
 * Decide what a refinement result saves. Answers and clarifications keep the
 * current plan. Core `refinePlan` normalises a modified plan itself and reports
 * `merged`, so its output is taken as is; a result without that report came
 * from an injected refinement and is normalised here, so edit-style output is
 * merged or rejected before it can replace the stored plan.
 */
export function resolveRefinementOutcome(currentPlan: Plan, result: RefinementResultLike): RefinementOutcome {
  if (result.action !== 'modified') return { plan: currentPlan, merged: false, summary: result.summary };
  if (typeof result.merged === 'boolean') return { plan: result.plan as Plan, merged: result.merged, summary: result.summary };
  const normalized = normalizeRefinedPlan(currentPlan, result.plan);
  if (!normalized.ok) throw new RefinementOutputError(normalized.message, normalized.details);
  const summary = normalized.merged && !result.summary.includes('Applied ')
    ? `Applied ${normalized.operations} edits to the existing plan. ${result.summary}`
    : result.summary;
  return { plan: normalized.plan, merged: normalized.merged, summary };
}
