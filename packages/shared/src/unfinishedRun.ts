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

/**
 * The warning callout shown above the agent's last update. Pass
 * `committed: false` when the run committed nothing, so the callout does not
 * point the reader at committed work that does not exist.
 */
export function unfinishedRunWarning(reason: string, options: { committed?: boolean } = {}): string {
    const line = reason.replace(/\s+/g, ' ').trim();
    const next = options.committed === false
        ? 'No changes were committed, so the requested work may still be outstanding.'
        : 'Review the committed changes before relying on them.';
    return `> [!WARNING]\n> **${UNFINISHED_RUN_HEADLINE}** ${line ? `${line} ` : ''}${next}\n\n`;
}

/** Headline of an issue run that ended unconfirmed without committing anything. */
export const UNFINISHED_NO_CHANGE_HEADLINE = '⚠️ **No code changes were committed, and the agent did not confirm the work was complete.**';

/** A markdown list of the committed files, at most 20, or empty when none are known. */
export function committedFilesList(files: readonly string[] | null | undefined): string {
    const changed = files ?? [];
    if (changed.length === 0) return '';
    const shown = changed.slice(0, 20).map(file => `- \`${file}\``).join('\n');
    const more = changed.length > 20 ? `\n- …and ${changed.length - 20} more` : '';
    return `${shown}${more}`;
}
