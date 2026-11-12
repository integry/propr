import type { Logger } from 'pino';
import { MAX_AUTOMATION_PREVIOUS_REPORTS } from '@propr/shared';
import {
    classifyAgentReportNovelty,
    truncateAgentReport,
    listLatestStoredReports,
    listPreviousReports,
    type AgentReportNovelty,
    type StoredAgentRun,
} from '@propr/core';

/**
 * The report's normalised hash and novelty against the previous reported run
 * of the definition, as the patch for the `report_ready` transition. The
 * stored (truncated) text is what is hashed, so it compares like with like.
 * Flags are informational: when the previous report cannot be read the run
 * keeps null flags rather than failing.
 *
 * The previous reported run is the one whose report was stored last, whenever
 * it was created and whatever its acting step did afterwards. The prompt
 * history (created earlier, run not failed) is read only for the run ids a
 * report's prompt may have quoted.
 */

/**
 * Reported runs whose ids count as volatile. A report's prompt names its run and
 * up to MAX_AUTOMATION_PREVIOUS_REPORTS earlier ones, so the previous report may
 * quote one run further back than this report can.
 */
const KNOWN_RUN_WINDOW = MAX_AUTOMATION_PREVIOUS_REPORTS + 1;

export interface ReportNoveltyLookups {
    /** Most recently stored reports, newest report first: the previous one is compared with. */
    listLatestReports: typeof listLatestStoredReports;
    /** Prompt history: the reports a run's prompt lists, here only for the run ids they quote. */
    listPreviousReports: typeof listPreviousReports;
}

export const defaultReportNoveltyLookups: ReportNoveltyLookups = {
    listLatestReports: listLatestStoredReports,
    listPreviousReports,
};

export async function reportNoveltyPatch(
    run: Pick<StoredAgentRun, 'id' | 'definitionId' | 'createdAt'>,
    report: string,
    { listLatestReports, listPreviousReports: listPromptHistory }: ReportNoveltyLookups,
    log: Pick<Logger, 'warn'>,
): Promise<AgentReportNovelty | Record<string, never>> {
    try {
        const [latest, promptHistory] = await Promise.all([
            listLatestReports(run.definitionId, { limit: KNOWN_RUN_WINDOW, excludeRunId: run.id }),
            listPromptHistory(run.definitionId, { limit: KNOWN_RUN_WINDOW, beforeCreatedAt: run.createdAt, excludeRunId: run.id }),
        ]);
        return classifyAgentReportNovelty({
            runId: run.id,
            report: truncateAgentReport(report).report,
            previous: latest[0] ?? null,
            knownRunIds: [...new Set([...latest, ...promptHistory].map(earlier => earlier.runId))],
        });
    } catch (error) {
        log.warn({ runId: run.id, err: error }, 'Could not compare the agent report with the previous one');
        return {};
    }
}
