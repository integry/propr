import { redactSecrets } from '../utils/secretRedaction.js';

/**
 * Closed outcome vocabulary for one `.propr/workflow.yml` validation command.
 * `failed` and `killed` carry the command's exit code; `not_run` says why.
 */
export type RepositoryValidationCommandStatus = 'passed' | 'failed' | 'timed_out' | 'killed' | 'not_run' | 'not_observed';
export type RepositoryValidationNotRunReason = 'execution_ended' | 'time_limit_reached';
export type RepositoryValidationOverall = 'passed' | 'failed' | 'incomplete';

export interface RepositoryValidationCommandResult {
    /** Zero-based position in the workflow's `validation` list; the markdown report shows `index + 1`. */
    index: number;
    /** The command as shown in the report: secrets redacted, whitespace collapsed and length bounded. */
    command: string;
    status: RepositoryValidationCommandStatus;
    exitCode?: number;
    reason?: RepositoryValidationNotRunReason;
    /** False when the container wrapper was not running as root, so the agent could have written reports itself. */
    verified: boolean;
}

/** Serialisable outcome of a run's repository validation commands. */
export interface RepositoryValidationResult {
    commands: RepositoryValidationCommandResult[];
    /** `failed` when any command failed, timed out or was killed; `incomplete` when one was not run or not observed. */
    overall: RepositoryValidationOverall;
}

// Completion comments share GitHub's 65,536-character body limit with summaries and logs.
export const REPOSITORY_VALIDATION_REPORT_MAX_LENGTH = 12_000;
const VALIDATION_LABEL_MAX_LENGTH = 200;
const ELLIPSIS = '…';
const REPORT_HEADER = '### Repository validation\n\n';
const UNVERIFIED_SUFFIX = ' (unverified: container wrapper was not running as root)';

/**
 * Valid commands may be far longer than a comment can hold. Labels are redacted
 * before shortening so a cut can never leave an unrecognisable secret prefix,
 * and every command keeps its index and status within the aggregate budget.
 */
function boundedLabels(entries: Array<{ command: string; status: string }>): string[] {
    const fixed = REPORT_HEADER.length + entries.reduce((total, entry, index) => total + `- [${index + 1}] `.length + `: ${entry.status}`.length + 1, 0);
    const labelBudget = Math.min(VALIDATION_LABEL_MAX_LENGTH, Math.floor((REPOSITORY_VALIDATION_REPORT_MAX_LENGTH - fixed) / Math.max(entries.length, 1)));
    return entries.map(entry => {
        const label = redactSecrets(entry.command).replace(/\s+/g, ' ').trim();
        return label.length <= labelBudget ? label : `${label.slice(0, Math.max(labelBudget - ELLIPSIS.length, 0)).trimEnd()}${ELLIPSIS}`;
    });
}

function formatReport(lines: Array<{ label: string; status: string }>): string {
    return `${REPORT_HEADER}${lines.map((line, index) => `- [${index + 1}] ${line.label}: ${line.status}`).join('\n')}`;
}

export function buildRepositoryValidationReport(entries: Array<{ command: string; status: string }>): string {
    const labels = boundedLabels(entries);
    return formatReport(entries.map((entry, index) => ({ label: labels[index], status: entry.status })));
}

/** The status text rendered in the markdown report for one command. */
export function describeRepositoryValidationStatus(entry: Pick<RepositoryValidationCommandResult, 'status' | 'exitCode' | 'reason' | 'verified'>): string {
    const text = entry.status === 'passed' ? 'Passed'
        : entry.status === 'failed' ? `Failed (exit ${entry.exitCode})`
        : entry.status === 'timed_out' ? 'Timed out'
        : entry.status === 'killed' ? `Killed (exit ${entry.exitCode})`
        : entry.status === 'not_observed' ? 'Not observed (agent transport did not capture container output)'
        : entry.reason === 'time_limit_reached' ? 'Not run (execution time limit reached)' : 'Not run (execution ended before validation)';
    return entry.verified ? text : `${text}${UNVERIFIED_SUFFIX}`;
}

/**
 * Maps one wrapper report (`0`, another exit code, `timeout`, `skipped`, or none)
 * to its structured status. 137 is reported as killed: timeout(1) already turned
 * a KILL at the command's limit into `timeout`.
 */
export function repositoryValidationStatus(code: string | undefined, unobserved: boolean): Pick<RepositoryValidationCommandResult, 'status' | 'exitCode' | 'reason'> {
    if (unobserved) return { status: 'not_observed' };
    if (code === undefined) return { status: 'not_run', reason: 'execution_ended' };
    if (code === 'skipped') return { status: 'not_run', reason: 'time_limit_reached' };
    if (code === 'timeout') return { status: 'timed_out' };
    if (code === '0') return { status: 'passed' };
    return { status: code === '137' ? 'killed' : 'failed', exitCode: Number(code) };
}

function overallOf(commands: RepositoryValidationCommandResult[]): RepositoryValidationOverall {
    if (commands.some(entry => entry.status === 'failed' || entry.status === 'timed_out' || entry.status === 'killed')) return 'failed';
    return commands.every(entry => entry.status === 'passed') ? 'passed' : 'incomplete';
}

/**
 * Builds the structured result and its markdown report from one observation, so
 * the two can never disagree. Returns undefined when there are no commands.
 */
export function buildRepositoryValidation(
    commands: readonly string[], observed: { validation: Map<number, string>; unverified?: boolean }, unobserved: boolean,
): { result: RepositoryValidationResult; report: string } | undefined {
    if (!commands.length) return undefined;
    const verified = !observed.unverified;
    const outcomes = commands.map((_, index) => ({ ...repositoryValidationStatus(observed.validation.get(index), unobserved), verified }));
    const labels = boundedLabels(commands.map((command, index) => ({ command, status: describeRepositoryValidationStatus(outcomes[index]) })));
    const entries = outcomes.map((outcome, index): RepositoryValidationCommandResult => ({ index, command: labels[index], ...outcome }));
    return { result: { commands: entries, overall: overallOf(entries) }, report: renderRepositoryValidationReport({ commands: entries }) };
}

/** Renders the markdown report from a structured result whose commands are already bounded labels. */
export function renderRepositoryValidationReport(result: Pick<RepositoryValidationResult, 'commands'>): string {
    return formatReport(result.commands.map(entry => ({ label: entry.command, status: describeRepositoryValidationStatus(entry) })));
}
