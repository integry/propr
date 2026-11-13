/**
 * Unproductive-run flags for automations, shared by the worker, API, MCP, CLI
 * and web UI. A run still completes normally; these values only describe
 * whether it produced anything: a report that differs from the previous one,
 * or an acting step that changed something.
 */

/**
 * - new: the normalised report differs from the previous reported run's.
 * - unchanged: the same normalised hash as the previous reported run of the definition.
 * - empty: the normalised report is shorter than `AUTOMATION_REPORT_MIN_NOVEL_CHARS`.
 */
export const AUTOMATION_REPORT_NOVELTIES = ['new', 'unchanged', 'empty'] as const;
export type AutomationReportNovelty = typeof AUTOMATION_REPORT_NOVELTIES[number];

/** A normalised report shorter than this says nothing and counts as `empty`. */
export const AUTOMATION_REPORT_MIN_NOVEL_CHARS = 40;

/** Instance setting: consecutive unproductive scheduled runs before the owner is told. */
export const AUTOMATION_UNPRODUCTIVE_RUN_THRESHOLD_SETTING = 'automation_unproductive_run_threshold';
export const DEFAULT_AUTOMATION_UNPRODUCTIVE_RUN_THRESHOLD = 3;
export const AUTOMATION_UNPRODUCTIVE_RUN_THRESHOLD_MIN = 1;
export const AUTOMATION_UNPRODUCTIVE_RUN_THRESHOLD_MAX = 50;

export function isAutomationReportNovelty(value: unknown): value is AutomationReportNovelty {
  return AUTOMATION_REPORT_NOVELTIES.includes(value as AutomationReportNovelty);
}

export function isAutomationUnproductiveRunThreshold(value: unknown): value is number {
  return Number.isSafeInteger(value)
    && (value as number) >= AUTOMATION_UNPRODUCTIVE_RUN_THRESHOLD_MIN
    && (value as number) <= AUTOMATION_UNPRODUCTIVE_RUN_THRESHOLD_MAX;
}

/** Why a run produced nothing; the "no change" badge and the streak both read it. */
export type AutomationRunNoChangeReason = 'empty_report' | 'unchanged_report' | 'no_op_action';

export interface AutomationRunProductivityFields {
  reportNovelty: AutomationReportNovelty | null;
  /** Mutating MCP operations the acting step performed; null when it did not act or the count is unknown. */
  actingMutations: number | null;
}

/**
 * Why a run counts as unproductive, or null when it produced something or has
 * no flags yet. An acting step that changed something makes the run productive
 * whatever its report said; one that changed nothing is a no-op acting step.
 */
export function automationRunNoChangeReason(run: AutomationRunProductivityFields): AutomationRunNoChangeReason | null {
  if (run.actingMutations != null && run.actingMutations > 0) return null;
  if (run.reportNovelty === 'empty') return 'empty_report';
  if (run.reportNovelty === 'unchanged') return 'unchanged_report';
  if (run.actingMutations === 0) return 'no_op_action';
  return null;
}

export const AUTOMATION_RUN_NO_CHANGE_LABELS: Readonly<Record<AutomationRunNoChangeReason, string>> = {
  empty_report: 'The report was empty',
  unchanged_report: 'The report was the same as the previous run\'s',
  no_op_action: 'The acting step changed nothing',
};
