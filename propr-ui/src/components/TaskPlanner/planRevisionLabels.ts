import type { PlanRevisionCause, PlanRevisionSummary } from '../../api/proprApi';

const CAUSE_LABELS: Record<PlanRevisionCause, string> = {
  generation: 'Generated',
  refinement: 'Refined',
  manual_edit: 'Manual edit',
  restore: 'Restored',
  rename: 'Renamed',
  unknown: 'Legacy',
};

/** Labels how the saved version itself came to be. */
export const describeRevisionCause = (cause: PlanRevisionCause): string => CAUSE_LABELS[cause];

/** Names a history snapshot by the operation that replaced it. */
export const describeRevision = (revision: Pick<PlanRevisionSummary, 'status_before' | 'status_after'>): string => {
  const { status_before: before, status_after: after } = revision;
  if (before === 'refining') return 'Before refinement';
  if (before === 'generating') return 'Before generation';
  if (after === 'draft') return 'Before returning to setup';
  if (after === 'executing' || after === 'executed') return 'Before publishing';
  if (before === after) return 'Before edits';
  return `Before ${after ?? 'change'}`;
};
