const MANAGED_COMMIT_STATUS_PATTERNS = [
    /^(?:all\s+)?(?:changes?|edits?|modifications?|work)\s+(?:(?:are|were|remain|remains|stayed|stay)\s+)?(?:still\s+)?uncommitted\b/i,
    /^(?:all\s+)?(?:changes?|edits?|modifications?|work)\s+remain(?:s)?\s+(?:in\s+)?(?:the\s+)?work(?:ing)?\s*tree\b/i,
    /^left\s+(?:the\s+)?(?:changes?|edits?|modifications?|work)\s+uncommitted\b/i,
    /^(?:no|zero)\s+(?:git\s+)?commits?\b/i,
    /^(?:nothing|none\s+of\s+(?:the\s+)?(?:changes?|edits?|modifications?|work))\s+(?:was\s+)?committed\b/i,
    /^(?:i|we|the\s+agent)\s+(?:(?:did|do|does|will)\s+not|didn't|don't|doesn't|won't|could\s+not|couldn't|cannot|can't|was\s+unable\s+to|were\s+unable\s+to|am\s+unable\s+to)\s+(?:create|make)?\s*(?:(?:a|any)\s+)?(?:git\s+)?commits?\b/i,
    /^(?:i|we|the\s+agent)\s+(?:(?:did|do|does|will)\s+not|didn't|don't|doesn't|won't|could\s+not|couldn't|cannot|can't|was\s+unable\s+to|were\s+unable\s+to|am\s+unable\s+to)\s+commit\b/i,
    /^(?:(?:a|the)\s+)?(?:git\s+)?commit(?:ting|\s+creation)?\s+(?:was|is|could|cannot|can't|failed)\b/i,
    /^(?:the\s+)?\.?git\s+(?:directory\s+)?(?:(?:was|is|remains?)\s+(?:not\s+(?:writeable|writable)|read-only|unwritable)|(?:isn't|wasn't)\s+(?:writeable|writable))\b/i,
];

function normalizedSentence(sentence: string): string {
    return sentence
        .trim()
        .replace(/^(?:>\s*)+/, '')
        .replace(/^(?:[-*+]\s+|\d+\.\s+)/, '')
        .replace(/^#{1,6}\s+/, '')
        .replace(/[*_`~]/g, '')
        .replace(/^(?:(?:git|commit)\s+status|status)\s*:\s*/i, '')
        .trim();
}

function isManagedCommitStatus(sentence: string): boolean {
    const normalized = normalizedSentence(sentence);
    return MANAGED_COMMIT_STATUS_PATTERNS.some(pattern => pattern.test(normalized));
}

function sanitizeLine(line: string): string | null {
    if (/^\s*#{1,6}\s+(?:(?:git|commit)\s+status|commits?)\s*$/i.test(line)) return null;

    const segments = line.split(/(?<=[.!?;])\s+/);
    const retained = segments.filter(segment => !isManagedCommitStatus(segment));
    if (retained.length === 0) return null;

    return retained.join(' ').replace(/;\s*$/, '.');
}

/**
 * Removes agent-side Git housekeeping from user-facing reports.
 *
 * Coding agents only edit and validate files. ProPR owns committing and pushing
 * afterwards, so statements about the agent not creating a commit are both
 * expected and misleading once ProPR publishes the report with a real commit.
 */
export function sanitizeAgentReport(text: string | null | undefined): string {
    if (!text?.trim()) return '';

    let insideFence = false;
    const lines = text.split('\n').map(line => {
        if (/^\s*```/.test(line)) {
            insideFence = !insideFence;
            return line;
        }
        return insideFence ? line : sanitizeLine(line);
    }).filter((line): line is string => line !== null);

    return lines
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}
