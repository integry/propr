/**
 * What happens to an agent run once its report is stored, by autonomy mode.
 *
 * - dry_run: the report is the whole result, so the run completes.
 * - preview / auto: the acting step (issue 10) is not wired yet; the run stays
 *   in `report_ready` with its report so nothing is lost when it lands.
 */

import { logger, transitionAgentRun, type StoredAgentRun } from '@propr/core';

export interface AdvanceAfterReportDeps {
    transitionRun?: typeof transitionAgentRun;
}

/**
 * Move a `report_ready` run to its next state. Returns the updated run, or
 * null when the run was no longer `report_ready` (another process got there first).
 */
export async function advanceAfterReport(
    run: StoredAgentRun,
    { transitionRun = transitionAgentRun }: AdvanceAfterReportDeps = {},
): Promise<StoredAgentRun | null> {
    if (run.autonomyMode === 'dry_run') {
        return transitionRun(run.id, ['report_ready'], 'completed');
    }
    logger.info({ runId: run.id, autonomyMode: run.autonomyMode }, 'Agent run acting step is not available yet; leaving the run in report_ready');
    return run;
}
