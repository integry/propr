export interface ReviewCheckRun {
    name?: string;
    status?: string;
    conclusion?: string | null;
}

const FAILED_CHECK_CONCLUSIONS = new Set([
    'action_required',
    'cancelled',
    'failure',
    'startup_failure',
    'stale',
    'timed_out',
]);

const MAX_REVIEW_CHECK_RUNS = 50;

type ReviewCheckState = 'failed' | 'pending' | 'passed' | 'neutral';

function classifyCheckRun(checkRun: ReviewCheckRun): ReviewCheckState {
    if (checkRun.status !== 'completed') return 'pending';
    if (checkRun.conclusion === 'success') return 'passed';
    if (checkRun.conclusion && FAILED_CHECK_CONCLUSIONS.has(checkRun.conclusion)) return 'failed';
    return 'neutral';
}

export function currentHeadChecksHaveFailures(checkRuns: ReviewCheckRun[]): boolean {
    return checkRuns.some(checkRun => classifyCheckRun(checkRun) === 'failed');
}

function sanitizeCheckName(name: string | undefined): string {
    return (name || 'Unnamed check').replace(/\s+/g, ' ').trim().slice(0, 200) || 'Unnamed check';
}

/** Format current-head check runs into a compact, deterministic prompt section. */
export function formatCurrentHeadCheckSummary(checkRuns: ReviewCheckRun[]): string {
    if (checkRuns.length === 0) return 'No check runs were reported for the current head commit.';

    const stateOrder: Record<ReviewCheckState, number> = { failed: 0, pending: 1, passed: 2, neutral: 3 };
    const normalizedRuns = checkRuns
        .map(checkRun => ({
            name: sanitizeCheckName(checkRun.name),
            state: classifyCheckRun(checkRun),
            status: checkRun.status || 'unknown',
            conclusion: checkRun.conclusion || 'none',
        }))
        .sort((a, b) => stateOrder[a.state] - stateOrder[b.state] || a.name.localeCompare(b.name));
    const counts: Record<ReviewCheckState, number> = { failed: 0, pending: 0, passed: 0, neutral: 0 };
    for (const checkRun of normalizedRuns) counts[checkRun.state]++;

    const visibleRuns = normalizedRuns.slice(0, MAX_REVIEW_CHECK_RUNS);
    const omittedCount = normalizedRuns.length - visibleRuns.length;
    const lines = visibleRuns.map(checkRun =>
        `- [${checkRun.state}] ${checkRun.name} — status: ${checkRun.status}; conclusion: ${checkRun.conclusion}`,
    );
    if (omittedCount > 0) lines.push(`- ${omittedCount} additional check run(s) omitted from this summary.`);

    return [
        `Summary: ${counts.failed} failed, ${counts.pending} pending, ${counts.passed} passed, ${counts.neutral} neutral/skipped.`,
        ...lines,
    ].join('\n');
}
