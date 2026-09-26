import { parseStructuredReview } from './reviewOutputParser.js';

const MAX_RECAP_CHARACTERS = 260;

function truncateAtWord(text: string, maximum = MAX_RECAP_CHARACTERS): string {
    const characters = Array.from(text);
    if (characters.length <= maximum) return text;
    const shortened = characters.slice(0, maximum - 1).join('');
    const lastSpace = shortened.lastIndexOf(' ');
    return `${shortened.slice(0, lastSpace >= maximum * 0.6 ? lastSpace : undefined).trimEnd()}…`;
}

/** Convert an agent-authored Markdown summary into one safe, scannable Inbox line. */
export function compactNotificationRecap(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const lines = value
        .replace(/<!--[^]*?-->/g, ' ')
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/```[^\n]*\n?/g, ' ')
        .split(/\r?\n/)
        .map(line => line
            .replace(/^\s{0,3}#{1,6}\s+/, '')
            .replace(/^\s*(?:[-*+] |\d+[.)]\s+)/, '')
            .replace(/^\s*>+\s?/, '')
            // Unwrap paired emphasis only, so snake_case identifiers keep their underscores.
            .replace(/`/g, '')
            .replace(/(\*{1,2}|~~)(?=\S)(.+?)(?<=\S)\1/g, '$2')
            .replace(/(^|\W)(_{1,2})(?=\S)(.+?)(?<=\S)\2(?!\w)/g, '$1$3')
            .replace(/^summary(?: of changes)?\s*:?\s*/i, '')
            .trim())
        .filter(line => line && !/^[-=:|\s]+$/.test(line));
    const compact = lines.join(' · ').replace(/\s+/g, ' ').trim();
    return compact ? truncateAtWord(compact) : undefined;
}

/** Task history metadata for a review that moved to its continuation pull request. */
export function stoppedReviewRecap(reason: string): { notificationRecap: string | undefined } {
    return { notificationRecap: compactNotificationRecap(reason) };
}

/** Task history metadata for an ultrafix review waiting on exact-head checks. */
export const deferredUltrafixReviewRecap = {
    notificationRecap: 'Review deferred until the continuation pull request passes its exact-head checks.',
} as const;

interface ReviewRecapResult {
    analysisResult: { success: boolean; response: string };
    findingCount?: number;
}

export function buildReviewNotificationRecap(results: readonly ReviewRecapResult[]): string {
    const successful = results.filter(result => result.analysisResult.success);
    const parsed = successful.map(result => ({
        result,
        review: parseStructuredReview(result.analysisResult.response),
    }));
    const valid = parsed.filter(item => item.review.status !== 'invalid');
    const scores = valid.flatMap(item => item.review.score === null ? [] : [item.review.score]);
    const issueCount = parsed.reduce((total, item) => total + (
        item.result.findingCount ?? item.review.actionableFindings.length
    ), 0);
    const issueTitles = valid.flatMap(item => item.review.actionableFindings.map(finding => finding.title));
    const scoreText = scores.length === 1
        ? `Score ${scores[0]}/10`
        : scores.length > 1
            ? `Scores ${scores.map(score => `${score}/10`).join(', ')}`
            : undefined;
    const issueText = `${issueCount} ${issueCount === 1 ? 'issue' : 'issues'} found`;
    const titleText = issueTitles.length > 0 ? `: ${issueTitles.slice(0, 2).join('; ')}` : '';
    const failedCount = results.length - successful.length;
    const failureText = failedCount > 0
        ? `${failedCount} ${failedCount === 1 ? 'reviewer failed' : 'reviewers failed'}`
        : undefined;
    const details = [scoreText, successful.length > 0 ? `${issueText}${titleText}` : undefined, failureText]
        .filter((part): part is string => Boolean(part))
        .join(' · ');
    return truncateAtWord(details || 'The review run finished without a published result.');
}

export function buildWorkNotificationRecap(
    summary: unknown,
    options: {
        commandMode?: string;
        filesChanged?: number;
        createdPullRequest?: boolean;
        noChanges?: boolean;
        partial?: boolean;
    } = {},
): string {
    const compact = compactNotificationRecap(summary);
    if (compact) return options.partial ? truncateAtWord(`Partial result: ${compact}`) : compact;
    if (options.noChanges) return 'Analyzed the request; no code changes were needed.';
    const files = options.filesChanged && options.filesChanged > 0
        ? ` across ${options.filesChanged} ${options.filesChanged === 1 ? 'file' : 'files'}`
        : '';
    switch (options.commandMode) {
        case 'fix': return `Applied the requested review fixes${files}.`;
        case 'merge': return `Updated the pull request branch and resolved merge conflicts${files}.`;
        default: return options.createdPullRequest
            ? `Implemented the requested work${files} and opened a pull request.`
            : `Implemented the requested work${files}.`;
    }
}

export function buildMergeNotificationRecap(options: {
    baseBranch: string;
    headBranch: string;
    conflictedFiles?: readonly string[];
    summary?: unknown;
}): string {
    const conflicts = options.conflictedFiles?.length ?? 0;
    const outcome = conflicts === 0
        ? `Merged ${options.baseBranch} into ${options.headBranch} cleanly.`
        : `Merged ${options.baseBranch} into ${options.headBranch} and resolved conflicts in ${conflicts} ${conflicts === 1 ? 'file' : 'files'}.`;
    const detail = compactNotificationRecap(options.summary);
    return truncateAtWord(detail ? `${outcome} ${detail}` : outcome);
}
