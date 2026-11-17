/**
 * One plain-language sentence naming why a run failed, for the top of a
 * failure comment. The raw (sanitized) error stays below it for detail; this
 * line is what a reader of the pull request or issue sees first.
 */

const CAUSES: ReadonlyArray<{ pattern: RegExp; sentence: string }> = [
    {
        pattern: /failed to authenticate|authentication[_ ]error|authentication failed|invalid (?:api[ -]?key|x-api-key|bearer token)|oauth token (?:has )?expired|not logged in|please run \/login|\b401\b|unauthorized/i,
        sentence: 'Provider authentication failed.',
    },
    {
        pattern: /process exited with code|exited with code \d+|killed by signal|was killed|\bSIG(?:KILL|TERM|SEGV|ILL|ABRT|BUS)\b|out of memory|\bOOM\b|process (?:crashed|terminated|stopped)/i,
        sentence: 'The agent process stopped unexpectedly.',
    },
    {
        pattern: /timed out|\btimeout\b|ETIMEDOUT/i,
        sentence: 'The run timed out.',
    },
];

/** The plain cause sentence for a failure message, or null when it fits no known cause. */
export function describeFailureCause(message: string | null | undefined): string | null {
    if (!message) return null;
    return CAUSES.find(cause => cause.pattern.test(message))?.sentence ?? null;
}
