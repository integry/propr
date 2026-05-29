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

const WORKFLOW_LABELS: Record<PrTaskWorkflow, string> = {
    followup: 'Follow-up',
    fix: 'Fix',
    review: 'Review',
    ultrafix: 'Ultrafix',
    merge: 'Merge',
};

const MAX_PR_TITLE_IN_TASK_TITLE = 140;

const PROPR_GENERATED_PATTERNS = [
    'Starting work on follow-up changes',
    'Starting AI Code Review',
    'AI Code Review Complete',
    'Resolved merge conflicts',
    'Auto-resolving merge conflicts',
    'Auto-merged',
    'Failed to apply follow-up changes',
    'Failed to resolve merge conflicts',
];

const NOISY_BOT_PATTERNS = [
    '### Checks Failed',
    'Linting or build errors were detected.',
    'View Logs',
    'View Workflow',
];

function compactWhitespace(value: string): string {
    return value.replace(/\s+/g, ' ').trim();
}

function truncate(value: string, maxLength = 1200): string {
    return value.length > maxLength ? `${value.substring(0, maxLength)}...` : value;
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
    const title = truncate(compactWhitespace(options.prTitle || '') || 'Untitled pull request', MAX_PR_TITLE_IN_TASK_TITLE);
    return `${WORKFLOW_LABELS[options.workflow]} PR #${options.pullRequestNumber}: ${title}`;
}

export function buildDeterministicPrTaskSubtitle(workflow: PrTaskWorkflow): string {
    switch (workflow) {
        case 'fix':
            return 'Fix requested without additional context.';
        case 'review':
            return 'Review requested without additional context.';
        case 'ultrafix':
            return 'Ultrafix cycle requested without additional context.';
        case 'merge':
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
    if (command === 'ultrafix') return Boolean(trailingLines);
    return false;
}

export function isUsefulTitleComment(comment: TitleComment): boolean {
    if (!hasMeaningfulTitleText(comment.body || '')) return false;
    const body = compactWhitespace(comment.body || '');
    const lowerBody = body.toLowerCase();

    const authorType = comment.user?.type;
    const author = comment.user?.login || comment.author || '';
    if (authorType === 'Bot' && author.toLowerCase().includes('propr')) return false;
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
    return `- @${author} (${kind}): ${truncate((comment.body || '').trim())}`;
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

    const includePrDescription = !hasMeaningfulInstructions
        && usefulRecentComments.length < recentCommentLimit
        && hasMeaningfulTitleText(options.prDescription);
    if (includePrDescription) {
        sections.push(`PR description fallback:\n${truncate(options.prDescription!.trim())}`);
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
        context: `Task: ${title}\n\n${sections.join('\n\n')}`,
        hasMeaningfulContext: true,
        usefulRecentCommentCount: usefulRecentComments.length,
        includedPrDescription: includePrDescription,
        includedReviewFeedback: includeReviewFeedback,
        includedMergeConflictDiff: includeMergeConflictDiff,
    };
}

function unquoteDiffPath(path: string): string {
    const trimmed = path.trim();
    if (!trimmed.startsWith('"') || !trimmed.endsWith('"')) return trimmed;
    try {
        return JSON.parse(trimmed) as string;
    } catch {
        return trimmed.substring(1, trimmed.length - 1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
}

function normalizeDiffPath(path: string): string {
    return unquoteDiffPath(path).replace(/^a\//, '').replace(/^b\//, '').trim();
}

function splitDiffHeaderArgs(value: string): string[] {
    const args: string[] = [];
    let current = '';
    let inQuotes = false;
    let escaping = false;

    for (const char of value) {
        if (escaping) {
            current += char;
            escaping = false;
            continue;
        }
        if (char === '\\' && inQuotes) {
            current += char;
            escaping = true;
            continue;
        }
        if (char === '"') {
            current += char;
            inQuotes = !inQuotes;
            continue;
        }
        if (/\s/.test(char) && !inQuotes) {
            if (current) {
                args.push(current);
                current = '';
            }
            continue;
        }
        current += char;
    }

    if (current) args.push(current);
    return args;
}

function diffBlockPaths(header: string): string[] {
    const gitHeader = header.match(/^diff --git\s+(.+)$/);
    if (gitHeader) {
        const paths = splitDiffHeaderArgs(gitHeader[1]);
        return paths.slice(0, 2).map(normalizeDiffPath);
    }

    const combinedHeader = header.match(/^diff --(?:cc|combined)\s+(.+)$/);
    if (combinedHeader) return [normalizeDiffPath(combinedHeader[1])];

    return [];
}

function diffPatchPath(line: string): string | null {
    const patchHeader = line.match(/^(?:---|\+\+\+)\s+(.+)$/);
    if (!patchHeader || patchHeader[1] === '/dev/null') return null;
    return normalizeDiffPath(patchHeader[1]);
}

function blockReferencesWantedFile(lines: string[], wanted: Set<string>): boolean {
    return lines.some(line => {
        const path = diffPatchPath(line);
        return path !== null && wanted.has(path);
    });
}

export function filterDiffToFiles(diff: string, filePaths: string[]): string {
    const wanted = new Set(filePaths.map(normalizeDiffPath));
    if (wanted.size === 0 || !diff.trim()) return '';

    const lines = diff.split('\n');
    const blocks: string[] = [];
    let current: string[] = [];
    let includeCurrent = false;
    let sawDiffHeader = false;

    for (const line of lines) {
        if (line.startsWith('diff --git ') || line.startsWith('diff --cc ') || line.startsWith('diff --combined ')) {
            sawDiffHeader = true;
            if (current.length > 0 && includeCurrent) blocks.push(current.join('\n'));
            current = [line];
            includeCurrent = diffBlockPaths(line).some(path => wanted.has(path));
        } else if (current.length > 0) {
            current.push(line);
            const patchPath = diffPatchPath(line);
            if (patchPath !== null && wanted.has(patchPath)) includeCurrent = true;
        }
    }

    if (current.length > 0 && includeCurrent) blocks.push(current.join('\n'));
    if (blocks.length === 0 && !sawDiffHeader && blockReferencesWantedFile(lines, wanted)) {
        return diff;
    }
    return blocks.join('\n');
}

function normalizeFallbackSummaryLine(line: string): string {
    return line
        .replace(/^[-*]\s+@\S+\s+\([^)]*\):\s*/, '')
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
    return context
        .split('\n')
        .map(line => normalizeFallbackSummaryLine(line.trim()))
        .find(line => line && !isFallbackContextHeader(line)) || '';
}

export async function getConflictDiffForTitle(worktreePath: string, conflictedFiles?: string[]): Promise<string> {
    if (!conflictedFiles || conflictedFiles.length === 0) return '';
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execFileAsync = promisify(execFile);

    for (const args of [
        ['diff', '--merge', '--', ...conflictedFiles],
        ['diff', '--', ...conflictedFiles],
        ['diff', '--cc', '--', ...conflictedFiles],
    ]) {
        try {
            const { stdout } = await execFileAsync('git', args, {
                cwd: worktreePath,
                encoding: 'utf8',
                maxBuffer: 2 * 1024 * 1024,
            });
            const filtered = filterDiffToFiles(String(stdout), conflictedFiles);
            if (filtered.trim()) return filtered;
        } catch {
            // Try the next diff mode; git versions and conflict states differ here.
        }
    }
    return '';
}
