/**
 * Whether a ProPR receipt on the pull request consumed a follow-up request.
 *
 * Every follow-up receipt lists the request IDs it covers as `<id>✓`: the
 * starting comment, the completion it is edited into, the failure notice and
 * the recovered completions. Only the last three end the request. A starting
 * comment is left as it is when a provider usage limit hands the request to a
 * delayed retry, so the retry must not read it as completion.
 *
 * The authoritative lifecycle evidence is the work-evidence marker each modern
 * receipt carries on its own line. A receipt that names the request only as
 * `phase=started` is in flight; one that names it as `completed` or `failed`
 * ended it. A receipt without a marker for the request (legacy completions
 * written before the markers existed) keeps counting through its checkmark.
 */

const WORK_EVIDENCE_LINE = /^<!-- propr:work-evidence phase=(started|completed|failed) trigger-comment-ids=(\d+(?:,\d+)*) -->$/;

/** `<id>✓` that is not the tail of a longer ID, so receipt 112345✓ never consumes request 2345. */
function checkmarkPattern(commentId: number): RegExp {
    return new RegExp(`(?<!\\d)${commentId}✓`);
}

/** Phases with which the receipt's own marker lines name this request. */
function markerPhases(lines: readonly string[], commentId: number): Map<string, number[]> {
    const phases = new Map<string, number[]>();
    lines.forEach((line, index) => {
        const match = WORK_EVIDENCE_LINE.exec(line);
        if (!match || !match[2].split(',').some(id => Number(id) === commentId)) return;
        phases.set(match[1], [...(phases.get(match[1]) ?? []), index]);
    });
    return phases;
}

/**
 * True when the started marker is the starting comment's own footer: it
 * directly follows the line that lists this request with its checkmark. A
 * started marker anywhere else (quoted in an agent summary, for example) does
 * not reopen a legacy completion.
 */
function isStartingFooter(lines: readonly string[], startedIndexes: readonly number[], commentId: number): boolean {
    const checkmark = checkmarkPattern(commentId);
    return startedIndexes.some(index => index > 0 && checkmark.test(lines[index - 1]));
}

/**
 * Whether this body, already known to be authored by the authenticated ProPR
 * identity, consumed the request. Callers decide trust; this reads evidence.
 */
export function receiptConsumesRequest(body: string | null | undefined, commentId: number): boolean {
    if (!body || !checkmarkPattern(commentId).test(body)) return false;
    const lines = body.replace(/\r\n?/g, '\n').split('\n');
    const phases = markerPhases(lines, commentId);
    if (phases.has('completed') || phases.has('failed')) return true;
    const started = phases.get('started');
    return !(started && isStartingFooter(lines, started, commentId));
}
