import { getConfigStrict } from '@propr/core';

/**
 * The production `isSummaryEnabled` dependency. A missing setting is the
 * default-off opt-in; a failed read or parse rejects, so the narrative status
 * route answers a retryable 503 instead of a confirmed `enabled: false`.
 */
export async function isDashboardSummaryEnabled(): Promise<boolean> {
  return (await getConfigStrict('dashboard_summary_enabled', false)) === true;
}
