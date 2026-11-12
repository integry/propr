import type { Logger } from 'pino';
import { MAX_AUTOMATION_PREVIOUS_REPORTS } from '@propr/shared';
import {
    classifyAgentReportNovelty,
    truncateAgentReport,
    type AgentReportNovelty,
    type listPreviousReports,
    type StoredAgentRun,
} from '@propr/core';

/**
 * The report's normalised hash and novelty against the previous reported run
 * of the definition, as the patch for the `report_ready` transition. The
 * stored (truncated) text is what is hashed, so it compares like with like.
 * Flags are informational: when the previous report cannot be read the run
 * keeps null flags rather than failing.
 */

/**
 * Reported runs whose ids count as volatile. A report's prompt names its run and
 * up to MAX_AUTOMATION_PREVIOUS_REPORTS earlier ones, so the previous report may
 * quote one run further back than this report can.
 */
const KNOWN_RUN_WINDOW = MAX_AUTOMATION_PREVIOUS_REPORTS + 1;

export async function reportNoveltyPatch(
    run: Pick<StoredAgentRun, 'id' | 'definitionId' | 'createdAt'>,
    report: string,
    { listPrevious, log }: { listPrevious: typeof listPreviousReports; log: Pick<Logger, 'warn'> },
): Promise<AgentReportNovelty | Record<string, never>> {
    try {
        const recent = await listPrevious(run.definitionId, { limit: KNOWN_RUN_WINDOW, beforeCreatedAt: run.createdAt, excludeRunId: run.id });
        return classifyAgentReportNovelty({
            runId: run.id,
            report: truncateAgentReport(report).report,
            previous: recent[0] ?? null,
            knownRunIds: recent.map(earlier => earlier.runId),
        });
    } catch (error) {
        log.warn({ runId: run.id, err: error }, 'Could not compare the agent report with the previous one');
        return {};
    }
}
