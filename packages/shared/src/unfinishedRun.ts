/**
 * Shared wording for a run whose agent exited while its last message said work
 * was still in progress or waiting. The summary-selection call sets
 * `unfinishedReason`; completion comments use these helpers so they never
 * present such a run as a clean success.
 */

export const UNFINISHED_RUN_HEADLINE = 'The run ended before the agent confirmed completion.';

/** True when the summary-selection call flagged the run unfinished. */
export function isUnfinishedRun(result: { unfinishedReason?: string | null } | null | undefined): boolean {
    return Boolean(result?.unfinishedReason?.trim());
}

/** The warning callout shown above the agent's last update. */
export function unfinishedRunWarning(reason: string): string {
    const line = reason.replace(/\s+/g, ' ').trim();
    return `> [!WARNING]\n> **${UNFINISHED_RUN_HEADLINE}** ${line ? `${line} ` : ''}Review the committed changes before relying on them.\n\n`;
}

/** A markdown list of the committed files, at most 20, or empty when none are known. */
export function committedFilesList(files: readonly string[] | null | undefined): string {
    const changed = files ?? [];
    if (changed.length === 0) return '';
    const shown = changed.slice(0, 20).map(file => `- \`${file}\``).join('\n');
    const more = changed.length > 20 ? `\n- …and ${changed.length - 20} more` : '';
    return `${shown}${more}`;
}
