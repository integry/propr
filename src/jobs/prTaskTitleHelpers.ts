import { diffBlockPaths, diffPatchPath } from './prTaskTitleDiffHelpers.js';

export { filterDiffToFiles, getConflictDiffForTitle } from './prTaskTitleDiffHelpers.js';

export type PrTaskWorkflow = 'followup' | 'fix' | 'review' | 'ultrafix' | 'merge';

export interface TitleComment {
    id?: number;
    body?: string | null;
    created_at?: string;
    user?: { login?: string; type?: string | null };
    author?: string;
    pull_request_review_id?: number;
}

export interface BuildTitleContextOptions {
    workflow: PrTaskWorkflow;
    pullRequestNumber: number;
    prTitle: string;
    instructionText?: string | null;
    recentComments?: TitleComment[];
    prDescription?: string | null;
    reviewFeedback?: string | null;
    mergeConflictDiff?: string | null;
    excludeCommentIds?: Array<number | undefined>;
    recentCommentLimit?: number;
}

export interface TitleContextResult {
    context: string;
    hasMeaningfulContext: boolean;
    usefulRecentCommentCount: number;
    includedPrDescription: boolean;
    includedReviewFeedback: boolean;
    includedMergeConflictDiff: boolean;
}

export function buildPrTaskTitleContextHistoryMetadata(result: TitleContextResult): Record<string, unknown> {
    return {
        hasMeaningfulContext: result.hasMeaningfulContext,
        usefulRecentCommentCount: result.usefulRecentCommentCount,
        includedPrDescription: result.includedPrDescription,
        includedReviewFeedback: result.includedReviewFeedback,
        includedMergeConflictDiff: result.includedMergeConflictDiff,
    };
}

const WORKFLOW_LABELS: Record<PrTaskWorkflow, string> = {
    followup: 'Follow-up',
    fix: 'Fix',
    review: 'Review',
    ultrafix: 'Ultrafix',
    merge: 'Merge',
};

const MAX_PR_TITLE_IN_TASK_TITLE = 140;
const MAX_TITLE_CONTEXT_LENGTH = 6000;

const PROPR_GENERATED_PATTERNS = [
    'AI Implementation Summary',
    'AI Processing Completed',
    'Starting work on follow-up changes',
    'Starting AI Code Review',
    'AI Code Review Complete',
    'Execution Details:',
    'Resolved merge conflicts',
    'Auto-resolving merge conflicts',
    'Auto-merged',
    'Failed to apply follow-up changes',
    'Failed to resolve merge conflicts',
];

const GENERIC_PR_TITLE_PATTERNS = [
    /^AI Implementation Summary:?$/i,
    /^Implementation Summary:?$/i,
    /^AI Processing Completed:?$/i,
    /^Implemented issue #\d+\.?$/i,
];

const NOISY_BOT_PATTERNS = [
    '### Checks Failed',
    'Linting or build errors were detected.',
    'View Logs',
    'View Workflow',
    'deployment',
    'preview deployment',
    'coverage report',
    'check run',
    'workflow run',
    'build failed',
    'build succeeded',
    'all checks',
];

const COMMON_NOISY_BOT_AUTHORS = [
    'github-actions[bot]',
    'vercel[bot]',
    'netlify[bot]',
    'codecov[bot]',
    'renovate[bot]',
    'dependabot[bot]',
    'sonarcloud[bot]',
    'snyk-bot',
];

function compactWhitespace(value: string): string {
    return value.replace(/\s+/g, ' ').trim();
}

function truncate(value: string, maxLength = 1200): string {
    return value.length > maxLength ? `${value.substring(0, maxLength)}...` : value;
}

function unwrapFencedCodeBlocks(value: string): string {
    return value
        .replace(/```[^\n]*\n?([\s\S]*?)```/g, '\n$1\n')
        .replace(/~~~[^\n]*\n?([\s\S]*?)~~~/g, '\n$1\n');
}

function cleanMarkdownForTitleContext(value: string | null | undefined): string {
    return unwrapFencedCodeBlocks(stripHtmlComments(value || '')
        .replace(/<details\b[\s\S]*?<\/details>/gi, '')
    )
        .split('\n')
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('>'))
        .filter(line => !/^(<summary\b|<\/summary>|view logs|view workflow)$/i.test(line))
        .join('\n')
        .trim();
}

function isLikelyReviewModelSelector(value: string): boolean {
    const text = compactWhitespace(value).toLowerCase();
    if (!text || /\s/.test(text)) return false;
    return /^(?:claude|sonnet|opus|haiku|gpt|o[1-9]|codex|gemini|openai|anthropic)(?:[\w.:-]*)?$/.test(text)
        || /(?:claude|sonnet|opus|haiku|gpt|codex|gemini)/.test(text);
}

export function buildPrTaskTitle(options: {
    workflow: PrTaskWorkflow;
    pullRequestNumber: number;
    prTitle: string | null | undefined;
}): string {
    const rawTitle = compactWhitespace(options.prTitle || '');
    const title = truncate(rawTitle && !isGenericPrTitleText(rawTitle) ? rawTitle : 'Untitled pull request', MAX_PR_TITLE_IN_TASK_TITLE);
    return `${WORKFLOW_LABELS[options.workflow]} PR #${options.pullRequestNumber}: ${title}`;
}

export function isGenericPrTitleText(value: string | null | undefined): boolean {
    const title = compactWhitespace(value || '');
    return !title || GENERIC_PR_TITLE_PATTERNS.some(pattern => pattern.test(title));
}

export function getPrTaskWorkflowLabel(workflow: PrTaskWorkflow): string {
    return WORKFLOW_LABELS[workflow];
}

export function buildDeterministicPrTaskSubtitle(workflow: PrTaskWorkflow, branches?: { baseBranch?: string; headBranch?: string }): string {
    switch (workflow) {
        case 'fix':
            return 'Fix requested without additional context.';
        case 'review':
            return 'Review requested without additional context.';
        case 'ultrafix':
            return 'Ultrafix cycle requested without additional context.';
        case 'merge':
            if (branches?.baseBranch && branches?.headBranch) return `Merging ${branches.baseBranch} into ${branches.headBranch}`;
            return 'Merge conflict resolution requested without conflict details.';
        case 'followup':
        default:
            return 'Follow-up requested without additional context.';
    }
}

export function resolvePrTaskWorkflow(commandMode: string | undefined, hasUltrafixMeta = false): PrTaskWorkflow {
    if (hasUltrafixMeta || commandMode === 'ultrafix') return 'ultrafix';
    if (commandMode === 'fix') return 'fix';
    if (commandMode === 'review') return 'review';
    return 'followup';
}

export function hasMeaningfulTitleText(value: string | null | undefined): boolean {
    const raw = (value || '').trim();
    const text = compactWhitespace(raw);
    if (!text) return false;

    const firstNewline = raw.indexOf('\n');
    const firstLine = (firstNewline === -1 ? raw : raw.substring(0, firstNewline)).trim();
    const trailingLines = firstNewline === -1 ? '' : raw.substring(firstNewline + 1).trim();
    const commandMatch = firstLine.match(/^\/(fix|review|merge|ultrafix)(?:\s+(.*))?$/i);
    if (!commandMatch) return true;

    const command = commandMatch[1].toLowerCase();
    const inlineText = (commandMatch[2] || '').trim();
    if (command === 'fix') return Boolean(inlineText || trailingLines);
    if (command === 'review') return Boolean(trailingLines || (inlineText && !isLikelyReviewModelSelector(inlineText)));
    if (command === 'ultrafix') return Boolean(inlineText || trailingLines);
    return false;
}

export function isUsefulTitleComment(comment: TitleComment): boolean {
    const cleanedBody = cleanMarkdownForTitleContext(comment.body);
    if (!hasMeaningfulTitleText(cleanedBody)) return false;
    const body = compactWhitespace(cleanedBody);
    const lowerBody = body.toLowerCase();

    const authorType = comment.user?.type;
    const author = comment.user?.login || comment.author || '';
    if (author.toLowerCase().includes('propr')
        && PROPR_GENERATED_PATTERNS.some(pattern => lowerBody.includes(pattern.toLowerCase()))) {
        return false;
    }
    if (authorType === 'Bot' && author.toLowerCase().includes('propr')) return false;
    if (authorType === 'Bot' && COMMON_NOISY_BOT_AUTHORS.includes(author.toLowerCase())) return false;
    if (authorType === 'Bot' && NOISY_BOT_PATTERNS.some(pattern => lowerBody.includes(pattern.toLowerCase()))) {
        return false;
    }
    return !PROPR_GENERATED_PATTERNS.some(pattern => lowerBody.includes(pattern.toLowerCase()));
}

export function selectRecentUsefulPrComments(
    comments: TitleComment[] | undefined,
    options: { limit?: number; excludeCommentIds?: Array<number | undefined> } = {},
): TitleComment[] {
    const excluded = new Set((options.excludeCommentIds || []).filter((id): id is number => typeof id === 'number'));
    const limit = options.limit ?? 2;
    return [...(comments || [])]
        .filter(comment => !excluded.has(comment.id ?? -1))
        .filter(isUsefulTitleComment)
        .sort((a, b) => {
            const aTime = a.created_at ? new Date(a.created_at).getTime() : 0;
            const bTime = b.created_at ? new Date(b.created_at).getTime() : 0;
            return bTime - aTime;
        })
        .slice(0, limit);
}

function formatComment(comment: TitleComment): string {
    const author = comment.user?.login || comment.author || 'unknown';
    const kind = comment.pull_request_review_id ? 'review comment' : 'PR comment';
    return `- @${author} (${kind}): ${truncate(cleanMarkdownForTitleContext(comment.body))}`;
}

function stripHtmlComments(value: string): string {
    return value.replace(/<!--[\s\S]*?-->/g, '').trim();
}

function isPrTemplateNoiseLine(line: string): boolean {
    return [
        /^#+\s*(checklist|todo|testing checklist|screenshots?|related issues?|linked issues?|how to test|test plan)\s*:?$/i,
        /^[-*]\s+\[[ xX]\]\s+/,
        /^(closes|fixes|resolves)\s+#\d+\b/i,
        /^n\/a$/i,
        /^none$/i,
    ].some(pattern => pattern.test(line.trim()));
}

function cleanPrDescriptionForTitleContext(value: string | null | undefined): string {
    const body = stripHtmlComments(value || '');
    if (!body.trim()) return '';
    if (PROPR_GENERATED_PATTERNS.some(pattern => body.toLowerCase().includes(pattern.toLowerCase()))) return '';

    const meaningfulParagraphs = body.split(/\n{2,}/)
        .map(paragraph => paragraph
            .split('\n')
            .map(line => line.trim())
            .filter(line => line && !isPrTemplateNoiseLine(line))
            .join('\n')
            .trim())
        .filter(hasMeaningfulTitleText);

    return truncate(meaningfulParagraphs.slice(0, 3).join('\n\n'), 1800);
}

export function buildPrTaskTitleContext(options: BuildTitleContextOptions): TitleContextResult {
    const recentCommentLimit = options.recentCommentLimit ?? 2;
    const usefulRecentComments = selectRecentUsefulPrComments(options.recentComments, {
        limit: recentCommentLimit,
        excludeCommentIds: options.excludeCommentIds,
    });
    const sections: string[] = [];

    const hasMeaningfulInstructions = hasMeaningfulTitleText(options.instructionText);
    if (hasMeaningfulInstructions) {
        sections.push(`User instructions:\n${truncate(options.instructionText!.trim())}`);
    }

    if (usefulRecentComments.length > 0) {
        sections.push(`Recent useful PR comments (newest first):\n${usefulRecentComments.map(formatComment).join('\n')}`);
    }

    const prDescriptionFallback = cleanPrDescriptionForTitleContext(options.prDescription);
    const includePrDescription = !hasMeaningfulInstructions
        && usefulRecentComments.length < recentCommentLimit
        && hasMeaningfulTitleText(prDescriptionFallback);
    if (includePrDescription) {
        sections.push(`PR description fallback:\n${truncate(prDescriptionFallback)}`);
    }

    const includeReviewFeedback = hasMeaningfulTitleText(options.reviewFeedback);
    if (includeReviewFeedback) {
        sections.push(`Review feedback to address:\n${truncate(options.reviewFeedback!.trim(), 1800)}`);
    }

    const includeMergeConflictDiff = hasMeaningfulTitleText(options.mergeConflictDiff);
    if (includeMergeConflictDiff) {
        sections.push(`Merge conflict diff for conflicting files only:\n${truncate(options.mergeConflictDiff!.trim(), 4000)}`);
    }

    if (sections.length === 0) {
        return {
            context: '',
            hasMeaningfulContext: false,
            usefulRecentCommentCount: 0,
            includedPrDescription: false,
            includedReviewFeedback: false,
            includedMergeConflictDiff: false,
        };
    }

    const title = buildPrTaskTitle({
        workflow: options.workflow,
        pullRequestNumber: options.pullRequestNumber,
        prTitle: options.prTitle,
    });

    return {
        context: truncate(`Task: ${title}\n\n${sections.join('\n\n')}`, MAX_TITLE_CONTEXT_LENGTH),
        hasMeaningfulContext: true,
        usefulRecentCommentCount: usefulRecentComments.length,
        includedPrDescription: includePrDescription,
        includedReviewFeedback: includeReviewFeedback,
        includedMergeConflictDiff: includeMergeConflictDiff,
    };
}

function normalizeFallbackSummaryLine(line: string): string {
    return line
        .replace(/^[-*]\s+@\S+\s+\([^)]*\):\s*/, '')
        .replace(/^[-*]\s+/, '')
        .replace(/^#+\s*/, '')
        .trim();
}

function isFallbackContextHeader(line: string): boolean {
    return [
        /^Task:/i,
        /^User instructions:?$/i,
        /^Recent useful PR comments\b/i,
        /^PR description fallback:?$/i,
        /^Review feedback to address:?$/i,
        /^Merge conflict diff for conflicting files only:?$/i,
        /^Conflicting Files:?$/i,
        /^Known Conflicting Files:?$/i,
        /^Resolution Summary:?$/i,
        /^Summary:?$/i,
        /^Findings:?$/i,
        /^Review Details:?$/i,
        /^Overall Evaluation:?$/i,
        /^Next step:?$/i,
        /^AI Implementation Summary:?$/i,
        /^AI Processing Completed:?$/i,
        /^Execution Details:?$/i,
        /^Changes:?$/i,
        /^Implemented issue #\d+\.?$/i,
        /^[-*_]{3,}$/,
        /^\*\*AI Review Comments\b/i,
        /^\*\*Review by:\*\*/i,
        /^AI Code Review\b/i,
        /^diff --/i,
        /^index\b/i,
        /^---\s/,
        /^\+\+\+\s/,
        /^@@@?\s/,
    ].some(pattern => pattern.test(line));
}

export function selectFallbackSummaryLine(context: string): string {
    if (/^Merge conflict diff for conflicting files only:?$/im.test(context)) {
        const mergeLine = selectMergeConflictFallbackLine(context);
        if (mergeLine) return mergeLine;
    }

    return context
        .split('\n')
        .map(line => normalizeFallbackSummaryLine(line.trim()))
        .find(line => line && !isFallbackContextHeader(line)) || '';
}

function selectMergeConflictFallbackLine(context: string): string {
    const files = new Set<string>();
    for (const rawLine of context.split('\n')) {
        const line = rawLine.trim();
        if (line.startsWith('diff --')) {
            diffBlockPaths(line).forEach(path => files.add(path));
        }
        const patchPath = diffPatchPath(line);
        if (patchPath) files.add(patchPath);
    }

    const fileList = [...files].filter(Boolean).slice(0, 3);
    if (fileList.length === 0) return '';
    return `Conflicts in ${fileList.join(', ')}${files.size > fileList.length ? ', ...' : ''}`;
}
