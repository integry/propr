export const PLAN_NOTIFICATION_INTENTS = ['refine', 'approve_execute'] as const;

export type PlanNotificationIntent = (typeof PLAN_NOTIFICATION_INTENTS)[number];

/**
 * Parses a single, recognized notification intent. Duplicate values are
 * rejected so an ambiguous URL can never select a consequential action.
 */
export function parsePlanNotificationIntent(search: string): PlanNotificationIntent | null {
  const params = new URLSearchParams(search);
  const values = params.getAll('intent');
  if (values.length !== 1) return null;
  return PLAN_NOTIFICATION_INTENTS.includes(values[0] as PlanNotificationIntent)
    ? values[0] as PlanNotificationIntent
    : null;
}

/** Removes only the consumed intent while retaining routing/hosted-flow data. */
export function removeNotificationIntent(search: string): string {
  const params = new URLSearchParams(search);
  params.delete('intent');
  const next = params.toString();
  return next ? `?${next}` : '';
}

export function describePlanPrBehavior(useEpic?: boolean, autoMerge?: boolean): string {
  if (useEpic && autoMerge) return 'Epic PR with automatic merging of issue PRs';
  if (useEpic) return 'Epic PR with manual merging of issue PRs';
  if (autoMerge) return 'Individual PRs with auto-merge enabled';
  return 'Individual PRs; merges remain manual';
}
