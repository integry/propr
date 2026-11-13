import type { Logger } from 'pino';
import { MAX_AUTOMATION_PREVIOUS_REPORTS } from '@propr/shared';
import {
    classifyAgentReportNovelty,
    truncateAgentReport,
    listLatestStoredReports,
    listPreviousReports,
    storeAgentRunReport,
    storeUnclassifiedAgentRunReport,
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
 * report's prompt may have quoted: this run's, and the previous reported run's,
 * which may reach further back when that run reported late.
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

type NoveltyRun = Pick<StoredAgentRun, 'id' | 'definitionId' | 'createdAt'>;

/** A report's flags and the previous reported run they were classified against. */
interface ReportClassification {
    /** Null when the previous report could not be read. */
    novelty: AgentReportNovelty | null;
    /** The previous reported run compared with; null when there was none. */
    previousRunId: string | null;
}

async function classifyReport(
    run: NoveltyRun,
    report: string,
    { listLatestReports, listPreviousReports: listPromptHistory }: ReportNoveltyLookups,
    log: Pick<Logger, 'warn'>,
): Promise<ReportClassification> {
    try {
        const [latest, promptHistory] = await Promise.all([
            listLatestReports(run.definitionId, { limit: KNOWN_RUN_WINDOW, excludeRunId: run.id }),
            listPromptHistory(run.definitionId, { limit: KNOWN_RUN_WINDOW, beforeCreatedAt: run.createdAt, excludeRunId: run.id }),
        ]);
        const previous = latest[0] ?? null;
        // The previous report may quote runs from its own prompt history, which neither window
        // above reaches when it was stored late (after more than KNOWN_RUN_WINDOW newer reports).
        const previousHistory = previous
            ? await listPromptHistory(run.definitionId, { limit: KNOWN_RUN_WINDOW, beforeCreatedAt: previous.createdAt, excludeRunId: previous.runId })
            : [];
        const novelty = classifyAgentReportNovelty({
            runId: run.id,
            report: truncateAgentReport(report).report,
            previous,
            knownRunIds: [...new Set([...latest, ...promptHistory, ...previousHistory].map(earlier => earlier.runId))],
        });
        return { novelty, previousRunId: previous?.runId ?? null };
    } catch (error) {
        log.warn({ runId: run.id, err: error }, 'Could not compare the agent report with the previous one');
        return { novelty: null, previousRunId: null };
    }
}

export async function reportNoveltyPatch(
    run: NoveltyRun,
    report: string,
    lookups: ReportNoveltyLookups,
    log: Pick<Logger, 'warn'>,
): Promise<AgentReportNovelty | Record<string, never>> {
    return (await classifyReport(run, report, lookups, log)).novelty ?? {};
}

export interface ReportNoveltyStore extends ReportNoveltyLookups {
    /** Stores the report with its flags while the report they were classified against is still the latest. */
    storeReport: typeof storeAgentRunReport;
    /** Stores the report without flags, when none could be classified; still in storing order. */
    storeUnclassifiedReport: typeof storeUnclassifiedAgentRunReport;
}

/** Comparisons made before the flags are given up, when other runs keep storing reports in between. */
const STORE_REPORT_ATTEMPTS = 3;

/**
 * Stores the report (running → report_ready) with its flags. They are
 * committed only while the report they were classified against is still the
 * definition's latest, so two runs storing the same report at once cannot both
 * count it as new; a report another run stored in between is compared with
 * again. Returns the reported run, or null when the run left `running` first.
 */
export async function storeReportWithNovelty(
    run: NoveltyRun,
    report: string,
    deps: ReportNoveltyStore,
    log: Pick<Logger, 'warn'>,
): Promise<StoredAgentRun | null> {
    for (let attempt = 0; attempt < STORE_REPORT_ATTEMPTS; attempt += 1) {
        const { novelty, previousRunId } = await classifyReport(run, report, deps, log);
        if (!novelty) break;
        const stored = await deps.storeReport(run, { patch: { report, ...novelty }, previousRunId });
        if (stored.outcome === 'stored') return stored.run;
        if (stored.outcome === 'not_running') return null;
    }
    // Unknown flags stay null rather than a classification that may already be stale.
    return deps.storeUnclassifiedReport(run, report);
}
