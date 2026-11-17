// One plain-words sentence naming why a ProPR run failed, for public GitHub
// comments. Raw provider output, container paths and upstream HTML page titles
// never reach the comment; the task page keeps the full detail.

const FAILURE_CAUSE_MAX_CHARS = 240;

const KNOWN_CAUSES: ReadonlyArray<{ pattern: RegExp; cause: string }> = [
    {
        pattern: /\b(?:failed to authenticate|authentication (?:failed|error)|invalid api key|unauthori[sz]ed|forbidden|(?:api error|http|status)[: ]*40[13]|oauth token (?:has )?expired|credential|attention required|cloudflare)\b/i,
        cause: 'Provider authentication failed.',
    },
    {
        pattern: /\b(?:usage limit|rate limit|rate-limited|quota|too many requests|(?:api error|http|status)[: ]*429)\b/i,
        cause: 'The provider usage limit was reached.',
    },
    {
        pattern: /\b(?:exited with code|exit code|killed|SIG(?:ILL|SEGV|KILL|TERM|ABRT|BUS)|signal \d+|segmentation fault|core dumped|process (?:crashed|terminated|exited))\b/i,
        cause: 'The agent process stopped unexpectedly.',
    },
    { pattern: /\b(?:timed out|timeout|deadline exceeded)\b/i, cause: 'The agent run timed out.' },
    { pattern: /\b(?:aborted by user|cancelled|canceled)\b/i, cause: 'The run was cancelled.' },
];

/** Container and host paths that are meaningless (and revealing) outside the worker. */
const INTERNAL_PATH = /(?:\/usr\/src\/app|\/app|\/tmp|\/home\/[^/\s]+|\/var\/[^/\s]+)(?:\/[^\s`'")]*)?/g;
const HTML_TAG = /<[^>]*>/g;

/**
 * A plain sentence for `message`: a known cause when one matches, otherwise the
 * first line with HTML, internal paths and trailing detail removed. Never empty.
 */
export function describeFailureCause(message: string | null | undefined, fallback = 'The run failed without reporting a cause.'): string {
    const text = (message ?? '').trim();
    if (!text) return fallback;
    const known = KNOWN_CAUSES.find(({ pattern }) => pattern.test(text));
    if (known) return known.cause;
    const firstLine = text
        .replace(HTML_TAG, ' ')
        .replace(INTERNAL_PATH, '')
        .split(/\r?\n/)
        .map(line => line.replace(/\s+/g, ' ').trim())
        .find(line => /[A-Za-z]/.test(line)) ?? '';
    const cleaned = firstLine.replace(/^(?:Error|Agent execution failed):\s*/i, '').replace(/[\s:;,-]+$/, '');
    if (!cleaned) return fallback;
    const bounded = cleaned.length > FAILURE_CAUSE_MAX_CHARS
        ? `${cleaned.slice(0, FAILURE_CAUSE_MAX_CHARS - 1).trimEnd()}…`
        : cleaned;
    const sentence = bounded.charAt(0).toUpperCase() + bounded.slice(1);
    return /[.!?…]$/.test(sentence) ? sentence : `${sentence}.`;
}
