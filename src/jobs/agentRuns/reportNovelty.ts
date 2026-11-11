import type { Logger } from 'pino';
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
export async function reportNoveltyPatch(
    run: Pick<StoredAgentRun, 'id' | 'definitionId' | 'createdAt'>,
    report: string,
    { listPrevious, log }: { listPrevious: typeof listPreviousReports; log: Pick<Logger, 'warn'> },
): Promise<AgentReportNovelty | Record<string, never>> {
    try {
        const [previous] = await listPrevious(run.definitionId, { limit: 1, beforeCreatedAt: run.createdAt, excludeRunId: run.id });
        return classifyAgentReportNovelty({ runId: run.id, report: truncateAgentReport(report).report, previous: previous ?? null });
    } catch (error) {
        log.warn({ runId: run.id, err: error }, 'Could not compare the agent report with the previous one');
        return {};
    }
}
