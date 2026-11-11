import { redactSecrets } from '../utils/secretRedaction.js';

/**
 * The machine-readable line an agent ends its final message with when the
 * repository workflow sets `on_blocker: report` and the task cannot be
 * completed as specified. Everything after it is the agent's explanation.
 */
export const BLOCKER_MARKER = 'PROPR_BLOCKED:';

/** Upper bound on the explanation ProPR quotes in comments, history and notifications. */
export const BLOCKER_EXPLANATION_MAX_LENGTH = 2000;

const MISSING_EXPLANATION = 'The agent reported a blocker without an explanation.';

export interface BlockerReport {
    /** Bounded, secret-redacted explanation of what blocked the run and what is needed. */
    explanation: string;
}

function boundExplanation(text: string): string {
    const redacted = redactSecrets(text.trim()).trim();
    if (!redacted) return MISSING_EXPLANATION;
    if (redacted.length <= BLOCKER_EXPLANATION_MAX_LENGTH) return redacted;
    return `${redacted.slice(0, BLOCKER_EXPLANATION_MAX_LENGTH - 1).trimEnd()}…`;
}

/**
 * Finds the blocker marker in an agent's final message. Only a marker that
 * starts a top-level line counts: a marker inside a fenced code block, a
 * blockquote, an indented code block, a list item or the middle of a sentence
 * (for example, quoted tool output or the agent restating its instructions)
 * is ignored. When several qualify, the last one wins.
 */
export function parseBlockerReport(finalMessage: string | null | undefined): BlockerReport | null {
    if (!finalMessage?.includes(BLOCKER_MARKER)) return null;
    const lines = finalMessage.replace(/\r\n?/g, '\n').split('\n');
    let fence: string | null = null;
    let markerLine = -1;
    lines.forEach((line, index) => {
        const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line);
        if (fenceMatch) {
            const marker = fenceMatch[1];
            if (fence === null) fence = marker;
            else if (marker[0] === fence[0] && marker.length >= fence.length && !line.trim().slice(marker.length).trim()) fence = null;
            return;
        }
        if (fence === null && /^ {0,3}\S/.test(line) && line.trimStart().startsWith(BLOCKER_MARKER)) markerLine = index;
    });
    if (markerLine < 0) return null;
    const first = lines[markerLine].trimStart().slice(BLOCKER_MARKER.length);
    return { explanation: boundExplanation([first, ...lines.slice(markerLine + 1)].join('\n')) };
}

/** The agent's final message, as the coding agents report it. */
export function agentFinalMessage(result: { summary?: string | null; finalResult?: { result?: string | null } | null }): string {
    return result.summary || result.finalResult?.result || '';
}

/**
 * Detects a reported blocker only when the run's workflow enables it and the
 * agent ended normally; failed and interrupted runs keep their own handling.
 */
export function detectBlockerReport(
    result: { success?: boolean; summary?: string | null; finalResult?: { result?: string | null } | null } | null | undefined,
    enabled: boolean,
): BlockerReport | null {
    if (!enabled || !result?.success) return null;
    return parseBlockerReport(agentFinalMessage(result));
}

/** Appended to implementation and follow-up prompts when `on_blocker: report` is set. */
export function blockerReportPrompt(): string {
    return [
        '**IF YOU ARE BLOCKED:**',
        'If the task cannot be completed as specified, do not deliver a reduced, partial or placeholder version of it.',
        '- Leave the workspace without partial changes: revert any edits you made for this task.',
        `- End your final message with a line that starts with \`${BLOCKER_MARKER}\` (at the start of the line, not inside a code block or quote), followed by a short explanation of what blocked you and what is needed to continue.`,
        `- Example final line: \`${BLOCKER_MARKER} The payment API credentials are not available in this environment; a sandbox key is needed to run the integration tests.\``,
        `Use the marker only for a real blocker. If you completed the task, do not include \`${BLOCKER_MARKER}\` anywhere at the start of a line.`,
    ].join('\n');
}
