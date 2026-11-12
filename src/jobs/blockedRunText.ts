/**
 * Text for runs that stopped on a reported blocker (`on_blocker: report`).
 * Dependency-free, so comment and terminal-state code can render a blocked
 * run without loading the blocker handlers.
 */

/**
 * Whether a run's workflow snapshot sets `on_blocker: report`. Kept here,
 * dependency-free, so job modules can check it without loading the handlers.
 */
export function workflowReportsBlockers(workflow: { config?: { on_blocker?: string } } | null | undefined): boolean {
    return workflow?.config?.on_blocker === 'report';
}

/** Shown in comments; the full list is kept on the task history. */
const LISTED_FILES_LIMIT = 10;

/** One line for task history and notification recaps. */
export function blockedRunRecap(outcome: { explanation: string }): string {
    const firstLine = outcome.explanation.split('\n').find(line => line.trim())?.trim() ?? '';
    const bounded = firstLine.length > 200 ? `${firstLine.slice(0, 199).trimEnd()}…` : firstLine;
    return `Stopped on a blocker: ${bounded}`;
}

/**
 * The agent's explanation as a Markdown quote. HTML comments are neutralized
 * so agent text cannot forge the machine-readable markers ProPR reads back
 * from its own comments.
 */
export function quoteBlockerExplanation(explanation: string): string {
    return explanation.replace(/<!--/g, '&lt;!--').split('\n').map(line => (line ? `> ${line}` : '>')).join('\n');
}

/** Says that changes the agent left behind were not committed; empty when it left none. */
export function describeUncommittedFiles(files: readonly string[]): string {
    if (files.length === 0) return '';
    const listed = files.slice(0, LISTED_FILES_LIMIT).map(file => `\`${file.replace(/`/g, "'")}\``).join(', ');
    const more = files.length > LISTED_FILES_LIMIT ? ` and ${files.length - LISTED_FILES_LIMIT} more` : '';
    return `⚠️ The agent reported the blocker but left changes in ${files.length} file${files.length === 1 ? '' : 's'} (${listed}${more}). They were not committed.`;
}
